// Turn system: start/end turn, gravestone aging, undo

import { hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, TERRAIN_PALM, TERRAIN_TREE, STRUCTURE_GRAVESTONE } from './constants.js'
import { computeIncome, computeUpkeep, applyBankruptcy } from './economy.js'

// Apply income/upkeep at the start of a player's turn, then snapshot the state.
// Any bankruptcy is resolved immediately (units → gravestones) before the player
// gets to act.  The snapshot is taken after the economic phase so that undo only
// reverts the player's own moves, not the income/upkeep collection.
function startTurn(state) {
  const player = state.activePlayer

  // Apply income and upkeep for every territory owned by this player
  for (let i = 0; i < state.territories.length; i++) {
    const territory = state.territories[i]
    if (territory.owner !== player) continue

    const income = computeIncome(state, territory)
    const upkeep = computeUpkeep(state, territory)

    territory.bank += income - upkeep

    if (territory.bank < 0) {
      applyBankruptcy(state, territory)
    }
  }

  state.turnSnapshot = {
    hexes: JSON.parse(JSON.stringify(state.hexes)),
    territories: JSON.parse(JSON.stringify(state.territories))
  }
  resetMovedFlags(state)
}

// Reset the `moved` flag on all units owned by the active player
function resetMovedFlags(state) {
  const player = state.activePlayer
  for (const k in state.hexes) {
    const hex = state.hexes[k]
    if (hex.unit && hex.owner === player) {
      hex.unit.moved = false
    }
  }
}

// End the current player's turn: age gravestones, spread trees, advance to next player.
// Income/upkeep is applied at the START of each player's turn (see startTurn).
function endTurn(state) {
  // Clear the moved flag on all units belonging to the ending player so they
  // no longer render with the "used" opacity badge during the next player's turn.
  resetMovedFlags(state)

  const player = state.activePlayer

  // Age gravestones (may convert to tree or palm)
  ageGravestones(state)

  // Spread trees and palms once per round (after the last active player's turn)
  const numActive = state.numActivePlayers != null ? state.numActivePlayers : state.players.length
  if (player === numActive - 1) {
    spreadTrees(state)
  }

  // Advance to next player, skipping inactive players
  let next = (state.activePlayer + 1) % state.players.length
  let iterations = 0
  while (next >= numActive && iterations < state.players.length) {
    next = (next + 1) % state.players.length
    iterations++
  }
  state.activePlayer = next
  state.turn++

  // Clear UI selection state
  state.selectedHex = null
  state.selectedUnit = null
  state.validMoves = []
  state.freeMoves = {}
  state.mode = 'normal'

  startTurn(state)
}

// Increment gravestone age; convert mature gravestones to tree or palm
function ageGravestones(state) {
  for (const k in state.hexes) {
    const hex = state.hexes[k]
    if (hex.structure !== STRUCTURE_GRAVESTONE) continue

    hex.gravestoneAge++
    if (hex.gravestoneAge >= 2) {
      const nearWater = hexNeighborKeys(hex.q, hex.r).some(function (nk) {
        const n = state.hexes[nk]
        return !n || n.terrain === TERRAIN_WATER
      })
      hex.terrain = nearWater ? TERRAIN_PALM : TERRAIN_TREE
      hex.structure = null
      hex.gravestoneAge = 0
    }
  }
}

// Spread trees and palms: each tree/palm ages by 1 every endTurn; when age
// reaches 4 it may spread (40% chance) to one random valid adjacent hex and
// resets to 0.  Raising the threshold and adding a probability gate reduces the
// spread rate to roughly 1/5 of the original rate, preventing runaway growth.
// Trees spread to any adjacent empty land hex (owned or not).
// Palms spread to any adjacent empty land hex adjacent to water.
function spreadTrees(state) {
  const hexes = state.hexes
  // Snapshot the keys so newly-created tree hexes don't spread in the same pass
  const keys = Object.keys(hexes)

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const hex = hexes[k]
    if (hex.terrain !== TERRAIN_TREE && hex.terrain !== TERRAIN_PALM) continue

    if (!hex.treeAge) hex.treeAge = 0
    hex.treeAge++
    if (hex.treeAge < 4) continue
    hex.treeAge = 0

    // 40% chance to actually spread this cycle
    if (Math.random() >= 0.4) continue

    // Collect valid spread candidates
    const nbrKeys = hexNeighborKeys(hex.q, hex.r)
    const candidates = []
    for (let j = 0; j < nbrKeys.length; j++) {
      const nk = nbrKeys[j]
      const nh = hexes[nk]
      if (!nh) continue
      if (nh.terrain !== TERRAIN_LAND) continue
      if (nh.unit) continue
      if (nh.structure) continue

      // Palms may only spread to hexes that are themselves adjacent to water
      if (hex.terrain === TERRAIN_PALM) {
        const nbrsOfTarget = hexNeighborKeys(nh.q, nh.r)
        const targetNearWater = nbrsOfTarget.some(function (tk) {
          const tn = hexes[tk]
          return !tn || tn.terrain === TERRAIN_WATER
        })
        if (!targetNearWater) continue
      }

      candidates.push(nk)
    }

    if (candidates.length === 0) continue

    // Pick one random candidate and plant a new tree/palm there
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    hexes[pick].terrain = hex.terrain
    hexes[pick].treeAge = 0
  }
}

// Restore game state to the snapshot taken at the start of the current turn
function undoTurn(state) {
  if (!state.turnSnapshot) return

  const snap = state.turnSnapshot
  state.hexes = JSON.parse(JSON.stringify(snap.hexes))
  state.territories = JSON.parse(JSON.stringify(snap.territories))

  // Clear UI state
  state.selectedHex = null
  state.selectedUnit = null
  state.validMoves = []
  state.freeMoves = {}
  state.mode = 'normal'
}

export { startTurn, endTurn, undoTurn }
