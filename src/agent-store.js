// Agent persistence: main-thread-only localStorage access with an in-memory cache.
//
// This module MUST NOT be imported by web workers (workers have no localStorage).
// All reads/writes to localStorage are centralised here so the separation between
// main-thread and worker code is unambiguous.

const LS_KEY = 'slay_best_agent'

// In-memory cache so the AI opponent doesn't need to JSON-parse on every turn.
let _cached = null  // { weights: Float32Array, generation: number } | null

// Load the best trained agent.  Returns the in-memory cached copy when available
// (updated by every saveNeuralAgent call), otherwise falls back to localStorage.
// Returns null when no model has been trained yet.
function getActiveNeuralAgent() {
  if (_cached) return _cached
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    _cached = {
      weights:    new Float32Array(parsed.weights),
      generation: parsed.generation || 0
    }
    return _cached
  } catch (e) {
    return null
  }
}

// Persist the best-agent weights.  Also refreshes the in-memory cache so that
// the game AI opponent starts using the new model immediately (no page reload
// or extra localStorage read required).
function saveNeuralAgent(weights, generation) {
  // Update in-memory cache immediately
  _cached = { weights: weights.slice(), generation: generation }

  // Persist to localStorage (main thread only — workers never call this)
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      weights:    Array.from(weights),
      generation: generation
    }))
  } catch (e) {
    // Storage quota exceeded — in-memory cache still works for the session
  }
}

// Remove all saved training data.
function clearSavedAgent() {
  _cached = null
  try { localStorage.removeItem(LS_KEY) } catch (e) {}
}

export { getActiveNeuralAgent, saveNeuralAgent, clearSavedAgent }
