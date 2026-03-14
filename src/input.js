// Input handling: mouse, wheel, and touch events on the canvas

import { pixelToHex, hexKey } from './hex.js'
import { TERRAIN_WATER, TERRAIN_LAND, TERRAIN_TREE, TERRAIN_PALM, STRUCTURE_TOWER, STRUCTURE_GRAVESTONE } from './constants.js'
import { getTerritoryForHex, recomputeTerritories } from './territory.js'
import { TOWER_COST, PEASANT_COST, getBuyPlacementHexes, getValidMoves, executeMove } from './movement.js'
import { mergedLevel, UNIT_DEFS } from './units.js'
import { render, view } from './renderer.js'

let updateUI = null

// Minimum pixel movement before a press is treated as a drag rather than a tap
const DRAG_THRESHOLD = 6
// Minimum distance between two touch points to process a pinch gesture
const MIN_PINCH_DISTANCE = 1

function initInput(canvasEl, state, uiUpdater) {
  if (typeof uiUpdater !== 'function') throw new Error('initInput: uiUpdater must be a function')
  updateUI = uiUpdater

  // ── Shared helper: fire a game tap at canvas-local coordinates ──────────────
  function fireTap(canvasX, canvasY) {
    const worldX = (canvasX - view.panX) / view.zoom
    const worldY = (canvasY - view.panY) / view.zoom
    const hc = pixelToHex(worldX, worldY)
    handleHexClick(state, hexKey(hc.q, hc.r))
  }

  // ── Mouse: drag-to-pan + click-to-act ────────────────────────────────────
  let mouseDown   = false
  let mouseDragging = false
  let mouseStartX = 0, mouseStartY = 0
  let panStartX   = 0, panStartY   = 0

  canvasEl.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return
    mouseDown     = true
    mouseDragging = false
    mouseStartX   = e.clientX
    mouseStartY   = e.clientY
    panStartX     = view.panX
    panStartY     = view.panY
  })

  // Attach move/up to window so drags work even when the cursor leaves the canvas
  window.addEventListener('mousemove', function (e) {
    if (!mouseDown) return
    const dx = e.clientX - mouseStartX
    const dy = e.clientY - mouseStartY
    if (!mouseDragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      mouseDragging = true
      canvasEl.style.cursor = 'grabbing'
    }
    if (mouseDragging) {
      view.panX = panStartX + dx
      view.panY = panStartY + dy
      render(state)
    }
  })

  window.addEventListener('mouseup', function (e) {
    if (!mouseDown || e.button !== 0) return
    mouseDown = false
    canvasEl.style.cursor = 'default'
    if (!mouseDragging) {
      const rect = canvasEl.getBoundingClientRect()
      fireTap(e.clientX - rect.left, e.clientY - rect.top)
    }
    mouseDragging = false
  })

  // ── Mouse wheel: zoom centred on the cursor ──────────────────────────────
  canvasEl.addEventListener('wheel', function (e) {
    e.preventDefault()
    const factor   = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const newZoom  = Math.max(0.2, Math.min(6, view.zoom * factor))
    const zf       = newZoom / view.zoom
    const rect     = canvasEl.getBoundingClientRect()
    const mx       = e.clientX - rect.left
    const my       = e.clientY - rect.top
    view.panX      = mx + (view.panX - mx) * zf
    view.panY      = my + (view.panY - my) * zf
    view.zoom      = newZoom
    render(state)
  }, { passive: false })

  // ── Touch: one-finger pan + two-finger pinch-zoom + tap ─────────────────
  let lastTouches  = []
  let touchStartX  = 0
  let touchStartY  = 0
  let touchMoved   = false

  canvasEl.addEventListener('touchstart', function (e) {
    e.preventDefault()
    lastTouches  = Array.from(e.touches)
    touchMoved   = false
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX
      touchStartY = e.touches[0].clientY
    }
  }, { passive: false })

  canvasEl.addEventListener('touchmove', function (e) {
    e.preventDefault()
    const touches = Array.from(e.touches)

    if (touches.length === 1 && lastTouches.length === 1) {
      // ── Single-finger pan ────────────────────────────────────────────────
      const dx = touches[0].clientX - lastTouches[0].clientX
      const dy = touches[0].clientY - lastTouches[0].clientY
      if (Math.hypot(touches[0].clientX - touchStartX,
                     touches[0].clientY - touchStartY) > DRAG_THRESHOLD) {
        touchMoved = true
      }
      view.panX += dx
      view.panY += dy
      render(state)

    } else if (touches.length === 2 && lastTouches.length >= 2) {
      // ── Two-finger pinch-zoom (+ implicit pan from midpoint shift) ────────
      touchMoved = true
      const rect     = canvasEl.getBoundingClientRect()
      const prevDist = Math.hypot(lastTouches[0].clientX - lastTouches[1].clientX,
                                  lastTouches[0].clientY - lastTouches[1].clientY)
      const curDist  = Math.hypot(touches[0].clientX - touches[1].clientX,
                                  touches[0].clientY - touches[1].clientY)
      if (prevDist < MIN_PINCH_DISTANCE) { lastTouches = touches; return }

      const factor  = curDist / prevDist
      const newZoom = Math.max(0.2, Math.min(6, view.zoom * factor))
      const zf      = newZoom / view.zoom

      // Midpoints in canvas space (current and previous)
      const mx     = (touches[0].clientX + touches[1].clientX) / 2 - rect.left
      const my     = (touches[0].clientY + touches[1].clientY) / 2 - rect.top
      const prevMx = (lastTouches[0].clientX + lastTouches[1].clientX) / 2 - rect.left
      const prevMy = (lastTouches[0].clientY + lastTouches[1].clientY) / 2 - rect.top

      // Zoom around old midpoint, then shift by midpoint delta
      view.panX = mx - (prevMx - view.panX) * zf
      view.panY = my - (prevMy - view.panY) * zf
      view.zoom = newZoom
      render(state)
    }

    lastTouches = touches
  }, { passive: false })

  canvasEl.addEventListener('touchend', function (e) {
    e.preventDefault()
    if (!touchMoved && lastTouches.length === 1) {
      const touch = lastTouches[0]
      const rect  = canvasEl.getBoundingClientRect()
      fireTap(touch.clientX - rect.left, touch.clientY - rect.top)
    }
    lastTouches = Array.from(e.touches)
    if (lastTouches.length === 0) touchMoved = false
  }, { passive: false })

  canvasEl.addEventListener('touchcancel', function () {
    lastTouches = []
    touchMoved  = false
  }, { passive: false })
}

function handleHexClick(state, key) {
  const hex = state.hexes[key]
  if (!hex || hex.terrain === TERRAIN_WATER) {
    clearSelection(state)
    return
  }

  const player = state.activePlayer

  // ── Buy-mode: place a newly-bought unit ────────────────────────────────────
  if (state.mode === 'buy') {
    // The paying territory was recorded in state.selectedHex when entering buy mode
    const buyTerritory = getTerritoryForHex(state, state.selectedHex)
    const buyLevel = state.buyLevel !== undefined ? state.buyLevel : 1
    const buyCost = UNIT_DEFS[buyLevel].cost

    if (buyTerritory && buyTerritory.owner === player && buyTerritory.bank >= buyCost) {
      const { ownHexes, mergeHexes, adjacentHexes } = getBuyPlacementHexes(state, buyTerritory, buyLevel)
      const isOwnTarget      = ownHexes.indexOf(key) !== -1
      const isMergeTarget    = mergeHexes.indexOf(key) !== -1
      const isAdjacentTarget = adjacentHexes.indexOf(key) !== -1

      if (isOwnTarget || isMergeTarget || isAdjacentTarget) {
        if (isMergeTarget) {
          // Merge: bought unit (unmoved) absorbed by existing unit.
          // Merged unit is moved only if the existing unit was already moved.
          const newLevel = mergedLevel(buyLevel, hex.unit.level)
          hex.unit = { level: newLevel, moved: hex.unit.moved }
          buyTerritory.bank -= buyCost
        } else {
          const isCapture = hex.owner !== player
          const wasTreeOrPalm = hex.terrain === TERRAIN_TREE || hex.terrain === TERRAIN_PALM
          const wasGravestone = hex.structure === STRUCTURE_GRAVESTONE
          if (wasTreeOrPalm) hex.terrain = TERRAIN_LAND
          hex.structure = null
          if (isCapture) hex.owner = player
          // Clearing tree/palm or gravestone is an action (moved); plain own land is fresh
          hex.unit = { level: buyLevel, moved: isCapture || wasTreeOrPalm || wasGravestone }
          // Deduct cost before recomputeTerritories — recompute replaces territory objects,
          // making any reference held in buyTerritory stale.  Deducting first ensures
          // getBankForHut picks up the correct reduced balance for the new territory.
          buyTerritory.bank -= buyCost
          if (isCapture) recomputeTerritories(state)
        }
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
