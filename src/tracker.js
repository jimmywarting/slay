(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.WebTorrent = f()}})(function(){var define,module,exports;
const R = typeof Reflect === 'object' ? Reflect : null
const ReflectApply = R && typeof R.apply === 'function'
  ? R.apply
  : function ReflectApply (target, receiver, args) {
    return Function.prototype.apply.call(target, receiver, args)
  }

let ReflectOwnKeys
if (R && typeof R.ownKeys === 'function') {
  ReflectOwnKeys = R.ownKeys
} else if (Object.getOwnPropertySymbols) {
  ReflectOwnKeys = function ReflectOwnKeys (target) {
    return Object.getOwnPropertyNames(target)
      .concat(Object.getOwnPropertySymbols(target))
  }
} else {
  ReflectOwnKeys = function ReflectOwnKeys (target) {
    return Object.getOwnPropertyNames(target)
  }
}

class EventEmitter {
  constructor () {
    if (this._events === undefined ||
      this._events === Object.getPrototypeOf(this)._events) {
      this._events = Object.create(null)
      this._eventsCount = 0
    }

    this._maxListeners = this._maxListeners || undefined
  }

  // Obviously not all Emitters should be limited to 10. This function allows
  // that to be increased. Set to zero for unlimited.
  setMaxListeners (n) {
    this._maxListeners = n
    return this
  }

  getMaxListeners () {
    return $getMaxListeners(this)
  }

  /**
   * @param  {string} type
   * @param  {...*} args
   * @return {boolean}
   */
  emit (type, ...args) {
    let doError = (type === 'error')

    const events = this._events
    if (events !== undefined) {
      doError = (doError && events.error === undefined)
    } else if (!doError) {
      return false
    }

    // If there is no 'error' event listener then throw.
    if (doError) {
      let er
      if (args.length > 0) {
        er = args[0]
      }
      if (er instanceof Error) {
        // Note: The comments on the `throw` lines are intentional, they show
        // up in Node's output if this results in an unhandled exception.
        throw er // Unhandled 'error' event
      }
      // At least give some kind of context to the user
      const err = new Error(`Unhandled error.${er ? ` (${er.message})` : ''}`)
      err.context = er
      throw err // Unhandled 'error' event
    }

    const handler = events[type]

    if (handler === undefined) {
      return false
    }

    if (typeof handler === 'function') {
      ReflectApply(handler, this, args)
    } else {
      const len = handler.length
      const listeners = arrayClone(handler, len)
      for (var i = 0; i < len; ++i) {
        ReflectApply(listeners[i], this, args)
      }
    }

    return true
  }

  addListener (type, listener) {
    return _addListener(this, type, listener, false)
  }

  prependListener (type, listener) {
    return _addListener(this, type, listener, true)
  }

  once (type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError(`The "listener" argument must be of type Function. Received type ${typeof listener}`)
    }
    this.on(type, _onceWrap(this, type, listener))
    return this
  }

  prependOnceListener (type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError(`The "listener" argument must be of type Function. Received type ${typeof listener}`)
    }
    this.prependListener(type, _onceWrap(this, type, listener))
    return this
  }

  // Emits a 'removeListener' event if and only if the listener was removed.
  removeListener (type, listener) {
    let list
    let events
    let position
    let i
    let originalListener

    if (typeof listener !== 'function') {
      throw new TypeError(`The "listener" argument must be of type Function. Received type ${typeof listener}`)
    }

    events = this._events
    if (events === undefined) {
      return this
    }

    list = events[type]
    if (list === undefined) {
      return this
    }

    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) {
        this._events = Object.create(null)
      } else {
        delete events[type]
        if (events.removeListener) {
          this.emit('removeListener', type, list.listener || listener)
        }
      }
    } else if (typeof list !== 'function') {
      position = -1

      for (i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          originalListener = list[i].listener
          position = i
          break
        }
      }

      if (position < 0) {
        return this
      }

      if (position === 0) {
        list.shift()
      } else {
        spliceOne(list, position)
      }

      if (list.length === 1) {
        events[type] = list[0]
      }

      if (events.removeListener !== undefined) {
        this.emit('removeListener', type, originalListener || listener)
      }
    }

    return this
  }

  removeAllListeners (type) {
    let listeners
    let events
    let i

    events = this._events
    if (events === undefined) {
      return this
    }

    // not listening for removeListener, no need to emit
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = Object.create(null)
        this._eventsCount = 0
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0) { this._events = Object.create(null) } else { delete events[type] }
      }
      return this
    }

    // emit removeListener for all listeners on all events
    if (arguments.length === 0) {
      const keys = Object.keys(events)
      let key
      for (i = 0; i < keys.length; ++i) {
        key = keys[i]
        if (key === 'removeListener') continue
        this.removeAllListeners(key)
      }
      this.removeAllListeners('removeListener')
      this._events = Object.create(null)
      this._eventsCount = 0
      return this
    }

    listeners = events[type]

    if (typeof listeners === 'function') {
      this.removeListener(type, listeners)
    } else if (listeners !== undefined) {
      // LIFO order
      for (i = listeners.length - 1; i >= 0; i--) {
        this.removeListener(type, listeners[i])
      }
    }

    return this
  }

  listeners (type) {
    return _listeners(this, type, true)
  }

  rawListeners (type) {
    return _listeners(this, type, false)
  }

  eventNames () {
    return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : []
  }
}

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter

EventEmitter.prototype._events = undefined
EventEmitter.prototype._eventsCount = 0
EventEmitter.prototype._maxListeners = undefined

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10

function $getMaxListeners ({_maxListeners}) {
  if (_maxListeners === undefined) {
    return EventEmitter.defaultMaxListeners
  }
  return _maxListeners
}

function _addListener (target, type, listener, prepend) {
  let m
  let events
  let existing

  if (typeof listener !== 'function') {
    throw new TypeError(`The "listener" argument must be of type Function. Received type ${typeof listener}`)
  }

  events = target._events
  if (events === undefined) {
    events = target._events = Object.create(null)
    target._eventsCount = 0
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener !== undefined) {
      target.emit('newListener', type, listener.listener ? listener.listener : listener)

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events
    }
    existing = events[type]
  }

  if (existing === undefined) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener
    ++target._eventsCount
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
        prepend ? [listener, existing] : [existing, listener]
      // If we've already got an array, just append.
    } else if (prepend) {
      existing.unshift(listener)
    } else {
      existing.push(listener)
    }

    // Check for listener leak
    m = $getMaxListeners(target)
    if (m > 0 && existing.length > m && !existing.warned) {
      existing.warned = true
      // No error code for this since it is a Warning
      // eslint-disable-next-line no-restricted-syntax
      const w = new Error(`Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners added. Use emitter.setMaxListeners() to increase limit`)
      w.name = 'MaxListenersExceededWarning'
      w.emitter = target
      w.type = type
      w.count = existing.length
      console.warn(w)
    }
  }

  return target
}

EventEmitter.prototype.on = EventEmitter.prototype.addListener
EventEmitter.prototype.off = EventEmitter.prototype.removeListener

function onceWrapper (...args) {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn)
    this.fired = true
    ReflectApply(this.listener, this.target, args)
  }
}

function _onceWrap (target, type, listener) {
  const state = { fired: false, wrapFn: undefined, target, type, listener }
  const wrapped = onceWrapper.bind(state)
  wrapped.listener = listener
  state.wrapFn = wrapped
  return wrapped
}

function _listeners ({_events}, type, unwrap) {
  const events = _events

  if (events === undefined) { return [] }

  const evlistener = events[type]
  if (evlistener === undefined) { return [] }

  if (typeof evlistener === 'function') {
    return unwrap ? [evlistener.listener || evlistener] : [evlistener]
  }

  return unwrap
    ? unwrapListeners(evlistener)
    : arrayClone(evlistener, evlistener.length)
}

EventEmitter.listenerCount = (emitter, type) => {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type)
  } else {
    return listenerCount.call(emitter, type)
  }
}

EventEmitter.prototype.listenerCount = listenerCount

function listenerCount (type) {
  const events = this._events

  if (events !== undefined) {
    const evlistener = events[type]

    if (typeof evlistener === 'function') {
      return 1
    } else if (evlistener !== undefined) {
      return evlistener.length
    }
  }

  return 0
}

function arrayClone (arr, n) {
  const copy = new Array(n)
  for (let i = 0; i < n; ++i) {
    copy[i] = arr[i]
  }
  return copy
}

function spliceOne (list, index) {
  for (; index + 1 < list.length; index++) { list[index] = list[index + 1] }
  list.pop()
}

function unwrapListeners (arr) {
  const ret = new Array(arr.length)
  for (let i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i]
  }
  return ret
}

var _$EventEmitter_6 = EventEmitter

/* removed: const _$EventEmitter_6 = require('events') */;

class Tracker extends _$EventEmitter_6 {
  constructor (client, announceUrl) {
    super()

    this.client = client
    this.announceUrl = announceUrl

    this.interval = null
    this.destroyed = false
  }

  setInterval (intervalMs) {
    if (intervalMs == null) intervalMs = this.DEFAULT_ANNOUNCE_INTERVAL

    clearInterval(this.interval)

    if (intervalMs) {
      this.interval = setInterval(() => {
        this.announce(this.client._defaultAnnounceOpts())
      }, intervalMs)
      if (this.interval.unref) this.interval.unref()
    }
  }
}

var _$Tracker_3 = Tracker

var _$common_5 = {};
/* global self crypto */
/**
 * This file is meant to be a substitute to some of what the nodejs api can do
 * that the browser can't do and vice versa.
 */

var sha1 = typeof crypto === 'object'
  ? crypto.subtle.digest.bind(crypto.subtle, 'sha-1')
  : () => Promise.reject(new Error('no web crypto support'))
var toArr = e => new Uint8Array(e)

var alphabet = '0123456789abcdef'
var encodeLookup = []
var decodeLookup = []

for (var i = 0; i < 256; i++) {
  encodeLookup[i] = alphabet[i >> 4 & 0xf] + alphabet[i & 0xf]
  if (i < 16) {
    if (i < 10) {
      decodeLookup[0x30 + i] = i
    } else {
      decodeLookup[0x61 - 10 + i] = i
    }
  }
}

/**
 * Encode a Uint8Array to a hex string
 *
 * @param  {Uint8Array} array Bytes to encode to string
 * @return {string}           hex string
 */
_$common_5.arr2hex = array => {
  var length = array.length
  var string = ''
  var i = 0
  while (i < length) {
    string += encodeLookup[array[i++]]
  }
  return string
}

/**
 * Decodes a hex string to a Uint8Array
 *
 * @param  {string} string hex string to decode to Uint8Array
 * @return {Uint8Array}    Uint8Array
 */
_$common_5.hex2arr = string => {
  var sizeof = string.length >> 1
  var length = sizeof << 1
  var array = new Uint8Array(sizeof)
  var n = 0
  var i = 0
  while (i < length) {
    array[n++] = decodeLookup[string.charCodeAt(i++)] << 4 | decodeLookup[string.charCodeAt(i++)]
  }
  return array
}

/**
 * @param  {string} str
 * @return {string}
 */
_$common_5.binary2hex = str => {
  var hex = '0123456789abcdef'
  var res = ''
  var c
  var i = 0
  var l = str.length

  for (; i < l; ++i) {
    c = str.charCodeAt(i)
    res += hex.charAt((c >> 4) & 0xF)
    res += hex.charAt(c & 0xF)
  }

  return res
}

/**
 * @param  {string} hex
 * @return {string}
 */
_$common_5.hex2binary = hex => {
  for (var string = '', i = 0, l = hex.length; i < l; i += 2) {
    string += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  }

  return string
}

/**
 * @param  {ArrayBuffer|ArrayBufferView} buffer
 * @return {Promise<Uint8Array>}
 */
_$common_5.sha1 = buffer => sha1(buffer).then(toArr)

_$common_5.text2arr = TextEncoder.prototype.encode.bind(new TextEncoder())

_$common_5.arr2text = TextDecoder.prototype.decode.bind(new TextDecoder())

_$common_5.binaryToHex = str => {
  var hex = '0123456789abcdef'
  var res = ''
  var c
  var i = 0
  var l = str.length

  for (; i < l; ++i) {
    c = str.charCodeAt(i)
    res += hex.charAt((c >> 4) & 0xF)
    res += hex.charAt(c & 0xF)
  }

  return res
}

_$common_5.hexToBinary = hex => {
  for (var string = '', i = 0, l = hex.length; i < l; i += 2) {
    string += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  }

  return string
}

/* global RTCPeerConnection */

const MAX_BUFFERED_AMOUNT = 64 * 1024
const buffer = new Uint8Array(MAX_BUFFERED_AMOUNT)

class Peer {
  constructor (opts = {}) {
    this.initiator = !opts.offer

    this.remoteAddress =
    this.remotePort =
    this.localAddress =
    this.onMessage =
    this.localPort =
    this.timestamp =
    this.sdp =
    this.onSignal =
    this.error =
    this._evtLoopTimer =
    this._dc = null

    this._bucket = [] // holds messages until ipadress have been found
    this._queue = []
    this._bulkSend = this.bulkSend.bind(this)

    const pc = new RTCPeerConnection(opts.config || Peer.config)
    this._pc = pc

    // (sometimes gets retriggerd by ondatachannel)
    pc.oniceconnectionstatechange = () => {
      switch (pc.iceConnectionState) {
        case 'connected':
          // pc.getStats().then(items => this._onceStats(items))
          break
        case 'disconnected':
          this.destroy(new Error('Ice connection disconnected.'))
          break
        case 'failed':
          this.destroy(new Error('Ice connection failed.'))
          break
        default:
      }
    }

    if (this.initiator) {
      this.createSDP()
    } else {
      this.setSDP(opts['offer'])
    }
  }

  _setupData () {
    const dc = this._dc

    dc.onopen = () => {
      this._pc.getStats().then(items => this._onceStats(items))
    }

    dc.binaryType = 'arraybuffer'

    dc.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT

    dc.onmessage = evt => {
      if (this.timestamp) {
        this.onMessage(new Uint8Array(evt.data))
      } else {
        this._bucket.push(new Uint8Array(evt.data))
      }
    }
  }

  _onceStats (items) {
    let selected

    items.forEach(item => {
      // Spec-compliant
      if (item.type === 'transport' && item.selectedCandidatePairId) {
        selected = items.get(item.selectedCandidatePairId)
      }

      // Old implementations
      if (!selected && item.type === 'candidate-pair' && (item.selected || item.nominated)) {
        selected = item
      }
    })

    const local = items.get(selected.localCandidateId) || {}
    const remote = items.get(selected.remoteCandidateId) || {}

    this.networkType = local.networkType

    this.candidateType = local.candidateType
    this.localAddress = local.ip || local.address || local.ipAddress
    this.localPort = local.port || local.portNumber

    this.remoteAddress = remote.ip || remote.address || remote.ipAddress
    this.remotePort = remote.port || remote.portNumber

    this.onConnect && this.onConnect(this)

    this.timestamp = Date.now() / 1000 | 0

    this._bucket.forEach(msg => {
      this.onMessage(msg)
    })
    this._bucket = null
  }

  async createSDP () {
    const pc = this._pc
    if (!this._dc) {
      this._dc = pc.createDataChannel('')
      this._setupData()
    }

    const desc = await pc.createOffer()

    // remove trickle
    desc.sdp = desc.sdp.replace(/a=ice-options:trickle\s\n/g, '')

    // trickle ice
    const iceGathering = new Promise(resolve => {
      setTimeout(resolve, 2000)
      pc.onicecandidate = evt => {
        !evt.candidate && resolve(pc.onicecandidate = null)
      }
    })

    await pc.setLocalDescription(desc)
    await iceGathering

    this.sdp = pc.localDescription
    this.onSignal(this)
  }

  async setSDP (sdp) {
    if (this.destroyed) console.log('cant do this when its closed', this.error)
    const pc = this._pc
    await pc.setRemoteDescription(sdp)
    pc.ondatachannel = null

    if (!pc.localDescription) {
      const iceGathering = new Promise(resolve => {
        pc.onicecandidate = evt => {
          !evt.candidate && resolve(pc.onicecandidate = null)
        }
      })

      const desc = await pc.createAnswer()
      desc.sdp = desc.sdp.replace(/a=ice-options:trickle\s\n/g, '')
      await pc.setLocalDescription(desc)
      await iceGathering
      pc.ondatachannel = evt => {
        this._dc = evt.channel
        this._setupData()
        pc.oniceconnectionstatechange()
      }
    }
    this.sdp = pc.localDescription
    this.onSignal && this.onSignal(this)
  }

  signal (sdp) {
    this.setSDP(sdp)
  }

  /**
   * Send text/binary data to the remote peer.
   * @param {Uint8Array} chunk
   */
  send (chunk) {
    // const channel = this._channel
    // if (this.destroyed) return
    // if (channel.readyState === 'closing') return this.destroy()
    // if (channel.readyState === 'open') {
    //   channel.send(chunk)
    // }

    if (!window.requestIdleCallback) {
      const channel = this._dc
      if (this.destroyed) return
      if (channel.readyState === 'closing') return this.destroy()

      channel.send(chunk)
      return
    }

    if (this.evtLoopTimer) {
      this.queue.push(chunk)
    } else {
      this.queue = [chunk]
      this.evtLoopTimer = window.requestIdleCallback(this._bulkSend)
    }
  }

  bulkSend () {
    const dc = this._dc
    if (this.destroyed) return
    if (dc.readyState === 'closing') return this.destroy()
    const chunks = this.queue

    if (chunks.length === 1) {
      dc.send(chunks[0])
      this.evtLoopTimer = this.queue = null
      return
    }

    let offset = 0
    let merged = []
    for (let i = 0, l = chunks.length; i < l; i++) {
      const chunk = chunks[i]
      if (chunk.length + offset >= buffer.length) {
        // Send many small messages as one
        if (offset) {
          dc.send(buffer.subarray(0, offset))
          offset = 0
          merged = []
        } else {
          dc.send(chunk)
          continue
        }
      }
      merged.push(chunk.length)
      buffer.set(chunk, offset)
      offset += chunk.length
    }

    dc.send(buffer.subarray(0, offset))

    this.evtLoopTimer = this.queue = null
  }

  destroy (err) {
    if (this.destroyed) return
    this.destroyed = true
    this.error = typeof err === 'string'
      ? new Error(err)
      : err || new Error('something closed')

    // this.error = err || null
    // this._debug('destroy (error: %s)', err && (err.message || err))
    const channel = this._dc
    const pc = this._pc

    // Cleanup DataChannel
    if (this._dc) {
      channel.onclose = null
      channel.onerror = null
      channel.onmessage = null
      channel.onopen = null
      if (channel.readyState !== 'closed') channel.close()
    }

    pc.ondatachannel = null
    pc.onicecandidate = null
    pc.oniceconnectionstatechange = null
    pc.onicegatheringstatechange = null
    pc.onsignalingstatechange = null
    if (pc.iceConnectionState === 'new') false && console.log(new Error('dont close this'))
    pc.close()

    // Cleanup local variables
    this._channelReady =
    this._pcReady =
    this.connected =
    this.onMessage =
    this.timestamp =
    this._dc =
    this._pc = null

    this.onDestroy && this.onDestroy(err)
  }
}

/**
 * Expose config, constraints, and data channel config for overriding all Peer
 * instances. Otherwise, just set opts.config, opts.constraints, or opts.channelConfig
 * when constructing a Peer.
 */
Peer.config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
  ]
}

var _$Peer_7 = Peer

/* global WebSocket */

/* removed: const _$Peer_7 = require('../../../light-peer/light.js') */;
/* removed: const _$Tracker_3 = require('./tracker') */;
const { hexToBinary, binaryToHex } = _$common_5

// Use a socket pool, so tracker clients share WebSocket objects for the same server.
// In practice, WebSockets are pretty slow to establish, so this gives a nice performance
// boost, and saves browser resources.
const socketPool = {}

const RECONNECT_MINIMUM = 15 * 1000
const RECONNECT_MAXIMUM = 30 * 60 * 1000
const RECONNECT_VARIANCE = 30 * 1000
const OFFER_TIMEOUT = 50 * 1000
const __MAX_BUFFERED_AMOUNT_4 = 64 * 1024

class WebSocketTracker extends _$Tracker_3 {
  constructor (client, announceUrl) {
    super(client, announceUrl)
    // debug('new websocket tracker %s', announceUrl)

    this.peers = {} // peers (offer id -> peer)
    this.reusable = {} // peers (offer id -> peer)
    this.socket = null

    this.reconnecting = false
    this.retries = 0
    this.reconnectTimer = null

    // Simple boolean flag to track whether the socket has received data from
    // the websocket server since the last time socket.send() was called.
    this.expectingResponse = false

    this._openSocket()
  }

  announce (opts) {
    if (this.destroyed || this.reconnecting) return
    if (this.socket._ws.readyState !== WebSocket.OPEN) {
      this.socket._ws.addEventListener('open', () => {
        this.announce(opts)
      }, { once: true })
      return
    }

    const params = Object.assign({}, opts, {
      action: 'announce',
      info_hash: this.client._infoHashBinary,
      peer_id: this.client._peerIdBinary
    })
    if (this._trackerId) params.trackerid = this._trackerId

    if (opts.event === 'stopped' || opts.event === 'completed') {
      // Don't include offers with 'stopped' or 'completed' event
      this._send(params)
    } else {
      // Limit the number of offers that are generated, since it can be slow
      const numwant = Math.min(opts.numwant, 10)

      this._generateOffers(numwant, offers => {
        params.numwant = numwant
        params.offers = offers
        this._send(params)
      })
    }
  }

  scrape (opts) {
    if (this.destroyed || this.reconnecting) return
    if (this.socket._ws.readyState !== WebSocket.OPEN) {
      this.socket._ws.addEventListener('open', () => {
        this.scrape(opts)
      }, { once: true })
      return
    }
    console.log('how did you not notice this?!')
    const infoHashes = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
      ? opts.infoHash.map(infoHash => {
        return infoHash.toString('binary')
      })
      : (opts.infoHash && opts.infoHash.toString('binary')) || this.client._infoHashBinary
    const params = {
      action: 'scrape',
      info_hash: infoHashes
    }

    this._send(params)
  }

  destroy () {
    if (this.destroyed) return

    this.destroyed = true

    clearInterval(this.interval)
    clearInterval(this.socket.interval)
    clearTimeout(this.reconnectTimer)

    // Destroy peers
    for (const peerId in this.peers) {
      const peer = this.peers[peerId]
      clearTimeout(peer.trackerTimeout)
      peer.destroy()
    }
    this.peers = null

    if (this.socket) {
      this.socket._ws.removeEventListener('open', this._onSocketConnectBound)
      this.socket._ws.removeEventListener('message', this._onSocketDataBound)
      this.socket._ws.removeEventListener('close', this._onSocketCloseBound)
      this.socket._ws.removeEventListener('error', this._onSocketErrorBound)
      this.socket = null
    }

    this._onSocketConnectBound = null
    this._onSocketErrorBound = null
    this._onSocketDataBound = null
    this._onSocketCloseBound = null

    if (socketPool[this.announceUrl]) {
      socketPool[this.announceUrl].consumers -= 1
    }

    // Other instances are using the socket, so there's nothing left to do here
    if (socketPool[this.announceUrl].consumers > 0) return

    let socket = socketPool[this.announceUrl]
    delete socketPool[this.announceUrl]

    // If there is no data response expected, destroy immediately.
    if (!this.expectingResponse) return destroyCleanup()

    // Otherwise, wait a short time for potential responses to come in from the
    // server, then force close the socket.
    var timeout = setTimeout(destroyCleanup, 1000)

    // But, if a response comes from the server before the timeout fires, do cleanup
    // right away.
    socket._ws.addEventListener('data', destroyCleanup)

    function destroyCleanup () {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      socket._ws.removeEventListener('data', destroyCleanup)
      socket._ws.close()
    }
  }

  _openSocket () {
    this.destroyed = false

    if (!this.peers) this.peers = {}
    const once = { once: true }

    this._onSocketConnectBound = () => {
      this._onSocketConnect()
    }
    this._onSocketErrorBound = err => {
      this._onSocketError(err)
    }
    this._onSocketDataBound = evt => {
      this._onSocketData(evt.data)
    }
    this._onSocketCloseBound = () => {
      this._onSocketClose()
    }

    this.socket = socketPool[this.announceUrl]
    if (this.socket) {
      socketPool[this.announceUrl].consumers += 1
    } else {
      console.log('opened', this.announceUrl)
      this.socket = socketPool[this.announceUrl] = {
        _ws: new WebSocket(this.announceUrl),
        consumers: 1,
        buffer: []
      }
      console.log('connecting to: ' + this.socket._ws.url)
      this.socket._ws.addEventListener('open', this._onSocketConnectBound, once)
    }

    this.socket._ws.addEventListener('message', this._onSocketDataBound)
    this.socket._ws.addEventListener('close', this._onSocketCloseBound, once)
    this.socket._ws.addEventListener('error', this._onSocketErrorBound, once)
  }

  _onSocketConnect () {
    console.log('connected to: ' + this.socket._ws.url)
    console.log('looking for peers')
    if (this.destroyed) return

    if (this.reconnecting) {
      this.reconnecting = false
      this.retries = 0
      this.announce(this.client._defaultAnnounceOpts())
    }
  }

  _onSocketData (data) {
    if (this.destroyed) return

    this.expectingResponse = false

    try {
      data = JSON.parse(data)
    } catch (err) {
      this.client.emit('warning', new Error('Invalid tracker response'))
      return
    }

    if (data.action === 'announce') {
      this._onAnnounceResponse(data)
    } else if (data.action === 'scrape') {
      this._onScrapeResponse(data)
    } else {
      this._onSocketError(new Error(`invalid action in WS response: ${data.action}`))
    }
  }

  _onAnnounceResponse (data) {
    if (data.info_hash !== this.client._infoHashBinary) {
      // debug(
      //   'ignoring websocket data from %s for %s (looking for %s: reused socket)',
      //   this.announceUrl, binaryToHex(data.info_hash), this.client.infoHash
      // )
      return
    }

    if (data.peer_id && data.peer_id === this.client._peerIdBinary) {
      // ignore offers/answers from this client
      return
    }

    // debug(
    //   'received %s from %s for %s',
    //   JSON.stringify(data), this.announceUrl, this.client.infoHash
    // )

    const failure = data['failure reason']
    if (failure) return this.client.emit('warning', new Error(failure))

    const warning = data['warning message']
    if (warning) this.client.emit('warning', new Error(warning))

    const interval = data.interval || data['min interval']
    if (interval) this.setInterval(interval * 1000)

    const trackerId = data['tracker id']
    if (trackerId) {
      // If absent, do not discard previous trackerId value
      this._trackerId = trackerId
    }

    if (data.complete != null) {
      const response = Object.assign({}, data, {
        announce: this.announceUrl,
        infoHash: binaryToHex(data.info_hash)
      })
      this.client.emit('update', response)
    }

    let peer
    if (data.offer && data.peer_id) {
      const peerId = binaryToHex(data.peer_id)
      if (this.client._filter && !this.client._filter(peerId)) return
      peer = this._createPeer({ offer: data.offer })
      peer.id = peerId

      peer.onSignal = peer => {
        peer.onSignal = null
        const params = {
          action: 'announce',
          info_hash: this.client._infoHashBinary,
          peer_id: this.client._peerIdBinary,
          to_peer_id: data.peer_id,
          answer: peer.sdp,
          offer_id: data.offer_id
        }
        if (this._trackerId) params.trackerid = this._trackerId
        this._send(params)
        this.client.emit('peer', peer)
        // peer.onConnect = () => {
        //   console.log(peer._dc)
        //   peer.connected = true
        //   this.client.emit('peer', peer)
        // }
      }
    }

    if (data.answer && data.peer_id) {
      const offerId = binaryToHex(data.offer_id)
      peer = this.peers[offerId]
      if (peer) {
        peer.id = binaryToHex(data.peer_id)
        const peerId = binaryToHex(data.peer_id)

        if (this.client._filter && !this.client._filter(peerId)) {
          return peer.destroy('filtered')
        }

        this.client.emit('peer', peer)

        peer.signal(data.answer)

        clearTimeout(peer.trackerTimeout)
        peer.trackerTimeout = null
        delete this.peers[offerId]
      } else {
        // debug(`got unexpected answer: ${JSON.stringify(data.answer)}`)
      }
    }
  }

  _onScrapeResponse (data) {
    data = data.files || {}

    const keys = Object.keys(data)
    if (keys.length === 0) {
      this.client.emit('warning', new Error('invalid scrape response'))
      return
    }

    keys.forEach(infoHash => {
      // TODO: optionally handle data.flags.min_request_interval
      // (separate from announce interval)
      const response = Object.assign(data[infoHash], {
        announce: this.announceUrl,
        infoHash: binaryToHex(infoHash)
      })
      this.client.emit('scrape', response)
    })
  }

  _onSocketClose () {
    if (this.destroyed) return
    this.destroy()
    this._startReconnectTimer()
  }

  _onSocketError (err) {
    if (this.destroyed) return
    this.destroy()
    // errors will often happen if a tracker is offline, so don't treat it as fatal
    this.client.emit('warning', err)
    this._startReconnectTimer()
  }

  _startReconnectTimer () {
    const ms = Math.floor(Math.random() * RECONNECT_VARIANCE) + Math.min(Math.pow(2, this.retries) * RECONNECT_MINIMUM, RECONNECT_MAXIMUM)

    this.reconnecting = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.retries++
      this._openSocket()
    }, ms)
    // debug('reconnecting socket in %s ms', ms)
  }

  _send (params) {
    if (this.destroyed) return
    this.expectingResponse = true
    const message = JSON.stringify(params)
    // debug('send %s', message)
    const { _ws, buffer } = this.socket
    if (buffer.length || _ws.readyState !== WebSocket.OPEN || _ws.bufferedAmount > __MAX_BUFFERED_AMOUNT_4) {
      buffer.push(message)

      if (!this.socket.interval) {
        this.socket.interval = setInterval(() => {
          while (_ws.readyState === WebSocket.OPEN && buffer.length && _ws.bufferedAmount < __MAX_BUFFERED_AMOUNT_4) {
            _ws.send(buffer.shift())
          }
          if (!buffer.length) {
            clearInterval(this.socket.interval)
            delete this.socket.interval
          }
        }, 150)
      }
    } else {
      _ws.send(message)
    }
  }

  async _generateOffers (numwant, cb) {
    let offers = []
    let i = numwant
    // debug('creating peer (from _generateOffers)')
    while (i--) {
      const peer = this._createPeer()

      offers.push(new Promise(resolve => {
        peer.onSignal = resolve
      }))
    }

    const peers = await Promise.all(offers)

    offers = []

    for (let peer of peers) {
      const offerId = peer.sdp.sdp
        .match(/a=fingerprint:[\w-]*\s(.*)/)[1].replace(/[^\w]*/g, '')
        .substr(0, 20)
        .toLowerCase()

      peer.onDestroy = () => {
        peer['destroyCalled'] = true
        delete this.peers[offerId]
      }

      this.peers[offerId] = peer

      offers.push({
        offer: peer.sdp,
        offer_id: hexToBinary(offerId)
      })

      peer.trackerTimeout = setTimeout(() => {
        peer.trackerTimeout = null
        delete this.peers[offerId]
        peer.destroy()
      }, OFFER_TIMEOUT)
    }

    cb(offers)
  }

  _createPeer (opts) {
    opts = Object.assign({
      config: this.client._rtcConfig
    }, opts)

    const peer = new _$Peer_7(opts)

    return peer
  }
}

WebSocketTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000 // 30 seconds
// Normally this shouldn't be accessed but is occasionally useful
WebSocketTracker._socketPool = socketPool

var _$WebSocketTracker_4 = WebSocketTracker

// const debug = require('debug')('bittorrent-tracker:client')
/* removed: const _$EventEmitter_6 = require('events') */;
/* removed: const _$common_5 = require('../common') */;
/* removed: const _$WebSocketTracker_4 = require('./lib/client/websocket-tracker') */;

const { arr2hex } = _$common_5

/**
 * BitTorrent tracker client.
 * Find torrent peers, to help a torrent client participate in a torrent swarm.
 */
class Client extends _$EventEmitter_6 {
  /**
   * @param {Object} opts                          options object
   * @param {Uint8Array} opts.infoHash             torrent info hash
   * @param {Uint8Array} opts.peerId               peer id
   * @param {string|Array.<string>} opts.announce  announce
   * @param {Function} opts.getAnnounceOpts        callback to provide data to tracker
   * @param {number} opts.rtcConfig                RTCPeerConnection configuration object
   */
  constructor (opts) {
    super()
    this._peerIdBinary = String.fromCharCode.apply(null, opts.peerId)

    // TODO: do we need this to be a string?
    this.infoHash = typeof opts.infoHash === 'string'
      ? opts.infoHash.toLowerCase()
      : arr2hex(opts.infoHash)
    this._infoHashBinary = _$common_5.hexToBinary(this.infoHash)

    this.destroyed = false

    this._getAnnounceOpts = opts.getAnnounceOpts
    this._filter = opts.filter
    this._rtcConfig = opts.rtcConfig

    let announce = typeof opts.announce === 'string'
      ? [ opts.announce ]
      : opts.announce == null ? [] : opts.announce

    // Remove trailing slash from trackers to catch duplicates
    announce = announce.map(announceUrl => {
      announceUrl = announceUrl.toString()
      if (announceUrl[announceUrl.length - 1] === '/') {
        announceUrl = announceUrl.substring(0, announceUrl.length - 1)
      }
      return announceUrl
    })
    announce = [...new Set(announce)]

    this._trackers = announce
      .map(announceUrl => {
        // TODO: should we try to cast ws: to wss:?
        if (announceUrl.startsWith('wss:') || announceUrl.startsWith('ws:')) {
          return new _$WebSocketTracker_4(this, announceUrl)
        } else {
          // console.warn(`Unsupported tracker protocol: ${announceUrl}`)
          return null
        }
      })
      .filter(Boolean)
  }

  /**
   * Send a `start` announce to the trackers.
   * @param {Object=} opts
   * @param {number=} opts.uploaded
   * @param {number=} opts.downloaded
   * @param {number=} opts.left (if not set, calculated automatically)
   */
  start (opts = {}) {
    // debug('send `start`')
    opts = this._defaultAnnounceOpts(opts)
    opts.event = 'started'
    this._announce(opts)

    // start announcing on intervals
    this._trackers.forEach(tracker => {
      tracker.setInterval()
    })
  }

  /**
   * Send a `stop` announce to the trackers.
   * @param {Object} opts
   * @param {number=} opts.uploaded
   * @param {number=} opts.downloaded
   * @param {number=} opts.numwant
   * @param {number=} opts.left (if not set, calculated automatically)
   */
  stop (opts) {
    // debug('send `stop`')
    opts = this._defaultAnnounceOpts(opts)
    opts.event = 'stopped'
    this._announce(opts)
  }

  /**
   * Send a `complete` announce to the trackers.
   * @param {Object} opts
   * @param {number=} opts.uploaded
   * @param {number=} opts.downloaded
   * @param {number=} opts.numwant
   * @param {number=} opts.left (if not set, calculated automatically)
   */
  complete (opts) {
    // debug('send `complete`')
    if (!opts) opts = {}
    opts = this._defaultAnnounceOpts(opts)
    opts.event = 'completed'
    this._announce(opts)
  }

  /**
   * Send a `update` announce to the trackers.
   * @param {Object} opts
   * @param {number=} opts.uploaded
   * @param {number=} opts.downloaded
   * @param {number=} opts.numwant
   * @param {number=} opts.left (if not set, calculated automatically)
   */
  update (opts) {
    opts = this._defaultAnnounceOpts(opts)
    if (opts.event) delete opts.event
    this._announce(opts)
  }

  _announce (opts) {
    this._trackers.forEach(tracker => {
      // tracker should not modify `opts` object, it's passed to all trackers
      tracker.announce(opts)
    })
  }

  /**
   * Send a scrape request to the trackers.
   * @param  {Object=} opts
   */
  scrape (opts = {}) {
    this._trackers.forEach(tracker => {
      // tracker should not modify `opts` object, it's passed to all trackers
      tracker.scrape(opts)
    })
  }

  setInterval (intervalMs) {
    this._trackers.forEach(tracker => {
      tracker.setInterval(intervalMs)
    })
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    const trackers = this._trackers
    let i = trackers.length
    while (i--) trackers[i].destroy()

    this._trackers = []
    this._getAnnounceOpts = null
  }

  _defaultAnnounceOpts (opts = {}) {
    if (!opts.numwant) opts.numwant = 50
    if (!opts.uploaded) opts.uploaded = 0
    if (!opts.downloaded) opts.downloaded = 0
    if (this._getAnnounceOpts) opts = Object.assign({}, opts, this._getAnnounceOpts())

    return opts
  }
}

var _$Client_2 = Client

var _$hgf_1 = {};
window.Tracker = _$Client_2
window.common = _$common_5

});