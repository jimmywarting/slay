// Input handling: mouse clicks on the canvas

import { pixelToHex, hexKey } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, STRUCTURE_TOWER } from './constants.js'
import { getTerritoryForHex } from './territory.js'
import { TOWER_COST, PEASANT_COST, getValidMoves, executeMove } from './movement.js'
import { render, offsetX, offsetY } from './renderer.js'
import { updateUI } from './game.js'

function initInput(canvasEl, state) {
  canvasEl.addEventListener('click', function (e) {
    var rect = canvasEl.getBoundingClientRect()
    var px = e.clientX - rect.left - offsetX
    var py = e.clientY - rect.top - offsetY
    var hc = pixelToHex(px, py)
    handleHexClick(state, hexKey(hc.q, hc.r))
  })
}

function handleHexClick(state, key) {
  var hex = state.hexes[key]
  if (!hex || hex.terrain === TERRAIN_WATER) {
    clearSelection(state)
    return
  }

  var player = state.activePlayer

  // ── Buy-mode: place a new peasant ──────────────────────────────────────────
  if (state.mode === 'buy') {
    var bt = getTerritoryForHex(state, key)
    if (bt && bt.owner === player &&
        bt.bank >= PEASANT_COST &&
        hex.terrain === TERRAIN_LAND &&
        !hex.unit && !hex.structure) {
      hex.unit = { level: 1, moved: false }
      bt.bank -= PEASANT_COST
      clearSelection(state)
    } else {
      state.mode = 'normal'
      state.validMoves = []
      state.freeMoves = {}
      render(state)
      updateUI(state)
    }
    render(state)
    updateUI(state)
    return
  }

  // ── Build-mode: place a tower ──────────────────────────────────────────────
  if (state.mode === 'build') {
    if (hex.owner === player &&
        hex.terrain === TERRAIN_LAND &&
        !hex.unit && !hex.structure) {
      var territory = getTerritoryForHex(state, key)
      if (territory && territory.bank >= TOWER_COST) {
        hex.structure = STRUCTURE_TOWER
        territory.bank -= TOWER_COST
      }
    }
    state.mode = 'normal'
    state.validMoves = []
    state.freeMoves = {}
    render(state)
    updateUI(state)
    return
  }

  // ── Unit selected — try to move ────────────────────────────────────────────
  if (state.selectedUnit) {
    if (state.validMoves.indexOf(key) !== -1) {
      var wasFree = executeMove(state, state.selectedUnit, key)
      if (wasFree) {
        // Free reposition — unit can still act; re-select at new position
        state.selectedUnit = key
        state.selectedHex = key
        var vm = getValidMoves(state, key)
        state.validMoves = vm.moves
        state.freeMoves = vm.freeSet
      } else {
        // Action consumed the move — deselect
        state.selectedUnit = null
        state.selectedHex = key
        state.validMoves = []
        state.freeMoves = {}
      }
      render(state)
      updateUI(state)
      return
    }

    // Click on another own un-moved unit — switch selection
    if (hex.owner === player && hex.unit && !hex.unit.moved) {
      state.selectedUnit = key
      state.selectedHex = key
      var vm2 = getValidMoves(state, key)
      state.validMoves = vm2.moves
      state.freeMoves = vm2.freeSet
      render(state)
      updateUI(state)
      return
    }

    // Otherwise deselect
    clearSelection(state)
    return
  }

  // ── No selection — select a unit or show territory info ───────────────────
  if (hex.owner === player && hex.unit && !hex.unit.moved) {
    state.selectedUnit = key
    state.selectedHex = key
    var vm3 = getValidMoves(state, key)
    state.validMoves = vm3.moves
    state.freeMoves = vm3.freeSet
  } else {
    state.selectedHex = key
    state.selectedUnit = null
    state.validMoves = []
    state.freeMoves = {}
  }

  render(state)
  updateUI(state)
}

function clearSelection(state) {
  state.selectedHex = null
  state.selectedUnit = null
  state.validMoves = []
  state.freeMoves = {}
  state.mode = 'normal'
  render(state)
  updateUI(state)
}

export { initInput }
