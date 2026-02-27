---
phase: quick-2
plan: 01
subsystem: betting-engine/nhl
tags: [nhl, drivers, cards, model, validator]
dependency_graph:
  requires: [apps/worker/src/models/index.js, packages/data/src/validators/card-payload.js]
  provides: [computeNHLDriverCards, generateNHLCards, driverPayloadSchema]
  affects: [apps/worker/src/jobs/run_nhl_model.js]
tech_stack:
  added: []
  patterns: [per-driver card fanout, driver descriptor objects, schema extension via .extend()]
key_files:
  created: []
  modified:
    - apps/worker/src/models/index.js
    - apps/worker/src/jobs/run_nhl_model.js
    - packages/data/src/validators/card-payload.js
decisions:
  - "welcomeHome included as 7th driver (global meta-driver per DATA_CONTRACTS.md); skipped when no h2h odds or score < 0.55"
  - "emptyNet skipped when status === 'missing' (no pull-seconds data), not emitted as NEUTRAL"
  - "model_outputs insert removed from NHL job — driver cards are the authoritative output, no composite record"
  - "nhl-model-output retained in validator schema for backward compat, not produced by run_nhl_model.js"
metrics:
  duration_seconds: 203
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
  completed_date: "2026-02-27"
---

# Quick Task 2: Convert NHL Drivers into Individual Card Payloads — Summary

**One-liner:** Per-driver NHL card fanout (goalie, specialTeams, shotEnvironment, emptyNet, totalFragility, pdoRegression, welcomeHome) replacing single composite nhl-model-output card, with driver-specific confidence, direction, and Zod schema registration.

---

## What Changed

### `apps/worker/src/models/index.js`

**Added:** `computeNHLDriverCards(gameId, oddsSnapshot)` — exported alongside existing exports.

Internally calls `computeNHLDrivers` for driver data, then maps each driver to a card descriptor object with:
- `cardType`, `cardTitle`, `confidence`, `prediction` (HOME/AWAY/NEUTRAL), `reasoning`
- `ev_threshold_passed`, `driverKey`, `driverInputs`, `driverScore`, `driverStatus`
- `inference_source: 'driver'`, `is_mock: true`

Driver-specific confidence formulas:
- `goalie`: `clamp(0.65 + |score - 0.5| * 0.4, 0.65, 0.85)` — highest ceiling (0.85) reflecting strongest signal
- `specialTeams`: `clamp(0.60 + |score - 0.5| * 0.2, 0.60, 0.70)` — modest range
- `shotEnvironment`: fixed `0.65`
- `emptyNet`: fixed `0.60` — **skipped entirely when status === 'missing'**
- `totalFragility`: fixed `0.60`, direction always `NEUTRAL`
- `pdoRegression`: `clamp(0.70 + |score - 0.5| * 0.3, 0.70, 0.85)` — high floor
- `welcomeHome` (global meta-driver): `clamp(0.60 + score * 0.15, 0.60, 0.75)` — **skipped when no h2h_home or score < 0.55**

### `apps/worker/src/jobs/run_nhl_model.js`

**Renamed:** `generateNHLCard` → `generateNHLCards` (plural). New signature: `generateNHLCards(gameId, driverDescriptors, oddsSnapshot)`.

Builds insertable card objects from descriptors — one per driver. Card ID format: `card-nhl-{driverKey}-{gameId}-{uuid8}`. Payload includes driver object `{ key, score, status, inputs }` and `model_version: 'nhl-drivers-v1'`.

**Game processing loop:** Replaced single `model.infer()` → `generateNHLCard()` → `insertModelOutput()` flow with:
1. `computeNHLDriverCards(gameId, oddsSnapshot)` — get descriptors
2. Skip game if `driverCards.length === 0` (all data missing)
3. `prepareModelAndCardWrite(gameId, 'nhl-drivers-v1', ct)` per distinct card type
4. `generateNHLCards()` → validate each card → `insertCardPayload()` per card

`insertModelOutput` removed — no composite model_output record. The driver cards are the authoritative output.

**Imports:** Added `computeNHLDriverCards` from `'../models'`. Retained `getModel` import (for forward compat with other model paths).

**Exports:** `{ runNHLModel, generateNHLCards }` (old `generateNHLCard` removed).

### `packages/data/src/validators/card-payload.js`

**Added:** `driverPayloadSchema` = `basePayloadSchema.extend({ driver: z.object({ key, score, status, inputs }) })`.

**Registered** in `schemaByCardType`:
- `nhl-goalie` → driverPayloadSchema
- `nhl-special-teams` → driverPayloadSchema
- `nhl-shot-environment` → driverPayloadSchema
- `nhl-empty-net` → driverPayloadSchema
- `nhl-total-fragility` → driverPayloadSchema
- `nhl-pdo-regression` → driverPayloadSchema
- `nhl-welcome-home` → driverPayloadSchema
- `nhl-model-output` → basePayloadSchema (retained for backward compat)

---

## Card Types: Before vs After

| Before | After |
|--------|-------|
| 1 card: `nhl-model-output` per game | 5-7 cards per game (one per active driver) |
| `cardTitle: 'NHL Model: HOME'` | `cardTitle: 'NHL Goalie Edge: HOME'` etc. |
| Composite confidence (0.56-0.78) | Driver-specific confidence (0.60-0.85) |
| All drivers buried in `payloadData.drivers` | Each card is the driver — `payloadData.driver` object |
| Single moneyline prediction | Per-driver HOME/AWAY/NEUTRAL direction |

---

## Edge Cases Handled

| Case | Behavior |
|------|----------|
| `emptyNet` with no pull-seconds data | Skipped (status==='missing'); no card emitted |
| `welcomeHome` with no h2h odds | Skipped (h2h_home is null); no card emitted |
| `welcomeHome` with weak signal (score < 0.55) | Skipped; minimum meaningful home edge required |
| All drivers missing data | `driverCards.length === 0`; game skipped with log |
| Strong home spread (`spread_home < -100`) | `marketCorroboration = 1`; welcomeHome more likely to pass threshold |
| `totalFragility` — always NEUTRAL | Hardcoded direction regardless of score |

---

## Verification Commands

```bash
# Task 1: 5 driver cards without h2h odds (emptyNet + welcomeHome skipped)
node -e "
const { computeNHLDriverCards } = require('./apps/worker/src/models/index.js');
const cards = computeNHLDriverCards('test-game-1', {
  total: 5.7,
  raw_data: JSON.stringify({
    goalie_home_gsax: 1.2, goalie_away_gsax: -0.4,
    pp_home_pct: 22, pk_home_pct: 82, pp_away_pct: 18, pk_away_pct: 79,
    xgf_home_pct: 56, xgf_away_pct: 44,
    pdo_home: 1.005, pdo_away: 0.988
  })
});
console.log('Card count:', cards.length);
cards.forEach(c => console.log(c.cardType, c.prediction, c.confidence.toFixed(2)));
"
# => Card count: 5 (no emptyNet, no welcomeHome)

# Task 2: End-to-end with 6 cards (emptyNet present, welcomeHome skipped - weak signal)
# Full round-trip (plan verification assertions) — all pass
```

---

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | `78c588f` | feat(quick-2): add computeNHLDriverCards() to models/index.js |
| Task 2 | `ad0d4ce` | feat(quick-2): rewrite run_nhl_model.js + register driver card types in validator |

---

## Deviations from Plan

None — plan executed exactly as written. The `welcomeHome` driver was included as required by the plan constraint (global meta-driver per `docs/DATA_CONTRACTS.md`).

---

## Self-Check: PASSED

- `apps/worker/src/models/index.js`: computeNHLDriverCards exported, 78c588f
- `apps/worker/src/jobs/run_nhl_model.js`: generateNHLCards exported, ad0d4ce
- `packages/data/src/validators/card-payload.js`: 7 NHL driver types registered, ad0d4ce
- All plan verification assertions pass (5 cards base, 6 with emptyNet, NEUTRAL on totalFragility, welcomeHome emitted with strong spread)
