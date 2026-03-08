// Training orchestrator: neuroevolution using TF.js + parallel web workers.
//
// Architecture:
//   • TensorFlow.js (globalThis.tf, loaded via CDN <script> in index.html) is
//     used to define the model shape and to save/restore the champion model.
//   • A pool of module web workers (train-worker.js) runs self-play games in
//     parallel, each worker receiving a pair of flat weight arrays, playing one
//     full game, and returning {fitness1, fitness2}.
//   • Neuroevolution (tournament selection + Gaussian mutation) evolves the
//     weight population each generation without back-propagation.

import {
  createRandomWeights, saveNeuralAgent, clearSavedAgent,
  IN, H1, H2, OUT, TOTAL_WEIGHTS
} from './ai-rl.js'

// ── Hyper-parameters ──────────────────────────────────────────────────────────

const POP_SIZE       = 8   // agents per generation
const GAMES_PER_GEN  = 8   // matchups to play each generation
const NUM_WORKERS    = 4   // parallel web workers
const MUT_STRENGTH   = 0.05 // σ for Gaussian weight mutation
const ELITE_FRACTION = 0.5  // fraction of population kept unchanged

// ── Runtime state ─────────────────────────────────────────────────────────────

let population     = []  // Array of Float32Array (weights)
let fitnessScores  = []  // latest fitness per individual
let generation     = 0
let totalGames     = 0
let bestFitness    = 0
let bestFitnessEver = 0
let workerPool     = []
let running        = false
let onUpdate       = null  // stats callback supplied by game.js

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

// Initialise population from localStorage (if a saved agent exists) plus randoms.
function initPopulation() {
  population = []
  let seedWeights = null

  try {
    const raw = localStorage.getItem('slay_best_agent')
    if (raw) {
      const parsed = JSON.parse(raw)
      seedWeights = new Float32Array(parsed.weights)
    }
  } catch (e) { /* ignore */ }

  for (let i = 0; i < POP_SIZE; i++) {
    if (i === 0 && seedWeights && seedWeights.length === TOTAL_WEIGHTS) {
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

  // Build a set of matchups: each individual plays ≈ GAMES_PER_GEN / POP_SIZE games
  const matchups = []
  for (let i = 0; i < GAMES_PER_GEN; i++) {
    const a = i % POP_SIZE
    const b = (i + Math.floor(POP_SIZE / 2)) % POP_SIZE
    matchups.push({ a: a, b: b, id: i })
  }

  let completed = 0

  for (let mi = 0; mi < matchups.length; mi++) {
    const m      = matchups[mi]
    const worker = workerPool[mi % workerPool.length]

    // Clone weights into new buffers so they can be transferred
    const buf1 = population[m.a].slice()
    const buf2 = population[m.b].slice()

    worker.onmessage = function (evt) {
      if (!running) return
      const { roundId, fitness1, fitness2 } = evt.data
      if (roundId !== m.id) return  // stale result from prior generation

      fitAccum[m.a]  += fitness1
      fitAccum[m.b]  += fitness2
      gamesCount[m.a]++
      gamesCount[m.b]++
      totalGames++
      completed++

      if (completed >= matchups.length) {
        // Normalise
        for (let i = 0; i < POP_SIZE; i++) {
          fitnessScores[i] = gamesCount[i] > 0 ? fitAccum[i] / gamesCount[i] : 0
        }
        evolve()
        if (onUpdate) onUpdate(getTrainingStats())
        if (running) setTimeout(runGeneration, 0)
      }
    }

    worker.postMessage(
      { weights1: buf1.buffer, weights2: buf2.buffer, roundId: m.id },
      [buf1.buffer, buf2.buffer]
    )
  }
}

// ── Evolution step ────────────────────────────────────────────────────────────

function evolve() {
  // Sort individuals by descending fitness
  const order = Array.from({ length: POP_SIZE }, function (_, i) { return i })
  order.sort(function (a, b) { return fitnessScores[b] - fitnessScores[a] })

  const bestIdx = order[0]
  bestFitness = fitnessScores[bestIdx]
  if (bestFitness > bestFitnessEver) {
    bestFitnessEver = bestFitness
    saveNeuralAgent(population[bestIdx], generation)

    // Also sync weights into a TF.js model for structured persistence
    const model = buildTFModel()
    if (model) {
      setTFWeights(model, population[bestIdx])
      model.save('localstorage://slay-champion').catch(function () {})
    }
  }

  generation++

  // Elitism: keep top ELITE_FRACTION unchanged
  const keepCount = Math.max(1, Math.floor(POP_SIZE * ELITE_FRACTION))
  const newPop = []

  for (let i = 0; i < keepCount; i++) {
    newPop.push(population[order[i]].slice())
  }

  // Fill remainder with mutated copies of elites
  for (let i = keepCount; i < POP_SIZE; i++) {
    const parentIdx = order[i % keepCount]
    const parent    = population[parentIdx]
    const child     = new Float32Array(TOTAL_WEIGHTS)
    for (let j = 0; j < TOTAL_WEIGHTS; j++) {
      child[j] = parent[j] + gaussianRand() * MUT_STRENGTH
    }
    newPop.push(child)
  }

  population = newPop
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
  population     = []
  fitnessScores  = []
  generation     = 0
  totalGames     = 0
  bestFitness    = 0
  bestFitnessEver = 0
  clearSavedAgent()
  try { globalThis.tf && globalThis.tf.io.removeModel('localstorage://slay-champion') } catch (e) {}
}

function isTrainingActive() { return running }

function getTrainingStats() {
  return {
    generation:     generation,
    totalGames:     totalGames,
    bestFitness:    bestFitness,
    bestFitnessEver: bestFitnessEver,
    numWorkers:     workerPool.length,
    mutRate:        MUT_STRENGTH
  }
}

export { startTraining, stopTraining, resetTraining, isTrainingActive, getTrainingStats }
