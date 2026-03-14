// Territory detection, management, and defensive zone calculations

import { hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, TERRAIN_TREE, TERRAIN_PALM, STRUCTURE_HUT, STRUCTURE_TOWER, STRUCTURE_GRAVESTONE } from './constants.js'
import { UNIT_DEFS } from './units.js'

// Recompute all territories from the current hex ownership map.
// Finds connected components per player and reconciles banks via hut keys.
function recomputeTerritories(state) {
  const hexes = state.hexes
  const visited = {}
  const newTerritories = []
  const numActivePlayers = state.numActivePlayers != null ? state.numActivePlayers : state.players.length

  const allKeys = Object.keys(hexes)

  for (let ki = 0; ki < allKeys.length; ki++) {
    const startKey = allKeys[ki]
    const startHex = hexes[startKey]
    if (startHex.owner === null || visited[startKey] || startHex.terrain === TERRAIN_WATER) continue

    // BFS to find connected component
    const component = []
    const queue = [startKey]
    visited[startKey] = true

    while (queue.length > 0) {
      const k = queue.shift()
      const hex = hexes[k]
      if (!hex) continue
      component.push(k)

      const nbrs = hexNeighborKeys(hex.q, hex.r)
      for (let ni = 0; ni < nbrs.length; ni++) {
        const nk = nbrs[ni]
        if (!visited[nk]) {
          const nh = hexes[nk]
          if (nh && nh.owner === hex.owner && nh.terrain !== TERRAIN_WATER) {
            visited[nk] = true
            queue.push(nk)
          }
        }
      }
    }

    // Collect all huts in this component
    const huts = []
    for (let ci = 0; ci < component.length; ci++) {
      if (hexes[component[ci]].structure === STRUCTURE_HUT) {
        huts.push(component[ci])
      }
    }

    let bank = 0
    let hutHexKey = null

    if (huts.length === 0) {
      // No hut — territory newly formed (split from enemy capture) or single hex
      bank = 0
      hutHexKey = null
    } else if (huts.length === 1) {
      hutHexKey = huts[0]
      bank = getBankForHut(state.territories, hutHexKey)
    } else {
      // Multiple huts merged into one component — keep richest, remove others
      let totalBank = 0
      let maxBank = -1
      let richestHut = huts[0]
      for (let hi = 0; hi < huts.length; hi++) {
        const b = getBankForHut(state.territories, huts[hi])
        totalBank += b
        if (b > maxBank) {
          maxBank = b
          richestHut = huts[hi]
        }
      }
      // Remove surplus huts
      for (let hi2 = 0; hi2 < huts.length; hi2++) {
        if (huts[hi2] !== richestHut) {
          hexes[huts[hi2]].structure = null
        }
      }
      hutHexKey = richestHut
      bank = totalBank
    }

    // If territory has ≥ 2 hexes but no hut, place one on the first eligible hex.
    // Never give huts to inactive players (index >= numActivePlayers).
    if (!hutHexKey && component.length >= 2 && startHex.owner < numActivePlayers) {
      for (let pi = 0; pi < component.length; pi++) {
        const ph = hexes[component[pi]]
        if (ph && ph.terrain === TERRAIN_LAND && !ph.unit && !ph.structure) {
          ph.structure = STRUCTURE_HUT
          hutHexKey = component[pi]
          break
        }
      }
      // Fallback: any non-water hex with no unit
      if (!hutHexKey) {
        for (let pi2 = 0; pi2 < component.length; pi2++) {
          const ph2 = hexes[component[pi2]]
          if (ph2 && ph2.terrain !== TERRAIN_WATER && !ph2.unit) {
            ph2.structure = STRUCTURE_HUT
            hutHexKey = component[pi2]
            break
          }
        }
      }
    }

    // Single-hex territory: the hut has no purpose — destroy it and convert the
    // hex to a tree or palm so the tile returns to neutral, impassable terrain.
    // Palm is used if the hex borders water; otherwise a regular tree.
    if (component.length === 1 && hutHexKey) {
      const orphan = hexes[hutHexKey]
      orphan.structure = null
      orphan.unit = null
      orphan.owner = null
      const nearWater = hexNeighborKeys(orphan.q, orphan.r).some(function (nk) {
        const n = hexes[nk]
        return !n || n.terrain === TERRAIN_WATER
      })
      orphan.terrain = nearWater ? TERRAIN_PALM : TERRAIN_TREE
      orphan.treeAge = 0
      // Hex is now neutral terrain — skip adding it to newTerritories.
      continue
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
  for (let i = 0; i < territories.length; i++) {
    if (territories[i].hutHexKey === hutKey) return territories[i].bank
  }
  return 0
}

// Find the territory object that contains a given hex key
function getTerritoryForHex(state, key) {
  const ts = state.territories
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].hexKeys.indexOf(key) !== -1) return ts[i]
  }
  return null
}

// Compute the effective defense strength of a target hex.
// = max strength of any unit/structure on the hex itself OR on any
//   adjacent hex owned by the same player.
//
// Units defend all neighbouring hexes regardless of whether they have already
// moved this turn.  Structures (huts, towers) likewise always contribute.
function getHexDefenseStrength(state, targetKey) {
  const hexes = state.hexes
  const targetHex = hexes[targetKey]
  if (!targetHex) return 99

  const owner = targetHex.owner
  let maxDef = 0

  function checkHex(h) {
    if (!h) return
    if (h.unit) {
      maxDef = Math.max(maxDef, UNIT_DEFS[h.unit.level].strength)
    }
    if (h.structure === STRUCTURE_HUT) maxDef = Math.max(maxDef, 1)
    if (h.structure === STRUCTURE_TOWER) maxDef = Math.max(maxDef, 2)
  }

  checkHex(targetHex)

  if (owner !== null) {
    const nbrs = hexNeighborKeys(targetHex.q, targetHex.r)
    for (let i = 0; i < nbrs.length; i++) {
      const nh = hexes[nbrs[i]]
      if (nh && nh.owner === owner) checkHex(nh)
    }
  }

  return maxDef
}

export { recomputeTerritories, getBankForHut, getTerritoryForHex, getHexDefenseStrength }
