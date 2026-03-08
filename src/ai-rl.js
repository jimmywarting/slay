// Neural agent: state encoding, pure-JS forward pass, self-play for neuroevolution.
// This module is imported by both the main thread (ai.js) and web workers (train-worker.js).
// It intentionally avoids TensorFlow.js so it works in worker contexts without extra deps.

import { getValidMoves, executeMove, PEASANT_COST, TOWER_COST } from './movement.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { TERRAIN_LAND, TERRAIN_WATER, STRUCTURE_HUT, STRUCTURE_TOWER, STRUCTURE_GRAVESTONE } from './constants.js'
import { hexNeighborKeys } from './hex.js'
import { generateHexMap, placeStartingTerritories } from './map.js'
import { startTurn, endTurn } from './turn-system.js'
import { UNIT_DEFS } from './units.js'

// ── Network architecture ──────────────────────────────────────────────────────
// Input : 30 features  (21 state + 9 move)
// Hidden: 32 units (ReLU)
// Hidden: 16 units (ReLU)
// Output:  1 scalar  (move score)

const IN  = 30
const H1  = 32
const H2  = 16
const OUT = 1

// Flat weight-array layout:
//   W1 [IN × H1]  offset 0       → 960 values
//   b1 [H1]       offset 960     → 32  values
//   W2 [H1 × H2]  offset 992     → 512 values
//   b2 [H2]       offset 1504    → 16  values
//   W3 [H2 × OUT] offset 1520    → 16  values
//   b3 [OUT]      offset 1536    → 1   value
const W1_OFF = 0
const B1_OFF = IN * H1             // 960
const W2_OFF = B1_OFF + H1         // 992
const B2_OFF = W2_OFF + H1 * H2   // 1504
const W3_OFF = B2_OFF + H2         // 1520
const B3_OFF = W3_OFF + H2 * OUT  // 1536

const TOTAL_WEIGHTS = B3_OFF + OUT // 1537

// ── State encoding ────────────────────────────────────────────────────────────

// Encode the global game state into a 21-element feature vector, always from the
// perspective of `playerId` (self = index 0 in the vector, opponent = index 1).
function encodeStateFeatures(state, playerId) {
  const features = new Float32Array(21)
  let idx = 0

  for (let p = 0; p < 2; p++) {
    const pid = p === 0 ? playerId : 1 - playerId
    let hexCount = 0, terrCount = 0, totalBank = 0, netIncome = 0
    let u1 = 0, u2 = 0, u3 = 0, u4 = 0, towers = 0

    for (const k in state.hexes) {
      const h = state.hexes[k]
      if (h.owner !== pid) continue
      hexCount++
      if (h.unit) {
        const lvl = h.unit.level
        if (lvl === 1)      u1++
        else if (lvl === 2) u2++
        else if (lvl === 3) u3++
        else                u4++
      }
      if (h.structure === STRUCTURE_TOWER) towers++
    }

    for (let ti = 0; ti < state.territories.length; ti++) {
      const t = state.territories[ti]
      if (t.owner !== pid) continue
      terrCount++
      totalBank += t.bank
      netIncome += computeIncome(state, t) - computeUpkeep(state, t)
    }

    features[idx++] = hexCount / 100
    features[idx++] = terrCount / 10
    features[idx++] = Math.min(1, totalBank / 100)
    features[idx++] = Math.max(-1, Math.min(1, netIncome / 20))
    features[idx++] = u1 / 10
    features[idx++] = u2 / 5
    features[idx++] = u3 / 3
    features[idx++] = u4 / 2
    features[idx++] = towers / 5
  }

  // Global: turn progress and my share of owned land
  const myHexes  = features[0] * 100
  const oppHexes = features[9] * 100
  const total    = myHexes + oppHexes
  features[idx++] = Math.min(1, state.turn / 200)
  features[idx++] = total > 0 ? myHexes / total : 0.5
  features[idx++] = 1.0  // constant bias feature

  return features
}

// Encode the 9 move-specific features for (fromKey → toKey).
function encodeMoveFeatures(state, playerId, fromKey, toKey, freeSet) {
  const features = new Float32Array(9)
  const fromHex = state.hexes[fromKey]
  const toHex   = state.hexes[toKey]
  if (!fromHex || !toHex || !fromHex.unit) return features

  const attackerLevel = fromHex.unit.level
  const isOwnHex      = toHex.owner === playerId
  const isActiveEnemy = toHex.owner !== null &&
                        toHex.owner !== playerId &&
                        toHex.owner < state.numActivePlayers
  const isNeutral     = !isActiveEnemy && !isOwnHex

  // Distance from attacker to nearest enemy hut (proximity = 1 - dist/20)
  let minDist = 20
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (!h || h.owner === playerId || h.structure !== STRUCTURE_HUT) continue
    const dq = fromHex.q - h.q
    const dr = fromHex.r - h.r
    const d  = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2
    if (d < minDist) minDist = d
  }

  features[0] = attackerLevel / 4
  features[1] = isActiveEnemy ? 1 : 0
  features[2] = isNeutral     ? 1 : 0
  features[3] = isOwnHex      ? 1 : 0
  features[4] = toHex.unit ? toHex.unit.level / 4 : 0
  features[5] = toHex.structure === STRUCTURE_HUT   ? 1 : 0
  features[6] = toHex.structure === STRUCTURE_TOWER ? 1 : 0
  features[7] = freeSet[toKey] ? 1 : 0
  features[8] = Math.max(0, 1 - minDist / 20)

  return features
}

// ── Pure-JS forward pass ──────────────────────────────────────────────────────

// Evaluate the network defined by `w` on the concatenation of stateFeatures (21)
// and moveFeatures (9), returning a single scalar score.
function forwardPass(w, stateFeatures, moveFeatures) {
  // Build input vector
  const input = new Float32Array(IN)
  for (let i = 0; i < 21; i++) input[i]      = stateFeatures[i]
  for (let i = 0; i < 9;  i++) input[21 + i] = moveFeatures[i]

  // Layer 1: IN → H1 (ReLU)
  const h1 = new Float32Array(H1)
  for (let j = 0; j < H1; j++) {
    let s = w[B1_OFF + j]
    for (let i = 0; i < IN; i++) s += w[W1_OFF + i * H1 + j] * input[i]
    h1[j] = s > 0 ? s : 0
  }

  // Layer 2: H1 → H2 (ReLU)
  const h2 = new Float32Array(H2)
  for (let j = 0; j < H2; j++) {
    let s = w[B2_OFF + j]
    for (let i = 0; i < H1; i++) s += w[W2_OFF + i * H2 + j] * h1[i]
    h2[j] = s > 0 ? s : 0
  }

  // Layer 3: H2 → 1 (linear)
  let out = w[B3_OFF]
  for (let i = 0; i < H2; i++) out += w[W3_OFF + i] * h2[i]

  return out
}

// ── Neural agent turn ─────────────────────────────────────────────────────────

// Execute a full turn for `state.activePlayer` using the neural network.
// Move phase: network scores all valid moves; highest-scoring move is taken.
// Buy/tower phase: greedy (economics-based) rules to keep implementation clean.
function runNeuralAgentTurn(state, agent) {
  const weights  = agent.weights
  const playerId = state.activePlayer

  // Move phase
  const stateFeatures = encodeStateFeatures(state, playerId)
  const MAX_ITERS = 80
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let bestScore = -Infinity
    let bestFrom  = null
    let bestTo    = null

    for (const fromKey in state.hexes) {
      const fromHex = state.hexes[fromKey]
      if (!fromHex.unit || fromHex.owner !== playerId || fromHex.unit.moved) continue

      const vm = getValidMoves(state, fromKey)
      for (let mi = 0; mi < vm.moves.length; mi++) {
        const toKey       = vm.moves[mi]
        const moveFeatures = encodeMoveFeatures(state, playerId, fromKey, toKey, vm.freeSet)
        const score        = forwardPass(weights, stateFeatures, moveFeatures)
        if (score > bestScore) {
          bestScore = score
          bestFrom  = fromKey
          bestTo    = toKey
        }
      }
    }

    // Stop if no move is available or the network strongly prefers doing nothing
    if (!bestFrom || bestScore < -0.5) break
    executeMove(state, bestFrom, bestTo)
  }

  // Buy phase (greedy)
  neuralBuyUnits(state, playerId)

  // Tower phase (greedy)
  neuralBuildTowers(state, playerId)
}

// ── Greedy buy / tower helpers (used by neural agent) ────────────────────────

function neuralBuyUnits(state, player) {
  let bought = true
  while (bought) {
    bought = false
    for (let ti = 0; ti < state.territories.length; ti++) {
      const t = state.territories[ti]
      if (t.owner !== player || t.bank < PEASANT_COST) continue

      const income = computeIncome(state, t)
      const upkeep = computeUpkeep(state, t)
      const netAfterBuy = income - (upkeep + 2)
      const bankAfterBuy = t.bank - PEASANT_COST
      if (netAfterBuy < 0 && bankAfterBuy < Math.abs(netAfterBuy) * 3) continue

      const placeKey = findFrontierPlacement(state, t, player)
      if (!placeKey) continue

      state.hexes[placeKey].unit = { level: 1, moved: false }
      t.bank -= PEASANT_COST
      bought = true
      break
    }
  }
}

function neuralBuildTowers(state, player) {
  for (let ti = 0; ti < state.territories.length; ti++) {
    const t = state.territories[ti]
    if (t.owner !== player || t.bank < TOWER_COST) continue
    if (computeIncome(state, t) - computeUpkeep(state, t) < 2) continue
    if (t.bank < TOWER_COST + 5) continue

    let bestKey        = null
    let bestBorderCount = 0
    for (let i = 0; i < t.hexKeys.length; i++) {
      const k = t.hexKeys[i]
      const h = state.hexes[k]
      if (!h || h.terrain !== TERRAIN_LAND || h.unit || h.structure) continue
      const nbrs = hexNeighborKeys(h.q, h.r)
      let enemyNbrs = 0
      for (let j = 0; j < nbrs.length; j++) {
        const nh = state.hexes[nbrs[j]]
        if (nh && nh.owner !== player && nh.owner !== null &&
            nh.owner < state.numActivePlayers) enemyNbrs++
      }
      if (enemyNbrs > bestBorderCount) { bestBorderCount = enemyNbrs; bestKey = k }
    }
    if (bestKey && bestBorderCount > 0) {
      state.hexes[bestKey].structure = STRUCTURE_TOWER
      t.bank -= TOWER_COST
    }
  }
}

function findFrontierPlacement(state, territory, player) {
  let bestKey   = null
  let bestScore = -Infinity
  for (let i = 0; i < territory.hexKeys.length; i++) {
    const k = territory.hexKeys[i]
    const h = state.hexes[k]
    if (!h || h.terrain !== TERRAIN_LAND || h.unit || h.structure) continue
    const nbrs = hexNeighborKeys(h.q, h.r)
    let borderScore = 0
    for (let j = 0; j < nbrs.length; j++) {
      const nh = state.hexes[nbrs[j]]
      if (!nh || nh.terrain === TERRAIN_WATER) continue
      if (nh.owner !== player) {
        borderScore += (nh.owner !== null && nh.owner < state.numActivePlayers) ? 2 : 1
      }
    }
    if (borderScore > bestScore) { bestScore = borderScore; bestKey = k }
  }
  return bestKey
}

// ── Self-play ─────────────────────────────────────────────────────────────────

// Play a complete game between two agents described by their flat weight arrays.
// Returns { fitness1, fitness2 } — raw scores based on final board position.
// Called by train-worker.js in the worker context.
function runSelfPlayGameWeights(weights1, weights2) {
  const NUM_ACTIVE = 2
  const NUM_TOTAL  = 6
  const NAMES      = ['A', 'B', 'C', 'D', 'E', 'F']
  const COLORS     = ['#000', '#111', '#222', '#333', '#444', '#555']

  const hexes       = generateHexMap()
  const territories = placeStartingTerritories(hexes, NUM_ACTIVE)

  const state = {
    players: NAMES.slice(0, NUM_TOTAL).map(function (n, i) {
      return { id: i, name: n, color: COLORS[i] }
    }),
    numActivePlayers: NUM_ACTIVE,
    hexes,
    territories,
    turn: 0,
    activePlayer: 0,
    selectedHex: null,
    selectedUnit: null,
    validMoves: [],
    freeMoves: {},
    mode: 'normal',
    turnSnapshot: null,
    message: '',
    gameOver: false,
    winner: null,
    aiPlayers: [0, 1],
    actionLog: [],
    aiThinking: false
  }

  startTurn(state)

  const agents = [
    { weights: weights1 },
    { weights: weights2 }
  ]

  const MAX_TURNS = 200
  while (!state.gameOver && state.turn < MAX_TURNS) {
    const p = state.activePlayer
    if (p < NUM_ACTIVE) {
      runNeuralAgentTurn(state, agents[p])
    }
    endTurn(state)
    checkWinLocal(state)
  }

  // Count final land ownership
  let land1 = 0, land2 = 0, totalLand = 0
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.terrain === TERRAIN_WATER) continue
    totalLand++
    if (h.owner === 0) land1++
    else if (h.owner === 1) land2++
  }
  const base = Math.max(1, totalLand)
  const fitness1 = (land1 / base) * 100 + (state.winner === 0 ? 50 : 0)
  const fitness2 = (land2 / base) * 100 + (state.winner === 1 ? 50 : 0)

  return { fitness1, fitness2 }
}

function checkWinLocal(state) {
  if (state.gameOver) return
  const ownedBy = {}
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.terrain !== TERRAIN_WATER && h.owner !== null) ownedBy[h.owner] = true
  }
  const active = Object.keys(ownedBy).map(Number)
  if (active.length <= 1) {
    state.gameOver = true
    state.winner   = active.length === 1 ? active[0] : null
  }
}

// ── Weight helpers ────────────────────────────────────────────────────────────

// Create a new Float32Array of random weights with a rough He initialisation.
function createRandomWeights() {
  const w     = new Float32Array(TOTAL_WEIGHTS)
  const scale = Math.sqrt(2 / IN) // He init (works well for ReLU networks)
  for (let i = 0; i < TOTAL_WEIGHTS; i++) {
    w[i] = (Math.random() * 2 - 1) * scale
  }
  return w
}

// ── Persistence ───────────────────────────────────────────────────────────────

const LS_KEY = 'slay_best_agent'

// Load the best trained agent from localStorage.  Returns null when no model
// has been saved yet, or if the stored data is corrupt.
function getActiveNeuralAgent() {
  try {
    const stored = localStorage.getItem(LS_KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored)
    return {
      weights:    new Float32Array(parsed.weights),
      generation: parsed.generation || 0
    }
  } catch (e) {
    return null
  }
}

// Persist the best agent weights to localStorage.  Exported so train.js can
// call it from the main thread (workers cannot access localStorage).
function saveNeuralAgent(weights, generation) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      weights:    Array.from(weights),
      generation: generation
    }))
  } catch (e) {
    // Storage quota exceeded or unavailable — training still continues in memory
  }
}

// Remove all saved training data.
function clearSavedAgent() {
  try { localStorage.removeItem(LS_KEY) } catch (e) {}
}

export {
  // Architecture constants (used by train.js for TF model creation)
  IN, H1, H2, OUT, TOTAL_WEIGHTS,
  // Weight helpers
  createRandomWeights, saveNeuralAgent, clearSavedAgent,
  // Agent lifecycle
  getActiveNeuralAgent,
  // Agent inference
  runNeuralAgentTurn,
  // Self-play (used in worker)
  runSelfPlayGameWeights
}
