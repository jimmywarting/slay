# Game Rules

This document describes the core mechanics of the Slay-like strategy game implemented in this repository.

The rules here should be considered the **single source of truth** for gameplay.

---

# Map

The game is played on a **hexagonal grid**.

Each hex may contain:

* land
* water
* tree
* palm
* unit
* hut
* tower
* gravestone

Each hex also has an **owner** (player id or neutral).

Connected hexes owned by the same player form a **territory**.

---

# Territories

Each territory has:

* its own **bank**
* its own **income**
* its own **units**
* exactly **one hut**

If a territory splits into multiple disconnected groups, each becomes a **new territory with its own bank**.

If two territories connect, they merge into **one territory** and one hut must be removed.

A hut may only exist if the territory has **at least two hexes**.

---

# Income

Each hex generates:

```
1 gold per turn
```

Exceptions:

| Terrain | Income |
| ------- | ------ |
| land    | 1      |
| tree    | 0      |
| palm    | 0      |

Trees and palms must be destroyed before the hex generates income.

---

# Units

| Level | Unit     | Upkeep |
| ----- | -------- | ------ |
| 1     | Peasant  | 2      |
| 2     | Spearman | 6      |
| 3     | Knight   | 18     |
| 4     | Baron    | 54     |

Buying a peasant costs:

```
5 gold
```

---

# Unit Merging

Units combine into stronger units:

| Combination | Result   |
| ----------- | -------- |
| 2 Peasants  | Spearman |
| 2 Spearmen  | Knight   |
| 2 Knights   | Baron    |

---

# Strength Levels

Each entity has a strength value.

| Entity   | Strength |
| -------- | -------- |
| Peasant  | 1        |
| Spearman | 2        |
| Knight   | 3        |
| Baron    | 4        |
| Hut      | 2        |
| Tower    | 3        |

A unit may defeat another if:

```
attacker > defender
```

Equal strengths cannot attack.

---

# Baron Rule

Barons cannot be killed by combat.

They only die if the territory becomes **bankrupt**.

---

# Defensive Zones

Units defend the **6 adjacent hexes owned by the same player**.

Enemy units may only enter if they are **stronger than the defending entity**.

Static structures also defend:

| Structure | Strength |
| --------- | -------- |
| Hut       | 2        |
| Tower     | 3        |

---

# Structures

## Hut

Each territory has exactly one hut.

Properties:

* static
* strength = spearman
* defends adjacent hexes
* destroyed by knight or baron

---

## Tower

Cost:

```
10 gold
```

Properties:

* static
* strength = knight
* defends adjacent hexes
* destroyed only by baron

---

# Movement

Each unit can move **once per turn**.

Possible actions:

* move to adjacent hex
* capture enemy hex
* capture neutral hex
* destroy tree or palm

Each costs one move.

---

# Upkeep

At the end of the turn:

```
territory.bank -= unitUpkeep
```

If upkeep cannot be paid:

* all units die
* hexes remain owned
* gravestones appear

Gravestone lifecycle:

| Turn           | Result     |
| -------------- | ---------- |
| 1              | gravestone |
| 2              | tree       |
| 2 + near water | palm       |

---

# Turn System

Players take turns sequentially.

During a turn a player may:

* move units
* capture hexes
* destroy trees/palms
* buy peasants
* merge units
* build towers

The turn ends when the player presses **End Turn**.
