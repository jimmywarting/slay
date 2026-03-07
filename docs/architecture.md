# Architecture

This project is implemented as a small modular JavaScript game engine.

The focus is on **deterministic game logic** separated from rendering.

---

# Design Principles

1. Game logic must be **independent of rendering**.
2. Rendering should only read game state.
3. All gameplay rules must live in **pure logic modules**.
4. Game state should be **serializable** to allow undo.

---

# Project Structure

```
src/
  game.js
  map.js
  hex.js
  territory.js
  units.js
  economy.js
  combat.js
  movement.js
  turn-system.js
  renderer.js
  input.js
```

---

# Core Game State

All gameplay should operate on a single `gameState` object.

Example:

```js
gameState = {
  turn: 0,
  activePlayer: 0,
  players: [],
  map: [],
  territories: []
}
```

---

# Game Loop

The game is **event driven** rather than a real-time loop.

Typical flow:

```
player action
→ update gameState
→ recalculate territories
→ renderer draws state
```

---

# Hex Coordinates

The game should use **axial hex coordinates**.

Each hex:

```
hex = {
  q: number,
  r: number,
  terrain: 'land',
  owner: playerId,
  unit: null,
  structure: null
}
```

---

# Undo System

Undo should restore the **game state at the beginning of the turn**.

Implementation suggestion:

```
turnStartState = structuredClone(gameState)
```

Undo simply restores that snapshot.

---

# Rendering

Rendering should be done using **HTML Canvas**.

Renderer responsibilities:

* draw hex grid
* draw units
* draw structures
* draw terrain
* highlight selections

Renderer must **not modify game state**.
