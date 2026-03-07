// Input handling: mouse clicks on the canvas

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
    render(state)
    updateUI(state)
    return
  }

  // ── Unit selected — try to move ────────────────────────────────────────────
  if (state.selectedUnit) {
    if (state.validMoves.indexOf(key) !== -1) {
      // Execute the move
      executeMove(state, state.selectedUnit, key)
      state.selectedUnit = null
      state.validMoves = []
      render(state)
      updateUI(state)
      return
    }

    // Click on another own un-moved unit — switch selection
    if (hex.owner === player && hex.unit && !hex.unit.moved) {
      state.selectedUnit = key
      state.selectedHex = key
      state.validMoves = getValidMoves(state, key)
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
    state.validMoves = getValidMoves(state, key)
  } else {
    state.selectedHex = key
    state.selectedUnit = null
    state.validMoves = []
  }

  render(state)
  updateUI(state)
}

function clearSelection(state) {
  state.selectedHex = null
  state.selectedUnit = null
  state.validMoves = []
  state.mode = 'normal'
  render(state)
  updateUI(state)
}
