// Main game orchestrator: state creation, button handlers, UI updates

import { PLAYER_HEX_COLORS, initRenderer, resizeCanvas, render } from './renderer.js'
import { generateHexMap, placeStartingTerritories, MAP_SIZES } from './map.js'
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
import {
  initP2P, destroyP2P, broadcastAction,
  broadcastStartGame, sendStartGameTo, getLocalPlayerIndex,
  p2pBus, roomUrl, resolveOrGenerateRoomId, isJoining,
  MSG_HEX_CLICK, MSG_END_TURN, MSG_BUY_UNIT, MSG_BUILD_TOWER, MSG_UNDO_TURN
} from './p2p.js'

const NUM_TOTAL_PLAYERS = 6 // colour zones always on the map
const PLAYER_NAMES = ['Olive', 'Forest', 'Gold', 'Fern', 'Sage', 'Lime']

// Player roles: 'human' = local player, 'ai' = AI bot, 'none' = unused slot
const DEFAULT_ROLES = ['human', 'ai', 'ai', 'ai', 'ai', 'ai']

// Current game configuration (updated by the start screen)
// playerRoles[i]: 'human' | 'ai' | 'none'
let gameConfig = {
  mapSize: 'small',
  playerRoles: DEFAULT_ROLES.slice()
}

let gameState = null
let watchMode = false       // true while watch loop is running
let watchLoopActive = false // guards against multiple concurrent loops

// P2P state
let p2pActive       = false   // true while a P2P session is running
let p2pLocalIndex   = -1      // which player index we control in P2P mode
let _p2pRemoteActionResolver = null  // resolve() for waiting on remote moves
let _guestLobbyMode = false   // true when page loaded with an existing room hash (joining)

// Water density constants — controls how many random interior water hexes are placed
const MIN_WATER_DENSITY  = 0.10  // floor for low player counts
const BASE_WATER_DENSITY = 0.26  // default density for max players
const DENSITY_SCALE_STEP = 0.02  // density reduction per player below maximum
const MAX_PLAYERS        = 6

// Calculate water density for the given number of active players.
// Fewer players → slightly less water so there's enough land for everyone.
function calcWaterDensity(numActivePlayers) {
  return Math.max(MIN_WATER_DENSITY, BASE_WATER_DENSITY - (MAX_PLAYERS - numActivePlayers) * DENSITY_SCALE_STEP)
}

// ── Start screen ──────────────────────────────────────────────────────────────

function showStartScreen() {
  // Pause any running watch loop without creating a new gameState
  watchMode = false

  const screen = document.getElementById('startScreen')
  if (!screen) return

  // Populate the player list and room link based on current selections
  refreshPlayerPreview()
  refreshRoomLink()
  screen.style.display = 'flex'

  // Guest lobby: disable all config controls and hide Start button
  if (_guestLobbyMode) {
    const btnStart = document.getElementById('btnStartGame')
    if (btnStart) btnStart.style.display = 'none'
    screen.querySelectorAll('.role-btn, .start-size-btn').forEach(function (b) {
      b.disabled = true
    })
  }
}

function hideStartScreen() {
  const screen = document.getElementById('startScreen')
  if (screen) screen.style.display = 'none'
}

// Re-render the per-player role rows in the start screen
function refreshPlayerPreview() {
  const listEl = document.getElementById('startPlayerList')
  if (!listEl) return

  const roles = gameConfig.playerRoles
  let html = ''

  for (let i = 0; i < NUM_TOTAL_PLAYERS; i++) {
    const role  = roles[i] || 'none'
    const color = PLAYER_HEX_COLORS[i % PLAYER_HEX_COLORS.length]
    const name  = PLAYER_NAMES[i]

    const humanClass = role === 'human' ? ' active-human' : ''
    const aiClass    = role === 'ai'    ? ' active-ai'    : ''
    const noneClass  = role === 'none'  ? ' active-none'  : ''

    html += `<div class="player-row">` +
      `<span class="player-row-dot" style="background:${color}"></span>` +
      `<span class="player-row-name" style="color:${color}">${name}</span>` +
      `<div class="role-toggle">` +
        `<button class="role-btn${humanClass}" data-player="${i}" data-role="human">👤 Human</button>` +
        `<button class="role-btn${aiClass}"    data-player="${i}" data-role="ai"   >🤖 AI</button>` +
        `<button class="role-btn${noneClass}"  data-player="${i}" data-role="none" >✕ None</button>` +
      `</div></div>`
  }

  listEl.innerHTML = html

  // Wire role-button click events (disabled in guest lobby mode)
  if (!_guestLobbyMode) {
    listEl.querySelectorAll('.role-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const pi   = parseInt(btn.dataset.player, 10)
        const role = btn.dataset.role

        // Player 0 cannot be set to 'none'
        if (pi === 0 && role === 'none') return

        gameConfig.playerRoles[pi] = role
        refreshPlayerPreview()
        refreshRoomLink()
      })
    })
  }
}

// Update the room-link panel visibility and URL field
function refreshRoomLink() {
  const panel = document.getElementById('roomLinkPanel')
  if (!panel) return

  // Always show the room link panel in guest lobby mode
  const hasHuman = _guestLobbyMode || gameConfig.playerRoles.some(function (r) { return r === 'human' })
  panel.style.display = hasHuman ? '' : 'none'

  const input = document.getElementById('roomLinkInput')
  if (input) {
    // Generate / preserve room URL (use current hash if present, otherwise eagerly generate one)
    let url = roomUrl()
    if (!url) {
      // Pre-generate the room hash so the user can share before clicking Start Game.
      const id = resolveOrGenerateRoomId()
      url = window.location.origin + window.location.pathname + '#slay-' + id
    }
    input.value = url
  }

  const statusEl = document.getElementById('p2pStatus')
  if (statusEl) {
    if (_guestLobbyMode) {
      statusEl.textContent = p2pActive
        ? '⏳ Connected — waiting for host to start the game…'
        : '🔗 Connecting to room…'
      statusEl.className = p2pActive ? 'connected' : ''
    } else {
      statusEl.textContent = p2pActive
        ? '✅ Room active – share the link above'
        : 'Not connected – start the game to open the room.'
      statusEl.className = p2pActive ? 'connected' : ''
    }
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────

function initGame() {
  const canvasEl = document.getElementById('gameCanvas')
  initRenderer(canvasEl)

  // Pass a getter so input always uses the live gameState reference.
  // Also pass an isLocalTurn predicate so input is blocked during remote turns.
  initInput(canvasEl, function () { return gameState }, updateUI, function (state) {
    if (!state) return false
    if (!p2pActive) return true                      // no P2P — always local
    return state.activePlayer === p2pLocalIndex      // only our own turn
  })

  // Button handlers — guard against null gameState (before first game starts)
  document.getElementById('btnEndTurn').addEventListener('click', async function () {
    if (!gameState || gameState.gameOver) return
    if (p2pActive && gameState.activePlayer !== p2pLocalIndex) return  // not our turn
    appendToLog(gameState, 'Turn ' + (gameState.turn + 1) + ': ' +
      gameState.players[gameState.activePlayer].name + ' ended their turn')
    endTurn(gameState)
    checkWinCondition(gameState)
    render(gameState)
    updateUI(gameState)
    // Broadcast the end-turn event so peers advance their game state
    if (p2pActive) broadcastAction({ type: MSG_END_TURN, from: p2pLocalIndex })
    await runPendingAITurns()
  })

  document.getElementById('btnUndo').addEventListener('click', function () {
    if (!gameState || gameState.gameOver) return
    if (p2pActive && gameState.activePlayer !== p2pLocalIndex) return
    undoTurn(gameState)
    render(gameState)
    updateUI(gameState)
    if (p2pActive) broadcastAction({ type: MSG_UNDO_TURN, from: p2pLocalIndex })
  })

  const BUY_BUTTON_IDS = ['btnBuyPeasant', 'btnBuySpearman', 'btnBuyKnight', 'btnBuyBaron']
  for (let lvl = 1; lvl <= 4; lvl++) {
    ;(function (level) {
      const btn = document.getElementById(BUY_BUTTON_IDS[level - 1])
      if (btn) {
        btn.addEventListener('click', function () {
          if (!gameState || gameState.gameOver) return
          if (p2pActive && gameState.activePlayer !== p2pLocalIndex) return
          if (p2pActive) broadcastAction({ type: MSG_BUY_UNIT, level: level, from: p2pLocalIndex })
          handleBuyUnit(gameState, level)
        })
      }
    })(lvl)
  }

  document.getElementById('btnBuildTower').addEventListener('click', function () {
    if (!gameState || gameState.gameOver) return
    if (p2pActive && gameState.activePlayer !== p2pLocalIndex) return
    if (p2pActive) broadcastAction({ type: MSG_BUILD_TOWER, from: p2pLocalIndex })
    handleBuildTower(gameState)
  })

  window.addEventListener('resize', function () {
    resizeCanvas()
    if (gameState) render(gameState)
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
      showStartScreen()
    })
  }

  // ── Start screen button wiring ─────────────────────────────────────────────
  const sizeButtons  = document.querySelectorAll('.start-size-btn')
  const btnStartGame = document.getElementById('btnStartGame')
  const btnCopyLink  = document.getElementById('btnCopyLink')

  sizeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      sizeButtons.forEach(function (b) { b.classList.remove('active') })
      btn.classList.add('active')
      gameConfig.mapSize = btn.dataset.size
      refreshPlayerPreview()
      refreshRoomLink()
    })
  })

  if (btnCopyLink) {
    btnCopyLink.addEventListener('click', function () {
      const url = document.getElementById('roomLinkInput')
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url.value).then(function () {
          btnCopyLink.textContent = 'Copied!'
          setTimeout(function () { btnCopyLink.textContent = 'Copy' }, 1500)
        })
      } else if (url) {
        url.select()
        document.execCommand('copy')
        btnCopyLink.textContent = 'Copied!'
        setTimeout(function () { btnCopyLink.textContent = 'Copy' }, 1500)
      }
    })
  }

  if (btnStartGame) {
    btnStartGame.addEventListener('click', function () {
      hideStartScreen()
      startNewGame()
    })
  }

  // Detect guest lobby mode: page loaded with an existing room hash
  _guestLobbyMode = isJoining()
  if (_guestLobbyMode) {
    // Auto-connect to P2P as a guest — player index assigned by host later
    p2pActive     = true
    p2pLocalIndex = -1
    initP2P({ localPlayerIndex: -1, numHumanSlots: 1 })
  }

  // Show the start screen instead of jumping straight into the game
  showStartScreen()
}

function startNewGame() {
  const roles     = gameConfig.playerRoles
  // Count active players (not 'none')
  const numActive = roles.filter(function (r) { return r !== 'none' }).length
  const radius    = MAP_SIZES[gameConfig.mapSize] || MAP_SIZES.small

  // Collect human slots (players controlled by real humans)
  const humanSlots = roles.map(function (r, i) { return r === 'human' ? i : -1 }).filter(function (i) { return i >= 0 })

  if (p2pActive) destroyP2P()

  // Only enable P2P when there are multiple human slots (real multiplayer needed).
  // Single human + AI slots = local solo play (no tracker connection required).
  if (humanSlots.length > 1) {
    p2pLocalIndex = humanSlots[0]  // local player is the first human slot (usually 0)
    p2pActive = true
    initP2P({ localPlayerIndex: p2pLocalIndex, numHumanSlots: humanSlots.length })
    refreshRoomLink()
  } else {
    p2pActive = false
    p2pLocalIndex = humanSlots[0] >= 0 ? humanSlots[0] : 0
  }

  gameState = createGameState(roles, radius, calcWaterDensity(numActive))
  render(gameState)
  updateUI(gameState)

  // Broadcast the game start to any already-connected guests
  if (p2pActive) {
    broadcastStartGame(gameState, {
      mapSize: gameConfig.mapSize,
      playerRoles: gameConfig.playerRoles.slice()
    })
  }

  runPendingAITurns()
}

function createGameState(playerRoles, radius, waterDensity) {
  const roles   = Array.isArray(playerRoles) ? playerRoles : DEFAULT_ROLES.slice()
  const players = []
  for (let i = 0; i < NUM_TOTAL_PLAYERS; i++) {
    players.push({
      id: i,
      name: PLAYER_NAMES[i],
      color: PLAYER_HEX_COLORS[i % PLAYER_HEX_COLORS.length]
    })
  }

  // Only active (non-'none') players get territory
  const numActive = roles.filter(function (r) { return r !== 'none' }).length

  const hexes = generateHexMap(radius, waterDensity)
  const territories = placeStartingTerritories(hexes, numActive)

  // Build AI player list: slots that are 'ai' (not 'human' and not 'none')
  const aiPlayers = []
  for (let i = 0; i < NUM_TOTAL_PLAYERS; i++) {
    if (roles[i] === 'ai') aiPlayers.push(i)
  }

  const state = {
    players: players,
    numActivePlayers: numActive,
    playerRoles: roles,
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
    aiPlayers: aiPlayers,
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
  if (!state) return
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
  const localTurn = !p2pActive || state.activePlayer === p2pLocalIndex
  const humanTurn = notOver && !isAIPlayer(state, state.activePlayer) && localTurn

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

  const roles     = gameConfig.playerRoles.slice()
  const numActive = roles.filter(function (r) { return r !== 'none' }).length
  const radius       = MAP_SIZES[gameConfig.mapSize] || MAP_SIZES.small
  const waterDensity = calcWaterDensity(numActive)

  // Override all roles to AI for watch mode
  const allAiRoles = roles.map(function (r) { return r === 'none' ? 'none' : 'ai' })

  gameState = createGameState(allAiRoles, radius, waterDensity)
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

    gameState = createGameState(allAiRoles, radius, waterDensity)
    render(gameState)
    updateUI(gameState)
  }

  watchLoopActive = false
  if (gameState) updateUI(gameState)
}

// Stop the watch loop.  The caller is responsible for showing the start screen
// or creating a new game as needed.
function stopWatchMode() {
  watchMode = false
}

// Is the active player a remote human (controlled by a P2P peer)?
function isRemotePlayer(state) {
  if (!p2pActive || !state) return false
  const role = (state.playerRoles || gameConfig.playerRoles)[state.activePlayer]
  return role === 'human' && state.activePlayer !== p2pLocalIndex
}

// Run AI turns for as long as the active player is AI-controlled.
// If the active player is a remote human in P2P mode, wait for their move.
// Shows "thinking..." in the UI while waiting for the LLM response.
async function runPendingAITurns() {
  while (gameState && !gameState.gameOver) {
    const ap = gameState.activePlayer
    if (isAIPlayer(gameState, ap)) {
      // ── AI turn ──────────────────────────────────────────────────────────
      gameState.aiThinking = true
      render(gameState)
      updateUI(gameState)

      if (!gameState || !isAIPlayer(gameState, gameState.activePlayer)) break
      await new Promise(function (resolve) { setTimeout(resolve, 500) })
      if (!gameState || !isAIPlayer(gameState, gameState.activePlayer)) break

      await runAITurn(gameState)

      gameState.aiThinking = false
      appendToLog(gameState, 'Turn ' + (gameState.turn + 1) + ': ' +
        gameState.players[gameState.activePlayer].name + ' (AI) ended their turn')
      endTurn(gameState)
      checkWinCondition(gameState)
      render(gameState)
      updateUI(gameState)

      // Broadcast AI move result to peers
      if (p2pActive) broadcastAction({ type: MSG_END_TURN, from: ap })

      await new Promise(function (resolve) { setTimeout(resolve, 300) })
    } else if (isRemotePlayer(gameState)) {
      // ── Remote human turn: wait for P2P action ───────────────────────────
      setMessage(gameState, '⌛ Waiting for ' + gameState.players[ap].name + '…')
      render(gameState)
      updateUI(gameState)
      await waitForRemoteAction()
      // After the remote action is applied, the loop continues
    } else {
      // Local human turn — return control to the event loop
      break
    }
  }
}

// Returns a Promise that resolves when the remote player ends their turn.
// Remote actions are applied inline via the p2pBus 'remote_action' listener.
function waitForRemoteAction() {
  return new Promise(function (resolve) {
    _p2pRemoteActionResolver = resolve
  })
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


// ── P2P event listeners ───────────────────────────────────────────────────────
// Wired up once at module load; they remain active for the lifetime of the page.

p2pBus.addEventListener('remote_action', function (ev) {
  const msg = ev.detail
  if (!gameState || gameState.gameOver) return
  if (!isRemotePlayer(gameState)) return   // ignore stale events

  switch (msg.type) {
    case MSG_HEX_CLICK: {
      // Simulate a hex click from the remote player
      const hex = gameState.hexes[msg.hexKey]
      if (hex) {
        const canvas = document.getElementById('gameCanvas')
        if (canvas) {
          canvas.dispatchEvent(new CustomEvent('p2p_hex_click', { detail: { hexKey: msg.hexKey } }))
        }
      }
      break
    }
    case MSG_END_TURN: {
      appendToLog(gameState, 'Turn ' + (gameState.turn + 1) + ': ' +
        gameState.players[gameState.activePlayer].name + ' ended their turn')
      endTurn(gameState)
      checkWinCondition(gameState)
      render(gameState)
      updateUI(gameState)
      // Resolve the waitForRemoteAction() promise so the game loop continues
      if (_p2pRemoteActionResolver) {
        const res = _p2pRemoteActionResolver
        _p2pRemoteActionResolver = null
        res()
      }
      break
    }
    case MSG_BUY_UNIT: {
      if (msg.level) handleBuyUnit(gameState, msg.level)
      break
    }
    case MSG_BUILD_TOWER: {
      handleBuildTower(gameState)
      break
    }
    case MSG_UNDO_TURN: {
      undoTurn(gameState)
      render(gameState)
      updateUI(gameState)
      break
    }
  }
})

// Host sent us the full game state during a running game (re-sync)
p2pBus.addEventListener('state_sync', function (ev) {
  if (p2pLocalIndex === 0) return // host doesn't accept state syncs
  const incoming = ev.detail.state
  if (!incoming || !incoming.hexes) return
  gameState = incoming
  if (gameState.playerRoles) gameConfig.playerRoles = gameState.playerRoles.slice()
  hideStartScreen()
  render(gameState)
  updateUI(gameState)
  runPendingAITurns()
})

// Host broadcasts game start — guests leave lobby and start playing
p2pBus.addEventListener('start_game', function (ev) {
  const incoming = ev.detail
  // Apply host-provided config
  if (incoming.config) {
    if (incoming.config.mapSize) gameConfig.mapSize = incoming.config.mapSize
    if (incoming.config.playerRoles) gameConfig.playerRoles = incoming.config.playerRoles.slice()
  }
  const state = incoming.state
  if (!state || !state.hexes) return

  // Sync the local player index from the p2p layer (host has assigned us a slot via MSG_ASSIGN)
  const assignedIdx = getLocalPlayerIndex()
  if (assignedIdx >= 0) {
    p2pLocalIndex = assignedIdx
  } else if (p2pLocalIndex < 0) {
    p2pLocalIndex = 1  // fallback: first non-host slot
  }

  gameState = state
  if (gameState.playerRoles) gameConfig.playerRoles = gameState.playerRoles.slice()

  _guestLobbyMode = false  // game has started — lobby over
  hideStartScreen()
  render(gameState)
  updateUI(gameState)
  runPendingAITurns()
})

p2pBus.addEventListener('peer_connected', function (ev) {
  const idx = ev.detail.playerIndex
  const dc  = ev.detail.dc
  if (gameState) {
    setMessage(gameState, '🌐 ' + gameState.players[idx].name + ' connected!')
    render(gameState)
    updateUI(gameState)
    // Host: send the current game (or lobby state) to the newly connected peer
    if (p2pLocalIndex === 0 && dc) {
      setTimeout(function () {
        if (gameState) {
          sendStartGameTo(dc, gameState, {
            mapSize: gameConfig.mapSize,
            playerRoles: gameConfig.playerRoles.slice()
          })
        }
      }, 500)
    }
  }
  refreshRoomLink()
})

p2pBus.addEventListener('peer_disconnected', function (ev) {
  setMessage(gameState, '⚠ A player disconnected.')
  if (gameState) {
    render(gameState)
    updateUI(gameState)
  }
  refreshRoomLink()
})

p2pBus.addEventListener('room_ready', function () {
  refreshRoomLink()
})


export { updateUI }
