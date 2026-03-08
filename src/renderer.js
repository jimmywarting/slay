// Renderer: draws the game map on an HTML Canvas element

import { HEX_SIZE, hexToPixel, hexCorners, hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_TREE, TERRAIN_PALM, TERRAIN_LAND, STRUCTURE_HUT, STRUCTURE_TOWER, STRUCTURE_GRAVESTONE } from './constants.js'
import { UNIT_DEFS } from './units.js'
import { getBuyPlacementHexes } from './movement.js'

const PLAYER_COLORS     = ['#736c03', '#158a17', '#dbc447', '#02792f', '#ada740', '#94c655']
const PLAYER_HEX_COLORS = ['#736c03', '#158a17', '#dbc447', '#02792f', '#ada740', '#94c655']
const WATER_COLOR      = '#2471a3'
const WATER_DEEP_COLOR = '#1a5276'

let canvas, ctx
let offsetX = 0
let offsetY = 0

function initRenderer(canvasEl) {
  canvas = canvasEl
  ctx = canvas.getContext('2d')
  resizeCanvas()
}

function resizeCanvas() {
  const sidebar = document.getElementById('sidebar')
  const sidebarWidth = sidebar ? sidebar.offsetWidth : 280
  canvas.width = window.innerWidth - sidebarWidth
  canvas.height = window.innerHeight
  offsetX = canvas.width / 2
  offsetY = canvas.height / 2
}

// Main render entry point
function render(state) {
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Background
  ctx.fillStyle = '#0f2030'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw all hexes
  const keys = Object.keys(state.hexes)
  for (let i = 0; i < keys.length; i++) {
    const hex = state.hexes[keys[i]]
    if (hex.terrain !== TERRAIN_WATER) drawHexBase(state, hex, keys[i])
  }
  // Draw water on top for correct overlap at edges
  for (let j = 0; j < keys.length; j++) {
    const wh = state.hexes[keys[j]]
    if (wh.terrain === TERRAIN_WATER) drawWaterHex(wh)
  }

  // Valid move highlights — blue for free repositions, gold for action moves
  for (let vi = 0; vi < state.validMoves.length; vi++) {
    const vmk = state.validMoves[vi]
    const vmh = state.hexes[vmk]
    if (!vmh) continue
    if (state.freeMoves && state.freeMoves[vmk]) {
      drawOverlay(vmh, 'rgba(100,200,255,0.40)', 0)  // light blue = free reposition
    } else {
      drawOverlay(vmh, 'rgba(255,210,0,0.55)', 0)    // gold = action move
    }
  }

  // Selected unit highlight
  if (state.selectedUnit) {
    const sh = state.hexes[state.selectedUnit]
    if (sh) drawOverlay(sh, 'rgba(255,255,255,0.5)', 2)
  }

  // Buy mode target highlight — own-territory hexes (green / yellow-green for trees)
  // merge targets (teal) and adjacent undefended hexes (orange = parachute drop)
  if (state.mode === 'buy') {
    const buyTerritory = findTerritoryForHex(state, state.selectedHex)
    if (buyTerritory && buyTerritory.owner === state.activePlayer) {
      const buyLevel = state.buyLevel !== undefined ? state.buyLevel : 1
      const { ownHexes, mergeHexes, adjacentHexes } = getBuyPlacementHexes(state, buyTerritory, buyLevel)
      for (let bi = 0; bi < ownHexes.length; bi++) {
        const bh = state.hexes[ownHexes[bi]]
        if (!bh) continue
        const isTree = bh.terrain === TERRAIN_TREE || bh.terrain === TERRAIN_PALM
        // Yellow-green for tree/palm (will be cleared); green for plain land / gravestone
        drawOverlay(bh, isTree ? 'rgba(180,220,0,0.45)' : 'rgba(0,220,100,0.35)', 0)
      }
      for (let mi = 0; mi < mergeHexes.length; mi++) {
        const mh = state.hexes[mergeHexes[mi]]
        if (mh) drawOverlay(mh, 'rgba(0,180,220,0.45)', 0)  // teal = merge
      }
      for (let ai = 0; ai < adjacentHexes.length; ai++) {
        const ah = state.hexes[adjacentHexes[ai]]
        if (ah) drawOverlay(ah, 'rgba(255,140,0,0.45)', 0)  // orange = parachute
      }
    }
  }

  // Build tower mode target highlight — only hexes in the selected territory
  if (state.mode === 'build') {
    const buildTerritory = findTerritoryForHex(state, state.selectedHex)
    const tkeys = (buildTerritory && buildTerritory.owner === state.activePlayer) ? buildTerritory.hexKeys : []
    for (let ti = 0; ti < tkeys.length; ti++) {
      const th = state.hexes[tkeys[ti]]
      if (!th) continue
      if (th.terrain === TERRAIN_LAND && !th.unit && !th.structure) {
        drawOverlay(th, 'rgba(150,100,255,0.35)', 0)
      }
    }
  }

  // Active territory border — drawn last so it appears on top of all highlights
  if (state.selectedHex) {
    const activeTerr = findTerritoryForHex(state, state.selectedHex)
    if (activeTerr) {
      drawTerritoryBorder(state.hexes, activeTerr, 'rgba(255,255,255,0.85)', 3)
    }
  }
}

function drawWaterHex(hex) {
  const pos = hexToPixel(hex.q, hex.r)
  const cx = pos.x + offsetX
  const cy = pos.y + offsetY
  const corners = hexCorners(cx, cy)

  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y)
  ctx.closePath()
  ctx.fillStyle = WATER_COLOR
  ctx.fill()
  ctx.strokeStyle = WATER_DEEP_COLOR
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawHexBase(state, hex, hexKey) {
  const pos = hexToPixel(hex.q, hex.r)
  const cx = pos.x + offsetX
  const cy = pos.y + offsetY
  const corners = hexCorners(cx, cy)

  // Fill color — every non-water hex is always owned by a player
  const fillColor = PLAYER_HEX_COLORS[hex.owner % PLAYER_HEX_COLORS.length]

  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y)
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Content (terrain icon, structure, unit)
  drawHexContent(state, hex, hexKey, cx, cy)
}

function drawHexContent(state, hex, hexKey, cx, cy) {
  const emojiSize = Math.round(HEX_SIZE * 0.82)

  if (hex.terrain === TERRAIN_TREE) {
    drawEmoji('🌲', cx, cy, emojiSize)
  } else if (hex.terrain === TERRAIN_PALM) {
    drawEmoji('🌴', cx, cy, emojiSize)
  }

  if (hex.structure === STRUCTURE_HUT) {
    drawEmoji('🛖', cx, cy, emojiSize)
    // Show 🚩 on the active player's hut when the territory can afford a new Peasant
    if (hex.owner === state.activePlayer) {
      const territory = findTerritoryForHex(state, hexKey)
      if (territory && territory.bank >= UNIT_DEFS[1].cost) {
        const flagSize = Math.round(HEX_SIZE * 0.45)
        drawEmoji('🚩', cx + HEX_SIZE * 0.32, cy - HEX_SIZE * 0.38, flagSize)
      }
    }
  } else if (hex.structure === STRUCTURE_TOWER) {
    drawEmoji('🏰', cx, cy, emojiSize)
  } else if (hex.structure === STRUCTURE_GRAVESTONE) {
    drawEmoji('🪦', cx, cy, emojiSize)
  }

  if (hex.unit) {
    drawUnitIcon(hex.unit, cx, cy, emojiSize)
  }
}

function drawOverlay(hex, color, strokeWidth) {
  const pos = hexToPixel(hex.q, hex.r)
  const cx = pos.x + offsetX
  const cy = pos.y + offsetY
  const corners = hexCorners(cx, cy)

  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  if (strokeWidth > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = strokeWidth
    ctx.stroke()
  }
}

// ── Icon drawing helpers ──────────────────────────────────────────────────────

function drawEmoji(emoji, cx, cy, size) {
  ctx.font = size + 'px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(emoji, cx, cy)
}

function drawUnitIcon(unit, cx, cy, size) {
  const def = UNIT_DEFS[unit.level]
  if (!def) return
  ctx.globalAlpha = unit.moved ? 0.4 : 1.0
  drawEmoji(def.symbol, cx, cy, size)
  ctx.globalAlpha = 1.0
}

// ── Territory helpers ─────────────────────────────────────────────────────────

// Find the territory object that contains the given hex key.
function findTerritoryForHex(state, key) {
  if (!key) return null
  const ts = state.territories
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].hexKeys.indexOf(key) !== -1) return ts[i]
  }
  return null
}

// Draw a solid border around a territory by stroking only the outer edges —
// i.e. edges whose neighbour lies outside the territory.
//
// Direction-to-edge mapping for pointy-top hexes (corners numbered 0-5 at
// angles -30°, 30°, 90°, 150°, 210°, 270°, matching hexCorners()):
//   dir 0 E  → edge between corners 0 and 1
//   dir 1 NE → edge between corners 5 and 0
//   dir 2 NW → edge between corners 4 and 5
//   dir 3 W  → edge between corners 3 and 4
//   dir 4 SW → edge between corners 2 and 3
//   dir 5 SE → edge between corners 1 and 2
// Formula: direction d → corners (6-d)%6 and (7-d)%6
function drawTerritoryBorder(hexes, territory, color, lineWidth) {
  if (!territory || territory.hexKeys.length === 0) return

  // Build a fast-lookup set of keys in this territory
  const hexSet = {}
  for (let i = 0; i < territory.hexKeys.length; i++) {
    hexSet[territory.hexKeys[i]] = true
  }

  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (let i = 0; i < territory.hexKeys.length; i++) {
    const hex = hexes[territory.hexKeys[i]]
    if (!hex) continue

    const pos = hexToPixel(hex.q, hex.r)
    const cx = pos.x + offsetX
    const cy = pos.y + offsetY
    const corners = hexCorners(cx, cy)
    const nbrs = hexNeighborKeys(hex.q, hex.r)

    for (let d = 0; d < 6; d++) {
      if (!hexSet[nbrs[d]]) {
        // This edge is on the outer border of the territory — draw it
        const c1 = (6 - d) % 6
        const c2 = (7 - d) % 6
        ctx.beginPath()
        ctx.moveTo(corners[c1].x, corners[c1].y)
        ctx.lineTo(corners[c2].x, corners[c2].y)
        ctx.stroke()
      }
    }
  }
}

export { PLAYER_COLORS, PLAYER_HEX_COLORS, offsetX, offsetY, initRenderer, resizeCanvas, render }

