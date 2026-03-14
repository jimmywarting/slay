const LS_KEY = 'slay_best_agent'
const SCHEMA_VERSION = 2

let cachedAgent = null

function hasStorage() {
  return typeof globalThis !== 'undefined' && !!globalThis.localStorage
}

function sanitizeGeneration(generation) {
  if (!Number.isFinite(generation)) return 0
  return Math.max(0, generation | 0)
}

function toFloat32Array(weights) {
  if (weights instanceof Float32Array) return weights.slice()
  if (!Array.isArray(weights)) return null

  const out = new Float32Array(weights.length)
  for (let i = 0; i < weights.length; i++) {
    const v = Number(weights[i])
    if (!Number.isFinite(v)) return null
    out[i] = v
  }
  return out
}

function parseStoredAgent(raw) {
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_err) {
    return null
  }

  const weights = toFloat32Array(parsed && parsed.weights)
  if (!weights || weights.length === 0) return null

  return {
    weights,
    generation: sanitizeGeneration(parsed.generation)
  }
}

function buildStoredPayload(agent) {
  return {
    version: SCHEMA_VERSION,
    generation: agent.generation,
    updatedAt: Date.now(),
    weights: Array.from(agent.weights)
  }
}

function getActiveNeuralAgent() {
  if (cachedAgent) {
    return {
      weights: cachedAgent.weights.slice(),
      generation: cachedAgent.generation
    }
  }

  if (!hasStorage()) return null

  const loaded = parseStoredAgent(globalThis.localStorage.getItem(LS_KEY))
  if (!loaded) return null
  cachedAgent = loaded

  return {
    weights: loaded.weights.slice(),
    generation: loaded.generation
  }
}

function saveNeuralAgent(weights, generation) {
  const normalized = toFloat32Array(weights)
  if (!normalized || normalized.length === 0) return

  const next = {
    weights: normalized,
    generation: sanitizeGeneration(generation)
  }
  cachedAgent = next

  if (!hasStorage()) return console.log('No storage available, skipping agent persistence.')

  try {
    globalThis.localStorage.setItem(LS_KEY, JSON.stringify(buildStoredPayload(next)))
  } catch (_err) {
    console.log('Failed to persist agent to storage, keeping in-memory cache.')
  }
}

function clearSavedAgent() {
  cachedAgent = null
  if (!hasStorage()) return
  try {
    globalThis.localStorage.removeItem(LS_KEY)
  } catch (_err) {
    // Ignore storage failures during clear.
  }
}

export { getActiveNeuralAgent, saveNeuralAgent, clearSavedAgent }