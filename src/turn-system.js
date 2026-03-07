// Turn system: start/end turn, gravestone aging, undo

import { hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_PALM, TERRAIN_TREE, STRUCTURE_GRAVESTONE } from './constants.js'
import { computeIncome, computeUpkeep, applyBankruptcy } from './economy.js'

// Save a snapshot of the current game state for undo and reset unit moved flags
function startTurn(state) {
  state.turnSnapshot = {
    hexes: JSON.parse(JSON.stringify(state.hexes)),
    territories: JSON.parse(JSON.stringify(state.territories))
  }
  resetMovedFlags(state)
}

// Reset the `moved` flag on all units owned by the active player
function resetMovedFlags(state) {
  var player = state.activePlayer
  for (var k in state.hexes) {
    var hex = state.hexes[k]
    if (hex.unit && hex.owner === player) {
      hex.unit.moved = false
    }
  }
}

// End the current player's turn: apply income/upkeep, age gravestones, advance
function endTurn(state) {
  var player = state.activePlayer

  // Apply income and upkeep for every territory owned by this player
  for (var i = 0; i < state.territories.length; i++) {
    var territory = state.territories[i]
    if (territory.owner !== player) continue

    var income = computeIncome(state, territory)
    var upkeep = computeUpkeep(state, territory)

    territory.bank += income - upkeep

    if (territory.bank < 0) {
      applyBankruptcy(state, territory)
    }
  }

  // Age gravestones (may convert to tree or palm)
  ageGravestones(state)

  // Advance to next player
  state.activePlayer = (state.activePlayer + 1) % state.players.length
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
  for (var k in state.hexes) {
    var hex = state.hexes[k]
    if (hex.structure !== STRUCTURE_GRAVESTONE) continue

    hex.gravestoneAge++
    if (hex.gravestoneAge >= 2) {
      var nearWater = hexNeighborKeys(hex.q, hex.r).some(function (nk) {
        var n = state.hexes[nk]
        return !n || n.terrain === TERRAIN_WATER
      })
      hex.terrain = nearWater ? TERRAIN_PALM : TERRAIN_TREE
      hex.structure = null
      hex.gravestoneAge = 0
    }
  }
}

// Restore game state to the snapshot taken at the start of the current turn
function undoTurn(state) {
  if (!state.turnSnapshot) return

  var snap = state.turnSnapshot
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
