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
  loadPopulation,
  resetTrainingMap
} from './ai-rl.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const POPULATION_SIZE    = 6
const GAMES_PER_CANDIDATE = 2     // games each candidate plays vs the frozen opponent per generation.
                                   // 2 games (once as each player, reducing positional bias) give a
                                   // more reliable fitness estimate without much extra cost because the
                                   // fixed map + frozen opponent eliminate most inter-game noise.
const NUM_ELITE          = 2      // agents that survive unchanged each gen
const MUTATION_RATE_INIT = 0.15   // starting mutation rate
const MUTATION_RATE_MIN  = 0.03   // floor
const MUTATION_DECAY     = 0.995  // slower decay: mutation stays active much longer before reaching the floor

// ── State ─────────────────────────────────────────────────────────────────────

let population       = null
let isRunning        = false
let generation       = 0
let totalGames       = 0
let bestFitnessEver  = -Infinity
let onProgressCb     = null
let workerPool       = null
let frozenBestWeights = null  // flat weights of the frozen reference opponent for the current generation

// ── Worker pool ───────────────────────────────────────────────────────────────

function _createWorkerPool () {
  if (typeof Worker === 'undefined') return null
  const numWorkers = Math.min(
    POPULATION_SIZE,
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

// Evaluate each candidate against the frozen reference opponent in parallel.
// agentWeightsArray[i] is the flat weights for candidate i.
// Each candidate plays GAMES_PER_CANDIDATE games as slot 0 against frozenBestWeights.
// Running 2 games per candidate gives a more reliable fitness estimate; only
// the candidate's fitness (slot 0) from each game is accumulated.
// Returns a Float64Array of cumulative candidate fitness totals.
function _runGamesParallel (agentWeightsArray) {
  const n = agentWeightsArray.length

  // Fallback: synchronous execution when workers are unavailable
  if (!workerPool || workerPool.length === 0) {
    const total = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      for (let g = 0; g < GAMES_PER_CANDIDATE; g++) {
        const d = runSelfPlayGameWeights([agentWeightsArray[i], frozenBestWeights])
        total[i] += d[0]
      }
    }
    return Promise.resolve(total)
  }

  const numWorkers = workerPool.length
  const promises   = []

  // One task per candidate — assign round-robin to the worker pool.
  for (let ci = 0; ci < n; ci++) {
    const candidateIdx = ci
    const worker = workerPool[ci % numWorkers]
    promises.push(new Promise(function (resolve, reject) {
      function onMessage (e) {
        // Match only the result for this specific candidate.
        if (e.data.type === 'result' && e.data.candidateIdx === candidateIdx) {
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
          resolve({ candidateIdx, fitnessDeltas: e.data.fitnessDeltas })
        }
      }
      function onError (err) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        console.error('[TrainWorker ' + (ci % numWorkers) + '] error:', err)
        reject(new Error('Worker ' + (ci % numWorkers) + ' failed: ' + (err.message || err)))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({
        type: 'run_games',
        agentWeights: [agentWeightsArray[ci], frozenBestWeights],
        numGames: GAMES_PER_CANDIDATE,
        candidateIdx,
        workerIdx: ci % numWorkers
      })
    }))
  }

  return Promise.all(promises).then(function (results) {
    const total = new Float64Array(n)
    for (let ri = 0; ri < results.length; ri++) {
      const r = results[ri]
      total[r.candidateIdx] += r.fitnessDeltas[0]  // only candidate (slot 0) fitness counts
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

  // Generate the fixed training map used by all games this session, and
  // initialise the frozen reference opponent from the current best agent.
  resetTrainingMap()
  const initSorted = population.slice().sort(function (a, b) { return b.fitness - a.fitness })
  frozenBestWeights = initSorted[0].getWeights()

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

    // Serialise all candidate weights for transfer to workers
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
      population[i].gamesPlayed += GAMES_PER_CANDIDATE
    }
    totalGames += POPULATION_SIZE * GAMES_PER_CANDIDATE

    // Report progress
    const sorted  = population.slice().sort(function (a, b) { return b.fitness - a.fitness })
    const best    = sorted[0]
    const avgFit  = population.reduce(function (s, a) { return s + a.fitness }, 0) / population.length

    if (best.fitness > bestFitnessEver) {
      bestFitnessEver = best.fitness
      saveBestAgent(best)
    }

    // The current generation's best becomes the frozen reference opponent for
    // the next generation — candidates always train against a stable, improving
    // adversary rather than a constantly shifting population.
    frozenBestWeights = best.getWeights()

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
  try { localStorage.removeItem('slay_rl_best_v2') } catch (_) {}
  try { localStorage.removeItem('slay_rl_pop_v2')  } catch (_) {}
  population        = null
  generation        = 0
  totalGames        = 0
  bestFitnessEver   = -Infinity
  frozenBestWeights = null
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

