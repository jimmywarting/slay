import { getValidMoves, executeMove, PEASANT_COST, TOWER_COST } from './movement.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import {
  TERRAIN_LAND,
  TERRAIN_WATER,
  TERRAIN_TREE,
  TERRAIN_PALM,
  STRUCTURE_HUT,
  STRUCTURE_TOWER,
  STRUCTURE_GRAVESTONE
} from './constants.js'
import { hexNeighborKeys } from './hex.js'
import { generateHexMap, placeStartingTerritories } from './map.js'
import { startTurn, endTurn } from './turn-system.js'
import { UNIT_DEFS } from './units.js'

const STATE_FEATURES = 24
const MOVE_FEATURES = 12

const IN = STATE_FEATURES + MOVE_FEATURES
const H1 = 64
const H2 = 32
const OUT = 1

const W1_OFF = 0
const B1_OFF = IN * H1
const W2_OFF = B1_OFF + H1
const B2_OFF = W2_OFF + H1 * H2
const W3_OFF = B2_OFF + H2
const B3_OFF = W3_OFF + H2 * OUT

const TOTAL_WEIGHTS = B3_OFF + OUT

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function safeRatio(numerator, denominator, fallback) {
  if (!denominator) return fallback
  return numerator / denominator
}

function hexDistance(a, b) {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2
}

function evaluatePlayerSummary(state, playerId) {
  let land = 0
  let units = 0
  let towers = 0
  let trees = 0
  let huts = 0
  let unitsL1 = 0
  let unitsL2 = 0
  let unitsL3 = 0
  let unitsL4 = 0
  let borderEnemy = 0
  let borderNeutral = 0

  for (const key in state.hexes) {
    const h = state.hexes[key]
    if (!h || h.owner !== playerId) continue
    land++

    if (h.structure === STRUCTURE_TOWER) towers++
    if (h.structure === STRUCTURE_HUT) huts++
    if (h.terrain === TERRAIN_TREE || h.terrain === TERRAIN_PALM) trees++

    if (h.unit) {
      units++
      if (h.unit.level === 1) unitsL1++
      else if (h.unit.level === 2) unitsL2++
      else if (h.unit.level === 3) unitsL3++
      else unitsL4++
    }

    const nbrs = hexNeighborKeys(h.q, h.r)
    for (let i = 0; i < nbrs.length; i++) {
      const nh = state.hexes[nbrs[i]]
      if (!nh || nh.terrain === TERRAIN_WATER || nh.owner === playerId) continue
      if (nh.owner !== null && nh.owner < state.numActivePlayers) borderEnemy++
      else borderNeutral++
    }
  }

  let territories = 0
  let bank = 0
  let income = 0
  let upkeep = 0
  for (let i = 0; i < state.territories.length; i++) {
    const t = state.territories[i]
    if (t.owner !== playerId) continue
    territories++
    bank += t.bank
    income += computeIncome(state, t)
    upkeep += computeUpkeep(state, t)
  }

  return {
    land,
    units,
    towers,
    trees,
    huts,
    unitsL1,
    unitsL2,
    unitsL3,
    unitsL4,
    borderEnemy,
    borderNeutral,
    territories,
    bank,
    income,
    upkeep,
    net: income - upkeep
  }
}

function writePlayerFeatures(features, startIndex, summary) {
  let idx = startIndex
  features[idx++] = clamp(summary.land / 120, 0, 1)
  features[idx++] = clamp(summary.territories / 12, 0, 1)
  features[idx++] = clamp(summary.units / 30, 0, 1)
  features[idx++] = clamp(summary.towers / 10, 0, 1)
  features[idx++] = clamp(summary.huts / 8, 0, 1)
  features[idx++] = clamp(summary.trees / 30, 0, 1)
  features[idx++] = clamp(summary.bank / 200, 0, 1)
  features[idx++] = clamp(summary.net / 30, -1, 1)
  features[idx++] = clamp(summary.unitsL1 / 20, 0, 1)
  features[idx++] = clamp(summary.unitsL2 / 12, 0, 1)
  features[idx++] = clamp(summary.unitsL3 / 8, 0, 1)
  features[idx++] = clamp(summary.unitsL4 / 6, 0, 1)
  features[idx++] = clamp(summary.borderEnemy / 120, 0, 1)
  features[idx++] = clamp(summary.borderNeutral / 120, 0, 1)
  return idx
}

function encodeStateFeatures(state, playerId) {
  const features = new Float32Array(STATE_FEATURES)
  const me = evaluatePlayerSummary(state, playerId)
  const opp = evaluatePlayerSummary(state, 1 - playerId)

  let idx = 0
  idx = writePlayerFeatures(features, idx, me)
  idx = writePlayerFeatures(features, idx, opp)

  const totalLand = me.land + opp.land
  features[idx++] = clamp(state.turn / 300, 0, 1)
  features[idx++] = clamp(safeRatio(me.land, totalLand, 0.5), 0, 1)
  features[idx++] = clamp(safeRatio(me.units, me.land, 0), 0, 1)
  features[idx++] = clamp(safeRatio(opp.units, opp.land, 0), 0, 1)
  features[idx++] = clamp(safeRatio(me.borderEnemy, me.land, 0), 0, 1)
  features[idx++] = 1

  return features
}

function nearestEnemyHutDistance(state, fromHex, playerId) {
  let minDist = Infinity
  for (const key in state.hexes) {
    const h = state.hexes[key]
    if (!h || h.owner === playerId || h.structure !== STRUCTURE_HUT) continue
    const d = hexDistance(fromHex, h)
    if (d < minDist) minDist = d
  }
  return Number.isFinite(minDist) ? minDist : 20
}

function encodeMoveFeatures(state, playerId, fromKey, toKey, freeSet) {
  const features = new Float32Array(MOVE_FEATURES)
  const fromHex = state.hexes[fromKey]
  const toHex = state.hexes[toKey]
  if (!fromHex || !toHex || !fromHex.unit) return features

  const isOwn = toHex.owner === playerId
  const isEnemy = toHex.owner !== null && toHex.owner !== playerId && toHex.owner < state.numActivePlayers
  const isNeutral = !isOwn && !isEnemy
  const isMerge = isOwn && !!toHex.unit

  let enemyAdj = 0
  let friendlyAdj = 0
  const nbrs = hexNeighborKeys(toHex.q, toHex.r)
  for (let i = 0; i < nbrs.length; i++) {
    const nh = state.hexes[nbrs[i]]
    if (!nh || nh.terrain === TERRAIN_WATER) continue
    if (nh.owner === playerId) friendlyAdj++
    else if (nh.owner !== null && nh.owner < state.numActivePlayers) enemyAdj++
  }

  const distanceToEnemyHut = nearestEnemyHutDistance(state, toHex, playerId)

  features[0] = clamp(fromHex.unit.level / 4, 0, 1)
  features[1] = toHex.unit ? clamp(toHex.unit.level / 4, 0, 1) : 0
  features[2] = isEnemy ? 1 : 0
  features[3] = isNeutral ? 1 : 0
  features[4] = isOwn ? 1 : 0
  features[5] = isMerge ? 1 : 0
  features[6] = toHex.structure === STRUCTURE_HUT ? 1 : 0
  features[7] = toHex.structure === STRUCTURE_TOWER ? 1 : 0
  features[8] = (toHex.terrain === TERRAIN_TREE || toHex.terrain === TERRAIN_PALM) ? 1 : 0
  features[9] = toHex.structure === STRUCTURE_GRAVESTONE ? 1 : 0
  features[10] = clamp(enemyAdj / 6, 0, 1)
  features[11] = clamp(1 - distanceToEnemyHut / 20, 0, 1)

  if (freeSet[toKey]) {
    features[10] = clamp(features[10] + 0.1, 0, 1)
  }

  return features
}

function forwardPass(weights, stateFeatures, moveFeatures) {
  const input = new Float32Array(IN)
  for (let i = 0; i < STATE_FEATURES; i++) input[i] = stateFeatures[i]
  for (let i = 0; i < MOVE_FEATURES; i++) input[STATE_FEATURES + i] = moveFeatures[i]

  const h1 = new Float32Array(H1)
  for (let j = 0; j < H1; j++) {
    let sum = weights[B1_OFF + j]
    for (let i = 0; i < IN; i++) {
      sum += weights[W1_OFF + i * H1 + j] * input[i]
    }
    h1[j] = sum > 0 ? sum : 0
  }

  const h2 = new Float32Array(H2)
  for (let j = 0; j < H2; j++) {
    let sum = weights[B2_OFF + j]
    for (let i = 0; i < H1; i++) {
      sum += weights[W2_OFF + i * H2 + j] * h1[i]
    }
    h2[j] = sum > 0 ? sum : 0
  }

  let out = weights[B3_OFF]
  for (let i = 0; i < H2; i++) out += weights[W3_OFF + i] * h2[i]
  return out
}

function chooseMove(candidates, explorationRate) {
  if (candidates.length === 0) return null

  if (explorationRate > 0 && Math.random() < explorationRate) {
    const maxPool = Math.min(4, candidates.length)
    return candidates[(Math.random() * maxPool) | 0]
  }

  return candidates[0]
}

function runNeuralAgentTurn(state, agent, options) {
  const weights = agent.weights
  const playerId = state.activePlayer
  const explorationRate = options && typeof options.explorationRate === 'number'
    ? clamp(options.explorationRate, 0, 0.5)
    : 0

  const MAX_ITERS = 80
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const stateFeatures = encodeStateFeatures(state, playerId)
    const candidates = []

    for (const fromKey in state.hexes) {
      const fromHex = state.hexes[fromKey]
      if (!fromHex || !fromHex.unit || fromHex.owner !== playerId || fromHex.unit.moved) continue

      const vm = getValidMoves(state, fromKey)
      for (let i = 0; i < vm.moves.length; i++) {
        const toKey = vm.moves[i]
        const toHex = state.hexes[toKey]

        const isMerge = toHex && toHex.owner === playerId && !!toHex.unit
        if (isMerge) {
          const resultLevel = fromHex.unit.level + toHex.unit.level
          if (resultLevel > 4) continue
          if (!isMergeEconomicallySafe(state, fromKey, toKey, resultLevel)) continue
        }

        const moveFeatures = encodeMoveFeatures(state, playerId, fromKey, toKey, vm.freeSet)
        let score = forwardPass(weights, stateFeatures, moveFeatures)

        if (toHex && toHex.owner === playerId &&
            (toHex.terrain === TERRAIN_TREE || toHex.terrain === TERRAIN_PALM)) {
          const treeAge = toHex.treeAge || 0
          score += 0.75 + treeAge * 0.15
        }

        candidates.push({ fromKey, toKey, score })
      }
    }

    if (candidates.length === 0) break
    candidates.sort(function (a, b) { return b.score - a.score })

    const selected = chooseMove(candidates, explorationRate)
    if (!selected || selected.score < -1.5) break
    executeMove(state, selected.fromKey, selected.toKey)
  }

  neuralBuyUnits(state, playerId)
  neuralBuildTowers(state, playerId)
}

function neuralBuyUnits(state, playerId) {
  let bought = true
  while (bought) {
    bought = false
    for (let i = 0; i < state.territories.length; i++) {
      const territory = state.territories[i]
      if (territory.owner !== playerId || territory.bank < PEASANT_COST) continue

      const income = computeIncome(state, territory)
      const upkeep = computeUpkeep(state, territory)
      const netAfterBuy = income - (upkeep + 2)
      const bankAfterBuy = territory.bank - PEASANT_COST
      const pressure = countTerritoryTreePressure(state, territory)

      if (netAfterBuy < -2 && bankAfterBuy < Math.abs(netAfterBuy) * 4) continue
      if (pressure === 0 && netAfterBuy <= 0 && bankAfterBuy < PEASANT_COST * 2) continue

      const placement = findFrontierPlacement(state, territory, playerId)
      if (!placement) continue

      state.hexes[placement].unit = { level: 1, moved: false }
      territory.bank -= PEASANT_COST
      bought = true
      break
    }
  }
}

function neuralBuildTowers(state, playerId) {
  for (let i = 0; i < state.territories.length; i++) {
    const territory = state.territories[i]
    if (territory.owner !== playerId || territory.bank < TOWER_COST) continue
    if (computeIncome(state, territory) - computeUpkeep(state, territory) < 2) continue

    let bestKey = null
    let bestEnemyAdj = 0

    for (let j = 0; j < territory.hexKeys.length; j++) {
      const key = territory.hexKeys[j]
      const hex = state.hexes[key]
      if (!hex || hex.terrain !== TERRAIN_LAND || hex.unit || hex.structure) continue

      const nbrs = hexNeighborKeys(hex.q, hex.r)
      let enemyAdj = 0
      for (let k = 0; k < nbrs.length; k++) {
        const nh = state.hexes[nbrs[k]]
        if (nh && nh.owner !== playerId && nh.owner !== null && nh.owner < state.numActivePlayers) {
          enemyAdj++
        }
      }

      if (enemyAdj > bestEnemyAdj) {
        bestEnemyAdj = enemyAdj
        bestKey = key
      }
    }

    if (bestKey && bestEnemyAdj > 0) {
      state.hexes[bestKey].structure = STRUCTURE_TOWER
      territory.bank -= TOWER_COST
    }
  }
}

function findFrontierPlacement(state, territory, playerId) {
  let bestKey = null
  let bestScore = -Infinity

  for (let i = 0; i < territory.hexKeys.length; i++) {
    const key = territory.hexKeys[i]
    const hex = state.hexes[key]
    if (!hex || hex.unit) continue

    const isTree = hex.terrain === TERRAIN_TREE || hex.terrain === TERRAIN_PALM
    const isLand = hex.terrain === TERRAIN_LAND &&
      (!hex.structure || hex.structure === STRUCTURE_GRAVESTONE)
    if (!isTree && !isLand) continue

    const nbrs = hexNeighborKeys(hex.q, hex.r)
    let borderScore = 0
    let ownTreeNbrs = 0

    for (let j = 0; j < nbrs.length; j++) {
      const nh = state.hexes[nbrs[j]]
      if (!nh || nh.terrain === TERRAIN_WATER) continue
      if (nh.owner !== playerId) {
        borderScore += (nh.owner !== null && nh.owner < state.numActivePlayers) ? 2 : 1
      } else if (nh.terrain === TERRAIN_TREE || nh.terrain === TERRAIN_PALM) {
        ownTreeNbrs++
      }
    }

    const treeAge = isTree ? (hex.treeAge || 0) : 0
    const clearingBonus = isTree ? 6 + treeAge * 2 : (hex.structure === STRUCTURE_GRAVESTONE ? 2 : 0)
    const score = borderScore * 2 + ownTreeNbrs + clearingBonus

    if (score > bestScore) {
      bestScore = score
      bestKey = key
    }
  }

  return bestKey
}

function isMergeEconomicallySafe(state, fromKey, toKey, resultLevel) {
  const territory = getTerritoryForHex(state, toKey)
  if (!territory) return true

  const fromHex = state.hexes[fromKey]
  const toHex = state.hexes[toKey]
  if (!fromHex || !toHex || !fromHex.unit || !toHex.unit) return true

  const income = computeIncome(state, territory)
  const upkeep = computeUpkeep(state, territory)
  const deltaUpkeep = UNIT_DEFS[resultLevel].upkeep -
    UNIT_DEFS[fromHex.unit.level].upkeep -
    UNIT_DEFS[toHex.unit.level].upkeep

  const netAfterMerge = income - (upkeep + deltaUpkeep)
  if (netAfterMerge >= 0) return true
  return territory.bank >= Math.abs(netAfterMerge) * 3
}

function countTerritoryTreePressure(state, territory) {
  let pressure = 0
  for (let i = 0; i < territory.hexKeys.length; i++) {
    const hex = state.hexes[territory.hexKeys[i]]
    if (!hex) continue
    if (hex.terrain !== TERRAIN_TREE && hex.terrain !== TERRAIN_PALM) continue
    pressure += 1 + (hex.treeAge || 0)
  }
  return pressure
}

function runSelfPlayGameWeights(weights1, weights2) {
  const NUM_ACTIVE = 2
  const NUM_TOTAL = 6
  const NAMES = ['A', 'B', 'C', 'D', 'E', 'F']
  const COLORS = ['#000', '#111', '#222', '#333', '#444', '#555']

  const hexes = generateHexMap()
  const territories = placeStartingTerritories(hexes, NUM_ACTIVE)

  const state = {
    players: NAMES.slice(0, NUM_TOTAL).map(function (name, id) {
      return { id, name, color: COLORS[id] }
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

  const agents = [{ weights: weights1 }, { weights: weights2 }]
  const MAX_TURNS = 220

  while (!state.gameOver && state.turn < MAX_TURNS) {
    const p = state.activePlayer
    if (p < NUM_ACTIVE) {
      const explorationRate = 0.1 * Math.max(0, 1 - state.turn / 180)
      runNeuralAgentTurn(state, agents[p], { explorationRate })
    }
    endTurn(state)
    checkWinLocal(state)
  }

  const scoreA = evaluateFinalScore(state, 0)
  const scoreB = evaluateFinalScore(state, 1)
  return {
    fitness1: scoreA,
    fitness2: scoreB,
    winner: state.winner
  }
}

function evaluateFinalScore(state, playerId) {
  let land = 0
  let units = 0
  let towers = 0
  let bank = 0

  for (const key in state.hexes) {
    const h = state.hexes[key]
    if (!h || h.terrain === TERRAIN_WATER || h.owner !== playerId) continue
    land++
    if (h.unit) units += h.unit.level
    if (h.structure === STRUCTURE_TOWER) towers++
  }

  for (let i = 0; i < state.territories.length; i++) {
    const t = state.territories[i]
    if (t.owner === playerId) bank += t.bank
  }

  const totalLand = Object.keys(state.hexes).reduce(function (sum, key) {
    const h = state.hexes[key]
    return h && h.terrain !== TERRAIN_WATER ? sum + 1 : sum
  }, 0)
  const landShare = safeRatio(land, Math.max(1, totalLand), 0)

  let score = landShare * 100
  score += units * 1.2
  score += towers * 2.5
  score += Math.min(20, bank * 0.3)
  if (state.winner === playerId) score += 60
  return score
}

function checkWinLocal(state) {
  if (state.gameOver) return

  const hasHut = {}
  for (const key in state.hexes) {
    const h = state.hexes[key]
    if (h && h.structure === STRUCTURE_HUT && h.owner !== null) {
      hasHut[h.owner] = true
    }
  }

  const active = Object.keys(hasHut).map(Number)
  if (active.length <= 1) {
    state.gameOver = true
    state.winner = active.length === 1 ? active[0] : null
  }
}

function createRandomWeights() {
  const w = new Float32Array(TOTAL_WEIGHTS)
  const scaleIn = Math.sqrt(2 / IN)
  const scaleH1 = Math.sqrt(2 / H1)
  const scaleH2 = Math.sqrt(2 / H2)

  for (let i = 0; i < TOTAL_WEIGHTS; i++) {
    const scale = i < B1_OFF ? scaleIn : i < W2_OFF ? 0 : i < B2_OFF ? scaleH1 : i < W3_OFF ? 0 : i < B3_OFF ? scaleH2 : 0
    w[i] = scale === 0 ? 0 : (Math.random() * 2 - 1) * scale
  }

  return w
}

export {
  IN,
  H1,
  H2,
  OUT,
  TOTAL_WEIGHTS,
  createRandomWeights,
  runNeuralAgentTurn,
  runSelfPlayGameWeights
}