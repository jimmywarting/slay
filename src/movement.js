// Movement: valid move computation, move execution, buy unit, build tower

import { hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_TREE, TERRAIN_PALM, TERRAIN_LAND, STRUCTURE_HUT, STRUCTURE_TOWER, STRUCTURE_GRAVESTONE } from './constants.js'
import { recomputeTerritories, getTerritoryForHex } from './territory.js'
import { canMergeUnits, mergedLevel } from './units.js'
import { canCapture } from './combat.js'

const TOWER_COST = 10
const PEASANT_COST = 5

// BFS through own territory to find all reachable destinations.
// Returns { moves: [keys], freeSet: {key: true} }
//   moves   — all valid destination keys (free repositions + actions)
//   freeSet — subset of moves that are free repositions (no move cost)
//
// Free repositions (unit.moved stays false):
//   own empty land hex (terrain=land, gravestone OK)
//   own units, huts and towers are passable for BFS transit but not valid landing hexes
//
// Action moves (unit.moved becomes true):
//   own hex with tree/palm      → clears it
//   own hex with a friendly unit → merges (if levels allow)
//   enemy/neutral hex            → capture (requires attacker > defender strength)
function getValidMoves(state, unitHexKey) {
  const fromHex = state.hexes[unitHexKey]
  if (!fromHex || !fromHex.unit || fromHex.unit.moved) return { moves: [], freeSet: {} }

  const unit = fromHex.unit
  const player = fromHex.owner

  const visited = {}   // BFS transit nodes (passable own land)
  const validSet = {}  // all destinations
  const freeSet  = {}  // free-reposition subset of validSet

  visited[unitHexKey] = true
  const queue = [unitHexKey]

  while (queue.length > 0) {
    const current = queue.shift()
    const currentHex = state.hexes[current]

    const nbrs = hexNeighborKeys(currentHex.q, currentHex.r)
    for (let i = 0; i < nbrs.length; i++) {
      const nk = nbrs[i]
      const nh = state.hexes[nk]
      if (!nh || nh.terrain === TERRAIN_WATER) continue

      if (nh.owner === player) {
        if (nh.unit) {
          // Own unit hex: passable for BFS transit; also a merge target if levels allow
          if (canMergeUnits(unit.level, nh.unit.level)) {
            validSet[nk] = true
          }
          if (!visited[nk]) {
            visited[nk] = true
            queue.push(nk)
          }
        } else if (nh.structure === STRUCTURE_HUT || nh.structure === STRUCTURE_TOWER) {
          // Huts and towers: passable for BFS transit but not a valid landing hex
          if (!visited[nk]) {
            visited[nk] = true
            queue.push(nk)
          }
        } else if (nh.terrain === TERRAIN_TREE || nh.terrain === TERRAIN_PALM) {
          // Tree/palm: can clear it (action), but cannot pass through
          validSet[nk] = true
        } else {
          // Empty passable own land (terrain=land, or gravestone on land):
          // free reposition — and BFS continues from here
          validSet[nk] = true
          freeSet[nk] = true
          if (!visited[nk]) {
            visited[nk] = true
            queue.push(nk)
          }
        }
      } else {
        // Enemy or neutral: capture if attacker is stronger than defender (action)
        if (canCapture(state, unit.level, nk)) {
          validSet[nk] = true
        }
      }
    }
  }

  // The starting hex is never a valid destination
  delete validSet[unitHexKey]
  delete freeSet[unitHexKey]

  return { moves: Object.keys(validSet), freeSet: freeSet }
}

// Execute a unit move from fromKey to toKey (assumed valid).
// Returns true if the resulting unit can still move (unit.moved is false),
// false if the move consumed the turn (unit.moved is true).
// Free repositions and merges of two unmoved units both return true.
function executeMove(state, fromKey, toKey) {
  const fromHex = state.hexes[fromKey]
  const toHex = state.hexes[toKey]
  const unit = fromHex.unit
  const player = fromHex.owner
  let isFree = false
  const isCapture = toHex.owner !== player  // save before mutating toHex

  if (!isCapture) {
    if (toHex.unit) {
      // Merge — the merged unit inherits the "has moved" state of both sources.
      // If either source has already moved this turn, the result is also moved.
      const newLevel = mergedLevel(unit.level, toHex.unit.level)
      const mergedMoved = (unit.moved || false) || (toHex.unit.moved || false)
      toHex.unit = { level: newLevel, moved: mergedMoved }
      isFree = !mergedMoved
    } else if (toHex.terrain === TERRAIN_TREE || toHex.terrain === TERRAIN_PALM) {
      // Clear tree/palm — action
      toHex.terrain = TERRAIN_LAND
      toHex.unit = { level: unit.level, moved: true }
    } else {
      // Free reposition within own territory — clear gravestone if present
      if (toHex.structure === STRUCTURE_GRAVESTONE) {
        toHex.structure = null
      }
      toHex.unit = { level: unit.level, moved: false }
      isFree = true
    }
  } else {
    // Capture enemy/neutral hex — action
    toHex.unit = null       // Remove any defending unit; barons are unreachable in practice
                            // because no attacker can exceed their strength of 4
    toHex.structure = null  // Remove hut/tower/gravestone on captured hex
    if (toHex.terrain === TERRAIN_TREE || toHex.terrain === TERRAIN_PALM) {
      toHex.terrain = TERRAIN_LAND
    }
    toHex.owner = player
    toHex.unit = { level: unit.level, moved: true }
  }

  fromHex.unit = null

  // Only recalculate territories on captures (ownership changed).
  // Merges and tree/palm clearing stay within own territory — no recompute needed.
  if (isCapture) {
    recomputeTerritories(state)
  }

  return isFree
}

// Buy a new peasant for a territory, placing it on the first eligible hex
function buyUnit(state, territoryIndex) {
  const territory = state.territories[territoryIndex]
  if (!territory || territory.owner !== state.activePlayer) return false
  if (territory.bank < PEASANT_COST) return false

  // Prefer empty land hexes, then land with gravestone
  let candidate = null

  for (let i = 0; i < territory.hexKeys.length; i++) {
    const k = territory.hexKeys[i]
    const h = state.hexes[k]
    if (!h || h.unit) continue
    if (h.terrain === TERRAIN_LAND && !h.structure) {
      candidate = k
      break
    }
  }

  if (!candidate) {
    for (let j = 0; j < territory.hexKeys.length; j++) {
      const k2 = territory.hexKeys[j]
      const h2 = state.hexes[k2]
      if (!h2 || h2.unit) continue
      if (h2.structure === STRUCTURE_GRAVESTONE) {
        candidate = k2
        break
      }
    }
  }

  if (!candidate) return false

  const ch = state.hexes[candidate]
  ch.structure = null // clear gravestone if present
  ch.unit = { level: 1, moved: false }
  territory.bank -= PEASANT_COST
  return true
}

// Build a tower on the selected hex
function buildTower(state, hexKey) {
  const hex = state.hexes[hexKey]
  if (!hex) return false
  if (hex.owner !== state.activePlayer) return false
  if (hex.terrain !== TERRAIN_LAND) return false
  if (hex.unit || hex.structure) return false

  const territory = getTerritoryForHex(state, hexKey)
  if (!territory || territory.bank < TOWER_COST) return false

  hex.structure = STRUCTURE_TOWER
  territory.bank -= TOWER_COST
  return true
}

export { TOWER_COST, PEASANT_COST, getValidMoves, executeMove, buyUnit, buildTower }
