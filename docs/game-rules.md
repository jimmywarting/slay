# Game Rules — Developer Specification

This document is the **complete, authoritative specification** of the Slay-like hex strategy game implemented in this repository.  It is written to be precise enough that an independent developer could re-implement the game from scratch purely by reading this document.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Map](#2-map)
3. [Hex Coordinate System](#3-hex-coordinate-system)
4. [Terrain Types](#4-terrain-types)
5. [Structures](#5-structures)
6. [Units](#6-units)
7. [Territories](#7-territories)
8. [Players and Starting State](#8-players-and-starting-state)
9. [Turn Structure](#9-turn-structure)
10. [Economy — Income and Upkeep](#10-economy--income-and-upkeep)
11. [Bankruptcy](#11-bankruptcy)
12. [Defense Strength](#12-defense-strength)
13. [Unit Movement](#13-unit-movement)
14. [Capturing Hexes](#14-capturing-hexes)
15. [Unit Merging](#15-unit-merging)
16. [Buying a Peasant](#16-buying-a-peasant)
17. [Building a Tower](#17-building-a-tower)
18. [Gravestone Lifecycle](#18-gravestone-lifecycle)
19. [Tree and Palm Spreading](#19-tree-and-palm-spreading)
20. [Win Condition](#20-win-condition)
21. [Undo](#21-undo)
22. [AI Players](#22-ai-players)

---

## 1. Overview

Slay is a turn-based hex strategy game for 2–6 players (by default: 1 human vs 1 AI on a map that also contains 4 inactive "ghost" players to fill the map).  Players buy units, move them across a hexagonal island, capture enemy territory, and win by eliminating all opponents.

---

## 2. Map

### Generation

The map is a **pointy-top hexagonal grid** with axial radius **7** (configurable via `MAP_RADIUS_DEFAULT`).  The grid is a regular hexagon of side-length 7, giving a maximum of 169 hexes before erosion.

Generation steps:

1. **Grid** — All hexes within the axial constraint `|q + r| ≤ R` are created.  Hexes at distance ≥ `R − 1` from the origin are set to **water**; all others start as **land**.
2. **Coastline erosion** — Each land hex at distance exactly `R − 2` from the origin has a **35 % chance** of being converted to water, producing an irregular coastline.
3. **Territory assignment** — Non-water hexes are distributed among 6 players using a multi-seed BFS flood-fill (see §8).
4. **Hut placement** — Each active player's connected territory of ≥ 2 hexes receives one hut on the first eligible plain-land hex.
5. **Terrain decoration** — After huts are placed, random trees and palms are scattered on empty owned land (§4).

### Hex state

Every hex stores:

| Field           | Type              | Description                                     |
| --------------- | ----------------- | ----------------------------------------------- |
| `q`, `r`        | integer           | Axial coordinates                               |
| `terrain`       | string            | `'water'`, `'land'`, `'tree'`, or `'palm'`      |
| `owner`         | integer or `null` | Player index, or `null` for unowned             |
| `unit`          | object or `null`  | `{ level: 1–4, moved: bool }`, or `null`        |
| `structure`     | string or `null`  | `'hut'`, `'tower'`, `'gravestone'`, or `null`   |
| `gravestoneAge` | integer           | Counts turns since gravestone appeared (see §18)|
| `treeAge`       | integer           | Counts rounds since tree/palm last spread (§19) |

---

## 3. Hex Coordinate System

The grid uses **axial coordinates** `(q, r)` with **pointy-top** orientation.

The six neighbour directions are:

```
{ q:+1, r: 0 }  { q:+1, r:-1 }  { q: 0, r:-1 }
{ q:-1, r: 0 }  { q:-1, r:+1 }  { q: 0, r:+1 }
```

Hexes are stored in a flat object keyed by the string `"q,r"` (e.g. `"0,0"`, `"-3,2"`).

**Pixel conversion (pointy-top, hex size = 36 px):**

```
x = HEX_SIZE × (√3 × q + √3/2 × r)
y = HEX_SIZE × 1.5 × r
```

---

## 4. Terrain Types

| Constant        | Value    | Description                                     | Income |
| --------------- | -------- | ----------------------------------------------- | ------ |
| `TERRAIN_WATER` | `water`  | Sea / edge of island. Impassable.               | 0      |
| `TERRAIN_LAND`  | `land`   | Plain land. Units may stand here.               | 1 gold |
| `TERRAIN_TREE`  | `tree`   | Forest. Blocks income. Can be cleared.          | 0      |
| `TERRAIN_PALM`  | `palm`   | Coastal palm. Blocks income. Can be cleared.    | 0      |

**Decoration probabilities** (applied once at map creation to empty owned land):

* Hex adjacent to water → **25 %** chance of becoming a palm.
* Hex not adjacent to water → **15 %** chance of becoming a tree.

Trees and palms spread over time (§19).

---

## 5. Structures

Structures occupy the `structure` field of a hex (at most one per hex).

### Hut

| Property  | Value       |
| --------- | ----------- |
| Cost      | free (auto) |
| Strength  | 1 (defense) |
| Placement | auto        |

* Every territory with ≥ 2 hexes (and belonging to an active player) has **exactly one hut**.
* The hut is placed automatically on the first eligible plain land hex (no unit, no other structure) when a territory forms or is split.
* A single-hex territory has **no hut**.
* A hut on a captured hex is **immediately destroyed**.
* When two territories merge, the surplus hut is **removed** and the banks are **combined** (the richest hut's territory keeps its key; total gold is pooled).
* The hut contributes **defense strength 1** to itself and all 6 adjacent hexes owned by the same player.

### Tower

| Property  | Value  |
| --------- | ------ |
| Cost      | 10 gold |
| Strength  | 2 (defense) |
| Placement | player choice |

* Can only be built on an empty plain-land hex (`terrain = 'land'`, no unit, no structure) inside the active player's territory.
* Contributes **defense strength 2** to itself and all 6 adjacent hexes owned by the same player.
* A tower on a captured hex is **immediately destroyed**.
* Towers cannot be built on trees or palms.

### Gravestone

* Appears when a unit dies due to bankruptcy (§11).
* Only placed on land hexes (not trees, not water).
* A unit cannot be placed on a gravestone via normal movement.
* A newly bought peasant **can** be placed on a gravestone — the gravestone is cleared upon placement.
* Ages and eventually converts to a tree or palm (§18).

---

## 6. Units

Only **Peasants** can be bought directly; higher-level units are obtained by merging.

| Level | Name      | Symbol | Strength | Upkeep | Buy cost |
| ----- | --------- | ------ | -------- | ------ | -------- |
| 1     | Peasant   | 🧑‍🌾     | 1        | 2 gold | 5 gold   |
| 2     | Spearman  | 🧑‍🎤     | 2        | 6 gold | —        |
| 3     | Knight    | 🧑‍🚒     | 3        | 18 gold| —        |
| 4     | Baron     | 🫅      | 4        | 54 gold| —        |

Units store:

```js
{ level: 1–4, moved: boolean }
```

`moved = true` means the unit has already acted this turn and cannot move again.

**The Baron rule**: Because a Baron has strength 4 and no unit can have strength > 4, no attacker can ever strictly exceed a Baron's defense.  In practice, Barons are indestructible in combat; they can only die via bankruptcy.

---

## 7. Territories

A **territory** is a maximal connected component of non-water hexes sharing the same owner.  Connectivity is 6-adjacency (no diagonals); water hexes break connections.

Each territory object stores:

| Field       | Type    | Description                                       |
| ----------- | ------- | ------------------------------------------------- |
| `owner`     | integer | Player index                                      |
| `hexKeys`   | array   | All hex keys in the component                     |
| `bank`      | integer | Gold accumulated by this territory                |
| `hutHexKey` | string  | Key of the hex holding the territory's hut (or `null`) |

### Recomputation

Territories are fully recomputed by BFS every time ownership changes (i.e. after any capture or parachute drop).  The algorithm:

1. Walk all hex keys; skip water and unowned hexes.
2. For each unvisited owned hex, BFS to collect the connected component.
3. For each component:
   * If it has **0 huts** → bank = 0 (new territory from a capture split).
   * If it has **1 hut** → bank = bank of that hut's old territory.
   * If it has **≥ 2 huts** (two territories merged) → keep the hut with the richest old bank, remove the rest, pool all banks.
4. If a component has ≥ 2 hexes, no hut yet, and its owner is an active player, **auto-place a hut** on the first eligible plain-land hex (or any non-water hex if no plain hex is available).
5. A component of exactly 1 hex has its hut removed.

---

## 8. Players and Starting State

The game is always initialised with **6 player slots** (`NUM_TOTAL_PLAYERS = 6`), but only the first `numActivePlayers` (default **2**) participate actively.  Inactive players (indices ≥ `numActivePlayers`) own colored land on the map but have no huts, no gold, and are never given a turn.

### Map distribution (multi-seed BFS flood-fill)

1. All non-water land hexes are shuffled randomly.
2. Each of the 6 players receives **3 seed hexes** chosen round-robin from the shuffled list, spread across the map for even coverage.
3. A simultaneous BFS expands each player's seeds one hex per player per round until all non-water hexes are claimed (one player per hex).
4. Connected components are identified; each ≥ 2-hex component owned by an active player receives a hut.
5. Any active player who ends up without a hut has a neighbouring hex "adopted" from an adjacent territory to guarantee they have at least a 2-hex territory and a hut.

### Starting bank

```
bank = 3 + territory.hexKeys.length   (active players only)
```

Inactive players start with `bank = 0`.

---

## 9. Turn Structure

Players take turns in order 0, 1, 2, … `numActivePlayers − 1`, then repeat.  Inactive player slots are skipped.  `state.turn` increments by 1 on each `endTurn` call.

### startTurn (called at the very beginning of a player's turn)

1. **Economic phase** — for each territory owned by the active player:
   ```
   territory.bank += computeIncome(territory) − computeUpkeep(territory)
   if territory.bank < 0 → applyBankruptcy(territory)
   ```
2. **Snapshot** — a deep-copy of `state.hexes` and `state.territories` is saved as `state.turnSnapshot` (used by Undo, §21).
3. **Reset moved flags** — all units owned by the active player have `unit.moved` set to `false`.

### Player actions (during the turn)

The active player may perform any combination of:

* **Move a unit** (§13) — each unit may act once per turn.
* **Buy a peasant** (§16) — once per button click, costs 5 gold from the selected territory.
* **Build a tower** (§17) — costs 10 gold from the owning territory.
* **Undo** — revert all moves back to the start-of-turn snapshot (§21).

### endTurn

1. Reset moved flags on all units of the ending player (cosmetic cleanup for the renderer).
2. **Age gravestones** — every gravestone on the map increments its `gravestoneAge` (§18).
3. **Tree spread** (once per full round, after the last active player's turn) — each tree/palm ages and may spread (§19).
4. Advance `state.activePlayer` to the next active player (wrap around, skip inactive slots).
5. Increment `state.turn`.
6. Clear UI selection state (`selectedHex`, `selectedUnit`, `validMoves`, `freeMoves`, `mode`).
7. Call `startTurn` for the new active player.

---

## 10. Economy — Income and Upkeep

### Income

```
income = count of hexes in territory where terrain === 'land'
```

Only plain land hexes generate income.  Trees, palms, and water do **not** generate income.

### Upkeep

```
upkeep = sum of UNIT_DEFS[unit.level].upkeep  for every unit in the territory
```

Upkeep costs per unit level:

| Level | Upkeep |
| ----- | ------ |
| 1     | 2      |
| 2     | 6      |
| 3     | 18     |
| 4     | 54     |

The net change to the bank each turn is `income − upkeep`.  This is applied **at the start** of the owner's turn (before the player acts).

---

## 11. Bankruptcy

If `territory.bank` drops **below 0** after income/upkeep are applied:

1. Every unit in the territory is **destroyed** (`hex.unit = null`).
2. Any land hex that had a unit receives a **gravestone** (`hex.structure = 'gravestone'`, `gravestoneAge = 0`).
3. `territory.bank` is reset to **0**.

The territory's hut and towers are not affected.  The player retains ownership of all hexes.

---

## 12. Defense Strength

The **effective defense strength** of a target hex determines what unit strength is needed to capture it.

```
defenseStrength(targetKey) = max of:
  • strength of the unit on targetKey itself (if any)
  • strength of the structure on targetKey itself:
      hut   → 1
      tower → 2
  • for each of the 6 adjacent hexes that share the same owner as targetKey:
      • strength of the structure on that neighbour (hut=1, tower=2)
      • strength of the unit on that neighbour (regardless of whether it has moved)
```

Key rules:

* **Units always defend**: a unit contributes its full strength to both the hex it occupies and all 6 adjacent hexes owned by the same player, regardless of whether it has already moved this turn.
* **Structures** (huts, towers): always contribute to adjacency defense.
* An unowned (neutral) hex has `owner = null`; adjacency defense is only computed for hexes with a non-null owner.
* If the target hex does not exist, the function returns `99` (unreachable).

**Capture condition**: a unit of `attackerLevel` can capture `targetKey` if and only if:

```
UNIT_DEFS[attackerLevel].strength  >  defenseStrength(targetKey)
```

Strict greater-than; equal strengths cannot attack.

---

## 13. Unit Movement

A unit can move **at most once per turn** (tracked by `unit.moved`).

### Valid moves (BFS from the unit's current hex)

Starting from the unit's hex, a BFS is performed through the **own territory**:

| Encountered hex                              | BFS continues? | Valid destination? | Move type         |
| -------------------------------------------- | -------------- | ------------------ | ----------------- |
| Own land (empty, no structure)               | ✅ yes          | ✅ yes              | **Free reposition** |
| Own gravestone hex                           | ✅ yes          | ✅ yes              | **Clear** (action)  |
| Own hut or tower (no unit)                   | ✅ yes          | ❌ no               | Transit only       |
| Own unit (mergeable: level1+level2 ≤ 4)      | ✅ yes          | ✅ yes              | **Merge** (action) |
| Own unit (not mergeable)                     | ✅ yes          | ❌ no               | Transit only       |
| Own tree or palm                             | ❌ no           | ✅ yes              | **Clear** (action) |
| Enemy/neutral non-water (capturable)         | ❌ no           | ✅ yes (if capturable) | **Capture** (action) |
| Water                                        | ❌ no           | ❌ no               | Impassable         |

A unit whose `moved` flag is already `true` has **no valid moves** (excluded at the start of the BFS).

### Free repositions

Moving to an **own empty land hex (no structure)** is a **free reposition**:

* `unit.moved` stays `false` after the move.
* The BFS continues from the destination, allowing the same unit to be moved again within the same turn (as long as the next destination is also a free reposition).

### Action moves

Any move to a gravestone, a tree/palm, a merge target, or an enemy/neutral hex is an **action**:

* `unit.moved` is set to `true` after the move.
* The unit cannot move again this turn.

### Move execution summary

| Destination type        | Result                                                                       | `unit.moved` |
| ----------------------- | ---------------------------------------------------------------------------- | ------------ |
| Own empty land          | Unit relocated                                                               | `false`      |
| Own gravestone          | Gravestone cleared; unit placed there                                        | `true`       |
| Own tree/palm           | Terrain cleared to land; unit placed there                                   | `true`       |
| Own unit (merge)        | Both units replaced by one at combined level; `moved = either source moved`  | `true` if either was moved |
| Enemy/neutral hex       | Hex owner changed; existing unit/structure/gravestone destroyed; terrain set to land if tree/palm | `true` |

After any capture, `recomputeTerritories` is called immediately.

---

## 14. Capturing Hexes

A unit can capture any enemy or neutral non-water hex that is adjacent to the BFS-reachable own territory **and** for which:

```
unit.strength  >  defenseStrength(targetHex)
```

On capture:

* `hex.owner` = attacking player
* `hex.unit` = the attacking unit (`{ level, moved: true }`)
* `hex.structure` = `null` (any hut, tower, or gravestone is destroyed)
* If `hex.terrain` is tree or palm, it is converted to land.
* The attacking unit's slot in its origin hex is cleared.
* Territories are recomputed.

---

## 15. Unit Merging

Two friendly units can merge if they occupy the same territory and their combined level does not exceed 4 (Baron).

```
canMerge(a, b) = (a.level + b.level) ≤ 4
mergedLevel(a, b) = a.level + b.level
```

Merge table:

| Unit A   | Unit B   | Result   |
| -------- | -------- | -------- |
| Peasant  | Peasant  | Spearman |
| Peasant  | Spearman | Knight   |
| Peasant  | Knight   | Baron    |
| Spearman | Spearman | Knight   |
| Spearman | Knight   | Baron    |

A merge is an **action move**:

* `unit.moved = unitA.moved OR unitB.moved` — if either source had already acted, the merged unit is also marked as moved.
* If both sources were unmoved, the merged unit can still act this turn.

---

## 16. Buying a Peasant

**Cost**: 5 gold, deducted from the territory's bank.

**Placement priority** (the game auto-picks the first available hex in this order):

1. **Own plain land** — empty land hex (`terrain = 'land'`) with no unit and no structure.
2. **Own gravestone** — empty land hex with a gravestone structure.  The gravestone is cleared on placement.
3. **Own tree or palm** — the terrain is cleared to land upon placement.
4. **Own mergeable unit** — a hex inside the territory whose unit level + 1 ≤ 4 (i.e. level ≤ 3).  The Peasant is merged into the existing unit.
5. **Undefended adjacent hex** (parachute drop) — a non-water, non-own hex that borders the territory and has no unit, and whose defense strength is 0 (i.e. `canCapture(state, 1, hex) === true`).

> **Chained buy rule**: territory hexes that already hold a **non-mergeable** unit (level 4 Baron, or any unit whose level would exceed 4 when combined with a Peasant) are **not** valid landing squares, but they **do** still expose their adjacent enemy hexes as parachute-drop candidates.  This allows a player to buy multiple peasants in sequence and place them in a straight line into enemy territory: each placed unit's occupied hex continues to reveal the next enemy hex as a valid drop zone.

**Placement result**:

| Type                             | `unit.moved` after placement                     | Territory effect |
| -------------------------------- | ------------------------------------------------ | ---------------- |
| Own plain land                   | `false` (can act this turn)                      | bank −= 5 |
| Own gravestone (cleared)         | `true` (acted)                                   | bank −= 5 |
| Own tree or palm (cleared)       | `true` (acted)                                   | bank −= 5 |
| Own unit (merge)                 | Inherits existing unit's `moved` flag            | bank −= 5 |
| Parachute drop                   | `true` (already acted)                           | bank −= 5; hex captured; `recomputeTerritories` |

---

## 17. Building a Tower

**Cost**: 10 gold, deducted from the territory's bank.

**Requirements** (all must hold):

* The selected hex belongs to the active player's territory.
* `hex.terrain === 'land'`
* `hex.unit === null`
* `hex.structure === null`

A tower can ONLY be placed on own empty land. A hex that has a tree, palm, structure (including a gravestone) or a unit is NOT a valid place to build at.

---

## 18. Gravestone Lifecycle

Gravestones appear when units die from bankruptcy (§11).

At the **end of each player's turn**, `ageGravestones` is called:

1. Increment `hex.gravestoneAge` for every hex with `structure === 'gravestone'`.
2. When `gravestoneAge >= 2`:
   * If any of the 6 neighbours is water (or off the map) → terrain becomes **palm**.
   * Otherwise → terrain becomes **tree**.
   * `hex.structure = null`
   * `hex.gravestoneAge = 0`

---

## 19. Tree and Palm Spreading

Tree/palm spreading occurs **once per full round** — after the last active player's turn (player index `numActivePlayers − 1`).

For each tree or palm hex:

1. Increment `hex.treeAge` (defaults to 0 if not set).
2. If `treeAge < 4` → skip (no spread this round).
3. If `treeAge >= 4`:
   * Reset `treeAge = 0`.
   * **40 % chance** to spread; if the roll fails, no spread occurs.
   * Collect spread **candidates**: adjacent hexes where `terrain === 'land'`, `unit === null`, `structure === null`.
     * For **palms**, the candidate must also be adjacent to at least one water hex (or map edge).
   * If candidates exist, pick one at random and set its terrain to the same type (tree or palm) with `treeAge = 0`.

This gives a spread rate of roughly **1 spread per 10 rounds per tree**, limiting runaway forest growth.

---

## 20. Win Condition

After every `endTurn`, the game checks whether the game is over:

* Count how many distinct active players still own at least one hut.
* If **exactly one player** owns a hut → that player wins.
* If **zero players** own a hut → draw (no winner).

A player who loses all their huts is eliminated and cannot recover.

---

## 21. Undo

At the start of every turn (in `startTurn`, after the economic phase), a **deep-copy snapshot** of `state.hexes` and `state.territories` is stored in `state.turnSnapshot`.

At any point during the turn the active player can invoke **Undo**:

* `state.hexes` and `state.territories` are replaced with deep copies of the snapshot.
* UI selection state is cleared.
* The economic phase (income/upkeep/bankruptcy) applied at the start of the turn is **not** reversed — Undo only reverts the player's own moves, not the economy.

---

## 22. AI Players

The game supports two AI modes:

### Heuristic AI

A rule-based AI that scores possible actions and greedily picks the best one each turn.  Always available, requires no training.

### Neural Network AI (optional)

A TF.js reinforcement-learning agent that can be trained in-browser.  When a saved model exists (`agent-store.js`), it is used instead of the heuristic.  Training uses self-play with experience replay.

### Watch Mode

All active player slots can be set to AI for an automated AI-vs-AI exhibition.  Games restart automatically after a 2.5-second pause.
