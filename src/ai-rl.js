// Reinforcement-learning agent using TensorFlow.js neuroevolution.
// Six neural agents self-play against each other; fitter agents survive
// each generation and are saved to localStorage for use in the main game.
//
// Architecture: 48-feature state → Dense(32,relu) → Dense(16,relu) → 24 logits
// Training:     neuroevolution (no gradient descent) — selection + Gaussian mutation
// Actions:      24 fixed types; invalid attempts are penalised as reward signals

import { getValidMoves, executeMove, PEASANT_COST, TOWER_COST, buyUnit } from './movement.js'
import { computeIncome, computeUpkeep } from './economy.js'
import {
  TERRAIN_WATER, TERRAIN_LAND, STRUCTURE_HUT, STRUCTURE_TOWER
} from './constants.js'
import { hexNeighborKeys } from './hex.js'
import { generateHexMap, placeStartingTerritories, MAP_RADIUS_DEFAULT } from './map.js'
import { startTurn, endTurn } from './turn-system.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATE_DIM  = 48   // feature-vector length  (8 global + 15 territory + 20 unit + 5 tactical)
const ACTION_DIM = 24   // fixed action-type count (see ACTION_* below)

// action-index ranges
const ACT_END_TURN  = 0         // 1 action
const ACT_BUY_BASE  = 1         // 3: buy peasant for territory slot 0-2
const ACT_BUILD_BASE = 4        // 3: build tower for territory slot 0-2
const ACT_ATTACK_BASE = 7       // 5: attack with unit slot 0-4
const ACT_EXPAND_BASE = 12      // 5: capture neutral/inactive with unit slot 0-4
const ACT_MERGE_BASE  = 17      // 4: merge with unit slot 0-3
const ACT_REPOS_BASE  = 21      // 3: free-reposition unit slot 0-2

const MAX_UNIT_SLOTS = 5
const MAX_TERR_SLOTS = 3
const MAP_RADIUS = MAP_RADIUS_DEFAULT  // max radius; used for coordinate normalisation in encodeState

// Fitness rewards / penalties
const R_WIN              =  5.0
const R_CAPTURE_HUT      =  1.0
const R_CAPTURE_ENEMY    =  0.5
const R_CAPTURE_NEUTRAL  =  0.3
const R_BUY_UNIT         =  0.1
const R_BUILD_TOWER      =  0.1
const R_MERGE            =  0.2
const R_REPOSITION       =  0.05
const P_INVALID          = -0.1   // action cannot exist (no territory / unit slot)
const P_CANT_AFFORD      = -0.15  // tried to buy/build without enough gold
const P_NO_MOVE          = -0.05  // action exists but no valid target found
const P_IDLE_TURN        = -0.3   // ended turn while units were idle or a buy was affordable

const MAX_ACTIONS_PER_TURN = 25
const MAX_TURNS_PER_GAME   = 200
const TOTAL_WEIGHTS        = 48 * 32 + 32 + 32 * 16 + 16 + 16 * 24 + 24  // 2504

const STORAGE_KEY_BEST = 'slay_rl_best_v1'
const STORAGE_KEY_POP  = 'slay_rl_pop_v1'

// ── TF.js global accessor ─────────────────────────────────────────────────────

function getTF() {
  return (typeof globalThis !== 'undefined' ? globalThis.tf : undefined) || undefined
}

// ── Neural network model ──────────────────────────────────────────────────────

function createModel() {
  const TF = getTF()
  if (!TF) return null
  const m = TF.sequential()
  m.add(TF.layers.dense({
    units: 32, activation: 'relu', inputShape: [STATE_DIM],
    kernelInitializer: 'glorotNormal', biasInitializer: 'zeros'
  }))
  m.add(TF.layers.dense({
    units: 16, activation: 'relu',
    kernelInitializer: 'glorotNormal', biasInitializer: 'zeros'
  }))
  m.add(TF.layers.dense({
    units: ACTION_DIM, activation: 'linear',
    kernelInitializer: 'glorotNormal', biasInitializer: 'zeros'
  }))
  return m
}

// ── NeuralAgent ───────────────────────────────────────────────────────────────

class NeuralAgent {
  constructor (weights) {
    this.model    = createModel()
    this.fitness  = 0
    this.generation = 0
    this.gamesPlayed = 0
    if (weights && this.model) this._setWeightsFromFlat(weights)
  }

  // ── weight serialisation ─────────────────────────────────────────────────

  getWeights () {
    if (!this.model) return new Float32Array(TOTAL_WEIGHTS)
    const ws = this.model.getWeights()
    const out = []
    for (let i = 0; i < ws.length; i++) {
      const d = ws[i].dataSync()
      for (let j = 0; j < d.length; j++) out.push(d[j])
    }
    return new Float32Array(out)
  }

  _setWeightsFromFlat (flat) {
    if (!this.model) return
    const TF = getTF()
    if (!TF) return
    const ws = this.model.getWeights()
    const newWs = []
    let offset = 0
    for (let i = 0; i < ws.length; i++) {
      const shape = ws[i].shape
      const size  = shape.reduce(function (a, b) { return a * b }, 1)
      newWs.push(TF.tensor(flat.slice(offset, offset + size), shape))
      offset += size
    }
    this.model.setWeights(newWs)
    newWs.forEach(function (w) { w.dispose() })
  }

  // ── inference ────────────────────────────────────────────────────────────

  // Returns the action index (0..ACTION_DIM-1) with the highest logit.
  selectAction (features) {
    const TF = getTF()
    if (!TF || !this.model) return Math.floor(Math.random() * ACTION_DIM)
    return TF.tidy(function () {
      const input  = TF.tensor2d([Array.from(features)], [1, STATE_DIM])
      const output = this.model.predict(input)
      return output.argMax(1).dataSync()[0]
    }.bind(this))
  }

  // ── evolution helpers ─────────────────────────────────────────────────────

  clone () {
    const child = new NeuralAgent(this.getWeights())
    child.generation  = this.generation
    child.gamesPlayed = this.gamesPlayed
    return child
  }

  mutate (rate) {
    const flat = this.getWeights()
    for (let i = 0; i < flat.length; i++) {
      if (Math.random() < rate) flat[i] += gaussianNoise(0.3)
    }
    this._setWeightsFromFlat(flat)
  }

  // ── persistence ───────────────────────────────────────────────────────────

  toJSON () {
    return {
      weights:     Array.from(this.getWeights()),
      fitness:     this.fitness,
      generation:  this.generation,
      gamesPlayed: this.gamesPlayed
    }
  }

  static fromJSON (obj) {
    const a = new NeuralAgent(new Float32Array(obj.weights))
    a.fitness     = obj.fitness     || 0
    a.generation  = obj.generation  || 0
    a.gamesPlayed = obj.gamesPlayed || 0
    return a
  }

  dispose () {
    if (this.model) { try { this.model.dispose() } catch (_) {} }
  }
}

// Box-Muller Gaussian noise
function gaussianNoise (stddev) {
  const u1 = Math.random() || 1e-10
  const u2 = Math.random()
  return stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// ── Pure-JS forward pass ──────────────────────────────────────────────────────
//
// Runs inference for the 48→32(ReLU)→16(ReLU)→24(linear) network entirely in
// plain JavaScript, with no dependency on TensorFlow.js.  This allows self-play
// games to be executed inside Web Workers where TF.js is not available.
//
// Weight layout matches the order returned by model.getWeights() / dataSync():
//   W0[48×32=1536]  b0[32]  W1[32×16=512]  b1[16]  W2[16×24=384]  b2[24]
// Kernel shape [in, out] in row-major: kernel[i * out + j]
//
const _L0_IN = STATE_DIM, _L0_OUT = 32
const _L1_IN = 32,        _L1_OUT = 16
const _L2_IN = 16,        _L2_OUT = ACTION_DIM

const _W0_OFF = 0
const _B0_OFF = _W0_OFF + _L0_IN * _L0_OUT          // 1536
const _W1_OFF = _B0_OFF + _L0_OUT                    // 1568
const _B1_OFF = _W1_OFF + _L1_IN * _L1_OUT          // 2080
const _W2_OFF = _B1_OFF + _L1_OUT                    // 2096
const _B2_OFF = _W2_OFF + _L2_IN * _L2_OUT          // 2480

function selectActionPure (flatWeights, features) {
  // Layer 0: [STATE_DIM] → [32] with ReLU
  const h0 = new Float32Array(_L0_OUT)
  for (let j = 0; j < _L0_OUT; j++) {
    let s = flatWeights[_B0_OFF + j]
    for (let i = 0; i < _L0_IN; i++) s += features[i] * flatWeights[_W0_OFF + i * _L0_OUT + j]
    h0[j] = s > 0 ? s : 0
  }
  // Layer 1: [32] → [16] with ReLU
  const h1 = new Float32Array(_L1_OUT)
  for (let j = 0; j < _L1_OUT; j++) {
    let s = flatWeights[_B1_OFF + j]
    for (let i = 0; i < _L1_IN; i++) s += h0[i] * flatWeights[_W1_OFF + i * _L1_OUT + j]
    h1[j] = s > 0 ? s : 0
  }
  // Layer 2: [16] → [ACTION_DIM] linear — return argmax directly
  let best = 0, bestV = -Infinity
  for (let j = 0; j < _L2_OUT; j++) {
    let s = flatWeights[_B2_OFF + j]
    for (let i = 0; i < _L2_IN; i++) s += h1[i] * flatWeights[_W2_OFF + i * _L2_OUT + j]
    if (s > bestV) { bestV = s; best = j }
  }
  return best
}

// ── State encoding ────────────────────────────────────────────────────────────
//
// Features (48 total):
//   [0..7]   global (8)         : turn, myHex, enemyHex, income, upkeep, bank, numTerr, numUnits
//   [8..22]  territory (3×5=15) : hexCount, bank, income, upkeep, unitCount per slot
//   [23..42] units (5×4=20)     : level, qNorm, rNorm, hasEnemyNeighbor per slot
//   [43..47] tactical (5)       : canBuy, canBuild, relStrength, borderPressure, unmovedUnits

function encodeState (state, playerId) {
  const f = new Float32Array(STATE_DIM)
  let i = 0

  // Gather territories for this player
  const myTerrs = []
  for (let t = 0; t < state.territories.length; t++) {
    if (state.territories[t].owner === playerId) myTerrs.push(state.territories[t])
  }

  // Count hexes
  let myHexCount = 0
  const enemyCounts = {}
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.terrain === TERRAIN_WATER) continue
    if (h.owner === playerId) {
      myHexCount++
    } else if (h.owner !== null && h.owner < state.numActivePlayers) {
      enemyCounts[h.owner] = (enemyCounts[h.owner] || 0) + 1
    }
  }
  const maxEnemyHexCount = Object.keys(enemyCounts).length > 0
    ? Math.max.apply(null, Object.values(enemyCounts)) : 0

  // Aggregate territory stats
  let totalIncome = 0, totalUpkeep = 0, totalBank = 0, totalUnits = 0
  for (let t = 0; t < myTerrs.length; t++) {
    totalIncome += computeIncome(state, myTerrs[t])
    totalUpkeep += computeUpkeep(state, myTerrs[t])
    totalBank   += myTerrs[t].bank
  }
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.unit && h.owner === playerId) totalUnits++
  }

  // ── global (8) ──
  f[i++] = Math.min(state.turn / 200, 1)
  f[i++] = Math.min(myHexCount / 100, 1)
  f[i++] = Math.min(maxEnemyHexCount / 100, 1)
  f[i++] = Math.min(totalIncome / 20, 1)
  f[i++] = Math.min(totalUpkeep / 20, 1)
  f[i++] = Math.min(totalBank / 100, 1)
  f[i++] = Math.min(myTerrs.length / 6, 1)
  f[i++] = Math.min(totalUnits / 10, 1)

  // ── territory slots (3×5=15) ──
  for (let ti = 0; ti < MAX_TERR_SLOTS; ti++) {
    const t = myTerrs[ti]
    if (t) {
      let numUnitsInT = 0
      for (let ki = 0; ki < t.hexKeys.length; ki++) {
        const h = state.hexes[t.hexKeys[ki]]
        if (h && h.unit) numUnitsInT++
      }
      f[i++] = Math.min(t.hexKeys.length / 10, 1)
      f[i++] = Math.min(t.bank / 50, 1)
      f[i++] = Math.min(computeIncome(state, t) / 10, 1)
      f[i++] = Math.min(computeUpkeep(state, t) / 10, 1)
      f[i++] = Math.min(numUnitsInT / 5, 1)
    } else {
      i += 5  // zero-pad missing territory slot
    }
  }

  // ── unit slots (5×4=20) ──
  const myUnits = getUnmovedUnits(state, playerId)
  for (let ui = 0; ui < MAX_UNIT_SLOTS; ui++) {
    const u = myUnits[ui]
    if (u) {
      let hasEnemyNeighbor = 0
      const nbrs = hexNeighborKeys(u.hex.q, u.hex.r)
      for (let ni = 0; ni < nbrs.length; ni++) {
        const nh = state.hexes[nbrs[ni]]
        if (nh && nh.owner !== playerId && nh.owner !== null && nh.owner < state.numActivePlayers) {
          hasEnemyNeighbor = 1
          break
        }
      }
      f[i++] = u.hex.unit.level / 4
      f[i++] = (u.hex.q + MAP_RADIUS) / (2 * MAP_RADIUS)
      f[i++] = (u.hex.r + MAP_RADIUS) / (2 * MAP_RADIUS)
      f[i++] = hasEnemyNeighbor
    } else {
      i += 4  // zero-pad missing unit slot
    }
  }

  // ── tactical (5) ──
  const canBuy   = myTerrs.some(function (t) { return t.bank >= PEASANT_COST }) ? 1 : 0
  const canBuild = myTerrs.some(function (t) { return t.bank >= TOWER_COST   }) ? 1 : 0

  // border pressure: fraction of my hexes that have a non-player neighbour
  let borderCount = 0
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.owner !== playerId || h.terrain === TERRAIN_WATER) continue
    const nbrs = hexNeighborKeys(h.q, h.r)
    for (let ni = 0; ni < nbrs.length; ni++) {
      const nh = state.hexes[nbrs[ni]]
      if (nh && nh.owner !== playerId && nh.terrain !== TERRAIN_WATER) {
        borderCount++
        break
      }
    }
  }

  f[i++] = canBuy
  f[i++] = canBuild
  f[i++] = Math.min(myHexCount / (maxEnemyHexCount + 1), 3) / 3  // relative strength 0-1
  f[i++] = Math.min(borderCount / 10, 1)
  f[i++] = Math.min(myUnits.length / 5, 1)

  // i === 48 here
  return f
}

// ── Action execution ──────────────────────────────────────────────────────────
//
// Tries to execute the given action for `state.activePlayer`.
// Returns the reward/penalty for this attempt.

function executeActionRL (state, actionIdx) {
  const player = state.activePlayer

  // Build per-turn context (cheap)
  const myTerrs = []
  for (let t = 0; t < state.territories.length; t++) {
    if (state.territories[t].owner === player) myTerrs.push(state.territories[t])
  }
  const myUnits = getUnmovedUnits(state, player)

  // ── 0: END_TURN ──
  if (actionIdx === ACT_END_TURN) return 0

  // ── 1-3: BUY PEASANT ──
  if (actionIdx >= ACT_BUY_BASE && actionIdx < ACT_BUY_BASE + MAX_TERR_SLOTS) {
    const terr = myTerrs[actionIdx - ACT_BUY_BASE]
    if (!terr)              return P_INVALID
    if (terr.bank < PEASANT_COST) return P_CANT_AFFORD
    // Find territory index and delegate to buyUnit() which handles tree/parachute placement
    const terrIdx = state.territories.indexOf(terr)
    if (buyUnit(state, terrIdx)) return R_BUY_UNIT
    return P_NO_MOVE  // no valid placement hex
  }

  // ── 4-6: BUILD TOWER ──
  if (actionIdx >= ACT_BUILD_BASE && actionIdx < ACT_BUILD_BASE + MAX_TERR_SLOTS) {
    const terr = myTerrs[actionIdx - ACT_BUILD_BASE]
    if (!terr)              return P_INVALID
    if (terr.bank < TOWER_COST) return P_CANT_AFFORD
    for (let ki = 0; ki < terr.hexKeys.length; ki++) {
      const h = state.hexes[terr.hexKeys[ki]]
      if (h && h.terrain === TERRAIN_LAND && !h.unit && !h.structure) {
        h.structure = STRUCTURE_TOWER
        terr.bank -= TOWER_COST
        return R_BUILD_TOWER
      }
    }
    return P_NO_MOVE
  }

  // ── 7-11: ATTACK active enemy hex ──
  if (actionIdx >= ACT_ATTACK_BASE && actionIdx < ACT_ATTACK_BASE + MAX_UNIT_SLOTS) {
    const unit = myUnits[actionIdx - ACT_ATTACK_BASE]
    if (!unit) return P_INVALID
    const vm = getValidMoves(state, unit.key)
    let bestKey = null
    let bestR   = -Infinity
    for (let mi = 0; mi < vm.moves.length; mi++) {
      const mk = vm.moves[mi]
      const mh = state.hexes[mk]
      if (!mh || mh.owner === player) continue
      if (mh.owner === null || mh.owner >= state.numActivePlayers) continue
      const r = (mh.structure === STRUCTURE_HUT) ? R_CAPTURE_HUT : R_CAPTURE_ENEMY
      if (r > bestR) { bestR = r; bestKey = mk }
    }
    if (!bestKey) return P_NO_MOVE
    executeMove(state, unit.key, bestKey)
    return bestR
  }

  // ── 12-16: EXPAND into neutral / inactive territory ──
  if (actionIdx >= ACT_EXPAND_BASE && actionIdx < ACT_EXPAND_BASE + MAX_UNIT_SLOTS) {
    const unit = myUnits[actionIdx - ACT_EXPAND_BASE]
    if (!unit) return P_INVALID
    const vm = getValidMoves(state, unit.key)
    for (let mi = 0; mi < vm.moves.length; mi++) {
      const mk = vm.moves[mi]
      const mh = state.hexes[mk]
      if (!mh || mh.owner === player) continue
      if (mh.owner === null || mh.owner >= state.numActivePlayers) {
        executeMove(state, unit.key, mk)
        return R_CAPTURE_NEUTRAL
      }
    }
    return P_NO_MOVE
  }

  // ── 17-20: MERGE ──
  if (actionIdx >= ACT_MERGE_BASE && actionIdx < ACT_MERGE_BASE + 4) {
    const unit = myUnits[actionIdx - ACT_MERGE_BASE]
    if (!unit) return P_INVALID
    const vm = getValidMoves(state, unit.key)
    for (let mi = 0; mi < vm.moves.length; mi++) {
      const mk = vm.moves[mi]
      const mh = state.hexes[mk]
      if (mh && mh.owner === player && mh.unit) {
        executeMove(state, unit.key, mk)
        return R_MERGE
      }
    }
    return P_NO_MOVE
  }

  // ── 21-23: FREE REPOSITION ──
  if (actionIdx >= ACT_REPOS_BASE && actionIdx < ACT_REPOS_BASE + 3) {
    const unit = myUnits[actionIdx - ACT_REPOS_BASE]
    if (!unit) return P_INVALID
    const vm = getValidMoves(state, unit.key)
    for (let mi = 0; mi < vm.moves.length; mi++) {
      const mk = vm.moves[mi]
      if (vm.freeSet[mk]) {
        executeMove(state, unit.key, mk)
        return R_REPOSITION
      }
    }
    return P_NO_MOVE
  }

  return P_INVALID
}

// ── Self-play infrastructure ──────────────────────────────────────────────────

function getUnmovedUnits (state, playerId) {
  const units = []
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.unit && h.owner === playerId && !h.unit.moved) {
      units.push({ key: k, hex: h })
    }
  }
  units.sort(function (a, b) { return a.key.localeCompare(b.key) })
  return units
}

// Returns true when the active player still has idle units or can buy a peasant.
// Used by both training paths to detect and penalise premature END_TURN choices.
function _hasIdleOptions (state, player) {
  if (getUnmovedUnits(state, player).length > 0) return true
  return state.territories.some(function (t) {
    return t.owner === player && t.bank >= PEASANT_COST
  })
}

function createHeadlessState (numActivePlayers) {
  const players = []
  for (let p = 0; p < 6; p++) players.push({ id: p, name: 'A' + p, color: '#fff' })
  // Vary map radius (5–MAP_RADIUS) so the agent trains on different map sizes.
  // MAP_RADIUS (7) is still the max and is used for coordinate normalisation.
  const radius = 5 + Math.floor(Math.random() * (MAP_RADIUS - 4)) // 5, 6, or 7
  const hexes       = generateHexMap(radius)
  const territories = placeStartingTerritories(hexes, numActivePlayers)
  const state = {
    players, numActivePlayers, hexes, territories,
    turn: 0, activePlayer: 0,
    selectedHex: null, selectedUnit: null,
    validMoves: [], freeMoves: {},
    mode: 'normal', turnSnapshot: null,
    message: '', gameOver: false, winner: null,
    aiPlayers: [], actionLog: []
  }
  startTurn(state)
  return state
}

function checkWinConditionHeadless (state) {
  const ownedBy = {}
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.terrain !== TERRAIN_WATER && h.owner !== null) ownedBy[h.owner] = true
  }
  const active = Object.keys(ownedBy).map(Number)
  if (active.length === 1) {
    state.gameOver = true
    state.winner   = active[0]
  } else if (active.length === 0) {
    state.gameOver = true
    state.winner   = null
  }
}

// Run one agent's full turn (multiple action steps until END_TURN or no moves left).
function runAgentTurn (state, agent) {
  const player = state.activePlayer
  for (let step = 0; step < MAX_ACTIONS_PER_TURN; step++) {
    const features  = encodeState(state, player)
    const actionIdx = agent.selectAction(features)
    if (actionIdx === ACT_END_TURN) {
      // Penalise ending the turn early while units are idle or a purchase is affordable
      if (_hasIdleOptions(state, player)) agent.fitness += P_IDLE_TURN
      break
    }
    const reward = executeActionRL(state, actionIdx)
    agent.fitness += reward
    // Auto-end if nothing left to do
    const unmoved = getUnmovedUnits(state, player)
    const canBuy  = state.territories.some(function (t) {
      return t.owner === player && t.bank >= PEASANT_COST
    })
    if (unmoved.length === 0 && !canBuy) break
  }
}

// Run a complete self-play game; updates agent.fitness in-place.
function runSelfPlayGame (agents) {
  const n = agents.length
  // Vary active player count (2..n) so the agent trains on different scenarios.
  const numActive = 2 + Math.floor(Math.random() * (n - 1))
  const state = createHeadlessState(numActive)
  let turn = 0
  while (!state.gameOver && turn < MAX_TURNS_PER_GAME) {
    const player = state.activePlayer
    runAgentTurn(state, agents[player])
    endTurn(state)
    checkWinConditionHeadless(state)
    turn++
  }
  // Win bonus (only active players compete)
  if (state.winner !== null && state.winner < numActive) agents[state.winner].fitness += R_WIN
  // Per-hex ownership bonus: primary fitness driver for territory control (active players only)
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.terrain !== TERRAIN_WATER && h.owner !== null && h.owner < numActive) {
      agents[h.owner].fitness += 0.1
    }
  }
  for (let i = 0; i < n; i++) agents[i].gamesPlayed++
}

// Run a complete self-play game using pure-JS inference (no TF.js).
// agentWeights: array of Float32Array, one per agent in the population.
// Returns a Float64Array of fitness deltas indexed by agent slot.
function runSelfPlayGameWeights (agentWeights) {
  const n = agentWeights.length
  const fitnessDeltas = new Float64Array(n)
  // Vary active player count (2..n) so the agent trains on different scenarios.
  const numActive = 2 + Math.floor(Math.random() * (n - 1))
  const state = createHeadlessState(numActive)
  let turn = 0
  while (!state.gameOver && turn < MAX_TURNS_PER_GAME) {
    const player  = state.activePlayer
    const weights = agentWeights[player]
    for (let step = 0; step < MAX_ACTIONS_PER_TURN; step++) {
      const features  = encodeState(state, player)
      const actionIdx = selectActionPure(weights, features)
      if (actionIdx === ACT_END_TURN) {
        // Penalise ending the turn early while units are idle or a purchase is affordable
        if (_hasIdleOptions(state, player)) fitnessDeltas[player] += P_IDLE_TURN
        break
      }
      const reward = executeActionRL(state, actionIdx)
      fitnessDeltas[player] += reward
      const unmoved = getUnmovedUnits(state, player)
      const canBuy  = state.territories.some(function (t) {
        return t.owner === player && t.bank >= PEASANT_COST
      })
      if (unmoved.length === 0 && !canBuy) break
    }
    endTurn(state)
    checkWinConditionHeadless(state)
    turn++
  }
  // Win bonus (only active players compete)
  if (state.winner !== null && state.winner < numActive) fitnessDeltas[state.winner] += R_WIN
  // Per-hex ownership bonus: primary fitness driver for territory control (active players only)
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.terrain !== TERRAIN_WATER && h.owner !== null && h.owner < numActive) {
      fitnessDeltas[h.owner] += 0.1
    }
  }
  return fitnessDeltas
}
function runNeuralAgentTurn (state, agent) {
  const player = state.activePlayer
  for (let step = 0; step < MAX_ACTIONS_PER_TURN; step++) {
    const features  = encodeState(state, player)
    const actionIdx = agent.selectAction(features)
    if (actionIdx === ACT_END_TURN) break
    executeActionRL(state, actionIdx)
    const unmoved = getUnmovedUnits(state, player)
    const canBuy  = state.territories.some(function (t) {
      return t.owner === player && t.bank >= PEASANT_COST
    })
    if (unmoved.length === 0 && !canBuy) break
  }
}

// ── Neuroevolution ────────────────────────────────────────────────────────────

// Select top `numElite` agents; fill the rest with mutated copies of elites.
function evolveAgents (agents, numElite, mutationRate) {
  const sorted = agents.slice().sort(function (a, b) { return b.fitness - a.fitness })
  const nextGen = []
  for (let i = 0; i < numElite && i < sorted.length; i++) {
    const elite = sorted[i].clone()
    elite.fitness = 0
    nextGen.push(elite)
  }
  while (nextGen.length < agents.length) {
    const parent = sorted[nextGen.length % numElite]
    const child  = parent.clone()
    child.mutate(mutationRate)
    child.fitness     = 0
    child.gamesPlayed = 0
    child.generation  = parent.generation + 1
    nextGen.push(child)
  }
  return nextGen
}

// ── Persistence ───────────────────────────────────────────────────────────────

function saveBestAgent (agent) {
  try { localStorage.setItem(STORAGE_KEY_BEST, JSON.stringify(agent.toJSON())) } catch (_) {}
}

function savePopulation (agents) {
  try {
    localStorage.setItem(STORAGE_KEY_POP, JSON.stringify(agents.map(function (a) { return a.toJSON() })))
  } catch (_) {}
}

function loadBestAgent () {
  if (!getTF()) return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BEST)
    if (!raw) return null
    return NeuralAgent.fromJSON(JSON.parse(raw))
  } catch (_) { return null }
}

function loadPopulation () {
  if (!getTF()) return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY_POP)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return null
    return data.map(function (d) { return NeuralAgent.fromJSON(d) })
  } catch (_) { return null }
}

// ── Cached agent for main game ────────────────────────────────────────────────
// Lazily loads the best trained agent; reloads if a newer generation is saved.

let _cachedAgent = null
let _cachedGeneration = -1

function getActiveNeuralAgent () {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BEST)
    if (!raw) return null
    const data = JSON.parse(raw)
    const gen  = data.generation || 0
    if (!_cachedAgent || gen > _cachedGeneration) {
      if (_cachedAgent) { try { _cachedAgent.dispose() } catch (_) {} }
      _cachedAgent     = NeuralAgent.fromJSON(data)
      _cachedGeneration = gen
    }
  } catch (_) {
    return null
  }
  return _cachedAgent
}

export {
  NeuralAgent,
  getTF,
  STATE_DIM,
  ACTION_DIM,
  STORAGE_KEY_BEST,
  selectActionPure,
  encodeState,
  executeActionRL,
  getUnmovedUnits,
  createHeadlessState,
  checkWinConditionHeadless,
  runSelfPlayGame,
  runSelfPlayGameWeights,
  runNeuralAgentTurn,
  getActiveNeuralAgent,
  evolveAgents,
  saveBestAgent,
  savePopulation,
  loadBestAgent,
  loadPopulation
}
