// Movement: valid move computation, move execution, buy unit, build tower

var TOWER_COST = 10
var PEASANT_COST = 5

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
  var fromHex = state.hexes[unitHexKey]
  if (!fromHex || !fromHex.unit || fromHex.unit.moved) return { moves: [], freeSet: {} }

  var unit = fromHex.unit
  var player = fromHex.owner

  var visited = {}   // BFS transit nodes (passable own land)
  var validSet = {}  // all destinations
  var freeSet  = {}  // free-reposition subset of validSet

  visited[unitHexKey] = true
  var queue = [unitHexKey]

  while (queue.length > 0) {
    var current = queue.shift()
    var currentHex = state.hexes[current]

    var nbrs = hexNeighborKeys(currentHex.q, currentHex.r)
    for (var i = 0; i < nbrs.length; i++) {
      var nk = nbrs[i]
      var nh = state.hexes[nk]
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
// Returns true if the move was a free reposition (unit.moved stays false),
// false if it was an action (capture, merge, clear tree/palm) that consumes the turn.
function executeMove(state, fromKey, toKey) {
  var fromHex = state.hexes[fromKey]
  var toHex = state.hexes[toKey]
  var unit = fromHex.unit
  var player = fromHex.owner
  var isFree = false
  var isCapture = toHex.owner !== player  // save before mutating toHex

  if (!isCapture) {
    if (toHex.unit) {
      // Merge — action
      var newLevel = mergedLevel(unit.level, toHex.unit.level)
      toHex.unit = { level: newLevel, moved: true }
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
  var territory = state.territories[territoryIndex]
  if (!territory || territory.owner !== state.activePlayer) return false
  if (territory.bank < PEASANT_COST) return false

  // Prefer empty land hexes, then land with gravestone
  var candidate = null

  for (var i = 0; i < territory.hexKeys.length; i++) {
    var k = territory.hexKeys[i]
    var h = state.hexes[k]
    if (!h || h.unit) continue
    if (h.terrain === TERRAIN_LAND && !h.structure) {
      candidate = k
      break
    }
  }

  if (!candidate) {
    for (var j = 0; j < territory.hexKeys.length; j++) {
      var k2 = territory.hexKeys[j]
      var h2 = state.hexes[k2]
      if (!h2 || h2.unit) continue
      if (h2.structure === STRUCTURE_GRAVESTONE) {
        candidate = k2
        break
      }
    }
  }

  if (!candidate) return false

  var ch = state.hexes[candidate]
  ch.structure = null // clear gravestone if present
  ch.unit = { level: 1, moved: false }
  territory.bank -= PEASANT_COST
  return true
}

// Build a tower on the selected hex
function buildTower(state, hexKey) {
  var hex = state.hexes[hexKey]
  if (!hex) return false
  if (hex.owner !== state.activePlayer) return false
  if (hex.terrain !== TERRAIN_LAND) return false
  if (hex.unit || hex.structure) return false

  var territory = getTerritoryForHex(state, hexKey)
  if (!territory || territory.bank < TOWER_COST) return false

  hex.structure = STRUCTURE_TOWER
  territory.bank -= TOWER_COST
  return true
}
