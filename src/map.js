// Map generation: hexagonal island with terrain and player starting areas

import { hexKey, hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, TERRAIN_TREE, TERRAIN_PALM, STRUCTURE_HUT } from './constants.js'

const MAP_RADIUS = 7
const NUM_PLAYERS = 6   // always 6 players on the map
const SEEDS_PER_PLAYER = 3  // each player gets 3 random starting seeds → multiple territories

// ── Grid creation ─────────────────────────────────────────────────────────────

function generateHexMap() {
  const hexes = {}

  for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
    for (let r = -MAP_RADIUS; r <= MAP_RADIUS; r++) {
      // Axial hex constraint: keep the grid hexagonal
      if (Math.abs(q + r) > MAP_RADIUS) continue
      const dist = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r))
      const terrain = dist >= MAP_RADIUS - 1 ? TERRAIN_WATER : TERRAIN_LAND
      hexes[hexKey(q, r)] = {
        q, r,
        terrain,
        owner: null,
        unit: null,
        structure: null,
        gravestoneAge: 0
      }
    }
  }

  // Erode some outer-ring land hexes to water for a more natural coastline
  for (const key in hexes) {
    const hex = hexes[key]
    if (hex.terrain !== TERRAIN_LAND) continue
    const dist = Math.max(Math.abs(hex.q), Math.abs(hex.r), Math.abs(hex.q + hex.r))
    if (dist === MAP_RADIUS - 2 && Math.random() < 0.35) {
      hex.terrain = TERRAIN_WATER
    }
  }

  return hexes
}

// ── Terrain decoration ────────────────────────────────────────────────────────

// Randomly scatter trees and palms on land hexes that have no structure/unit.
// Called after ownership is assigned so huts are already placed and excluded.
function addRandomTerrain(hexes) {
  for (const key in hexes) {
    const hex = hexes[key]
    // Only decorate plain, empty, owned land
    if (hex.terrain !== TERRAIN_LAND || hex.structure || hex.unit) continue

    const nearWater = hexNeighborKeys(hex.q, hex.r).some(function (k) {
      const n = hexes[k]
      return !n || n.terrain === TERRAIN_WATER
    })

    if (nearWater) {
      if (Math.random() < 0.25) hex.terrain = TERRAIN_PALM
    } else {
      if (Math.random() < 0.15) hex.terrain = TERRAIN_TREE
    }
  }
}

// ── Territory assignment ──────────────────────────────────────────────────────

// Randomly distribute all non-water hexes among NUM_PLAYERS players using a
// multi-seed BFS flood fill.  Each player gets SEEDS_PER_PLAYER random starting
// hexes so the resulting regions are scattered across the whole map rather than
// forming a single contiguous zone.  After the flood fill, connected components
// are identified and each ≥2-hex component for an *active* player receives a hut.
// Active players (index < numActivePlayers) get huts + a starting bank.
// Inactive players (index >= numActivePlayers) have their colored land drawn on
// the map but receive no huts and no starting gold.
function placeStartingTerritories(hexes, numActivePlayers) {
  // ── Step 1: collect and shuffle all non-water land hexes ──────────────────
  const allLandKeys = Object.keys(hexes).filter(k => hexes[k].terrain !== TERRAIN_WATER)
  shuffleArray(allLandKeys)

  // ── Step 2: place seeds — SEEDS_PER_PLAYER seeds per player ──────────────
  // Seeds are selected so that each player's seeds are spread across the map.
  // We interleave seeds round-robin from the shuffled list for even distribution.
  const totalSeeds = NUM_PLAYERS * SEEDS_PER_PLAYER
  const seedSlice = allLandKeys.slice(0, Math.min(totalSeeds, allLandKeys.length))

  const queues = Array.from({ length: NUM_PLAYERS }, () => [])
  for (let i = 0; i < seedSlice.length; i++) {
    const p = i % NUM_PLAYERS
    hexes[seedSlice[i]].owner = p
    queues[p].push(seedSlice[i])
  }

  // ── Step 3: BFS flood fill from all seeds simultaneously ─────────────────
  // Process one hex per player per round to keep region sizes balanced.
  let anyWork = true
  while (anyWork) {
    anyWork = false
    for (let p = 0; p < NUM_PLAYERS; p++) {
      if (queues[p].length === 0) continue
      anyWork = true
      const k = queues[p].shift()
      const hex = hexes[k]
      const nbrs = hexNeighborKeys(hex.q, hex.r)
      shuffleArray(nbrs) // randomise expansion direction
      for (let i = 0; i < nbrs.length; i++) {
        const nk = nbrs[i]
        const nh = hexes[nk]
        if (!nh || nh.terrain === TERRAIN_WATER || nh.owner !== null) continue
        nh.owner = p
        queues[p].push(nk)
      }
    }
  }

  // ── Step 4: find connected components ─────────────────────────────────────
  const territories = findConnectedComponents(hexes)

  // ── Step 5: place hut in every ≥2-hex component owned by an active player ──
  for (let ti = 0; ti < territories.length; ti++) {
    const territory = territories[ti]
    // Inactive players' territories are drawn but get no huts
    if (territory.owner >= numActivePlayers) continue
    if (territory.hexKeys.length < 2) continue

    // Prefer a plain land hex (no tree) for the hut
    let hutKey = null
    for (let i = 0; i < territory.hexKeys.length; i++) {
      const h = hexes[territory.hexKeys[i]]
      if (h.terrain === TERRAIN_LAND && !h.unit && !h.structure) {
        hutKey = territory.hexKeys[i]
        break
      }
    }
    // Fallback: use first hex regardless of terrain, clear it to land
    if (!hutKey) {
      hutKey = territory.hexKeys[0]
      hexes[hutKey].terrain = TERRAIN_LAND
    }
    hexes[hutKey].structure = STRUCTURE_HUT
    territory.hutHexKey = hutKey
  }

  // ── Step 6: guarantee each *active* player has at least one hut ─────────────
  // Inactive players intentionally have no huts.
  for (let p = 0; p < numActivePlayers; p++) {
    const hasHut = territories.some(t => t.owner === p && t.hutHexKey !== null)
    if (hasHut) continue

    // Find the player's largest component
    const playerTerrs = territories.filter(t => t.owner === p)
    if (playerTerrs.length === 0) continue

    const target = playerTerrs.reduce(
      (best, t) => t.hexKeys.length > best.hexKeys.length ? t : best,
      playerTerrs[0]
    )

    // Try to absorb an adjacent non-water hex from any neighbour
    let adopted = false
    for (let i = 0; i < target.hexKeys.length && !adopted; i++) {
      const h = hexes[target.hexKeys[i]]
      const nbrs = hexNeighborKeys(h.q, h.r)
      for (let j = 0; j < nbrs.length && !adopted; j++) {
        const nk = nbrs[j]
        const nh = hexes[nk]
        if (!nh || nh.terrain === TERRAIN_WATER) continue
        if (nh.owner === p) continue // already ours

        // Remove nk from the old owner's territory
        const oldOwner = nh.owner
        for (let ti = 0; ti < territories.length; ti++) {
          const ot = territories[ti]
          if (ot.owner !== oldOwner) continue
          const idx = ot.hexKeys.indexOf(nk)
          if (idx === -1) continue
          ot.hexKeys.splice(idx, 1)
          if (ot.hutHexKey === nk) ot.hutHexKey = null
          break
        }

        // Give the hex to player p and grow target component
        nh.owner = p
        target.hexKeys.push(nk)

        // Place hut on the new hex (ensure terrain is land)
        nh.terrain = TERRAIN_LAND
        nh.structure = STRUCTURE_HUT
        target.hutHexKey = nk
        adopted = true
      }
    }
  }

  // ── Step 7: assign bank and add terrain decorations ───────────────────────
  // Only active players start with gold; inactive players have bank 0.
  for (let ti = 0; ti < territories.length; ti++) {
    territories[ti].bank = territories[ti].owner < numActivePlayers ? 5 : 0
  }

  addRandomTerrain(hexes) // place trees/palms after huts so they don't cover them

  return territories
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// BFS to find all connected components of owned non-water hexes
function findConnectedComponents(hexes) {
  const visited = {}
  const territories = []

  for (const startKey in hexes) {
    const startHex = hexes[startKey]
    if (startHex.owner === null || visited[startKey] || startHex.terrain === TERRAIN_WATER) continue

    const component = []
    const queue = [startKey]
    visited[startKey] = true

    while (queue.length > 0) {
      const k = queue.shift()
      const hex = hexes[k]
      if (!hex) continue
      component.push(k)

      const nbrs = hexNeighborKeys(hex.q, hex.r)
      for (let i = 0; i < nbrs.length; i++) {
        const nk = nbrs[i]
        if (!visited[nk]) {
          const nh = hexes[nk]
          if (nh && nh.owner === hex.owner && nh.terrain !== TERRAIN_WATER) {
            visited[nk] = true
            queue.push(nk)
          }
        }
      }
    }

    territories.push({
      owner: startHex.owner,
      hexKeys: component,
      bank: 0,
      hutHexKey: null
    })
  }

  return territories
}

// Fisher–Yates shuffle in-place
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

export { generateHexMap, placeStartingTerritories }
