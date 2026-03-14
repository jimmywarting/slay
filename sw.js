// Service Worker for Slay – Turn-Based Strategy
// Strategy: cache-first for all local assets, network-only for CDN (TF.js)

const CACHE_VERSION = 'slay-v1'

// All local files that make up the game shell
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/agent-store.js',
  './src/ai-rl.js',
  './src/ai.js',
  './src/combat.js',
  './src/constants.js',
  './src/economy.js',
  './src/game.js',
  './src/hex.js',
  './src/input.js',
  './src/map.js',
  './src/movement.js',
  './src/renderer.js',
  './src/territory.js',
  './src/train-worker.js',
  './src/train.js',
  './src/turn-system.js',
  './src/units.js'
]

// ── Install: pre-cache every local file ─────────────────────────────────────
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(PRECACHE_URLS)
    }).then(function () {
      // Activate the new SW immediately without waiting for old clients to close
      return self.skipWaiting()
    })
  )
})

// ── Activate: delete stale caches from previous versions ────────────────────
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_VERSION })
          .map(function (key) { return caches.delete(key) })
      )
    }).then(function () {
      // Take control of all open clients immediately
      return self.clients.claim()
    })
  )
})

// ── Fetch: serve local assets from cache, CDN resources from network ────────
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url)

  // Let CDN requests (TF.js) fall through to the network — they are large and
  // change rarely; the browser's HTTP cache handles them fine.  If the network
  // is unavailable and TF.js cannot load, the game still runs (AI falls back
  // to the heuristic engine; training is simply unavailable).
  if (url.origin !== self.location.origin) {
    return  // no event.respondWith → browser handles it normally
  }

  // Cache-first for all same-origin requests
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached

      // Not in cache yet — fetch from network and cache the response
      return fetch(event.request).then(function (response) {
        // Only cache valid responses (CDN/cross-origin was already let through above)
        if (!response || response.status !== 200) {
          return response
        }
        const toCache = response.clone()
        caches.open(CACHE_VERSION).then(function (cache) {
          cache.put(event.request, toCache)
        })
        return response
      })
    })
  )
})
