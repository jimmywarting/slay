// Renderer: draws the game map on an HTML Canvas element

import { HEX_SIZE, hexToPixel, hexCorners, hexNeighborKeys } from './hex.js'
import { TERRAIN_WATER, TERRAIN_TREE, TERRAIN_PALM, TERRAIN_LAND, STRUCTURE_HUT, STRUCTURE_TOWER, STRUCTURE_GRAVESTONE } from './constants.js'
import { UNIT_DEFS } from './units.js'

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
    if (hex.terrain !== TERRAIN_WATER) drawHexBase(state, hex)
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

  // Buy mode target highlight — only hexes in the selected territory
  if (state.mode === 'buy') {
    const buyTerritory = findTerritoryForHex(state, state.selectedHex)
    const bkeys = (buyTerritory && buyTerritory.owner === state.activePlayer) ? buyTerritory.hexKeys : []
    for (let bi = 0; bi < bkeys.length; bi++) {
      const bh = state.hexes[bkeys[bi]]
      if (!bh) continue
      if (bh.terrain === TERRAIN_LAND && !bh.unit && !bh.structure) {
        drawOverlay(bh, 'rgba(0,220,100,0.35)', 0)
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

function drawHexBase(state, hex) {
  const pos = hexToPixel(hex.q, hex.r)
  const cx = pos.x + offsetX
  const cy = pos.y + offsetY
  const corners = hexCorners(cx, cy)

  // Fill color — every non-water hex is always owned by a player
  let fillColor = PLAYER_HEX_COLORS[hex.owner % PLAYER_HEX_COLORS.length]
  if (hex.terrain === TERRAIN_TREE) fillColor = darken(fillColor, 0.25)
  else if (hex.terrain === TERRAIN_PALM) fillColor = darken(fillColor, 0.2)

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
  drawHexContent(state, hex, cx, cy)
}

function drawHexContent(state, hex, cx, cy) {
  const r = HEX_SIZE * 0.42

  if (hex.terrain === TERRAIN_TREE) {
    drawTreeIcon(cx, cy, r * 0.85)
  } else if (hex.terrain === TERRAIN_PALM) {
    drawPalmIcon(cx, cy, r * 0.85)
  }

  if (hex.structure === STRUCTURE_HUT) {
    drawHutIcon(cx, cy, r)
  } else if (hex.structure === STRUCTURE_TOWER) {
    drawTowerIcon(cx, cy, r)
  } else if (hex.structure === STRUCTURE_GRAVESTONE) {
    drawGravestoneIcon(cx, cy, r * 0.7)
  }

  if (hex.unit) {
    drawUnitIcon(hex.unit, cx, cy, r * 0.72)
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

function drawTreeIcon(cx, cy, r) {
  // Pine triangle
  ctx.fillStyle = '#1b5e20'
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx - r * 0.75, cy + r * 0.55)
  ctx.lineTo(cx + r * 0.75, cy + r * 0.55)
  ctx.closePath()
  ctx.fill()
  // Trunk
  ctx.fillStyle = '#6d4c41'
  ctx.fillRect(cx - r * 0.13, cy + r * 0.55, r * 0.26, r * 0.45)
}

function drawPalmIcon(cx, cy, r) {
  // Trunk (slight curve)
  ctx.strokeStyle = '#6d4c41'
  ctx.lineWidth = r * 0.22
  ctx.beginPath()
  ctx.moveTo(cx, cy + r)
  ctx.quadraticCurveTo(cx + r * 0.25, cy, cx, cy - r * 0.85)
  ctx.stroke()
  // Fronds
  ctx.strokeStyle = '#2e7d32'
  ctx.lineWidth = r * 0.14
  const fronds = [
    [-0.9, -0.8], [0.9, -0.8], [0, -1.2], [-1.1, -0.2], [1.1, -0.2]
  ]
  for (let i = 0; i < fronds.length; i++) {
    ctx.beginPath()
    ctx.moveTo(cx, cy - r * 0.85)
    ctx.lineTo(cx + fronds[i][0] * r * 0.65, cy + fronds[i][1] * r * 0.65)
    ctx.stroke()
  }
}

function drawHutIcon(cx, cy, r) {
  const w = r * 1.1
  const h = r * 0.9

  // Body
  ctx.fillStyle = '#8d6e63'
  ctx.fillRect(cx - w * 0.5, cy - h * 0.2, w, h)

  // Roof
  ctx.fillStyle = '#5d4037'
  ctx.beginPath()
  ctx.moveTo(cx - w * 0.65, cy - h * 0.2)
  ctx.lineTo(cx, cy - h * 1.0)
  ctx.lineTo(cx + w * 0.65, cy - h * 0.2)
  ctx.closePath()
  ctx.fill()

  // Door
  ctx.fillStyle = '#3e2723'
  ctx.fillRect(cx - r * 0.2, cy + h * 0.8 - h * 0.7, r * 0.4, h * 0.7)
}

function drawTowerIcon(cx, cy, r) {
  const w = r * 0.9
  const h = r * 1.3

  // Body
  ctx.fillStyle = '#78909c'
  ctx.fillRect(cx - w * 0.5, cy - h * 0.5, w, h)

  // Battlements (3 merlons)
  ctx.fillStyle = '#90a4ae'
  const merlon = w * 0.28
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(cx + i * merlon - merlon * 0.45, cy - h * 0.5 - r * 0.4, merlon * 0.9, r * 0.4)
  }

  // Window slit
  ctx.fillStyle = '#263238'
  ctx.fillRect(cx - r * 0.1, cy - h * 0.2, r * 0.2, r * 0.45)
}

function drawGravestoneIcon(cx, cy, r) {
  ctx.fillStyle = '#90a4ae'
  // Vertical bar
  ctx.fillRect(cx - r * 0.18, cy - r, r * 0.36, r * 2)
  // Horizontal bar
  ctx.fillRect(cx - r, cy - r * 0.45, r * 2, r * 0.36)
  // Rounded top
  ctx.beginPath()
  ctx.arc(cx, cy - r, r * 0.18, Math.PI, 0)
  ctx.fillStyle = '#90a4ae'
  ctx.fill()
}

const UNIT_COLORS = ['', '#f9a825', '#ef5350', '#7b1fa2', '#1a237e']

function drawUnitIcon(unit, cx, cy, r) {
  const def = UNIT_DEFS[unit.level]
  const color = unit.moved ? '#9e9e9e' : UNIT_COLORS[unit.level]

  // Outer circle
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = unit.moved ? '#757575' : '#212121'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Letter from UNIT_DEFS to keep a single source of truth
  ctx.fillStyle = '#fff'
  ctx.font = 'bold ' + Math.round(r * 1.05) + 'px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(def ? def.symbol : '?', cx, cy + r * 0.05)
}

// ── Colour helpers ────────────────────────────────────────────────────────────

function darken(hexColor, amount) {
  const c = parseHexColor(hexColor)
  return 'rgb(' +
    Math.round(c.r * (1 - amount)) + ',' +
    Math.round(c.g * (1 - amount)) + ',' +
    Math.round(c.b * (1 - amount)) + ')'
}

function parseHexColor(hex) {
  const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 128, g: 128, b: 128 }
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

