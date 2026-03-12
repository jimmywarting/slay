// AI opponent using the self-trained neural agent (from web-worker training).
// Falls back to a greedy heuristic when no trained model is available yet.

import { getValidMoves, executeMove, PEASANT_COST, TOWER_COST } from './movement.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { UNIT_DEFS } from './units.js'
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
import { getActiveNeuralAgent } from './agent-store.js'
import { runNeuralAgentTurn } from './ai-rl.js'

// ── Public API ────────────────────────────────────────────────────────────────

// Returns true if the given player index is AI-controlled in this game state.
function isAIPlayer(state, playerId) {
  return !!(state.aiPlayers && state.aiPlayers.indexOf(playerId) !== -1)
}

// Run a full AI turn: think, execute actions.
// The caller is responsible for calling endTurn() afterwards.
async function runAITurn(state) {
  // 1. Prefer the trained neural agent (loaded from localStorage)
  const neuralAgent = getActiveNeuralAgent()
  if (neuralAgent) {
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
      state.players[state.activePlayer].name + ' [RL gen ' + neuralAgent.generation + ']')
    runNeuralAgentTurn(state, neuralAgent)
    return
  }

  // 2. Greedy heuristic fallback (used until a model has been trained)
  runGreedyTurn(state)
}

// Append an entry to the shared action log (capped at 60 entries).
function appendToLog(state, entry) {
  if (!state.actionLog) state.actionLog = []
  state.actionLog.push(entry)
  if (state.actionLog.length > 60) state.actionLog.shift()
}

// ── Greedy fallback ───────────────────────────────────────────────────────────
// A multi-phase strategy: buy units at the frontier, then execute the globally
// best available move each step (captures > merges > expansions > repositions),
// and finally build towers on contested borders with spare gold.

// Minimum move score to act (prevents pointless low-value repositions)
const MIN_MOVE_SCORE = 5
// Maximum unit level (Baron = 4)
const MAX_UNIT_LEVEL = 4

function runGreedyTurn(state) {
  const player = state.activePlayer
  greedyBuyUnits(state, player)
  greedyMoveUnits(state, player)
  greedyBuildTowers(state, player)
}

// ── Buy phase ─────────────────────────────────────────────────────────────────

function greedyBuyUnits(state, player) {
  // Keep buying as long as affordable and won't immediately bankrupt the territory.
  // Iterate repeatedly so multiple units can be bought per turn.
  let bought = true
  while (bought) {
    bought = false
    for (let ti = 0; ti < state.territories.length; ti++) {
      const t = state.territories[ti]
      if (t.owner !== player || t.bank < PEASANT_COST) continue

      const income = computeIncome(state, t)
      const upkeep = computeUpkeep(state, t)
      const netAfterBuy = income - (upkeep + 2) // 2 = peasant upkeep per turn
      const bankAfterBuy = t.bank - PEASANT_COST
      const treePressure = countTerritoryTreePressure(state, t)

      // Buy if: net income stays non-negative after the purchase,
      // OR the saved gold covers at least 4 turns of the resulting deficit,
      // but only when the territory is not already running a deficit.
      const isCurrentlyProfitable = income - upkeep >= 0
      const sustainable = netAfterBuy >= 0
      const deficit = Math.abs(Math.min(0, netAfterBuy))
      const hasRunway = isCurrentlyProfitable && bankAfterBuy >= deficit * 4
      if (!sustainable && !hasRunway) continue

      // In healthy territories, avoid overbuying peasants if there is no immediate
      // border pressure and no tree pressure to clean up.
      if (treePressure === 0 && netAfterBuy <= 1 && bankAfterBuy < PEASANT_COST * 2) continue

      // Place the unit on the frontier hex closest to enemy/neutral territory.
      const placeKey = findFrontierPlacement(state, t, player)
      if (!placeKey) continue

      state.hexes[placeKey].unit = { level: 1, moved: false }
      t.bank -= PEASANT_COST
      appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
        state.players[player].name + ' bought a Peasant at ' + placeKey)
      bought = true
      break // restart outer loop — income/upkeep changed
    }
  }
}

// Find the best empty land hex in a territory for placing a new unit.
// Prefers hexes that are on or near the border (adjacent to non-owned hexes).
function findFrontierPlacement(state, territory, player) {
  let bestKey = null
  let bestScore = -Infinity

  for (let i = 0; i < territory.hexKeys.length; i++) {
    const k = territory.hexKeys[i]
    const h = state.hexes[k]
    if (!h || h.unit) continue
    const isTree = h.terrain === TERRAIN_TREE || h.terrain === TERRAIN_PALM
    const isLandPlacable = h.terrain === TERRAIN_LAND &&
      (!h.structure || h.structure === STRUCTURE_GRAVESTONE)
    if (!isTree && !isLandPlacable) continue

    // Count how many adjacent hexes are non-owned (border neighbours).
    const nbrs = hexNeighborKeys(h.q, h.r)
    let borderScore = 0
    let ownTreeNbrs = 0
    for (let j = 0; j < nbrs.length; j++) {
      const nh = state.hexes[nbrs[j]]
      if (!nh || nh.terrain === TERRAIN_WATER) continue
      if (nh.owner !== player) {
        // Active enemy counts double (more urgent frontier)
        borderScore += (nh.owner !== null && nh.owner < state.numActivePlayers) ? 2 : 1
      } else if (nh.terrain === TERRAIN_TREE || nh.terrain === TERRAIN_PALM) {
        ownTreeNbrs++
      }
    }

    const treeAge = isTree ? (h.treeAge || 0) : 0
    const clearingBonus = isTree ? 25 + treeAge * 5 : (h.structure === STRUCTURE_GRAVESTONE ? 2 : 0)
    const score = borderScore * 2 + ownTreeNbrs + clearingBonus

    if (score > bestScore) {
      bestScore = score
      bestKey = k
    }
  }
  return bestKey
}

// ── Move phase ────────────────────────────────────────────────────────────────

// On each iteration pick the globally highest-scored move and execute it.
// Repeat until no move scores above the minimum threshold.
function greedyMoveUnits(state, player) {
  const MAX_ITERS = 80 // safety cap
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let bestScore = MIN_MOVE_SCORE
    let bestFrom = null
    let bestTo = null

    for (const fromKey in state.hexes) {
      const fromHex = state.hexes[fromKey]
      if (!fromHex.unit || fromHex.owner !== player || fromHex.unit.moved) continue

      const vm = getValidMoves(state, fromKey)
      for (let mi = 0; mi < vm.moves.length; mi++) {
        const toKey = vm.moves[mi]
        const score = scoreMoveGreedy(state, fromKey, toKey, vm, player)
        if (score > bestScore) {
          bestScore = score
          bestFrom = fromKey
          bestTo = toKey
        }
      }
    }

    if (!bestFrom) break // no useful move found
    // Capture the pre-move destination state to determine action type for logging
    const preToHex = state.hexes[bestTo]
    const wasMerge = preToHex && preToHex.owner === player && !!preToHex.unit
    const wasCapture = preToHex && preToHex.owner !== player
    executeMove(state, bestFrom, bestTo)
    const destHex = state.hexes[bestTo]
    const unitLevel = destHex && destHex.unit ? destHex.unit.level : 1
    const action = wasCapture ? 'captured' : wasMerge ? 'merged →' : 'repositioned'
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
      state.players[player].name + ' ' + action + ' ' +
      UNIT_DEFS[unitLevel].name + ' → ' + bestTo)
  }
}

// Assign a numeric desirability score to a candidate move.
// Higher score = more desirable. Captures are always preferred over repositions.
function scoreMoveGreedy(state, fromKey, toKey, vm, player) {
  const fromHex = state.hexes[fromKey]
  const toHex = state.hexes[toKey]
  if (!fromHex || !toHex || !fromHex.unit) return 0

  const attackerLevel = fromHex.unit.level
  const isOwnHex = toHex.owner === player
  const isActiveEnemy = toHex.owner !== null && toHex.owner !== player &&
                        toHex.owner < state.numActivePlayers
  const isNeutral = !isActiveEnemy && toHex.owner !== player
  const isFree = !!vm.freeSet[toKey]
  const isMerge = isOwnHex && !!toHex.unit
  const isOwnTree = isOwnHex && (toHex.terrain === TERRAIN_TREE || toHex.terrain === TERRAIN_PALM)
  const isOwnGravestone = isOwnHex && toHex.structure === STRUCTURE_GRAVESTONE

  // ── Capture enemy hut → splits + often bankrupts their territory ──
  if (isActiveEnemy && toHex.structure === STRUCTURE_HUT) {
    const enemyTerr = getTerritoryForHex(state, toKey)
    return 10000 + (enemyTerr ? enemyTerr.hexKeys.length * 5 : 0)
  }

  // ── Take enemy's last hex (eliminates them) ──
  if (isActiveEnemy) {
    const enemyTerr = getTerritoryForHex(state, toKey)
    if (enemyTerr && enemyTerr.hexKeys.length === 1) return 9500
  }

  // ── Capture enemy hex adjacent to their hut (isolate HQ) ──
  if (isActiveEnemy) {
    const enemyTerr = getTerritoryForHex(state, toKey)
    const hutKey = enemyTerr ? enemyTerr.hutHexKey : null
    if (hutKey) {
      const hutHex = state.hexes[hutKey]
      const dist = hutHex ? hexDist(toHex.q, toHex.r, hutHex.q, hutHex.r) : 5
      return 2000 + Math.max(0, 5 - dist) * 200
    }
    return 600
  }

  // ── Capture neutral hut (gains a new income-producing territory) ──
  if (isNeutral && toHex.structure === STRUCTURE_HUT) return 1500

  // ── Capture neutral hex (expand land = more income) ──
  if (isNeutral) return 300

  // ── Merge two units → creates a stronger attacker ──
  if (isMerge) {
    const resultLevel = attackerLevel + toHex.unit.level
    if (resultLevel > MAX_UNIT_LEVEL) return 0
    if (!isMergeEconomicallySafe(state, fromKey, toKey, resultLevel)) return 0
    // Extra value when the merged unit can break a defended position
    return 400 + resultLevel * 120
  }

  // ── Clear own tree/palm: preserve future income and stop spread pressure ──
  if (isOwnTree) {
    const treeAge = toHex.treeAge || 0
    let localThreat = 0
    const nbrs = hexNeighborKeys(toHex.q, toHex.r)
    for (let i = 0; i < nbrs.length; i++) {
      const nh = state.hexes[nbrs[i]]
      if (!nh || nh.owner !== player) continue
      if (nh.terrain === TERRAIN_TREE || nh.terrain === TERRAIN_PALM) localThreat++
    }
    return 200 + treeAge * 20 + localThreat * 15
  }

  // ── Clear own gravestone to recover buildable space ──
  if (isOwnGravestone) return 60

  // ── Free reposition: only worthwhile if it moves toward the frontier ──
  if (isFree) {
    const distBefore = distToNearestTarget(state, fromHex.q, fromHex.r, player)
    const distAfter = distToNearestTarget(state, toHex.q, toHex.r, player)
    const improvement = distBefore - distAfter
    if (improvement > 0) return 15 + improvement * 10
    return 0 // don't reposition away from frontier
  }

  return 0
}

// ── Tower-build phase ─────────────────────────────────────────────────────────

function greedyBuildTowers(state, player) {
  for (let ti = 0; ti < state.territories.length; ti++) {
    const t = state.territories[ti]
    if (t.owner !== player || t.bank < TOWER_COST) continue

    const income = computeIncome(state, t)
    const upkeep = computeUpkeep(state, t)
    // Only build towers when we have healthy income and enough surplus gold
    if (income - upkeep < 2) continue
    if (t.bank < TOWER_COST + 5) continue

    // Find a border hex that would benefit most from a tower
    let bestKey = null
    let bestBorderCount = 0

    for (let i = 0; i < t.hexKeys.length; i++) {
      const k = t.hexKeys[i]
      const h = state.hexes[k]
      if (!h || h.terrain !== TERRAIN_LAND || h.unit || h.structure) continue

      // Count enemy-owned adjacent hexes (tower is most useful here)
      const nbrs = hexNeighborKeys(h.q, h.r)
      let enemyNbrs = 0
      for (let j = 0; j < nbrs.length; j++) {
        const nh = state.hexes[nbrs[j]]
        if (nh && nh.owner !== player && nh.owner !== null &&
            nh.owner < state.numActivePlayers) {
          enemyNbrs++
        }
      }
      if (enemyNbrs > bestBorderCount) {
        bestBorderCount = enemyNbrs
        bestKey = k
      }
    }

    if (bestKey && bestBorderCount > 0) {
      state.hexes[bestKey].structure = STRUCTURE_TOWER
      t.bank -= TOWER_COST
      appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
        state.players[player].name + ' built a Tower at ' + bestKey)
    }
  }
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

// Axial hex distance
function hexDist(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2
}

// Distance from (q, r) to the nearest enemy-owned or neutral (non-water) hex.
function distToNearestTarget(state, q, r, player) {
  let minDist = Infinity
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (!h || h.terrain === TERRAIN_WATER || h.owner === player) continue
    const d = hexDist(q, r, h.q, h.r)
    if (d < minDist) minDist = d
  }
  return minDist
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

  // Never merge to create a more expensive unit when already running a deficit.
  const isCurrentlyProfitable = income - upkeep >= 0
  if (!isCurrentlyProfitable) return false

  const deficit = Math.abs(netAfterMerge)
  return territory.bank >= deficit * 5
}

function countTerritoryTreePressure(state, territory) {
  let pressure = 0
  for (let i = 0; i < territory.hexKeys.length; i++) {
    const h = state.hexes[territory.hexKeys[i]]
    if (!h) continue
    if (h.terrain !== TERRAIN_TREE && h.terrain !== TERRAIN_PALM) continue
    pressure += 1 + (h.treeAge || 0)
  }
  return pressure
}

export { isAIPlayer, runAITurn, appendToLog }
