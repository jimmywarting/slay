// Web Worker: runs a single self-play game between two neural agents.
// Receives flat weight arrays from the main thread, plays a complete game,
// and posts back fitness scores.  TF.js is NOT needed here — ai-rl.js uses
// a pure-JS forward pass that works in any worker context.

import { runSelfPlayGameWeights } from './ai-rl.js'

self.onmessage = function (evt) {
  const { weights1, weights2, roundId } = evt.data

  // Reconstruct Float32Arrays from transferred ArrayBuffers
  const result = runSelfPlayGameWeights(
    new Float32Array(weights1),
    new Float32Array(weights2)
  )

  self.postMessage({ roundId: roundId, fitness1: result.fitness1, fitness2: result.fitness2 })
}
