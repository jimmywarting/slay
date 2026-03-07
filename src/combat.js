// Combat: determines whether a unit can capture a target hex

import { UNIT_DEFS } from './units.js'
import { getHexDefenseStrength } from './territory.js'

// Returns true if a unit of attackerLevel can legally capture targetKey
function canCapture(state, attackerLevel, targetKey) {
  var atkStr = UNIT_DEFS[attackerLevel].strength
  var defStr = getHexDefenseStrength(state, targetKey)
  return atkStr > defStr
}

export { canCapture }
