// Main game orchestrator: state creation, button handlers, UI updates

import { PLAYER_HEX_COLORS, initRenderer, resizeCanvas, render } from './renderer.js'
import { generateHexMap, placeStartingTerritories } from './map.js'
import { PEASANT_COST, TOWER_COST, getBuyPlacementHexes } from './movement.js'
import { startTurn, endTurn, undoTurn } from './turn-system.js'
import { initInput } from './input.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { UNIT_DEFS } from './units.js'
import { STRUCTURE_HUT } from './constants.js'
import { isAIPlayer, runAITurn, appendToLog } from './ai.js'
import { getActiveNeuralAgent } from './agent-store.js'
import { startTraining, stopTraining, resetTraining, isTrainingActive, getTrainingStats } from './train.js'

const NUM_PLAYERS = 6       // number of active players (human + AI)
const NUM_TOTAL_PLAYERS = 6 // total players always present on the map
const AI_PLAYERS = [1,2,3,4,5]      // player indices that are AI-controlled
const PLAYER_NAMES = ['Olive', 'Forest', 'Gold', 'Fern', 'Sage', 'Lime']

let gameState = null
let watchMode = false       // true while watch loop is running
let watchLoopActive = false // guards against multiple concurrent loops

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

  const BUY_BUTTON_IDS = ['btnBuyPeasant', 'btnBuySpearman', 'btnBuyKnight', 'btnBuyBaron']
  for (let lvl = 1; lvl <= 4; lvl++) {
    ;(function (level) {
      const btn = document.getElementById(BUY_BUTTON_IDS[level - 1])
      if (btn) {
        btn.addEventListener('click', function () {
          if (gameState.gameOver) return
          handleBuyUnit(gameState, level)
        })
      }
    })(lvl)
  }

  document.getElementById('btnBuildTower').addEventListener('click', function () {
    if (gameState.gameOver) return
    handleBuildTower(gameState)
  })

  window.addEventListener('resize', function () {
    resizeCanvas()
    render(gameState)
  })

  const btnWatchAI = document.getElementById('btnWatchAI')
  const btnNewGame = document.getElementById('btnNewGame')

  // Training panel buttons
  const btnTrain      = document.getElementById('btnTrain')
  const btnStopTrain  = document.getElementById('btnStopTrain')
  const btnResetTrain = document.getElementById('btnResetTrain')

  if (btnTrain) {
    btnTrain.addEventListener('click', function () {
      btnTrain.disabled     = true
      btnStopTrain.disabled = false
      startTraining(function (stats) { updateTrainingUI(stats) })
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

  if (btnWatchAI) {
    btnWatchAI.addEventListener('click', function () {
      if (watchLoopActive) {
        stopWatchMode()
      } else {
        startWatchMode()
      }
    })
  }

  if (btnNewGame) {
    btnNewGame.addEventListener('click', function () {
      stopWatchMode()
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
    buyLevel: 1,     // unit level being bought in 'buy' mode
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

function handleBuyUnit(state, level) {
  if (level === undefined) level = 1
  const unitDef = UNIT_DEFS[level]
  const cost = unitDef.cost

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
      if (t.owner === state.activePlayer && t.bank >= cost) {
        territory = t
        break
      }
    }
  }

  if (!territory || territory.bank < cost) {
    setMessage(state, 'Not enough gold to buy a ' + unitDef.name + ' (costs ' + cost + ').')
    updateUI(state)
    return
  }

  // Guard: make sure there is at least one valid placement hex
  const placement = getBuyPlacementHexes(state, territory, level)
  if (placement.ownHexes.length === 0 && placement.mergeHexes.length === 0 && placement.adjacentHexes.length === 0) {
    setMessage(state, 'No valid hex to place a ' + unitDef.name + ' — all adjacent hexes are defended.')
    updateUI(state)
    return
  }

  // Enter buy mode: player clicks a highlighted hex to place the unit.
  state.mode = 'buy'
  state.buyLevel = level
  state.selectedHex = territory.hutHexKey
  state.validMoves = []
  setMessage(state, 'Click a highlighted hex to place the ' + unitDef.name + '.')
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

  // Show which type of model (neural / heuristic) the current AI player is using.
  const neuralAgent = getActiveNeuralAgent()
  const aiLabel     = neuralAgent ? ('🧠 [gen ' + neuralAgent.generation + ']') : '🤖'

  const thinkingSuffix = state.aiThinking ? ' – thinking…' : "'s Turn"
  const nameLabel = watchLoopActive
    ? '👁 ' + player.name + ' (AI ' + (neuralAgent ? 'Neural' : 'Heuristic') + ')' + thinkingSuffix
    : aiTurn
      ? aiLabel + ' ' + player.name + thinkingSuffix
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

  // Enable/disable each buy button based on whether the player can afford that unit
  const BUY_BTN_IDS = ['btnBuyPeasant', 'btnBuySpearman', 'btnBuyKnight', 'btnBuyBaron']
  for (let lvl = 1; lvl <= 4; lvl++) {
    const cost = UNIT_DEFS[lvl].cost
    const canAfford = humanTurn && !state.aiThinking &&
      state.territories.some(function (t) {
        return t.owner === state.activePlayer && t.bank >= cost
      })
    const btn = document.getElementById(BUY_BTN_IDS[lvl - 1])
    if (btn) btn.disabled = !canAfford
  }

  const activeTerritoryHasGoldForTower = humanTurn && !state.aiThinking &&
    state.territories.some(function (t) {
      return t.owner === state.activePlayer && t.bank >= TOWER_COST
    })

  document.getElementById('btnBuildTower').disabled = !activeTerritoryHasGoldForTower
  document.getElementById('btnEndTurn').disabled = !humanTurn || !!state.aiThinking
  document.getElementById('btnUndo').disabled = !humanTurn || !!state.aiThinking

  // Watch AI button: toggle label and colour based on active state.
  const btnWatchAI = document.getElementById('btnWatchAI')
  if (btnWatchAI) {
    btnWatchAI.textContent = watchLoopActive ? '⏹ Stop Watching' : '👁 Watch AI'
    btnWatchAI.classList.toggle('watching', watchLoopActive)
    btnWatchAI.disabled = false
  }

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

// ── Watch mode ────────────────────────────────────────────────────────────────

// Start a continuous AI-vs-AI exhibition: all active players are AI-controlled.
// Games restart automatically with a short pause between them until stopped.
async function startWatchMode() {
  if (watchLoopActive) return
  watchMode = true
  watchLoopActive = true

  // All active player slots become AI-controlled.
  const aiPlayerIndices = Array.from({ length: NUM_PLAYERS }, function (_, i) { return i })

  gameState = createGameState(NUM_PLAYERS)
  gameState.aiPlayers = aiPlayerIndices
  render(gameState)
  updateUI(gameState)

  while (watchMode) {
    await runPendingAITurns()
    if (!watchMode) break

    // Show the result briefly before restarting.
    render(gameState)
    updateUI(gameState)
    await new Promise(function (resolve) { setTimeout(resolve, 2500) })
    if (!watchMode) break

    gameState = createGameState(NUM_PLAYERS)
    gameState.aiPlayers = aiPlayerIndices
    render(gameState)
    updateUI(gameState)
  }

  watchLoopActive = false
  updateUI(gameState)
}

// Stop the watch loop and reset to a normal human-vs-AI game.
function stopWatchMode() {
  watchMode = false
  // Replacing gameState makes the running loop's isAIPlayer check fail on the
  // very next iteration, cleanly aborting runPendingAITurns without extra flags.
  gameState = createGameState(NUM_PLAYERS)
  render(gameState)
  updateUI(gameState)
}

// Run AI turns for as long as the active player is AI-controlled.
// Shows "thinking..." in the UI while waiting for the LLM response.
async function runPendingAITurns() {
  while (!gameState.gameOver && isAIPlayer(gameState, gameState.activePlayer)) {
    gameState.aiThinking = true
    render(gameState)
    updateUI(gameState)

    // Abort immediately if gameState was replaced before we even sleep.
    if (!isAIPlayer(gameState, gameState.activePlayer)) break

    // Small pause so the player can see the transition before the AI acts
    await new Promise(function (resolve) { setTimeout(resolve, 500) })

    // Abort if gameState was replaced (e.g. stop-watch / new-game clicked) during the sleep.
    if (!isAIPlayer(gameState, gameState.activePlayer)) break

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

// A player wins when all opponents own no huts (they have been eliminated).
// A player is also considered active only while they still own at least one hut.
function checkWinCondition(state) {
  if (state.gameOver) return

  // Determine which players still own at least one hut
  const hasHut = {}
  for (const k in state.hexes) {
    const hex = state.hexes[k]
    if (hex.structure === STRUCTURE_HUT && hex.owner !== null) {
      hasHut[hex.owner] = true
    }
  }

  const playersWithHuts = Object.keys(hasHut).map(Number)
  if (playersWithHuts.length === 1) {
    state.gameOver = true
    state.winner = playersWithHuts[0]
  } else if (playersWithHuts.length === 0) {
    state.gameOver = true
    state.winner = null
  }
}

// Kick everything off once the DOM is ready
window.addEventListener('DOMContentLoaded', initGame)

// Update TF.js readiness status once all external scripts have loaded.
window.addEventListener('load', function () {
  const statusEl = document.getElementById('trainStatus')
  if (!statusEl) return

  const savedAgent = getActiveNeuralAgent()
  if (savedAgent) {
    // A model was saved in a previous session — show its status
    statusEl.textContent = '💾 Model loaded from generation ' + savedAgent.generation + '. Ready to play or continue training.'
    statusEl.style.color = '#27ae60'
    updateTrainingUI(getTrainingStats())
  } else if (typeof globalThis.tf !== 'undefined') {
    statusEl.textContent = 'TF.js ready. No model trained yet — click ▶ Start.'
  } else {
    statusEl.textContent = 'TF.js failed to load – training unavailable.'
  }
})

function updateTrainingUI(stats) {
  const statusEl   = document.getElementById('trainStatus')
  const progressEl = document.getElementById('trainProgress')
  const chartEl    = document.getElementById('trainChart')
  if (!statusEl || !progressEl) return

  if (!stats) {
    statusEl.textContent   = 'No training data. Click ▶ Start to begin.'
    progressEl.innerHTML   = ''
    if (chartEl) chartEl.innerHTML = ''
    return
  }

  const running     = isTrainingActive()
  const savedAgent  = getActiveNeuralAgent()
  const modelStatus = savedAgent
    ? '💾 Model saved — Gen ' + savedAgent.generation + ' (used by AI)'
    : '⚠ No model saved yet'

  statusEl.textContent = running ? '⚙ Training in progress…' : '⏸ Training paused'
  statusEl.style.color = running ? '#2ecc71' : '#95a5a6'

  const totalDecided = stats.wins + stats.losses + stats.draws
  const winPct  = totalDecided > 0 ? Math.round(100 * stats.wins / totalDecided) : 0
  const lossPct = totalDecided > 0 ? Math.round(100 * stats.losses / totalDecided) : 0
  const drwPct  = totalDecided > 0 ? Math.round(100 * stats.draws / totalDecided) : 0

  const genTotal = (stats.genWins || 0) + (stats.genLosses || 0) + (stats.genDraws || 0)
  const genWinPct  = genTotal > 0 ? Math.round(100 * (stats.genWins || 0) / genTotal) : 0
  const genLossPct = genTotal > 0 ? Math.round(100 * (stats.genLosses || 0) / genTotal) : 0
  const genDrawPct = genTotal > 0 ? Math.round(100 * (stats.genDraws || 0) / genTotal) : 0

  progressEl.innerHTML =
    '<div style="color:#27ae60">' + modelStatus + '</div>' +
    '<div style="margin-top:4px">' +
      'Gen <b>' + stats.generation + '</b> &nbsp;|&nbsp; Games <b>' + stats.totalGames + '</b>' +
    '</div>' +
    '<div style="color:#95a5a6">' +
      'Current gen progress: <b>' + (stats.genGamesDone || 0) + '</b>/<b>' + (stats.genGamesPlanned || 0) + '</b>' +
    '</div>' +
    '<div>' +
      'Best fitness: <b>' + (stats.bestFitness || 0).toFixed(1) + '</b>' +
      ' &nbsp;All-time: <b>' + (stats.bestFitnessEver || 0).toFixed(1) + '</b>' +
    '</div>' +
    (genTotal > 0
      ? '<div>Gen W/L/D: ' +
          '<span style="color:#2ecc71"><b>' + (stats.genWins || 0) + '</b></span>/' +
          '<span style="color:#e74c3c"><b>' + (stats.genLosses || 0) + '</b></span>/' +
          '<span style="color:#95a5a6"><b>' + (stats.genDraws || 0) + '</b></span>' +
          ' (' + genWinPct + '%/' + genLossPct + '%/' + genDrawPct + '%)' +
        '</div>'
      : '') +
    (totalDecided > 0
      ? '<div>Total W/L/D: ' +
          '<span style="color:#2ecc71"><b>' + stats.wins + '</b></span>/' +
          '<span style="color:#e74c3c"><b>' + stats.losses + '</b></span>/' +
          '<span style="color:#95a5a6"><b>' + stats.draws + '</b></span>' +
          ' (' + winPct + '%/' + lossPct + '%/' + drwPct + '%)' +
        '</div>'
      : '') +
    '<div style="color:#7f8c8d;font-size:0.7rem;margin-top:2px">' +
      'Workers: ' + stats.numWorkers + ' &nbsp;|&nbsp; Mutation σ: ' + (stats.mutRate * 100).toFixed(1) + '%' +
    '</div>'

  // Fitness sparkline using block characters
  if (chartEl && stats.fitnessHistory && stats.fitnessHistory.length > 1) {
    const hist = stats.fitnessHistory
    const maxFit = Math.max.apply(null, hist.map(function (h) { return h.fitness }))
    const minFit = Math.min.apply(null, hist.map(function (h) { return h.fitness }))
    const range  = Math.max(1, maxFit - minFit)
    const bars   = '▁▂▃▄▅▆▇█'
    const last   = Math.min(32, hist.length)
    let sparkline = ''
    for (let i = hist.length - last; i < hist.length; i++) {
      const norm = (hist[i].fitness - minFit) / range
      sparkline += bars[Math.round(norm * (bars.length - 1))]
    }
    chartEl.textContent = sparkline
    chartEl.title       = 'Fitness over last ' + last + ' generations'
  } else if (chartEl) {
    chartEl.textContent = ''
  }
}


export { updateUI }
