// Main game orchestrator: state creation, button handlers, UI updates

import { PLAYER_HEX_COLORS, initRenderer, resizeCanvas, render } from './renderer.js'
import { generateHexMap, placeStartingTerritories } from './map.js'
import { PEASANT_COST, TOWER_COST, getBuyPlacementHexes } from './movement.js'
import { startTurn, endTurn, undoTurn } from './turn-system.js'
import { initInput } from './input.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { UNIT_DEFS } from './units.js'
import { TERRAIN_WATER } from './constants.js'
import { isAIPlayer, runAITurn, appendToLog } from './ai.js'
import { startTraining, stopTraining, resetTraining, isTrainingActive, getTrainingStats } from './train.js'

const NUM_PLAYERS = 2       // number of active players (human + AI)
const NUM_TOTAL_PLAYERS = 6 // total players always present on the map
const AI_PLAYERS = [1]      // player indices that are AI-controlled
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
  document.getElementById('btnEndTurn').addEventListener('click', async function () {
    if (gameState.gameOver) return
    appendToLog(gameState, 'Turn ' + (gameState.turn + 1) + ': ' +
      gameState.players[gameState.activePlayer].name + ' ended their turn')
    endTurn(gameState)
    checkWinCondition(gameState)
    render(gameState)
    updateUI(gameState)
    await runPendingAITurns()
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

  // Training panel buttons
  const btnTrain = document.getElementById('btnTrain')
  const btnStopTrain = document.getElementById('btnStopTrain')
  const btnResetTrain = document.getElementById('btnResetTrain')

  if (btnTrain) {
    btnTrain.addEventListener('click', function () {
      btnTrain.disabled     = true
      btnStopTrain.disabled = false
      startTraining(function (stats) {
        updateTrainingUI(stats)
      })
    })
  }

  if (btnStopTrain) {
    btnStopTrain.disabled = true
    btnStopTrain.addEventListener('click', function () {
      stopTraining()
      btnTrain.disabled     = false
      btnStopTrain.disabled = true
      updateTrainingUI(getTrainingStats())
    })
  }

  if (btnResetTrain) {
    btnResetTrain.addEventListener('click', function () {
      if (!confirm('Reset all training data? The AI will start learning from scratch.')) return
      resetTraining()
      btnTrain.disabled     = false
      btnStopTrain.disabled = true
      updateTrainingUI(null)
    })
  }
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
    winner: null,
    aiPlayers: AI_PLAYERS,
    actionLog: [],
    aiThinking: false
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

  // Guard: make sure there is at least one valid placement hex
  const placement = getBuyPlacementHexes(state, territory)
  if (placement.ownHexes.length === 0 && placement.adjacentHexes.length === 0) {
    setMessage(state, 'No valid hex to place a peasant — all adjacent hexes are defended.')
    updateUI(state)
    return
  }

  // Enter buy mode: player clicks a highlighted hex to place the peasant.
  // Green = own land/gravestone, yellow-green = tree (gets cleared),
  // orange = undefended adjacent hex (parachute drop).
  state.mode = 'buy'
  state.selectedHex = territory.hutHexKey
  state.validMoves = []
  setMessage(state, 'Click a highlighted hex to place the peasant.')
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
  const aiTurn = isAIPlayer(state, state.activePlayer)

  const nameLabel = aiTurn
    ? '🤖 ' + player.name + ' (AI)' + (state.aiThinking ? ' – thinking…' : "'s Turn")
    : player.name + "'s Turn"
  document.getElementById('playerName').textContent = nameLabel
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
    msgEl.textContent = 'Click a highlighted hex to place your peasant (green = land, yellow = tree, orange = parachute).'
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
  const humanTurn = notOver && !isAIPlayer(state, state.activePlayer)
  const activeTerritoryHasGoldForUnit = humanTurn && !state.aiThinking &&
    state.territories.some(function (t) {
      return t.owner === state.activePlayer && t.bank >= PEASANT_COST
    })
  const activeTerritoryHasGoldForTower = humanTurn && !state.aiThinking &&
    state.territories.some(function (t) {
      return t.owner === state.activePlayer && t.bank >= TOWER_COST
    })

  document.getElementById('btnBuyUnit').disabled = !activeTerritoryHasGoldForUnit
  document.getElementById('btnBuildTower').disabled = !activeTerritoryHasGoldForTower
  document.getElementById('btnEndTurn').disabled = !humanTurn || !!state.aiThinking
  document.getElementById('btnUndo').disabled = !humanTurn || !!state.aiThinking

  // Legend sidebar
  updateLegend(state)

  // AI log panel
  updateAILog(state)
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

function updateAILog(state) {
  const el = document.getElementById('aiLog')
  if (!el || !state.actionLog || state.actionLog.length === 0) return
  const recent = state.actionLog.slice(-8)
  el.innerHTML = recent.map(function (entry) {
    return '<p>' + entry + '</p>'
  }).join('')
  el.scrollTop = el.scrollHeight
}

function setMessage(state, msg) {
  state.message = msg
}

// Run AI turns for as long as the active player is AI-controlled.
// Shows "thinking..." in the UI while waiting for the LLM response.
async function runPendingAITurns() {
  while (!gameState.gameOver && isAIPlayer(gameState, gameState.activePlayer)) {
    gameState.aiThinking = true
    render(gameState)
    updateUI(gameState)

    // Small pause so the player can see the transition before the AI acts
    await new Promise(function (resolve) { setTimeout(resolve, 500) })

    await runAITurn(gameState)

    gameState.aiThinking = false
    appendToLog(gameState, 'Turn ' + (gameState.turn + 1) + ': ' +
      gameState.players[gameState.activePlayer].name + ' (AI) ended their turn')
    endTurn(gameState)
    checkWinCondition(gameState)
    render(gameState)
    updateUI(gameState)

    // Brief pause after AI moves so the human can review
    await new Promise(function (resolve) { setTimeout(resolve, 300) })
  }
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

// Update TF.js readiness status once all external scripts have loaded.
// The script tag loads asynchronously so we check after window 'load'.
window.addEventListener('load', function () {
  const statusEl = document.getElementById('trainStatus')
  if (!statusEl) return
  if (typeof globalThis.tf !== 'undefined') {
    statusEl.textContent = 'Ready to train. Click ▶ Start.'
  } else {
    statusEl.textContent = 'TF.js failed to load – training unavailable.'
  }
})

function updateTrainingUI(stats) {
  const statusEl = document.getElementById('trainStatus')
  const progressEl = document.getElementById('trainProgress')
  if (!statusEl || !progressEl) return

  if (!stats) {
    statusEl.textContent = 'No training data. Click ▶ Start to begin.'
    progressEl.textContent = ''
    return
  }

  const running = isTrainingActive()
  statusEl.textContent = running ? '⚙ Training…' : '⏸ Paused'
  progressEl.innerHTML =
    'Gen <b>' + stats.generation + '</b> | ' +
    'Games <b>' + stats.totalGames + '</b><br>' +
    'Best fitness: <b>' + (stats.bestFitness || 0).toFixed(2) + '</b> ' +
    '(all-time: ' + (stats.bestFitnessEver || 0).toFixed(2) + ')<br>' +
    (stats.mutRate ? 'Mutation rate: ' + (stats.mutRate * 100).toFixed(1) + '%' : '') +
    (stats.numWorkers ? ' | Workers: ' + stats.numWorkers : '')
}

export { updateUI }

