// AI opponent using the browser's built-in LanguageModel Prompt API.
// Falls back to a greedy heuristic when the API is unavailable.

import { getValidMoves, executeMove, PEASANT_COST, TOWER_COST } from './movement.js'
import { getTerritoryForHex } from './territory.js'
import { computeIncome, computeUpkeep } from './economy.js'
import { UNIT_DEFS } from './units.js'
import { TERRAIN_LAND, STRUCTURE_HUT, STRUCTURE_TOWER } from './constants.js'

// ── Public API ────────────────────────────────────────────────────────────────

// Returns true if the given player index is AI-controlled in this game state.
function isAIPlayer(state, playerId) {
  return !!(state.aiPlayers && state.aiPlayers.indexOf(playerId) !== -1)
}

// Run a full AI turn: think, execute actions.
// The caller is responsible for calling endTurn() afterwards.
async function runAITurn(state) {
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
  'You are an AI player in a turn-based hex strategy game called Slay.\n' +
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
  'STRATEGY TIPS:\n' +
  '  - Expand to claim more land (more income).\n' +
  '  - Attack enemy huts to split and bankrupt them.\n' +
  '  - Keep an eye on upkeep – too many expensive units = bankruptcy.\n' +
  '  - Towers cheaply protect key chokepoints.\n' +
  '  - Merging creates strong attackers without paying full cost.\n' +
  '  - Neutrals (inactive players) can be captured for free land.\n' +
  '\n' +
  'OUTPUT RULES:\n' +
  '  - Output ONLY valid JSON matching the schema. No markdown, no extra text.\n' +
  '  - Only use hex keys that appear in the state description below.\n' +
  '  - Always include "end_turn" as the last action.'

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

function runGreedyTurn(state) {
  const player = state.activePlayer

  // Collect all unmoved units
  const unitKeys = []
  for (const k in state.hexes) {
    const h = state.hexes[k]
    if (h.unit && h.owner === player && !h.unit.moved) {
      unitKeys.push(k)
    }
  }

  for (let ui = 0; ui < unitKeys.length; ui++) {
    const fromKey = unitKeys[ui]
    const fromHex = state.hexes[fromKey]
    if (!fromHex || !fromHex.unit || fromHex.unit.moved) continue

    const vm = getValidMoves(state, fromKey)
    if (vm.moves.length === 0) continue

    // Priority: capture enemy hut > capture any enemy > free move toward enemy
    const hutCaptures = []
    const otherCaptures = []
    const freeMoves = []

    for (let mi = 0; mi < vm.moves.length; mi++) {
      const mk = vm.moves[mi]
      const mh = state.hexes[mk]
      if (!mh) continue
      if (mh.owner !== player) {
        if (mh.structure === STRUCTURE_HUT) {
          hutCaptures.push(mk)
        } else {
          otherCaptures.push(mk)
        }
      } else if (vm.freeSet[mk]) {
        freeMoves.push(mk)
      }
    }

    let chosen = null
    if (hutCaptures.length > 0) {
      chosen = hutCaptures[0]
    } else if (otherCaptures.length > 0) {
      chosen = otherCaptures[0]
    } else if (freeMoves.length > 0) {
      chosen = pickMoveTowardEnemy(state, freeMoves, player)
    }

    if (chosen) {
      executeMove(state, fromKey, chosen)
    }
  }

  // Buy peasants when sustainably affordable
  for (let ti = 0; ti < state.territories.length; ti++) {
    const t = state.territories[ti]
    if (t.owner !== player || t.bank < PEASANT_COST) continue

    const income = computeIncome(state, t)
    const upkeep = computeUpkeep(state, t)
    // Only buy if net income can sustain the new unit's upkeep, or we have spare gold
    if (income - (upkeep + 2) >= 0 || t.bank >= PEASANT_COST * 2) {
      for (let j = 0; j < t.hexKeys.length; j++) {
        const k = t.hexKeys[j]
        const h = state.hexes[k]
        if (h && h.terrain === TERRAIN_LAND && !h.unit && !h.structure) {
          h.unit = { level: 1, moved: false }
          t.bank -= PEASANT_COST
          break
        }
      }
    }
  }
}

// Among candidate hex keys, pick the one closest to any active enemy hex.
function pickMoveTowardEnemy(state, candidates, player) {
  let bestKey = candidates[0]
  let bestDist = Infinity

  for (let ci = 0; ci < candidates.length; ci++) {
    const h = state.hexes[candidates[ci]]
    if (!h) continue
    let minDist = Infinity
    for (const ek in state.hexes) {
      const eh = state.hexes[ek]
      if (!eh || eh.owner === null || eh.owner === player ||
          eh.owner >= state.numActivePlayers) continue
      const dq = h.q - eh.q
      const dr = h.r - eh.r
      const dist = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2
      if (dist < minDist) minDist = dist
    }
    if (minDist < bestDist) {
      bestDist = minDist
      bestKey = candidates[ci]
    }
  }
  return bestKey
}

export { isAIPlayer, runAITurn, appendToLog }
