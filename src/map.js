// Map generation: hexagonal island with terrain and player starting areas

var MAP_RADIUS = 7

var TERRAIN_WATER = 'water'
var TERRAIN_LAND = 'land'
var TERRAIN_TREE = 'tree'
var TERRAIN_PALM = 'palm'

// Generate the base hex grid
function generateHexMap() {
  var hexes = {}

  for (var q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
    for (var r = -MAP_RADIUS; r <= MAP_RADIUS; r++) {
      // Axial hex constraint: |q| + |r| + |s| = 0 where s = -q-r.
      // Equivalent to Math.abs(q+r) <= MAP_RADIUS — keeps the grid hexagonal.
      if (Math.abs(q + r) > MAP_RADIUS) continue
      var dist = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r))
      var terrain = dist >= MAP_RADIUS - 1 ? TERRAIN_WATER : TERRAIN_LAND
      var key = hexKey(q, r)
      hexes[key] = {
        q: q,
        r: r,
        terrain: terrain,
        owner: null,
        unit: null,
        structure: null,
        gravestoneAge: 0
      }
    }
  }

  addNaturalTerrain(hexes)
  return hexes
}

// Scatter trees and palms on the inner land area
function addNaturalTerrain(hexes) {
  var rng = seededRng(12345)

  // First pass: edge water and coastal palms
  for (var key in hexes) {
    var hex = hexes[key]
    if (hex.terrain !== TERRAIN_LAND) continue
    var dist = Math.max(Math.abs(hex.q), Math.abs(hex.r), Math.abs(hex.q + hex.r))

    if (dist === MAP_RADIUS - 2 && rng() < 0.35) {
      hex.terrain = TERRAIN_WATER
    }
  }

  // Second pass: coastal palms and inland trees
  for (var key2 in hexes) {
    var hex2 = hexes[key2]
    if (hex2.terrain !== TERRAIN_LAND) continue

    var nearWater = hexNeighborKeys(hex2.q, hex2.r).some(function (k) {
      var n = hexes[k]
      return !n || n.terrain === TERRAIN_WATER
    })

    if (nearWater) {
      if (rng() < 0.3) hex2.terrain = TERRAIN_PALM
    } else {
      if (rng() < 0.12) hex2.terrain = TERRAIN_TREE
    }
  }
}

// Place player starting territories on the map
function placeStartingTerritories(hexes, numPlayers) {
  var territories = []

  // Evenly-spaced start positions for up to 4 players (axial coords)
  var startPositions = [
    { q: -4, r: 0 },
    { q: 4,  r: 0 },
    { q: 0,  r: -4 },
    { q: 0,  r: 4 }
  ]

  var usedKeys = {}

  for (var p = 0; p < numPlayers; p++) {
    var sp = startPositions[p % startPositions.length]
    var centerHex = findNearestLandHex(hexes, sp.q, sp.r, usedKeys)
    if (!centerHex) continue

    var centerKey = hexKey(centerHex.q, centerHex.r)
    var claimedKeys = [centerKey]
    usedKeys[centerKey] = true

    // Claim 2 adjacent land hexes
    var neighbors = hexNeighborKeys(centerHex.q, centerHex.r)
    var added = 0
    for (var i = 0; i < neighbors.length && added < 2; i++) {
      var nk = neighbors[i]
      var nh = hexes[nk]
      if (nh && nh.terrain !== TERRAIN_WATER && !usedKeys[nk]) {
        claimedKeys.push(nk)
        usedKeys[nk] = true
        added++
      }
    }

    // Assign ownership and clear to land
    for (var j = 0; j < claimedKeys.length; j++) {
      var h = hexes[claimedKeys[j]]
      h.owner = p
      h.terrain = TERRAIN_LAND
    }

    // Place hut at center
    centerHex.structure = STRUCTURE_HUT

    territories.push({
      owner: p,
      hexKeys: claimedKeys.slice(),
      bank: 5,
      hutHexKey: centerKey
    })
  }

  return territories
}

// BFS-style nearest available land hex to (targetQ, targetR)
function findNearestLandHex(hexes, targetQ, targetR, usedKeys) {
  var allKeys = Object.keys(hexes)
  allKeys.sort(function (a, b) {
    var ha = hexes[a]
    var hb = hexes[b]
    return hexDistance(ha.q, ha.r, targetQ, targetR) - hexDistance(hb.q, hb.r, targetQ, targetR)
  })
  for (var i = 0; i < allKeys.length; i++) {
    var k = allKeys[i]
    var h = hexes[k]
    if (h.terrain !== TERRAIN_WATER && !usedKeys[k]) return h
  }
  return null
}

// Deterministic seeded pseudo-random number generator (Mulberry32)
function seededRng(seed) {
  var s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    var t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
