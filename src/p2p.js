// P2P multiplayer: WebRTC peer discovery via BitTorrent-style tracker + DataChannel messaging.
//
// Topology  : Host (player 0) connects to every guest. Each guest connects only to the host.
//             The host re-broadcasts all game messages so every client stays in sync.
// Room ID   : URL hash #slay-<40 hex chars>.  All players with the same hash join one room.
// Lobby     : Guests stay on the start screen until the host sends MSG_START_GAME.
//             Late joiners receive MSG_START_GAME with the current game state.

import { WebSocketTracker } from './tracker.js'

// ── Public event bus ──────────────────────────────────────────────────────────
// Consumers listen on `p2pBus` for CustomEvents:
//   'peer_connected'    detail: { playerIndex }
//   'peer_disconnected' detail: { playerIndex }
//   'remote_action'     detail: { type, ... }
//   'state_sync'        detail: { state }
//   'start_game'        detail: { state, config }
//   'room_ready'        detail: { roomId }

export const p2pBus = new EventTarget()

// ── Message type constants ────────────────────────────────────────────────────
export const MSG_HEX_CLICK   = 'hex_click'
export const MSG_END_TURN    = 'end_turn'
export const MSG_BUY_UNIT    = 'buy_unit'
export const MSG_BUILD_TOWER = 'build_tower'
export const MSG_UNDO_TURN   = 'undo_turn'
export const MSG_STATE_SYNC  = 'state_sync'
export const MSG_HELLO       = 'hello'
export const MSG_ASSIGN      = 'assign'
export const MSG_START_GAME  = 'start_game'

// ── Guest detection ───────────────────────────────────────────────────────────
// Checked once at module load, before any history.replaceState calls.
const _initialHash = typeof window !== 'undefined' ? window.location.hash : ''

/** Returns true when the page was opened with an existing room hash (guest joining). */
export function isJoining () {
  return /^#slay-[0-9a-f]{40}$/i.test(_initialHash)
}

const MAX_PLAYER_SLOTS = 6

// ── Module state ──────────────────────────────────────────────────────────────
let _tracker           = null
let _roomId            = null
let _localPlayerIndex  = -1
let _isHost            = false
let _peers             = new Map()  // offerId → { dc, playerIndex, ready }
let _expectedPeerCount = 0          // how many peers we expect (host: n-1, guest: 1)

// ── Helpers ───────────────────────────────────────────────────────────────────

function randHex (bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return [...arr].map(function (b) { return b.toString(16).padStart(2, '0') }).join('')
}

export function resolveOrGenerateRoomId () {
  const hash = window.location.hash.replace(/^#/, '')
  if (/^slay-[0-9a-f]{40}$/i.test(hash)) {
    return hash.slice('slay-'.length)
  }
  const id = randHex(20)
  window.history.replaceState(null, '', window.location.pathname + '#slay-' + id)
  return id
}

export function roomUrl () {
  return _roomId
    ? window.location.origin + window.location.pathname + '#slay-' + _roomId
    : ''
}

export function isP2PConnected ()     { return _tracker !== null }
export function getLocalPlayerIndex () { return _localPlayerIndex }
export function getConnectedPeerCount () {
  let n = 0
  for (const p of _peers.values()) if (p.ready) n++
  return n
}

// ── Send helpers ──────────────────────────────────────────────────────────────

function sendToDc (dc, msg) {
  try {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg))
  } catch (_) {}
}

function broadcast (msg) {
  for (const p of _peers.values()) {
    if (p.ready) sendToDc(p.dc, msg)
  }
}

/** Guests send all messages to the host (first ready peer). */
function sendToHost (msg) {
  for (const p of _peers.values()) {
    if (p.ready) { sendToDc(p.dc, msg); return }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise (or re-initialise) the P2P layer.
 * @param {object} opts
 * @param {number} opts.localPlayerIndex  Player slot we control. 0 = host. -1 = unknown (guest before assign).
 * @param {number} opts.numHumanSlots     Total human player slots in this game (including self).
 */
export function initP2P ({ localPlayerIndex = 0, numHumanSlots = 2 } = {}) {
  destroyP2P()

  _localPlayerIndex  = localPlayerIndex
  _isHost            = (localPlayerIndex === 0)

  // Resolve room ID from hash or generate a fresh one
  if (isJoining()) {
    _roomId = _initialHash.replace(/^#slay-/i, '')
    window.history.replaceState(null, '', window.location.pathname + '#slay-' + _roomId)
  } else {
    _roomId = resolveOrGenerateRoomId()
  }

  // numwant: how many peer connections to create
  //   host  → numHumanSlots - 1  (all other humans)
  //   guest → 1                  (the host only)
  _expectedPeerCount = _isHost ? Math.max(1, numHumanSlots - 1) : 1

  _tracker           = new WebSocketTracker(_roomId)
  _tracker.numwant   = _expectedPeerCount

  _tracker.addEventListener('peer', function (ev) {
    _onPeer(ev.detail.dc, ev.detail.offerId)
  })
  _tracker.addEventListener('message', function (ev) {
    _onData(ev.detail.data, ev.detail.dc, ev.detail.offerId)
  })
  _tracker.addEventListener('peer-disconnect', function (ev) {
    _onDisconnect(ev.detail.offerId)
  })
  _tracker.addEventListener('error', function (ev) {
    console.warn('[p2p] tracker error:', ev.detail)
  })

  _tracker.connect()

  p2pBus.dispatchEvent(new CustomEvent('room_ready', { detail: { roomId: _roomId } }))
  return _roomId
}

/** Disconnect from the room and clean up all WebRTC connections. */
export function destroyP2P () {
  if (_tracker) {
    try { _tracker.close() } catch (_) {}
    _tracker = null
  }
  _peers.clear()
  _roomId           = null
  _localPlayerIndex = -1
  _isHost           = false
}

/**
 * Send a game action.
 * Host broadcasts to all peers; guests send only to the host.
 */
export function broadcastAction (action) {
  if (_isHost) {
    broadcast(action)
  } else {
    sendToHost(action)
  }
}

/**
 * Host sends the full serialised game state to all peers (re-sync).
 */
export function broadcastStateSync (state) {
  if (!_isHost) return
  const payload = typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state))
  broadcast({ type: MSG_STATE_SYNC, state: payload })
}

/**
 * Host broadcasts MSG_START_GAME to move all guests out of the lobby.
 * Also used when a late-joining peer connects: host sends the current state.
 * @param {object} state   Current (or initial) game state snapshot.
 * @param {object} config  { mapSize, playerRoles } — game config for the guest.
 */
export function broadcastStartGame (state, config) {
  if (!_isHost) return
  const payload = typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state))
  broadcast({ type: MSG_START_GAME, state: payload, config })
}

/**
 * Send MSG_START_GAME to a single DataChannel (for late joiners).
 */
export function sendStartGameTo (dc, state, config) {
  if (!_isHost) return
  const payload = typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state))
  sendToDc(dc, { type: MSG_START_GAME, state: payload, config })
}

// ── Internal ──────────────────────────────────────────────────────────────────

/** Close the tracker once all expected peers have connected (keep DataChannels open). */
function _checkAllPeersConnected () {
  if (getConnectedPeerCount() >= _expectedPeerCount && _tracker) {
    try { _tracker.closeTracker() } catch (_) {}
  }
}

function _onPeer (dc, offerId) {
  const entry = { dc, playerIndex: -1, ready: true }
  _peers.set(offerId, entry)
  sendToDc(dc, { type: MSG_HELLO, from: _localPlayerIndex })
  _checkAllPeersConnected()
}

function _onData (data, dc, offerId) {
  let msg
  try { msg = JSON.parse(data) } catch (_) { return }
  const entry = _peers.get(offerId)
  if (!entry) return
  _onMessage(entry, msg, offerId)
}

function _onDisconnect (offerId) {
  const entry = _peers.get(offerId)
  const idx   = entry ? entry.playerIndex : -1
  _peers.delete(offerId)
  if (idx >= 0) {
    p2pBus.dispatchEvent(new CustomEvent('peer_disconnected', { detail: { playerIndex: idx } }))
  }
}

function _onMessage (entry, msg, offerId) {
  switch (msg.type) {
    case MSG_HELLO: {
      if (_isHost) {
        // Assign a player index to this guest
        const assigned = (msg.from >= 0 && msg.from < MAX_PLAYER_SLOTS) ? msg.from : _nextFreeSlot()
        entry.playerIndex = assigned
        sendToDc(entry.dc, { type: MSG_ASSIGN, playerIndex: assigned })
      } else {
        entry.playerIndex = msg.from
      }
      p2pBus.dispatchEvent(new CustomEvent('peer_connected', {
        detail: { playerIndex: entry.playerIndex, dc: entry.dc }
      }))
      break
    }

    case MSG_ASSIGN: {
      // Host assigned us a player index
      if (_localPlayerIndex < 0) {
        _localPlayerIndex = msg.playerIndex
        _isHost           = (_localPlayerIndex === 0)
      }
      entry.playerIndex = 0  // this peer is the host
      p2pBus.dispatchEvent(new CustomEvent('room_ready', { detail: { roomId: _roomId } }))
      break
    }

    case MSG_START_GAME: {
      p2pBus.dispatchEvent(new CustomEvent('start_game', {
        detail: { state: msg.state, config: msg.config }
      }))
      break
    }

    case MSG_STATE_SYNC: {
      p2pBus.dispatchEvent(new CustomEvent('state_sync', { detail: { state: msg.state } }))
      break
    }

    default: {
      // Game action — pass to the game layer
      p2pBus.dispatchEvent(new CustomEvent('remote_action', { detail: msg }))
      // Host re-broadcasts to every OTHER peer so all clients stay in sync
      if (_isHost) {
        for (const [id, other] of _peers) {
          if (id !== offerId && other.ready) sendToDc(other.dc, msg)
        }
      }
      break
    }
  }
}

function _nextFreeSlot () {
  const used = new Set([_localPlayerIndex])
  for (const e of _peers.values()) if (e.playerIndex >= 0) used.add(e.playerIndex)
  for (let i = 1; i < MAX_PLAYER_SLOTS; i++) if (!used.has(i)) return i
  return -1
}
