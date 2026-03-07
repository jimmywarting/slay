// Territory detection, management, and defensive zone calculations

var STRUCTURE_HUT = 'hut'
var STRUCTURE_TOWER = 'tower'
var STRUCTURE_GRAVESTONE = 'gravestone'

// Recompute all territories from the current hex ownership map.
// Finds connected components per player and reconciles banks via hut keys.
function recomputeTerritories(state) {
  var hexes = state.hexes
  var visited = {}
  var newTerritories = []

  var allKeys = Object.keys(hexes)

  for (var ki = 0; ki < allKeys.length; ki++) {
    var startKey = allKeys[ki]
    var startHex = hexes[startKey]
    if (startHex.owner === null || visited[startKey] || startHex.terrain === TERRAIN_WATER) continue

    // BFS to find connected component
    var component = []
    var queue = [startKey]
    visited[startKey] = true

    while (queue.length > 0) {
      var k = queue.shift()
      var hex = hexes[k]
      if (!hex) continue
      component.push(k)

      var nbrs = hexNeighborKeys(hex.q, hex.r)
      for (var ni = 0; ni < nbrs.length; ni++) {
        var nk = nbrs[ni]
        if (!visited[nk]) {
          var nh = hexes[nk]
          if (nh && nh.owner === hex.owner && nh.terrain !== TERRAIN_WATER) {
            visited[nk] = true
            queue.push(nk)
          }
        }
      }
    }

    // Collect all huts in this component
    var huts = []
    for (var ci = 0; ci < component.length; ci++) {
      if (hexes[component[ci]].structure === STRUCTURE_HUT) {
        huts.push(component[ci])
      }
    }

    var bank = 0
    var hutHexKey = null

    if (huts.length === 0) {
      // No hut — territory newly formed (split from enemy capture) or single hex
      bank = 0
      hutHexKey = null
    } else if (huts.length === 1) {
      hutHexKey = huts[0]
      bank = getBankForHut(state.territories, hutHexKey)
    } else {
      // Multiple huts merged into one component — keep richest, remove others
      var totalBank = 0
      var maxBank = -1
      var richestHut = huts[0]
      for (var hi = 0; hi < huts.length; hi++) {
        var b = getBankForHut(state.territories, huts[hi])
        totalBank += b
        if (b > maxBank) {
          maxBank = b
          richestHut = huts[hi]
        }
      }
      // Remove surplus huts
      for (var hi2 = 0; hi2 < huts.length; hi2++) {
        if (huts[hi2] !== richestHut) {
          hexes[huts[hi2]].structure = null
        }
      }
      hutHexKey = richestHut
      bank = totalBank
    }

    // If territory has ≥ 2 hexes but no hut, place one on the first eligible hex
    if (!hutHexKey && component.length >= 2) {
      for (var pi = 0; pi < component.length; pi++) {
        var ph = hexes[component[pi]]
        if (ph && ph.terrain === TERRAIN_LAND && !ph.unit && !ph.structure) {
          ph.structure = STRUCTURE_HUT
          hutHexKey = component[pi]
          break
        }
      }
      // Fallback: any non-water hex with no unit
      if (!hutHexKey) {
        for (var pi2 = 0; pi2 < component.length; pi2++) {
          var ph2 = hexes[component[pi2]]
          if (ph2 && ph2.terrain !== TERRAIN_WATER && !ph2.unit) {
            ph2.structure = STRUCTURE_HUT
            hutHexKey = component[pi2]
            break
          }
        }
      }
    }

    // Single-hex territory should not have a hut
    if (component.length === 1 && hutHexKey) {
      hexes[hutHexKey].structure = null
      hutHexKey = null
    }

    newTerritories.push({
      owner: startHex.owner,
      hexKeys: component,
      bank: bank,
      hutHexKey: hutHexKey
    })
  }

  state.territories = newTerritories
}

// Look up the saved bank for a given hut key in the old territory list
function getBankForHut(territories, hutKey) {
  if (!territories) return 0
  for (var i = 0; i < territories.length; i++) {
    if (territories[i].hutHexKey === hutKey) return territories[i].bank
  }
  return 0
}

// Find the territory object that contains a given hex key
function getTerritoryForHex(state, hexKey) {
  var ts = state.territories
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].hexKeys.indexOf(hexKey) !== -1) return ts[i]
  }
  return null
}

// Compute the effective defense strength of a target hex.
// = max strength of any unit/structure on the hex itself OR on any
//   adjacent hex owned by the same player.
function getHexDefenseStrength(state, targetKey) {
  var hexes = state.hexes
  var targetHex = hexes[targetKey]
  if (!targetHex) return 99

  var owner = targetHex.owner
  var maxDef = 0

  function checkHex(h) {
    if (!h) return
    if (h.unit) maxDef = Math.max(maxDef, UNIT_DEFS[h.unit.level].strength)
    if (h.structure === STRUCTURE_HUT) maxDef = Math.max(maxDef, 2)
    if (h.structure === STRUCTURE_TOWER) maxDef = Math.max(maxDef, 3)
  }

  checkHex(targetHex)

  if (owner !== null) {
    var nbrs = hexNeighborKeys(targetHex.q, targetHex.r)
    for (var i = 0; i < nbrs.length; i++) {
      var nh = hexes[nbrs[i]]
      if (nh && nh.owner === owner) checkHex(nh)
    }
  }

  return maxDef
}
