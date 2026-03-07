// Economy: income, upkeep, and bankruptcy

import { TERRAIN_LAND, STRUCTURE_GRAVESTONE } from './constants.js'
import { UNIT_DEFS } from './units.js'

// Count income-generating hexes in a territory (plain land only)
function computeIncome(state, territory) {
  var income = 0
  for (var i = 0; i < territory.hexKeys.length; i++) {
    var hex = state.hexes[territory.hexKeys[i]]
    if (hex && hex.terrain === TERRAIN_LAND) income++
  }
  return income
}

// Sum of all unit upkeep costs in a territory
function computeUpkeep(state, territory) {
  var upkeep = 0
  for (var i = 0; i < territory.hexKeys.length; i++) {
    var hex = state.hexes[territory.hexKeys[i]]
    if (hex && hex.unit) upkeep += UNIT_DEFS[hex.unit.level].upkeep
  }
  return upkeep
}

// Handle bankruptcy: kill all units, leave gravestones on land hexes
function applyBankruptcy(state, territory) {
  for (var i = 0; i < territory.hexKeys.length; i++) {
    var k = territory.hexKeys[i]
    var hex = state.hexes[k]
    if (!hex || !hex.unit) continue
    hex.unit = null
    if (hex.terrain === TERRAIN_LAND) {
      hex.structure = STRUCTURE_GRAVESTONE
      hex.gravestoneAge = 0
    }
  }
  territory.bank = 0
}

export { computeIncome, computeUpkeep, applyBankruptcy }
