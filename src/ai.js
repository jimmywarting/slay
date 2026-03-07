// AI opponent using the browser's built-in LanguageModel Prompt API.
// Falls back to a trained TF.js neural agent when available, and then
// to a greedy heuristic when neither is usable.

import { getValidMoves, executeMove, PEASANT_COST, TOWER_COST } from './movement.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { UNIT_DEFS } from './units.js'
import { TERRAIN_LAND, TERRAIN_WATER, STRUCTURE_HUT, STRUCTURE_TOWER } from './constants.js'
import { hexNeighborKeys } from './hex.js'
import { getActiveNeuralAgent, runNeuralAgentTurn } from './ai-rl.js'

// ── Public API ────────────────────────────────────────────────────────────────

// Returns true if the given player index is AI-controlled in this game state.
function isAIPlayer(state, playerId) {
  return !!(state.aiPlayers && state.aiPlayers.indexOf(playerId) !== -1)
}

// Run a full AI turn: think, execute actions.
// The caller is responsible for calling endTurn() afterwards.
async function runAITurn(state) {
  // 1. Try trained neural agent (from self-play training via localStorage)
  const neuralAgent = getActiveNeuralAgent()
  if (neuralAgent) {
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
      state.players[state.activePlayer].name + ' [RL gen ' + neuralAgent.generation + ']')
    runNeuralAgentTurn(state, neuralAgent)
    return
  }

  // 2. Try browser LanguageModel Prompt API
  const api = (typeof LanguageModel !== 'undefined' && LanguageModel) ||
              (typeof window !== 'undefined' && window.LanguageModel)
  if (api) {
    try {
      await runLLMTurn(state, api)
      return
    } catch (err) {
      console.warn('[AI] LanguageModel failed, falling back to greedy:', err)
    }
  }

  // 3. Greedy heuristic fallback
  runGreedyTurn(state)
}

// Append an entry to the shared action log (capped at 60 entries).
function appendToLog(state, entry) {
  if (!state.actionLog) state.actionLog = []
  state.actionLog.push(entry)
  if (state.actionLog.length > 60) state.actionLog.shift()
}

// ── LanguageModel-based turn ──────────────────────────────────────────────────

const GAME_RULES_SYSTEM_PROMPT =
  'You are an AI player in a turn-based hex strategy game called Slay. YOUR GOAL IS TO WIN by controlling all land hexes.\n' +
  '\n' +
  'GAME RULES:\n' +
  '- The map is a hexagonal grid. Each hex has axial coordinates "q,r".\n' +
  '- Players own contiguous land-hex groups called territories, each with a hut (HQ).\n' +
  '- On your turn: move units, buy peasants, build towers, then end the turn.\n' +
  '\n' +
  'INCOME & UPKEEP (applied when turn ends):\n' +
  '- Each plain land hex you own earns 1 gold per turn.\n' +
  '- Units cost upkeep each turn: Peasant=2, Spearman=6, Knight=18, Baron=54.\n' +
  '- If a territory cannot pay upkeep (bank < 0), all its units die → gravestones.\n' +
  '\n' +
  'UNITS (strength / upkeep / cost):\n' +
  '  Peasant  str=1  upkeep=2  costs 5g (only purchasable unit)\n' +
  '  Spearman str=2  upkeep=6  (merge two Peasants)\n' +
  '  Knight   str=3  upkeep=18 (merge Peasant+Spearman)\n' +
  '  Baron    str=4  upkeep=54 (merge two Spearmen)\n' +
  '\n' +
  'MERGING: move a unit onto a friendly unit; their levels add (max 4).\n' +
  '  If either source already moved this turn, the merged unit is also "moved".\n' +
  '\n' +
  'MOVEMENT:\n' +
  '  Free reposition – moving within own territory to empty land: unit stays ready.\n' +
  '  Action – capturing enemy hex, merging, clearing a tree: marks unit as "moved".\n' +
  '  A "moved" unit cannot act again this turn.\n' +
  '\n' +
  'CAPTURING: attacker strength must be STRICTLY GREATER than defender strength.\n' +
  '  Defender strength = highest strength of any unit/structure on the hex OR adjacent friendly hex.\n' +
  '  Hut defends 1, Tower defends 2.\n' +
  '\n' +
  'TOWERS: cost 10g, defend strength 2 on adjacent hexes, cannot move.\n' +
  '\n' +
  'WINNING STRATEGY (follow this order of priorities):\n' +
  '  1. EXPAND FIRST – grab neutral territory hexes every turn; more land = more income.\n' +
  '  2. BUY UNITS – buy peasants aggressively when you can afford them; place them on border hexes.\n' +
  '  3. MERGE FOR POWER – merge two Peasants into a Spearman to break through enemy defences.\n' +
  '  4. ATTACK ENEMY HUTS – capturing a hut splits the enemy territory and often bankrupts it.\n' +
  '  5. ELIMINATE THREATS – target the player with the most land and income first.\n' +
  '  6. DEFEND WITH TOWERS – build a tower on a border hex when income is healthy and gold is spare.\n' +
  '  7. AVOID BANKRUPTCY – never let upkeep exceed income unless you have many saved gold.\n' +
  '\n' +
  'OUTPUT RULES:\n' +
  '  - Output ONLY valid JSON matching the schema. No markdown, no extra text.\n' +
  '  - Only use hex keys that appear in the state description below.\n' +
  '  - Always include "end_turn" as the last action.\n' +
  '  - Always buy at least one unit if you can afford it and have empty land.\n' +
  '  - Always reposition units toward the border if they cannot yet capture.'

async function runLLMTurn(state, api) {
  const session = await api.create()

  const stateText = buildStateDescription(state)
  const schema = buildActionSchema()

  const response = await session.prompt(stateText, {
    initialPrompts: [{ role: 'system', content: GAME_RULES_SYSTEM_PROMPT }],
    responseConstraint: schema
  })

  try { session.destroy() } catch (_) {}

  let parsed
  try {
    parsed = JSON.parse(response)
  } catch (e) {
    console.warn('[AI] Could not parse response:', response)
    runGreedyTurn(state)
    return
  }

  if (parsed.reasoning) {
    console.log('[AI reasoning]', parsed.reasoning)
    appendToLog(state, 'AI thought: ' + parsed.reasoning)
  }

  const actions = parsed.actions || []
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].type === 'end_turn') break
    executeAIAction(state, actions[i])
  }
}

function buildActionSchema() {
  return {
    type: 'object',
    required: ['actions'],
    additionalProperties: false,
    properties: {
      reasoning: {
        type: 'string',
        description: 'Brief 1-2 sentence strategic reasoning for this turn.'
      },
      actions: {
        type: 'array',
        description: 'Ordered list of actions to perform this turn, ending with end_turn.',
        items: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: ['move_unit', 'buy_unit', 'build_tower', 'end_turn'],
              description:
                'move_unit=move a unit, buy_unit=purchase a peasant, ' +
                'build_tower=place a tower, end_turn=stop acting.'
            },
            from: {
              type: 'string',
              description: 'Source hex key "q,r" for move_unit.'
            },
            to: {
              type: 'string',
              description: 'Destination hex key "q,r" for move_unit.'
            },
            hex: {
              type: 'string',
              description: 'Target hex key "q,r" for buy_unit or build_tower placement.'
            }
          }
        }
      }
    }
  }
}

function buildStateDescription(state) {
  const player = state.activePlayer
  const playerName = state.players[player].name
  const lines = []

  lines.push('=== YOUR TURN: ' + playerName +
    ' (player index ' + player + '), Turn ' + (state.turn + 1) + ' ===')
  lines.push('')

  // Own territories
  lines.push('YOUR TERRITORIES:')
  const myTerritories = state.territories.filter(function (t) { return t.owner === player })
  if (myTerritories.length === 0) {
    lines.push('  (none)')
  }
  for (let i = 0; i < myTerritories.length; i++) {
    const t = myTerritories[i]
    const income = computeIncome(state, t)
    const upkeep = computeUpkeep(state, t)
    lines.push('  Territory ' + (i + 1) + ':')
    lines.push('    Hexes: ' + t.hexKeys.join(', '))
    lines.push('    Hut: ' + (t.hutHexKey || 'none'))
    lines.push('    Bank: ' + t.bank + 'g | Income: +' + income +
      ' | Upkeep: -' + upkeep + ' | Net: ' + (income - upkeep) + '/turn')

    // Units with valid moves
    const unitLines = []
    for (let j = 0; j < t.hexKeys.length; j++) {
      const k = t.hexKeys[j]
      const h = state.hexes[k]
      if (!h || !h.unit) continue
      const ud = UNIT_DEFS[h.unit.level]
      if (h.unit.moved) {
        unitLines.push('      ' + ud.name + '(str' + ud.strength + ') at ' + k + ' [MOVED]')
      } else {
        const vm = getValidMoves(state, k)
        const moveDescs = []
        for (let m = 0; m < vm.moves.length; m++) {
          const mk = vm.moves[m]
          const mh = state.hexes[mk]
          if (!mh) continue
          let kind
          if (mh.owner === player) {
            kind = mh.unit ? 'merge' : (vm.freeSet[mk] ? 'free' : 'clear-tree')
          } else {
            kind = 'CAPTURE'
          }
          moveDescs.push(mk + '(' + kind + ')')
        }
        unitLines.push('      ' + ud.name + '(str' + ud.strength + ') at ' + k +
          ' | valid moves: ' + (moveDescs.length ? moveDescs.join(', ') : 'none'))
      }
    }
    if (unitLines.length > 0) {
      lines.push('    Units:')
      for (let u = 0; u < unitLines.length; u++) lines.push(unitLines[u])
    } else {
      lines.push('    Units: none')
    }

    // Empty hexes where a new peasant could be placed
    const emptyLand = []
    for (let e = 0; e < t.hexKeys.length; e++) {
      const h2 = state.hexes[t.hexKeys[e]]
      if (h2 && h2.terrain === TERRAIN_LAND && !h2.unit && !h2.structure) {
        emptyLand.push(t.hexKeys[e])
      }
    }
    if (t.bank >= PEASANT_COST && emptyLand.length > 0) {
      lines.push('    CAN BUY PEASANT (5g): place on any of: ' + emptyLand.join(', '))
    }
    if (t.bank >= TOWER_COST && emptyLand.length > 0) {
      lines.push('    CAN BUILD TOWER (10g): place on any of: ' + emptyLand.join(', '))
    }
  }
  lines.push('')

  // Enemy territories
  lines.push('ENEMY TERRITORIES:')
  let hasEnemies = false
  for (let p = 0; p < state.numActivePlayers; p++) {
    if (p === player) continue
    const enemyTerritories = state.territories.filter(function (t) { return t.owner === p })
    lines.push('  ' + state.players[p].name + ' (player ' + p + ', ' +
      enemyTerritories.length + ' territories):')
    hasEnemies = true
    for (let i = 0; i < enemyTerritories.length; i++) {
      const t = enemyTerritories[i]
      const income = computeIncome(state, t)
      const upkeep = computeUpkeep(state, t)
      lines.push('    Territory ' + (i + 1) + ': ' + t.hexKeys.length + ' hexes, ' +
        'Bank: ' + t.bank + 'g, Net: ' + (income - upkeep) + '/turn')
      lines.push('      Hut: ' + (t.hutHexKey || 'none'))
      for (let j = 0; j < t.hexKeys.length; j++) {
        const k = t.hexKeys[j]
        const h = state.hexes[k]
        if (!h) continue
        if (h.unit) {
          lines.push('      Enemy unit: ' + UNIT_DEFS[h.unit.level].name +
            '(str' + UNIT_DEFS[h.unit.level].strength + ') at ' + k)
        }
        if (h.structure === STRUCTURE_TOWER) {
          lines.push('      Enemy tower at ' + k)
        }
      }
    }
  }
  if (!hasEnemies) lines.push('  (none)')
  lines.push('')

  // Neutral territories (inactive players)
  const neutralTerritories = state.territories.filter(function (t) {
    return t.owner >= state.numActivePlayers
  })
  if (neutralTerritories.length > 0) {
    lines.push('NEUTRAL TERRITORIES (' + neutralTerritories.length + ' total):')
    for (let i = 0; i < neutralTerritories.length; i++) {
      const t = neutralTerritories[i]
      lines.push('  Neutral ' + (i + 1) + ': ' + t.hexKeys.length + ' hexes, ' +
        'hut: ' + (t.hutHexKey || 'none') + ' | hexes: ' + t.hexKeys.join(', '))
    }
    lines.push('')
  }

  // Recent event log
  if (state.actionLog && state.actionLog.length > 0) {
    const recent = state.actionLog.slice(-12)
    lines.push('RECENT EVENTS:')
    for (let i = 0; i < recent.length; i++) {
      lines.push('  ' + recent[i])
    }
    lines.push('')
  }

  lines.push('Decide your actions. Include "end_turn" as the last action.')
  lines.push('Only use hex keys that appear above.')

  return lines.join('\n')
}

// Execute one AI action (move_unit, buy_unit, build_tower).
function executeAIAction(state, action) {
  const player = state.activePlayer

  if (action.type === 'move_unit') {
    if (!action.from || !action.to) return
    const fromHex = state.hexes[action.from]
    if (!fromHex || !fromHex.unit) return
    if (fromHex.owner !== player || fromHex.unit.moved) return
    const vm = getValidMoves(state, action.from)
    if (vm.moves.indexOf(action.to) === -1) return
    executeMove(state, action.from, action.to)
    const destHex = state.hexes[action.to]
    const unitLevel = destHex && destHex.unit ? destHex.unit.level : 1
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' + state.players[player].name +
      ' moved ' + UNIT_DEFS[unitLevel].name +
      ' ' + action.from + ' → ' + action.to)
    return
  }

  if (action.type === 'buy_unit') {
    // Find a territory with enough gold
    let territory = null
    if (action.hex) {
      const h = state.hexes[action.hex]
      if (h && h.owner === player) {
        territory = getTerritoryForHex(state, action.hex)
      }
    }
    if (!territory || territory.bank < PEASANT_COST) {
      for (let i = 0; i < state.territories.length; i++) {
        const t = state.territories[i]
        if (t.owner === player && t.bank >= PEASANT_COST) {
          territory = t
          break
        }
      }
    }
    if (!territory || territory.bank < PEASANT_COST) return

    // Find placement hex (prefer the specified hex, then any empty land)
    let placeKey = null
    if (action.hex) {
      const ph = state.hexes[action.hex]
      if (ph && ph.owner === player && ph.terrain === TERRAIN_LAND &&
          !ph.unit && !ph.structure) {
        placeKey = action.hex
      }
    }
    if (!placeKey) {
      for (let j = 0; j < territory.hexKeys.length; j++) {
        const k = territory.hexKeys[j]
        const h = state.hexes[k]
        if (h && h.terrain === TERRAIN_LAND && !h.unit && !h.structure) {
          placeKey = k
          break
        }
      }
    }
    if (!placeKey) return

    state.hexes[placeKey].unit = { level: 1, moved: false }
    territory.bank -= PEASANT_COST
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' + state.players[player].name +
      ' bought a Peasant at ' + placeKey)
    return
  }

  if (action.type === 'build_tower') {
    if (!action.hex) return
    const h = state.hexes[action.hex]
    if (!h) return
    if (h.owner !== player || h.terrain !== TERRAIN_LAND || h.unit || h.structure) return
    const territory = getTerritoryForHex(state, action.hex)
    if (!territory || territory.bank < TOWER_COST) return
    h.structure = STRUCTURE_TOWER
    territory.bank -= TOWER_COST
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' + state.players[player].name +
      ' built a Tower at ' + action.hex)
  }
}

// ── Greedy fallback ───────────────────────────────────────────────────────────
// A multi-phase strategy: buy units at the frontier, then execute the globally
// best available move each step (captures > merges > expansions > repositions),
// and finally build towers on contested borders with spare gold.

// Minimum move score to act (prevents pointless low-value repositions)
const MIN_MOVE_SCORE = 5
// Maximum unit level (Baron = 4)
const MAX_UNIT_LEVEL = 4

function runGreedyTurn(state) {
  const player = state.activePlayer
  greedyBuyUnits(state, player)
  greedyMoveUnits(state, player)
  greedyBuildTowers(state, player)
}

// ── Buy phase ─────────────────────────────────────────────────────────────────

function greedyBuyUnits(state, player) {
  // Keep buying as long as affordable and won't immediately bankrupt the territory.
  // Iterate repeatedly so multiple units can be bought per turn.
  let bought = true
  while (bought) {
    bought = false
    for (let ti = 0; ti < state.territories.length; ti++) {
      const t = state.territories[ti]
      if (t.owner !== player || t.bank < PEASANT_COST) continue

      const income = computeIncome(state, t)
      const upkeep = computeUpkeep(state, t)
      const netAfterBuy = income - (upkeep + 2) // 2 = peasant upkeep per turn
      const bankAfterBuy = t.bank - PEASANT_COST

      // Buy if: net income stays non-negative after the purchase,
      // OR the saved gold covers at least 3 turns of the resulting deficit.
      const sustainable = netAfterBuy >= 0
      const deficit = Math.abs(Math.min(0, netAfterBuy))
      const hasRunway = bankAfterBuy >= deficit * 3
      if (!sustainable && !hasRunway) continue

      // Place the unit on the frontier hex closest to enemy/neutral territory.
      const placeKey = findFrontierPlacement(state, t, player)
      if (!placeKey) continue

      state.hexes[placeKey].unit = { level: 1, moved: false }
      t.bank -= PEASANT_COST
      appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
        state.players[player].name + ' bought a Peasant at ' + placeKey)
      bought = true
      break // restart outer loop — income/upkeep changed
    }
  }
}

// Find the best empty land hex in a territory for placing a new unit.
// Prefers hexes that are on or near the border (adjacent to non-owned hexes).
function findFrontierPlacement(state, territory, player) {
  let bestKey = null
  let bestScore = -Infinity

  for (let i = 0; i < territory.hexKeys.length; i++) {
    const k = territory.hexKeys[i]
    const h = state.hexes[k]
    if (!h || h.terrain !== TERRAIN_LAND || h.unit || h.structure) continue

    // Count how many adjacent hexes are non-owned (border neighbours).
    const nbrs = hexNeighborKeys(h.q, h.r)
    let borderScore = 0
    for (let j = 0; j < nbrs.length; j++) {
      const nh = state.hexes[nbrs[j]]
      if (!nh || nh.terrain === TERRAIN_WATER) continue
      if (nh.owner !== player) {
        // Active enemy counts double (more urgent frontier)
        borderScore += (nh.owner !== null && nh.owner < state.numActivePlayers) ? 2 : 1
      }
    }
    if (borderScore > bestScore) {
      bestScore = borderScore
      bestKey = k
    }
  }
  return bestKey
}

// ── Move phase ────────────────────────────────────────────────────────────────

// On each iteration pick the globally highest-scored move and execute it.
// Repeat until no move scores above the minimum threshold.
function greedyMoveUnits(state, player) {
  const MAX_ITERS = 80 // safety cap
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let bestScore = MIN_MOVE_SCORE
    let bestFrom = null
    let bestTo = null

    for (const fromKey in state.hexes) {
      const fromHex = state.hexes[fromKey]
      if (!fromHex.unit || fromHex.owner !== player || fromHex.unit.moved) continue

      const vm = getValidMoves(state, fromKey)
      for (let mi = 0; mi < vm.moves.length; mi++) {
        const toKey = vm.moves[mi]
        const score = scoreMoveGreedy(state, fromKey, toKey, vm, player)
        if (score > bestScore) {
          bestScore = score
          bestFrom = fromKey
          bestTo = toKey
        }
      }
    }

    if (!bestFrom) break // no useful move found
    // Capture the pre-move destination state to determine action type for logging
    const preToHex = state.hexes[bestTo]
    const wasMerge = preToHex && preToHex.owner === player && !!preToHex.unit
    const wasCapture = preToHex && preToHex.owner !== player
    executeMove(state, bestFrom, bestTo)
    const destHex = state.hexes[bestTo]
    const unitLevel = destHex && destHex.unit ? destHex.unit.level : 1
    const action = wasCapture ? 'captured' : wasMerge ? 'merged →' : 'repositioned'
    appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
      state.players[player].name + ' ' + action + ' ' +
      UNIT_DEFS[unitLevel].name + ' → ' + bestTo)
  }
}

// Assign a numeric desirability score to a candidate move.
// Higher score = more desirable. Captures are always preferred over repositions.
function scoreMoveGreedy(state, fromKey, toKey, vm, player) {
  const fromHex = state.hexes[fromKey]
  const toHex = state.hexes[toKey]
  if (!fromHex || !toHex || !fromHex.unit) return 0

  const attackerLevel = fromHex.unit.level
  const isOwnHex = toHex.owner === player
  const isActiveEnemy = toHex.owner !== null && toHex.owner !== player &&
                        toHex.owner < state.numActivePlayers
  const isNeutral = !isActiveEnemy && toHex.owner !== player
  const isFree = !!vm.freeSet[toKey]
  const isMerge = isOwnHex && !!toHex.unit

  // ── Capture enemy hut → splits + often bankrupts their territory ──
  if (isActiveEnemy && toHex.structure === STRUCTURE_HUT) {
    const enemyTerr = getTerritoryForHex(state, toKey)
    return 10000 + (enemyTerr ? enemyTerr.hexKeys.length * 5 : 0)
  }

  // ── Take enemy's last hex (eliminates them) ──
  if (isActiveEnemy) {
    const enemyTerr = getTerritoryForHex(state, toKey)
    if (enemyTerr && enemyTerr.hexKeys.length === 1) return 9500
  }

  // ── Capture enemy hex adjacent to their hut (isolate HQ) ──
  if (isActiveEnemy) {
    const enemyTerr = getTerritoryForHex(state, toKey)
    const hutKey = enemyTerr ? enemyTerr.hutHexKey : null
    if (hutKey) {
      const hutHex = state.hexes[hutKey]
      const dist = hutHex ? hexDist(toHex.q, toHex.r, hutHex.q, hutHex.r) : 5
      return 2000 + Math.max(0, 5 - dist) * 200
    }
    return 600
  }

  // ── Capture neutral hut (gains a new income-producing territory) ──
  if (isNeutral && toHex.structure === STRUCTURE_HUT) return 1500

  // ── Capture neutral hex (expand land = more income) ──
  if (isNeutral) return 300

  // ── Merge two units → creates a stronger attacker ──
  if (isMerge) {
    const resultLevel = attackerLevel + toHex.unit.level
    if (resultLevel > MAX_UNIT_LEVEL) return 0
    // Extra value when the merged unit can break a defended position
    return 400 + resultLevel * 120
  }

  // ── Free reposition: only worthwhile if it moves toward the frontier ──
  if (isFree) {
    const distBefore = distToNearestTarget(state, fromHex.q, fromHex.r, player)
    const distAfter = distToNearestTarget(state, toHex.q, toHex.r, player)
    const improvement = distBefore - distAfter
    if (improvement > 0) return 15 + improvement * 10
    return 0 // don't reposition away from frontier
  }

  return 0
}

// ── Tower-build phase ─────────────────────────────────────────────────────────

function greedyBuildTowers(state, player) {
  for (let ti = 0; ti < state.territories.length; ti++) {
    const t = state.territories[ti]
    if (t.owner !== player || t.bank < TOWER_COST) continue

    const income = computeIncome(state, t)
    const upkeep = computeUpkeep(state, t)
    // Only build towers when we have healthy income and enough surplus gold
    if (income - upkeep < 2) continue
    if (t.bank < TOWER_COST + 5) continue

    // Find a border hex that would benefit most from a tower
    let bestKey = null
    let bestBorderCount = 0

    for (let i = 0; i < t.hexKeys.length; i++) {
      const k = t.hexKeys[i]
      const h = state.hexes[k]
      if (!h || h.terrain !== TERRAIN_LAND || h.unit || h.structure) continue

      // Count enemy-owned adjacent hexes (tower is most useful here)
      const nbrs = hexNeighborKeys(h.q, h.r)
      let enemyNbrs = 0
      for (let j = 0; j < nbrs.length; j++) {
        const nh = state.hexes[nbrs[j]]
        if (nh && nh.owner !== player && nh.owner !== null &&
            nh.owner < state.numActivePlayers) {
          enemyNbrs++
        }
      }
      if (enemyNbrs > bestBorderCount) {
        bestBorderCount = enemyNbrs
        bestKey = k
      }
    }

    if (bestKey && bestBorderCount > 0) {
      state.hexes[bestKey].structure = STRUCTURE_TOWER
      t.bank -= TOWER_COST
      appendToLog(state, 'Turn ' + (state.turn + 1) + ': ' +
        state.players[player].name + ' built a Tower at ' + bestKey)
    }
  }
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

// Axial hex distance
function hexDist(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2
}

// Distance from (q, r) to the nearest enemy-owned or neutral (non-water) hex.
function distToNearestTarget(state, q, r, player) {
  let minDist = Infinity
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (!h || h.terrain === TERRAIN_WATER || h.owner === player) continue
    const d = hexDist(q, r, h.q, h.r)
    if (d < minDist) minDist = d
  }
  return minDist
}

export { isAIPlayer, runAITurn, appendToLog }
