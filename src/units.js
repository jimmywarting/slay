// Unit definitions and merging rules
// Index 0 unused; levels 1–4 correspond to array positions.

var UNIT_DEFS = [
  null,
  { level: 1, name: 'Peasant',  upkeep: 2,  strength: 1, cost: 5,    symbol: 'P' },
  { level: 2, name: 'Spearman', upkeep: 6,  strength: 2, cost: null, symbol: 'S' },
  { level: 3, name: 'Knight',   upkeep: 18, strength: 3, cost: null, symbol: 'K' },
  { level: 4, name: 'Baron',    upkeep: 54, strength: 4, cost: null, symbol: 'B' }
];

// Can two units of given levels be merged together?
function canMergeUnits(level1, level2) {
  return level1 === level2 && level1 < 4
}

// The resulting level when merging two equal-level units
function mergedLevel(level1, level2) {
  if (!canMergeUnits(level1, level2)) return null
  return level1 + 1
}
