// Unit definitions and merging rules
// Index 0 unused; levels 1–4 correspond to array positions.

const UNIT_DEFS = [
  null,
  { level: 1, name: 'Peasant',  upkeep: 2,  strength: 1, cost: 5,    symbol: '🧑‍🌾' },
  { level: 2, name: 'Spearman', upkeep: 6,  strength: 2, cost: null, symbol: '🧑‍🎤' },
  { level: 3, name: 'Knight',   upkeep: 18, strength: 3, cost: null, symbol: '🧑‍🚒' },
  { level: 4, name: 'Baron',    upkeep: 54, strength: 4, cost: null, symbol: '🫅'  }
];

// Can two units of given levels be merged together?
// Merging is additive: the combined level must be ≤ 4 (Baron).
function canMergeUnits(level1, level2) {
  return level1 + level2 <= 4
}

// The resulting level when merging two units (additive, capped at Baron)
function mergedLevel(level1, level2) {
  if (!canMergeUnits(level1, level2)) return null
  return level1 + level2
}

export { UNIT_DEFS, canMergeUnits, mergedLevel }
