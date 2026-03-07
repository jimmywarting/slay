// Web Worker for AI self-play training.
//
// Runs one or more complete self-play games off the main thread using the
// pure-JS forward pass (no TensorFlow.js required).
//
// Message in:  { type: 'run_games', agentWeights: Float32Array[], numGames: number, workerIdx: number }
// Message out: { type: 'result', fitnessDeltas: Float64Array, workerIdx: number }

import { runSelfPlayGameWeights } from './ai-rl.js'

self.onmessage = function (e) {
  const msg = e.data
  if (msg.type !== 'run_games') return

  const { agentWeights, numGames, workerIdx } = msg
  const n = agentWeights.length
  const fitnessDeltas = new Float64Array(n)

  for (let g = 0; g < numGames; g++) {
    const deltas = runSelfPlayGameWeights(agentWeights)
    for (let i = 0; i < n; i++) fitnessDeltas[i] += deltas[i]
  }

  self.postMessage({ type: 'result', fitnessDeltas, workerIdx })
}
