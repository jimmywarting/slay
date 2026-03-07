// Renderer: draws the game map on an HTML Canvas element

var PLAYER_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#d35400']
var PLAYER_HEX_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#e67e22']
var NEUTRAL_LAND_COLOR = '#7dbe6a'
var WATER_COLOR = '#2471a3'
var WATER_DEEP_COLOR = '#1a5276'

var canvas, ctx, offsetX, offsetY

function initRenderer(canvasEl) {
  canvas = canvasEl
  ctx = canvas.getContext('2d')
  resizeCanvas()
}

function resizeCanvas() {
  var sidebar = document.getElementById('sidebar')
  var sidebarWidth = sidebar ? sidebar.offsetWidth : 280
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
  var keys = Object.keys(state.hexes)
  for (var i = 0; i < keys.length; i++) {
    var hex = state.hexes[keys[i]]
    if (hex.terrain !== TERRAIN_WATER) drawHexBase(state, hex)
  }
  // Draw water on top for correct overlap at edges
  for (var j = 0; j < keys.length; j++) {
    var wh = state.hexes[keys[j]]
    if (wh.terrain === TERRAIN_WATER) drawWaterHex(wh)
  }

  // Valid move highlights
  for (var vi = 0; vi < state.validMoves.length; vi++) {
    var vmk = state.validMoves[vi]
    var vmh = state.hexes[vmk]
    if (vmh) drawOverlay(vmh, 'rgba(255,230,0,0.45)', 0)
  }

  // Selected unit highlight
  if (state.selectedUnit) {
    var sh = state.hexes[state.selectedUnit]
    if (sh) drawOverlay(sh, 'rgba(255,255,255,0.5)', 2)
  }

  // Buy mode target highlight
  if (state.mode === 'buy') {
    var bkeys = Object.keys(state.hexes)
    for (var bi = 0; bi < bkeys.length; bi++) {
      var bh = state.hexes[bkeys[bi]]
      if (bh.owner === state.activePlayer &&
          bh.terrain === TERRAIN_LAND &&
          !bh.unit && !bh.structure) {
        drawOverlay(bh, 'rgba(0,220,100,0.35)', 0)
      }
    }
  }

  // Build tower mode target highlight
  if (state.mode === 'build') {
    var tkeys = Object.keys(state.hexes)
    for (var ti = 0; ti < tkeys.length; ti++) {
      var th = state.hexes[tkeys[ti]]
      if (th.owner === state.activePlayer &&
          th.terrain === TERRAIN_LAND &&
          !th.unit && !th.structure) {
        drawOverlay(th, 'rgba(150,100,255,0.35)', 0)
      }
    }
  }
}

function drawWaterHex(hex) {
  var pos = hexToPixel(hex.q, hex.r)
  var cx = pos.x + offsetX
  var cy = pos.y + offsetY
  var corners = hexCorners(cx, cy)

  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  for (var i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y)
  ctx.closePath()
  ctx.fillStyle = WATER_COLOR
  ctx.fill()
  ctx.strokeStyle = WATER_DEEP_COLOR
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawHexBase(state, hex) {
  var pos = hexToPixel(hex.q, hex.r)
  var cx = pos.x + offsetX
  var cy = pos.y + offsetY
  var corners = hexCorners(cx, cy)

  // Fill color
  var fillColor
  if (hex.owner !== null) {
    fillColor = PLAYER_HEX_COLORS[hex.owner % 4]
    // Darken for tree/palm
    if (hex.terrain === TERRAIN_TREE) fillColor = darken(fillColor, 0.25)
    else if (hex.terrain === TERRAIN_PALM) fillColor = darken(fillColor, 0.2)
  } else {
    if (hex.terrain === TERRAIN_TREE) fillColor = '#3d8b3d'
    else if (hex.terrain === TERRAIN_PALM) fillColor = '#2e7d32'
    else fillColor = NEUTRAL_LAND_COLOR
  }

  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  for (var i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y)
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
  var r = HEX_SIZE * 0.42

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
  var pos = hexToPixel(hex.q, hex.r)
  var cx = pos.x + offsetX
  var cy = pos.y + offsetY
  var corners = hexCorners(cx, cy)

  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  for (var i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y)
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
  var fronds = [
    [-0.9, -0.8], [0.9, -0.8], [0, -1.2], [-1.1, -0.2], [1.1, -0.2]
  ]
  for (var i = 0; i < fronds.length; i++) {
    ctx.beginPath()
    ctx.moveTo(cx, cy - r * 0.85)
    ctx.lineTo(cx + fronds[i][0] * r * 0.65, cy + fronds[i][1] * r * 0.65)
    ctx.stroke()
  }
}

function drawHutIcon(cx, cy, r) {
  var w = r * 1.1
  var h = r * 0.9

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
  var w = r * 0.9
  var h = r * 1.3

  // Body
  ctx.fillStyle = '#78909c'
  ctx.fillRect(cx - w * 0.5, cy - h * 0.5, w, h)

  // Battlements (3 merlons)
  ctx.fillStyle = '#90a4ae'
  var merlon = w * 0.28
  for (var i = -1; i <= 1; i++) {
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

var UNIT_COLORS = ['', '#f9a825', '#ef5350', '#7b1fa2', '#1a237e']

function drawUnitIcon(unit, cx, cy, r) {
  var def = UNIT_DEFS[unit.level]
  var color = unit.moved ? '#9e9e9e' : UNIT_COLORS[unit.level]

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
  var c = parseHexColor(hexColor)
  return 'rgb(' +
    Math.round(c.r * (1 - amount)) + ',' +
    Math.round(c.g * (1 - amount)) + ',' +
    Math.round(c.b * (1 - amount)) + ')'
}

function parseHexColor(hex) {
  var m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 128, g: 128, b: 128 }
}
