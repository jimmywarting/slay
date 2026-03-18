// Training orchestrator: neuroevolution using TF.js + parallel web workers.
//
// Architecture:
//   • TensorFlow.js (globalThis.tf, loaded via CDN <script> in index.html) is
//     used to define the model shape and to save/restore the champion model.
//   • A pool of module web workers (train-worker.js) runs self-play games in
//     parallel, each worker receiving a pair of flat weight arrays, playing one
//     full game, and returning {fitness1, fitness2, winner}.
//   • Neuroevolution (tournament selection + Gaussian mutation) evolves the
//     weight population each generation without back-propagation.
//   • All localStorage access is delegated to agent-store.js so it stays on
//     the main thread and is never called from workers.

import {
  createRandomWeights,
  IN, H1, H2, OUT, TOTAL_WEIGHTS
} from './ai-rl.js'

import { saveNeuralAgent, clearSavedAgent, getActiveNeuralAgent } from './agent-store.js'

// ── Hyper-parameters ──────────────────────────────────────────────────────────

const POP_SIZE       = 24  // agents per generation
const GAMES_PER_GEN  = 5  // matchups to play each generation
const NUM_WORKERS    = 2
const MUT_BASE       = 0.04  // starting mutation strength
const MUT_MIN        = 0.01
const MUT_MAX        = 0.12
const ELITE_FRACTION = 0.25  // fraction of population kept unchanged
const IMMIGRANT_RATE = 0.1   // random fresh individuals per generation
const MAX_MATCH_RETRIES = 2

// ── Runtime state ─────────────────────────────────────────────────────────────

let population      = []  // Array of Float32Array (weights)
let fitnessScores   = []  // latest fitness per individual
let generation      = 0
let totalGames      = 0
let bestFitness     = 0
let bestFitnessEver = 0
let lastSavedGen    = -1  // generation at which the model was last saved to localStorage
let stagnationGens  = 0
let currentMutRate  = MUT_BASE
let wins            = 0   // agent-1 wins across all self-play games
let losses          = 0   // agent-1 losses (= agent-2 wins)
let draws           = 0
let genWins         = 0
let genLosses       = 0
let genDraws        = 0
let genGamesDone    = 0
let genGamesPlanned = 0
let fitnessHistory  = []  // { gen, fitness }[] — one entry per generation
let workerPool      = []
let running         = false
let onUpdate        = null  // stats callback supplied by game.js

// ── TF.js model (main-thread only) ───────────────────────────────────────────

// Build a Keras sequential model matching the ai-rl.js architecture.
// Used to (1) verify shapes, (2) provide a clean save/restore path via tf.io.
function buildTFModel() {
  const tf = globalThis.tf
  if (!tf) return null
  return tf.sequential({
    layers: [
      tf.layers.dense({ units: H1, activation: 'relu', inputShape: [IN] }),
      tf.layers.dense({ units: H2, activation: 'relu' }),
      tf.layers.dense({ units: OUT })
    ]
  })
}

// Copy a flat weight array back onto a TF.js model (for champion persistence).
// The dense-layer weight order is [kernel_0, bias_0, kernel_1, bias_1, …],
// which matches our W1/b1/W2/b2/W3/b3 layout exactly.
function setTFWeights(model, flat) {
  const tf = globalThis.tf
  if (!tf || !model) return
  const shapes = [
    [IN, H1], [H1],
    [H1, H2], [H2],
    [H2, OUT], [OUT]
  ]
  const tensors = []
  let offset = 0
  for (let si = 0; si < shapes.length; si++) {
    const shape = shapes[si]
    const size  = shape.reduce(function (product, dimension) { return product * dimension }, 1)
    tensors.push(tf.tensor(flat.slice(offset, offset + size), shape))
    offset += size
  }
  model.setWeights(tensors)
  tensors.forEach(function (t) { t.dispose() })
}

// Initialise population from a saved agent (if one exists) plus randoms.
// Uses agent-store.js so that all localStorage access stays on the main thread.
function initPopulation() {
  population = []
  const saved = getActiveNeuralAgent()
  const seedWeights = saved && saved.weights.length === TOTAL_WEIGHTS ? saved.weights : null

  for (let i = 0; i < POP_SIZE; i++) {
    if (i === 0 && seedWeights) {
      population.push(seedWeights.slice())
    } else {
      population.push(createRandomWeights())
    }
  }

  fitnessScores = new Float32Array(POP_SIZE)
}

// ── Worker pool ───────────────────────────────────────────────────────────────

function spawnWorkers() {
  workerPool = []
  for (let i = 0; i < NUM_WORKERS; i++) {
    workerPool.push(
      new Worker(new URL('./train-worker.js', import.meta.url), { type: 'module' })
    )
  }
}

function terminateWorkers() {
  for (let i = 0; i < workerPool.length; i++) workerPool[i].terminate()
  workerPool = []
}

// ── Generation loop ───────────────────────────────────────────────────────────

function runGeneration() {
  if (!running) return

  const fitAccum  = new Float32Array(POP_SIZE)
  const gamesCount = new Int32Array(POP_SIZE)

  const matchups = buildMatchups()

  genWins = 0
  genLosses = 0
  genDraws = 0
  genGamesDone = 0
  genGamesPlanned = matchups.length

  let completed = 0

  let nextMatch = 0

  function finishGenerationIfDone() {
    if (completed < matchups.length) return
    for (let i = 0; i < POP_SIZE; i++) {
      fitnessScores[i] = gamesCount[i] > 0 ? fitAccum[i] / gamesCount[i] : 0
    }
    evolve()
    if (onUpdate) onUpdate(getTrainingStats())
    if (running) setTimeout(runGeneration, 0)
  }

  function finalizeMatch(m, fitness1, fitness2, winner) {
    fitAccum[m.a] += fitness1
    fitAccum[m.b] += fitness2
    gamesCount[m.a]++
    gamesCount[m.b]++
    totalGames++
    completed++
    genGamesDone++

    if (winner === 0) {
      wins++
      genWins++
    } else if (winner === 1) {
      losses++
      genLosses++
    } else {
      draws++
      genDraws++
    }

    if (onUpdate && (genGamesDone % 6 === 0 || completed >= matchups.length)) {
      onUpdate(getTrainingStats())
    }
  }

  function requeueOrFinalizeAsDraw(m) {
    if (m.retries < MAX_MATCH_RETRIES) {
      m.retries++
      matchups.push(m)
      return
    }
    finalizeMatch(m, 0, 0, null)
  }

  function dispatch(worker) {
    if (!running) return
    if (nextMatch >= matchups.length) {
      finishGenerationIfDone()
      return
    }

    const m = matchups[nextMatch++]
    worker.__activeMatch = m

    const buf1 = population[m.a].slice()
    const buf2 = population[m.b].slice()
    worker.postMessage(
      { weights1: buf1.buffer, weights2: buf2.buffer, roundId: m.id },
      [buf1.buffer, buf2.buffer]
    )
  }

  for (let wi = 0; wi < workerPool.length; wi++) {
    const worker = workerPool[wi]
    worker.__activeMatch = null
    worker.onmessage = function (evt) {
      if (!running) return
      const m = worker.__activeMatch
      if (!m) return

      const { roundId, fitness1, fitness2, winner, error } = evt.data
      if (roundId !== m.id) {
        requeueOrFinalizeAsDraw(m)
      } else if (error) {
        requeueOrFinalizeAsDraw(m)
      } else {
        finalizeMatch(m, fitness1, fitness2, winner)
      }

      worker.__activeMatch = null
      dispatch(worker)
      finishGenerationIfDone()
    }

    worker.onerror = function () {
      if (!running) return
      const m = worker.__activeMatch
      if (!m) return

      requeueOrFinalizeAsDraw(m)
      worker.__activeMatch = null
      dispatch(worker)
      finishGenerationIfDone()
      return true
    }

    dispatch(worker)
  }
}

function buildMatchups() {
  const matchups = []
  let id = 0

  while (matchups.length < GAMES_PER_GEN) {
    const a = (Math.random() * POP_SIZE) | 0
    let b = (Math.random() * POP_SIZE) | 0
    while (b === a) b = (Math.random() * POP_SIZE) | 0

    matchups.push({ a, b, id: id++, retries: 0 })
    if (matchups.length < GAMES_PER_GEN) {
      matchups.push({ a: b, b: a, id: id++, retries: 0 })
    }
  }

  return matchups
}

// ── Evolution step ────────────────────────────────────────────────────────────

function evolve() {
  // Sort individuals by descending fitness
  const order = Array.from({ length: POP_SIZE }, function (_, i) { return i })
  order.sort(function (a, b) { return fitnessScores[b] - fitnessScores[a] })
  console.log('Gen', generation, 'best fitness', fitnessScores[order[0]].toFixed(4), 'avg fitness', (fitnessScores.reduce((a, b) => a + b, 0) / POP_SIZE).toFixed(4))
  const bestIdx = order[0]
  bestFitness = fitnessScores[bestIdx]
  if (bestFitness > bestFitnessEver) {
    stagnationGens = 0
    currentMutRate = Math.max(MUT_MIN, currentMutRate * 0.9)
    bestFitnessEver = bestFitness
    lastSavedGen = generation
    // Save to localStorage via main-thread-only agent-store.js
    saveNeuralAgent(population[bestIdx], generation)

    // Also sync weights into a TF.js model for structured persistence
    const model = buildTFModel()
    if (model) {
      setTFWeights(model, population[bestIdx])
      model.save('localstorage://slay-champion').catch(function () {})
    }
  } else {
    stagnationGens++
    const bump = stagnationGens > 12 ? 1.1 : 1.03
    currentMutRate = Math.min(MUT_MAX, currentMutRate * bump)
  }

  // Record fitness history (capped at 200 entries)
  fitnessHistory.push({ gen: generation, fitness: bestFitness })
  if (fitnessHistory.length > 200) fitnessHistory.shift()

  generation++

  // Elitism: keep top ELITE_FRACTION unchanged
  const keepCount = Math.max(1, Math.floor(POP_SIZE * ELITE_FRACTION))
  const immigrantCount = Math.max(1, Math.floor(POP_SIZE * IMMIGRANT_RATE))
  const newPop = []

  for (let i = 0; i < keepCount; i++) {
    newPop.push(population[order[i]].slice())
  }

  // Fill remainder with crossover + mutation from elite parents
  const childTarget = POP_SIZE - immigrantCount
  for (let i = keepCount; i < childTarget; i++) {
    const parentA = population[selectEliteParent(order, keepCount)]
    const parentB = population[selectEliteParent(order, keepCount)]
    const child = new Float32Array(TOTAL_WEIGHTS)

    for (let j = 0; j < TOTAL_WEIGHTS; j++) {
      const mix = Math.random()
      const base = parentA[j] * mix + parentB[j] * (1 - mix)
      child[j] = base + gaussianRand() * currentMutRate

      if (Math.random() < 0.005) {
        child[j] += gaussianRand() * currentMutRate * 3
      }
    }
    newPop.push(child)
  }

  for (let i = 0; i < immigrantCount; i++) {
    newPop.push(createRandomWeights())
  }

  population = newPop
}

function selectEliteParent(order, keepCount) {
  let best = order[(Math.random() * keepCount) | 0]
  for (let i = 0; i < 2; i++) {
    const challenger = order[(Math.random() * keepCount) | 0]
    if (fitnessScores[challenger] > fitnessScores[best]) best = challenger
  }
  return best
}

// Box-Muller transform for N(0,1) random numbers
function gaussianRand() {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ── Public API ────────────────────────────────────────────────────────────────

function startTraining(callback) {
  if (running) return
  running  = true
  onUpdate = callback || null

  if (population.length === 0) initPopulation()
  spawnWorkers()
  runGeneration()
}

function stopTraining() {
  running = false
  terminateWorkers()
}

function resetTraining() {
  stopTraining()
  population      = []
  fitnessScores   = []
  generation      = 0
  totalGames      = 0
  bestFitness     = 0
  bestFitnessEver = 0
  lastSavedGen    = -1
  stagnationGens  = 0
  currentMutRate  = MUT_BASE
  wins            = 0
  losses          = 0
  draws           = 0
  genWins         = 0
  genLosses       = 0
  genDraws        = 0
  genGamesDone    = 0
  genGamesPlanned = 0
  fitnessHistory  = []
  clearSavedAgent()
  if (globalThis.tf) globalThis.tf.io.removeModel('localstorage://slay-champion').catch(function () {})
}

function isTrainingActive() { return running }

function getTrainingStats() {
  const totalDecided = wins + losses + draws
  const winRate  = totalDecided > 0 ? wins / totalDecided : null
  const savedAgent = getActiveNeuralAgent()
  return {
    generation:      generation,
    totalGames:      totalGames,
    bestFitness:     bestFitness,
    bestFitnessEver: bestFitnessEver,
    lastSavedGen:    lastSavedGen,
    wins:            wins,
    losses:          losses,
    draws:           draws,
    genWins:         genWins,
    genLosses:       genLosses,
    genDraws:        genDraws,
    genGamesDone:    genGamesDone,
    genGamesPlanned: genGamesPlanned,
    winRate:         winRate,
    fitnessHistory:  fitnessHistory.slice(),
    numWorkers:      workerPool.length,
    mutRate:         currentMutRate,
    stagnationGens:  stagnationGens,
    hasSavedModel:   savedAgent !== null,
    savedModelGen:   savedAgent ? savedAgent.generation : null
  }
}

export { startTraining, stopTraining, resetTraining, isTrainingActive, getTrainingStats }
