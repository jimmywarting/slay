// Main game orchestrator: state creation, button handlers, UI updates

import { PLAYER_HEX_COLORS, initRenderer, resizeCanvas, render } from './renderer.js'
import { generateHexMap, placeStartingTerritories } from './map.js'
import { PEASANT_COST, TOWER_COST } from './movement.js'
import { startTurn, endTurn, undoTurn } from './turn-system.js'
import { initInput } from './input.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { UNIT_DEFS } from './units.js'
import { TERRAIN_WATER } from './constants.js'

const NUM_PLAYERS = 2  // number of active (human-controlled) players
const NUM_TOTAL_PLAYERS = 6  // total players always present on the map
const PLAYER_NAMES = ['Olive', 'Forest', 'Gold', 'Fern', 'Sage', 'Lime']

let gameState = null

// ── Initialisation ────────────────────────────────────────────────────────────

function initGame() {
  const canvasEl = document.getElementById('gameCanvas')
  initRenderer(canvasEl)

  gameState = createGameState(NUM_PLAYERS)
  initInput(canvasEl, gameState, updateUI)

  render(gameState)
  updateUI(gameState)

  // Button handlers
  document.getElementById('btnEndTurn').addEventListener('click', function () {
    if (gameState.gameOver) return
    endTurn(gameState)
    checkWinCondition(gameState)
    render(gameState)
    updateUI(gameState)
  })

  document.getElementById('btnUndo').addEventListener('click', function () {
    if (gameState.gameOver) return
    undoTurn(gameState)
    render(gameState)
    updateUI(gameState)
  })

  document.getElementById('btnBuyUnit').addEventListener('click', function () {
    if (gameState.gameOver) return
    handleBuyUnit(gameState)
  })

  document.getElementById('btnBuildTower').addEventListener('click', function () {
    if (gameState.gameOver) return
    handleBuildTower(gameState)
  })

  window.addEventListener('resize', function () {
    resizeCanvas()
    render(gameState)
  })
}

function createGameState(numActivePlayers) {
  // Always create all 6 players; only the first numActivePlayers are active
  const players = []
  for (let i = 0; i < NUM_TOTAL_PLAYERS; i++) {
    players.push({
      id: i,
      name: PLAYER_NAMES[i],
      color: PLAYER_HEX_COLORS[i % PLAYER_HEX_COLORS.length]
    })
  }

  const hexes = generateHexMap()
  const territories = placeStartingTerritories(hexes, numActivePlayers)

  const state = {
    players: players,
    numActivePlayers: numActivePlayers,
    hexes: hexes,
    territories: territories,
    turn: 0,
    activePlayer: 0,
    selectedHex: null,
    selectedUnit: null,
    validMoves: [],
    freeMoves: {},
    mode: 'normal',  // 'normal' | 'buy' | 'build'
    turnSnapshot: null,
    message: '',
    gameOver: false,
    winner: null
  }

  startTurn(state)
  return state
}

// ── Button handlers ───────────────────────────────────────────────────────────

function handleBuyUnit(state) {
  // Find the territory for the selected hex (or any territory of active player)
  let territory = null
  if (state.selectedHex) {
    territory = getTerritoryForHex(state, state.selectedHex)
    if (territory && territory.owner !== state.activePlayer) territory = null
  }

  // Fallback: first territory with enough gold
  if (!territory) {
    for (let i = 0; i < state.territories.length; i++) {
      const t = state.territories[i]
      if (t.owner === state.activePlayer && t.bank >= PEASANT_COST) {
        territory = t
        break
      }
    }
  }

  if (!territory || territory.bank < PEASANT_COST) {
    setMessage(state, 'Not enough gold to buy a peasant (costs ' + PEASANT_COST + ').')
    updateUI(state)
    return
  }

  // Enter buy mode: player clicks the hex to place the peasant
  state.mode = 'buy'
  state.selectedHex = territory.hutHexKey
  state.validMoves = []
  setMessage(state, 'Click an empty land hex in your territory to place the peasant.')
  render(state)
  updateUI(state)
}

function handleBuildTower(state) {
  // Find territory with enough gold
  let territory = null
  if (state.selectedHex) {
    territory = getTerritoryForHex(state, state.selectedHex)
    if (territory && territory.owner !== state.activePlayer) territory = null
  }
  if (!territory) {
    for (let i = 0; i < state.territories.length; i++) {
      const t = state.territories[i]
      if (t.owner === state.activePlayer && t.bank >= TOWER_COST) {
        territory = t
        break
      }
    }
  }

  if (!territory || territory.bank < TOWER_COST) {
    setMessage(state, 'Not enough gold to build a tower (costs ' + TOWER_COST + ').')
    updateUI(state)
    return
  }

  state.mode = 'build'
  state.validMoves = []
  setMessage(state, 'Click an empty land hex in your territory to build the tower.')
  render(state)
  updateUI(state)
}

// ── UI updates ────────────────────────────────────────────────────────────────

function updateUI(state) {
  const player = state.players[state.activePlayer]

  document.getElementById('playerName').textContent = player.name + "'s Turn"
  document.getElementById('playerName').style.color = player.color
  document.getElementById('turnNumber').textContent = 'Turn ' + (state.turn + 1)

  // Territory info for selected hex
  const infoEl = document.getElementById('territoryInfo')
  const territory = state.selectedHex ? getTerritoryForHex(state, state.selectedHex) : null

  if (territory) {
    const income = computeIncome(state, territory)
    const upkeep = computeUpkeep(state, territory)
    const owner = state.players[territory.owner]
    infoEl.innerHTML =
      '<strong>' + owner.name + ' Territory</strong><br>' +
      'Hexes: ' + territory.hexKeys.length + '<br>' +
      'Bank: <b>' + territory.bank + ' g</b><br>' +
      'Income: +' + income + ' / Upkeep: -' + upkeep + '<br>' +
      'Net: ' + (income - upkeep) + ' per turn'
  } else {
    infoEl.innerHTML = '<em>Click a hex to see territory info</em>'
  }

  // Selected hex info
  const hexInfoEl = document.getElementById('hexInfo')
  if (state.selectedHex) {
    const hex = state.hexes[state.selectedHex]
    if (hex) {
      let desc = 'Hex (' + hex.q + ', ' + hex.r + ')  terrain: ' + hex.terrain
      if (hex.owner !== null) desc += '  owner: ' + state.players[hex.owner].name
      if (hex.unit) {
        const ud = UNIT_DEFS[hex.unit.level]
        desc += '<br>Unit: ' + ud.name + ' (str ' + ud.strength + ', upkeep ' + ud.upkeep + ')'
        if (hex.unit.moved) desc += ' <em>[moved]</em>'
      }
      if (hex.structure) desc += '<br>Structure: ' + hex.structure
      hexInfoEl.innerHTML = desc
    }
  } else {
    hexInfoEl.innerHTML = ''
  }

  // Mode message
  const msgEl = document.getElementById('message')
  if (state.gameOver) {
    const winnerName = state.winner !== null ? state.players[state.winner].name : 'Nobody'
    msgEl.textContent = '🏆 Game Over – ' + winnerName + ' wins!'
    msgEl.style.color = state.winner !== null ? state.players[state.winner].color : '#ecf0f1'
  } else if (state.mode === 'buy') {
    msgEl.textContent = 'Click a green hex to place your peasant.'
    msgEl.style.color = '#f39c12'
  } else if (state.mode === 'build') {
    msgEl.textContent = 'Click a purple-tinted hex to build a tower.'
    msgEl.style.color = '#f39c12'
  } else if (state.message) {
    msgEl.textContent = state.message
    msgEl.style.color = '#f39c12'
    state.message = ''
  } else {
    msgEl.textContent = ''
  }

  // Button states
  const notOver = !state.gameOver
  const activeTerritoryHasGoldForUnit = notOver && state.territories.some(function (t) {
    return t.owner === state.activePlayer && t.bank >= PEASANT_COST
  })
  const activeTerritoryHasGoldForTower = notOver && state.territories.some(function (t) {
    return t.owner === state.activePlayer && t.bank >= TOWER_COST
  })

  document.getElementById('btnBuyUnit').disabled = !activeTerritoryHasGoldForUnit
  document.getElementById('btnBuildTower').disabled = !activeTerritoryHasGoldForTower
  document.getElementById('btnEndTurn').disabled = state.gameOver
  document.getElementById('btnUndo').disabled = state.gameOver

  // Legend sidebar
  updateLegend(state)
}

function updateLegend(state) {
  const el = document.getElementById('legend')
  if (!el) return

  const rows = UNIT_DEFS.slice(1).map(function (u) {
    return '<tr><td>' + u.name + '</td><td>' + u.strength + '</td>' +
           '<td>' + u.upkeep + '</td>' +
           (u.cost ? '<td>' + u.cost + '</td>' : '<td>—</td>') + '</tr>'
  }).join('')

  el.innerHTML =
    '<table class="legend-table">' +
    '<thead><tr><th>Unit</th><th>Str</th><th>Upk</th><th>Cost</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>'
}

function setMessage(state, msg) {
  state.message = msg
}

// A player wins when every non-water hex on the island belongs to them.
// A player is eliminated when they own no hexes at all.
function checkWinCondition(state) {
  if (state.gameOver) return

  // Count land-owning players
  const ownedBy = {}
  for (const k in state.hexes) {
    const hex = state.hexes[k]
    if (hex.terrain !== TERRAIN_WATER && hex.owner !== null) {
      ownedBy[hex.owner] = true
    }
  }

  const activePlayers = Object.keys(ownedBy).map(Number)
  if (activePlayers.length === 1) {
    state.gameOver = true
    state.winner = activePlayers[0]
  } else if (activePlayers.length === 0) {
    state.gameOver = true
    state.winner = null
  }
}

// Kick everything off once the DOM is ready
window.addEventListener('DOMContentLoaded', initGame)

export { updateUI }

