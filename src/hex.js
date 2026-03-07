// Hex coordinate utilities using axial coordinates (pointy-top orientation)

var HEX_SIZE = 36

var HEX_DIRS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
]

function hexKey(q, r) {
  return q + ',' + r
}

function parseHexKey(key) {
  var parts = key.split(',')
  return { q: parseInt(parts[0], 10), r: parseInt(parts[1], 10) }
}

function hexNeighborKeys(q, r) {
  return HEX_DIRS.map(function (d) { return hexKey(q + d.q, r + d.r) })
}

function hexDistance(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2
}

// Convert axial coordinates to canvas pixel position (pointy-top)
function hexToPixel(q, r) {
  return {
    x: HEX_SIZE * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r),
    y: HEX_SIZE * 1.5 * r
  }
}

// Convert canvas pixel to nearest axial hex coordinate
function pixelToHex(px, py) {
  var q = (Math.sqrt(3) / 3 * px - 1 / 3 * py) / HEX_SIZE
  var r = (2 / 3 * py) / HEX_SIZE
  return hexRound(q, r)
}

function hexRound(q, r) {
  var s = -q - r
  var rq = Math.round(q)
  var rr = Math.round(r)
  var rs = Math.round(s)
  var dq = Math.abs(rq - q)
  var dr = Math.abs(rr - r)
  var ds = Math.abs(rs - s)
  if (dq > dr && dq > ds) {
    rq = -rr - rs
  } else if (dr > ds) {
    rr = -rq - rs
  }
  return { q: rq, r: rr }
}

// Get the 6 corner points of a pointy-top hex centered at (cx, cy)
function hexCorners(cx, cy) {
  var pts = []
  for (var i = 0; i < 6; i++) {
    var angleDeg = 60 * i - 30 // pointy-top: first corner at -30°
    var angleRad = Math.PI / 180 * angleDeg
    pts.push({
      x: cx + HEX_SIZE * Math.cos(angleRad),
      y: cy + HEX_SIZE * Math.sin(angleRad)
    })
  }
  return pts
}

export { HEX_SIZE, hexKey, parseHexKey, hexNeighborKeys, hexDistance, hexToPixel, pixelToHex, hexCorners }

