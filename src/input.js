// Input handling: mouse clicks on the canvas

import { pixelToHex, hexKey } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, TERRAIN_TREE, TERRAIN_PALM, STRUCTURE_TOWER } from './constants.js'
import { getTerritoryForHex, recomputeTerritories } from './territory.js'
import { TOWER_COST, PEASANT_COST, getBuyPlacementHexes, getValidMoves, executeMove } from './movement.js'
import { render, offsetX, offsetY } from './renderer.js'

let updateUI = null

function initInput(canvasEl, state, uiUpdater) {
  if (typeof uiUpdater !== 'function') throw new Error('initInput: uiUpdater must be a function')
  updateUI = uiUpdater
  canvasEl.addEventListener('click', function (e) {
    const rect = canvasEl.getBoundingClientRect()
    const px = e.clientX - rect.left - offsetX
    const py = e.clientY - rect.top - offsetY
    const hc = pixelToHex(px, py)
    handleHexClick(state, hexKey(hc.q, hc.r))
  })
}

function handleHexClick(state, key) {
  const hex = state.hexes[key]
  if (!hex || hex.terrain === TERRAIN_WATER) {
    clearSelection(state)
    return
  }

  const player = state.activePlayer

  // ── Buy-mode: place a new peasant ──────────────────────────────────────────
  if (state.mode === 'buy') {
    // The paying territory was recorded in state.selectedHex when entering buy mode
    const buyTerritory = getTerritoryForHex(state, state.selectedHex)

    if (buyTerritory && buyTerritory.owner === player && buyTerritory.bank >= PEASANT_COST) {
      const { ownHexes, adjacentHexes } = getBuyPlacementHexes(state, buyTerritory)
      const isOwnTarget      = ownHexes.indexOf(key) !== -1
      const isAdjacentTarget = adjacentHexes.indexOf(key) !== -1

      if (isOwnTarget || isAdjacentTarget) {
        const isCapture = hex.owner !== player
        // Clear tree/palm or gravestone on destination
        if (hex.terrain === TERRAIN_TREE || hex.terrain === TERRAIN_PALM) hex.terrain = TERRAIN_LAND
        hex.structure = null
        if (isCapture) hex.owner = player
        // Parachuted-in peasant has used its move; own-territory peasant is fresh
        hex.unit = { level: 1, moved: isCapture }
        buyTerritory.bank -= PEASANT_COST
        if (isCapture) recomputeTerritories(state)
      }
    }

    // Always leave buy mode after any click and re-render once
    state.mode = 'normal'
    state.selectedHex = null
    state.selectedUnit = null
    state.validMoves = []
    state.freeMoves = {}
    render(state)
    updateUI(state)
    return
  }

  // ── Build-mode: place a tower ──────────────────────────────────────────────
  if (state.mode === 'build') {
    if (hex.owner === player &&
        hex.terrain === TERRAIN_LAND &&
        !hex.unit && !hex.structure) {
      const territory = getTerritoryForHex(state, key)
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
      const wasFree = executeMove(state, state.selectedUnit, key)
      if (wasFree) {
        // Free reposition — unit can still act; re-select at new position
        state.selectedUnit = key
        state.selectedHex = key
        const vm = getValidMoves(state, key)
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
      const vm2 = getValidMoves(state, key)
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
    const vm3 = getValidMoves(state, key)
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
