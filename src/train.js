// Self-play training orchestrator.
// Manages a population of 6 NeuralAgents, runs generation loops in the
// background (yielding to the browser between generations), and persists
// the best agent to localStorage for use in the main game AI.

import {
  NeuralAgent,
  getTF,
  runSelfPlayGame,
  evolveAgents,
  saveBestAgent,
  savePopulation,
  loadPopulation
} from './ai-rl.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const POPULATION_SIZE    = 6
const GAMES_PER_GEN      = 3      // self-play games per generation
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

  while (isRunning) {
    // Reset per-generation fitness
    for (let i = 0; i < population.length; i++) population[i].fitness = 0

    // Compute adaptive mutation rate
    const mutRate = Math.max(
      MUTATION_RATE_MIN,
      MUTATION_RATE_INIT * Math.pow(MUTATION_DECAY, generation)
    )

    // Run self-play games
    for (let g = 0; g < GAMES_PER_GEN; g++) {
      if (!isRunning) break
      runSelfPlayGame(population)
      totalGames++
    }

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
        mutRate:        parseFloat(mutRate.toFixed(4)),
        bestFitness:    parseFloat(best.fitness.toFixed(2)),
        avgFitness:     parseFloat(avgFit.toFixed(2)),
        bestFitnessEver: parseFloat(bestFitnessEver.toFixed(2)),
        totalGames
      })
    }

    // Evolve
    population = evolveAgents(population, NUM_ELITE, mutRate)
    generation++

    // Persist population every 5 generations to avoid excessive storage writes
    if (generation % 5 === 0) savePopulation(population)

    // Yield to the browser event loop so the UI stays responsive
    await new Promise(function (resolve) { setTimeout(resolve, 0) })
  }
}

function stopTraining () {
  isRunning = false
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
