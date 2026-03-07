// Self-play training orchestrator.
// Manages a population of 6 NeuralAgents; runs each generation's self-play
// games in parallel across Web Workers (one worker per game), then performs
// selection + mutation on the main thread and persists the best agent.

import {
  NeuralAgent,
  getTF,
  runSelfPlayGameWeights,
  evolveAgents,
  saveBestAgent,
  savePopulation,
  loadPopulation
} from './ai-rl.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const POPULATION_SIZE    = 6
const GAMES_PER_GEN      = 6      // self-play games per generation (distributed across workers)
const NUM_ELITE          = 2      // agents that survive unchanged each gen
const MUTATION_RATE_INIT = 0.15   // starting mutation rate
const MUTATION_RATE_MIN  = 0.03   // floor
const MUTATION_DECAY     = 0.985  // rate decays by this factor each generation

// ── State ─────────────────────────────────────────────────────────────────────

let population       = null
let isRunning        = false
let generation       = 0
let totalGames       = 0
let bestFitnessEver  = -Infinity
let onProgressCb     = null
let workerPool       = null

// ── Worker pool ───────────────────────────────────────────────────────────────

function _createWorkerPool () {
  if (typeof Worker === 'undefined') return null
  const numWorkers = Math.min(
    GAMES_PER_GEN,
    typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4
  )
  const pool = []
  for (let i = 0; i < numWorkers; i++) {
    pool.push(new Worker(new URL('./train-worker.js', import.meta.url), { type: 'module' }))
  }
  return pool
}

function _terminateWorkers () {
  if (!workerPool) return
  workerPool.forEach(function (w) { w.terminate() })
  workerPool = null
}

// Distribute GAMES_PER_GEN games across the worker pool in parallel.
// Returns a Promise that resolves to a Float64Array of cumulative fitness deltas
// (indexed by agent/player slot 0..POPULATION_SIZE-1).
function _runGamesParallel (agentWeights) {
  const n = agentWeights.length

  // Fallback: synchronous execution when workers are unavailable
  if (!workerPool || workerPool.length === 0) {
    const total = new Float64Array(n)
    for (let g = 0; g < GAMES_PER_GEN; g++) {
      const d = runSelfPlayGameWeights(agentWeights)
      for (let i = 0; i < n; i++) total[i] += d[i]
    }
    return Promise.resolve(total)
  }

  const numWorkers = workerPool.length
  const promises   = []

  for (let wi = 0; wi < numWorkers; wi++) {
    // Distribute games as evenly as possible across workers
    const gamesForWorker = Math.floor(GAMES_PER_GEN / numWorkers) +
                           (wi < GAMES_PER_GEN % numWorkers ? 1 : 0)
    if (gamesForWorker === 0) continue

    const worker = workerPool[wi]
    promises.push(new Promise(function (resolve, reject) {
      function onMessage (e) {
        if (e.data.type === 'result') {
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
          resolve(e.data.fitnessDeltas)
        }
      }
      function onError (err) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        console.error('[TrainWorker ' + wi + '] error:', err)
        reject(new Error('Worker ' + wi + ' failed: ' + (err.message || err)))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({ type: 'run_games', agentWeights, numGames: gamesForWorker, workerIdx: wi })
    }))
  }

  return Promise.all(promises).then(function (results) {
    const total = new Float64Array(n)
    for (let ri = 0; ri < results.length; ri++) {
      const d = results[ri]
      for (let i = 0; i < n; i++) total[i] += d[i]
    }
    return total
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

function isTrainingActive () { return isRunning }

function getTrainingStats () {
  if (!population) return null
  const sorted = population.slice().sort(function (a, b) { return b.fitness - a.fitness })
  return {
    generation,
    totalGames,
    bestFitness:     sorted[0] ? sorted[0].fitness : 0,
    bestFitnessEver,
    topGeneration:   sorted[0] ? sorted[0].generation : 0
  }
}

async function startTraining (progressCallback) {
  if (isRunning) return
  if (!getTF()) {
    console.warn('[Train] TensorFlow.js not loaded – cannot train neural agents.')
    return
  }

  onProgressCb = progressCallback || null
  isRunning    = true

  _ensurePopulation()
  if (!population) { isRunning = false; return }

  workerPool = _createWorkerPool()
  if (workerPool) {
    console.log('[Train] Using ' + workerPool.length + ' web worker(s) for parallel self-play.')
  } else {
    console.warn('[Train] Web Workers unavailable — falling back to single-threaded training.')
  }

  while (isRunning) {
    // Reset per-generation fitness
    for (let i = 0; i < population.length; i++) population[i].fitness = 0

    // Compute adaptive mutation rate
    const mutRate = Math.max(
      MUTATION_RATE_MIN,
      MUTATION_RATE_INIT * Math.pow(MUTATION_DECAY, generation)
    )

    // Serialise all agent weights for transfer to workers
    const agentWeights = population.map(function (a) { return a.getWeights() })

    // Run all games in parallel across the worker pool; stop on unrecoverable error
    let fitnessDeltas
    try {
      fitnessDeltas = await _runGamesParallel(agentWeights)
    } catch (err) {
      console.error('[Train] Worker failure — stopping training:', err)
      isRunning = false
      _terminateWorkers()
      if (population) savePopulation(population)
      break
    }

    // Apply accumulated fitness deltas back to population
    for (let i = 0; i < population.length; i++) {
      population[i].fitness    += fitnessDeltas[i]
      population[i].gamesPlayed += GAMES_PER_GEN  // every agent participates in every game
    }
    totalGames += GAMES_PER_GEN

    // Report progress
    const sorted  = population.slice().sort(function (a, b) { return b.fitness - a.fitness })
    const best    = sorted[0]
    const avgFit  = population.reduce(function (s, a) { return s + a.fitness }, 0) / population.length

    if (best.fitness > bestFitnessEver) {
      bestFitnessEver = best.fitness
      saveBestAgent(best)
    }

    if (onProgressCb) {
      onProgressCb({
        generation,
        mutRate:         parseFloat(mutRate.toFixed(4)),
        bestFitness:     parseFloat(best.fitness.toFixed(2)),
        avgFitness:      parseFloat(avgFit.toFixed(2)),
        bestFitnessEver: parseFloat(bestFitnessEver.toFixed(2)),
        totalGames,
        numWorkers:      workerPool ? workerPool.length : 0
      })
    }

    // Evolve
    population = evolveAgents(population, NUM_ELITE, mutRate)
    generation++

    // Persist population every 5 generations to avoid excessive storage writes
    if (generation % 5 === 0) savePopulation(population)

    // Yield to the browser event loop between generations
    await new Promise(function (resolve) { setTimeout(resolve, 0) })
  }
}

function stopTraining () {
  isRunning = false
  _terminateWorkers()
  if (population) savePopulation(population)
}

function resetTraining () {
  stopTraining()
  try { localStorage.removeItem('slay_rl_best_v1') } catch (_) {}
  try { localStorage.removeItem('slay_rl_pop_v1')  } catch (_) {}
  population      = null
  generation      = 0
  totalGames      = 0
  bestFitnessEver = -Infinity
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _ensurePopulation () {
  if (population && population.length === POPULATION_SIZE) return

  const saved = loadPopulation()
  if (saved && saved.length === POPULATION_SIZE) {
    population = saved
    generation = Math.max(0, Math.max.apply(null, population.map(function (a) { return a.generation || 0 })))
    console.log('[Train] Resumed from saved population (gen ' + generation + ')')
  } else {
    if (getTF()) {
      population = []
      for (let i = 0; i < POPULATION_SIZE; i++) population.push(new NeuralAgent())
      generation = 0
      console.log('[Train] Initialised new random population (' + POPULATION_SIZE + ' agents)')
    } else {
      population = null
    }
  }
}

export { startTraining, stopTraining, resetTraining, isTrainingActive, getTrainingStats }

