// Simplified WebRTC peer discovery via BitTorrent WebSocket tracker.
// Extracted and simplified from WebTorrent for direct browser use.
//
// Usage:
//   const t = new WebSocketTracker(infoHash)
//   t.numwant = 2   // how many peers to connect to
//   t.addEventListener('peer',           e => { /* e.detail.dc, e.detail.offerId  */ })
//   t.addEventListener('message',        e => { /* e.detail.data, e.detail.dc, e.detail.offerId */ })
//   t.addEventListener('peer-disconnect',e => { /* e.detail.offerId               */ })
//   t.connect()

import { cors } from 'https://jimmy.warting.se/packages/fetch/cors.js'

const TRACKER_URL = 'wss://tracker.openwebtorrent.com'

class WebSocketTracker extends EventTarget {
  #ws = null
  #announceInterval = null
  #infoHash = null
  #offers = new Map()
  #config = null
  numwant = 1

  #peerId = new Uint8Array(
    [45, 87, 87, 48, 48, 51, 45].concat(
      [...Array(13)].map(() => (Math.random() * 16) | 0)
    )
  )

  constructor (infoHash) {
    super()
    this.#infoHash = infoHash
  }

  connect () {
    this.#ws = new WebSocket(TRACKER_URL)
    this.#ws.onopen = () => {
      this.dispatchEvent(new Event('connected'))
      this.#announce('started')
    }

    this.#ws.onmessage = (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      this.#handleMessage(data)
    }

    this.#ws.onerror = (err) => {
      this.dispatchEvent(new CustomEvent('error', { detail: err }))
    }

    this.#ws.onclose = () => {
      clearInterval(this.#announceInterval)
      this.dispatchEvent(new Event('close'))
    }
  }

  async #announce (event = undefined) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
    this.#config ??= await cors('https://instant.io/__rtcConfig__')
      .then(res => res.json())
      .then(config => config.rtcConfig.iceServers)

    const offers = []

    for (let i = 0; i < this.numwant; i++) {
      const pc = new RTCPeerConnection({ iceServers: this.#config })

      // Pre-negotiated data channel: both sides create it with the same id.
      const dc = pc.createDataChannel('data', { negotiated: true, id: 0 })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const offerId = crypto.randomUUID()
      this.#offers.set(offerId, { pc, dc })

      this.#setupDataChannel(dc, offerId)

      pc.onicecandidate = (e) => {
        if (e.candidate === null) {
          const fullOffer = pc.localDescription
          offers.push({
            offer: { type: fullOffer.type, sdp: fullOffer.sdp },
            offer_id: offerId
          })
          if (offers.length === this.numwant) {
            this.#sendAnnounce(event, offers)
          }
        }
      }
    }
  }

  #sendAnnounce (event, offers) {
    const msg = {
      action: 'announce',
      info_hash: this.#infoHash,
      peer_id: String.fromCharCode.apply(null, this.#peerId),
      numwant: offers.length,
      uploaded: 0,
      downloaded: 0,
      left: 1,
      offers
    }

    if (event) msg.event = event
    this.#ws.send(JSON.stringify(msg))

    if (!this.#announceInterval) {
      this.#announceInterval = setInterval(() => this.#announce(), 30_000)
    }
  }

  #handleMessage (data) {
    if (data.info_hash !== this.#infoHash) return

    if (data.offer) {
      this.#handleOffer(data)
    } else if (data.answer) {
      this.#handleAnswer(data)
    }
  }

  async #handleOffer (data) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })

    // Pre-negotiated: answerer creates the same channel with the same id (0)
    const dc = pc.createDataChannel('data', { negotiated: true, id: 0 })
    this.#setupDataChannel(dc, data.offer_id)

    pc.onicecandidate = (e) => {
      if (e.candidate === null) {
        this.#ws.send(JSON.stringify({
          action: 'announce',
          info_hash: this.#infoHash,
          peer_id: String.fromCharCode.apply(null, this.#peerId),
          to_peer_id: data.peer_id,
          answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          offer_id: data.offer_id
        }))
      }
    }

    await pc.setRemoteDescription(data.offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
  }

  #handleAnswer (data) {
    const entry = this.#offers.get(data.offer_id)
    if (!entry) return
    entry.pc.setRemoteDescription(data.answer)
  }

  #setupDataChannel (dc, offerId) {
    dc.onopen = () => {
      this.dispatchEvent(new CustomEvent('peer', { detail: { dc, offerId } }))
    }
    dc.onmessage = (e) => {
      this.dispatchEvent(new CustomEvent('message', { detail: { data: e.data, dc, offerId } }))
    }
    dc.onclose = () => {
      this.#offers.delete(offerId)
      this.dispatchEvent(new CustomEvent('peer-disconnect', { detail: { offerId } }))
    }
    dc.onerror = (err) => {
      this.dispatchEvent(new CustomEvent('error', { detail: err }))
    }
  }

  send (dc, data) {
    if (dc.readyState === 'open') {
      dc.send(data)
    }
  }

  close () {
    this.closeTracker()
    this.closeOffersAndPeers()
  }

  closeTracker () {
    clearInterval(this.#announceInterval)
    this.#announceInterval = null
    this.#ws?.close()
    this.#ws = null
  }

  closeOffersAndPeers () {
    for (const { pc } of this.#offers.values()) {
      pc.close()
    }
    this.#offers.clear()
  }
}

export { WebSocketTracker }
