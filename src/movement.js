// Movement: valid move computation, move execution, buy unit, build tower

var TOWER_COST = 10
var PEASANT_COST = 5

// Returns an array of hex keys the unit at unitHexKey can legally move to
function getValidMoves(state, unitHexKey) {
  var fromHex = state.hexes[unitHexKey]
  if (!fromHex || !fromHex.unit || fromHex.unit.moved) return []

  var unit = fromHex.unit
  var player = fromHex.owner
  var atkStr = UNIT_DEFS[unit.level].strength
  var moves = []

  var nbrs = hexNeighborKeys(fromHex.q, fromHex.r)
  for (var i = 0; i < nbrs.length; i++) {
    var toKey = nbrs[i]
    var toHex = state.hexes[toKey]
    if (!toHex || toHex.terrain === TERRAIN_WATER) continue

    if (toHex.owner === player) {
      // Own territory: can move if no blocking structure
      var blocked = toHex.structure === STRUCTURE_HUT || toHex.structure === STRUCTURE_TOWER
      if (!blocked) {
        if (!toHex.unit) {
          // Empty hex (land, tree, palm, or gravestone)
          moves.push(toKey)
        } else if (canMergeUnits(unit.level, toHex.unit.level)) {
          // Merge with same-level unit
          moves.push(toKey)
        }
      }
    } else {
      // Enemy or neutral: capture if strong enough
      if (canCapture(state, unit.level, toKey)) {
        moves.push(toKey)
      }
    }
  }

  return moves
}

// Execute a unit move from fromKey to toKey (assumed valid)
function executeMove(state, fromKey, toKey) {
  var fromHex = state.hexes[fromKey]
  var toHex = state.hexes[toKey]
  var unit = fromHex.unit
  var player = fromHex.owner

  if (toHex.owner === player) {
    // Move within own territory
    if (toHex.unit) {
      // Merge
      var newLevel = mergedLevel(unit.level, toHex.unit.level)
      toHex.unit = { level: newLevel, moved: true }
    } else {
      // Move to empty hex — clear tree/palm/gravestone
      if (toHex.terrain === TERRAIN_TREE || toHex.terrain === TERRAIN_PALM) {
        toHex.terrain = TERRAIN_LAND
      }
      if (toHex.structure === STRUCTURE_GRAVESTONE) {
        toHex.structure = null
      }
      toHex.unit = { level: unit.level, moved: true }
    }
  } else {
    // Capture enemy/neutral hex
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
  recomputeTerritories(state)
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
