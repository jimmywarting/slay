// Map generation: hexagonal island with terrain and player starting areas

import { hexKey, hexNeighborKeys, hexDistance } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, TERRAIN_TREE, TERRAIN_PALM, STRUCTURE_HUT } from './constants.js'

const MAP_RADIUS = 7

// Six evenly-spaced start positions at the vertices of a radius-4 hexagon
const NUM_TERRITORIES = 6
const START_POSITIONS = [
  { q:  0, r: -4 },
  { q:  4, r: -4 },
  { q:  4, r:  0 },
  { q:  0, r:  4 },
  { q: -4, r:  4 },
  { q: -4, r:  0 }
]

// Generate the base hex grid
function generateHexMap() {
  const hexes = {}

  for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
    for (let r = -MAP_RADIUS; r <= MAP_RADIUS; r++) {
      // Axial hex constraint: |q| + |r| + |s| = 0 where s = -q-r.
      // Equivalent to Math.abs(q+r) <= MAP_RADIUS — keeps the grid hexagonal.
      if (Math.abs(q + r) > MAP_RADIUS) continue
      const dist = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r))
      const terrain = dist >= MAP_RADIUS - 1 ? TERRAIN_WATER : TERRAIN_LAND
      const key = hexKey(q, r)
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
  const rng = seededRng(12345)

  // First pass: edge water and coastal palms
  for (const key in hexes) {
    const hex = hexes[key]
    if (hex.terrain !== TERRAIN_LAND) continue
    const dist = Math.max(Math.abs(hex.q), Math.abs(hex.r), Math.abs(hex.q + hex.r))

    if (dist === MAP_RADIUS - 2 && rng() < 0.35) {
      hex.terrain = TERRAIN_WATER
    }
  }

  // Second pass: coastal palms and inland trees
  for (const key in hexes) {
    const hex = hexes[key]
    if (hex.terrain !== TERRAIN_LAND) continue

    const nearWater = hexNeighborKeys(hex.q, hex.r).some(function (k) {
      const n = hexes[k]
      return !n || n.terrain === TERRAIN_WATER
    })

    if (nearWater) {
      if (rng() < 0.3) hex.terrain = TERRAIN_PALM
    } else {
      if (rng() < 0.12) hex.terrain = TERRAIN_TREE
    }
  }
}

// Assign every non-water hex to one of NUM_TERRITORIES players via Voronoi
// partition, then set up territories. Only the first numActivePlayers players
// receive a starting hut and bank; the rest simply own their land.
function placeStartingTerritories(hexes, numActivePlayers) {
  // Build per-player hex lists via Voronoi (nearest start position)
  const playerHexKeys = []
  for (let p = 0; p < NUM_TERRITORIES; p++) playerHexKeys.push([])

  for (const key in hexes) {
    const hex = hexes[key]
    if (hex.terrain === TERRAIN_WATER) continue

    let nearest = 0
    let minDist = Infinity
    for (let p = 0; p < NUM_TERRITORIES; p++) {
      const d = hexDistance(hex.q, hex.r, START_POSITIONS[p].q, START_POSITIONS[p].r)
      if (d < minDist) { minDist = d; nearest = p }
    }
    hex.owner = nearest
    playerHexKeys[nearest].push(key)
  }

  // Build territory objects; active players get a hut + starting bank
  const territories = []
  for (let p = 0; p < NUM_TERRITORIES; p++) {
    const active = p < numActivePlayers
    let hutHexKey = null

    if (active) {
      const sp = START_POSITIONS[p]
      const center = findNearestOwnedLandHex(hexes, sp.q, sp.r, p)
      if (center) {
        hutHexKey = hexKey(center.q, center.r)
        center.terrain = TERRAIN_LAND
        center.structure = STRUCTURE_HUT
      }
    }

    territories.push({
      owner: p,
      hexKeys: playerHexKeys[p].slice(),
      bank: active ? 5 : 0,
      hutHexKey: hutHexKey
    })
  }

  return territories
}

// Find the non-water hex owned by `owner` that is closest to (targetQ, targetR)
function findNearestOwnedLandHex(hexes, targetQ, targetR, owner) {
  let best = null
  let bestDist = Infinity
  for (const key in hexes) {
    const h = hexes[key]
    if (h.owner !== owner || h.terrain === TERRAIN_WATER) continue
    const d = hexDistance(h.q, h.r, targetQ, targetR)
    if (d < bestDist) { bestDist = d; best = h }
  }
  return best
}

// Deterministic seeded pseudo-random number generator (Mulberry32)
function seededRng(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export { generateHexMap, placeStartingTerritories }
