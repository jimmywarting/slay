// P2P multiplayer: WebRTC peer discovery via BitTorrent-style tracker + DataChannel messaging
//
// Room identity  : URL hash (e.g. #slay-a1b2c3d4).  All players sharing the same
//                  hash end up in the same "room" and are wired together.
// Host vs client : Player 0 is always the host.  Other players are assigned slots
//                  in joining order.
// Move protocol  : Compact JSON messages sent over the DataChannel, see MSG_* constants.

import { TrackerClient, common } from './tracker.js'

// ── Public event bus ──────────────────────────────────────────────────────────
// Consumers listen on the `p2pBus` EventTarget for CustomEvents.
// Events dispatched:
//   'peer_connected'    detail: { peerId, playerIndex }
//   'peer_disconnected' detail: { playerIndex }
//   'remote_action'     detail: { type, ... } (same shape as local actions)
//   'state_sync'        detail: { state }      (host sends full state)
//   'room_ready'        detail: { roomId }      (tracker connected, room hash known)

export const p2pBus = new EventTarget()

// ── Message type constants ────────────────────────────────────────────────────
export const MSG_HEX_CLICK   = 'hex_click'
export const MSG_END_TURN    = 'end_turn'
export const MSG_BUY_UNIT    = 'buy_unit'
export const MSG_BUILD_TOWER = 'build_tower'
export const MSG_UNDO_TURN   = 'undo_turn'
export const MSG_STATE_SYNC  = 'state_sync'
export const MSG_HELLO       = 'hello'   // first message after DataChannel opens
export const MSG_ASSIGN      = 'assign'  // host tells peer their player index

// Public trackers that support WebRTC signalling
const TRACKER_URLS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz'
]

// ── Module state ──────────────────────────────────────────────────────────────
let _client           = null   // TrackerClient
let _roomId           = null   // hex string (40 chars)
let _localPlayerIndex = -1     // which player slot we control
let _isHostFlag       = false  // true if we are player 0
let _peers            = new Map()  // tempId → { peer, playerIndex, ready }

// ── Helpers ───────────────────────────────────────────────────────────────────

function randHex(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return common.arr2hex(arr)
}

// Read or generate the room ID from the URL hash.
function resolveRoomId(createNew) {
  if (!createNew) {
    const hash = window.location.hash.replace(/^#/, '')
    if (/^slay-[0-9a-f]{40}$/i.test(hash)) {
      return hash.slice('slay-'.length)
    }
  }
  const id = randHex(20)
  window.location.hash = 'slay-' + id
  return id
}

// Build the shareable room URL for display
export function roomUrl() {
  return _roomId
    ? window.location.origin + window.location.pathname + '#slay-' + _roomId
    : ''
}

export function isP2PConnected() { return _client !== null && !_client.destroyed }
export function getLocalPlayerIndex() { return _localPlayerIndex }
export function getConnectedPeerCount() {
  let n = 0
  for (const p of _peers.values()) if (p.ready) n++
  return n
}

// ── Send helpers ──────────────────────────────────────────────────────────────

function sendTo(entry, msg) {
  try {
    if (entry && entry.peer && entry.ready) {
      entry.peer.send(JSON.stringify(msg))
    }
  } catch (_) {}
}

function broadcast(msg) {
  for (const p of _peers.values()) sendTo(p, msg)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise (or re-initialise) the P2P layer.
 * @param {object} opts
 * @param {number}  opts.localPlayerIndex  Which player slot we control (0 = host).
 * @param {boolean} opts.createRoom        When true, always generate a fresh room ID.
 */
export function initP2P({ localPlayerIndex: lpi = 0, createRoom = false } = {}) {
  destroyP2P()

  _localPlayerIndex = lpi
  _isHostFlag       = (lpi === 0)
  _roomId           = resolveRoomId(createRoom)

  const localPeerId = randHex(20)
  const infoHash    = common.text2arr(_roomId).slice(0, 20)
  const peerId      = common.text2arr(localPeerId).slice(0, 20)

  _client = new TrackerClient({
    infoHash,
    peerId,
    announce: TRACKER_URLS
  })

  _client.on('peer', _onNewPeer)
  _client.on('warning', function (err) {
    console.warn('[p2p] tracker warning:', err && err.message)
  })
  _client.on('error', function (err) {
    console.error('[p2p] tracker error:', err && err.message)
  })

  _client.start()

  p2pBus.dispatchEvent(new CustomEvent('room_ready', { detail: { roomId: _roomId } }))
  return _roomId
}

/** Disconnect from the room and clean up all WebRTC connections. */
export function destroyP2P() {
  if (_client) {
    try { _client.destroy() } catch (_) {}
    _client = null
  }
  for (const e of _peers.values()) {
    try { e.peer.destroy() } catch (_) {}
  }
  _peers.clear()
  _roomId = null
}

/**
 * Send a game action to all connected peers.
 * The host re-broadcasts so every peer receives every move.
 * @param {object} action  Plain object with a `type` field.
 */
export function broadcastAction(action) {
  broadcast(action)
}

/**
 * Send the full serialised game state to all peers (host only).
 * @param {object} state  Plain-object snapshot of the current game state.
 */
export function broadcastStateSync(state) {
  if (!_isHostFlag) return
  // Use structuredClone if available, otherwise JSON round-trip
  const payload = typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state))
  broadcast({ type: MSG_STATE_SYNC, state: payload })
}

// ── Internal peer wiring ──────────────────────────────────────────────────────

function _onNewPeer(peer) {
  const tempId = 'peer-' + Date.now() + '-' + Math.random()
  const entry  = { peer, playerIndex: -1, ready: false }
  _peers.set(tempId, entry)

  peer.on('connect', function () {
    entry.ready = true
    sendTo(entry, { type: MSG_HELLO, from: _localPlayerIndex })
  })

  peer.on('data', function (raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch (_) { return }
    _onMessage(entry, msg, tempId)
  })

  peer.on('close', function () {
    const idx = entry.playerIndex
    _peers.delete(tempId)
    p2pBus.dispatchEvent(new CustomEvent('peer_disconnected', {
      detail: { playerIndex: idx }
    }))
  })

  peer.on('error', function (err) {
    console.warn('[p2p] peer error:', err && err.message)
  })
}

function _onMessage(entry, msg, tempId) {
  switch (msg.type) {
    case MSG_HELLO: {
      entry.playerIndex = msg.from

      if (_isHostFlag) {
        // Assign the peer a slot if they are joining without a specific index
        const assigned = msg.from >= 0 ? msg.from : _nextFreeSlot()
        entry.playerIndex = assigned
        sendTo(entry, { type: MSG_ASSIGN, playerIndex: assigned })
      }

      p2pBus.dispatchEvent(new CustomEvent('peer_connected', {
        detail: { playerIndex: entry.playerIndex }
      }))
      break
    }

    case MSG_ASSIGN: {
      if (_localPlayerIndex < 0) {
        _localPlayerIndex = msg.playerIndex
        _isHostFlag       = (_localPlayerIndex === 0)
      }
      p2pBus.dispatchEvent(new CustomEvent('room_ready', { detail: { roomId: _roomId } }))
      break
    }

    case MSG_STATE_SYNC: {
      p2pBus.dispatchEvent(new CustomEvent('state_sync', { detail: { state: msg.state } }))
      break
    }

    default: {
      // Game action — bubble up to the game layer
      p2pBus.dispatchEvent(new CustomEvent('remote_action', { detail: msg }))

      // Host re-broadcasts to every OTHER peer for full fan-out
      if (_isHostFlag) {
        for (const [id, other] of _peers) {
          if (id !== tempId) sendTo(other, msg)
        }
      }
      break
    }
  }
}

function _nextFreeSlot() {
  const used = new Set([_localPlayerIndex])
  for (const e of _peers.values()) if (e.playerIndex >= 0) used.add(e.playerIndex)
  for (let i = 1; i < 6; i++) if (!used.has(i)) return i
  return -1
}
