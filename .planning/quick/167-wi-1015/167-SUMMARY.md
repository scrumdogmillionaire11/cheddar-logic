---
phase: quick-167
plan: "01"
subsystem: game-card-transform
tags: [migration, status-to-action, decision-routing, cleanup]
dependency_graph:
  requires: [WI-1013, WI-1014]
  provides: [clean-decision-routing, single-canonical-field]
  affects: [game-card/transform, game-card/decision, market-inference, shared, legacy-repair]
tech_stack:
  added: []
  patterns: [canonical-action-field, deprecated-optional-field]
key_files:
  modified:
    - web/src/lib/games/market-inference.ts
    - web/src/lib/game-card/transform/index.ts
    - web/src/lib/game-card/decision.ts
    - web/src/lib/game-card/transform/legacy-repair.ts
    - web/src/components/cards/shared.ts
    - web/src/lib/types/game-card.ts
    - web/src/__tests__/game-card-transform-mlb-game-lines.test.js
    - web/src/__tests__/game-card-decision.test.js
    - web/src/lib/games/market-inference.test.ts
decisions:
  - "Play.status retained as optional @deprecated field for historical DB rows; not removed entirely"
  - "Pre-existing transform-sport/truth-price/evidence test failures (ENOENT on transform.ts) confirmed out-of-scope — pre-date this WI"
  - "fallbackDecision.status in GameCardItem.tsx is DecisionModel.status, not Play.status — not migrated (different semantic)"
metrics:
  duration: ~5 minutes
  completed: "2026-04-20T23:04:45Z"
  tasks_completed: 4
  files_changed: 9
---

# Quick Task 167 (WI-1015): Complete status → action migration in card transform

**One-liner:** Eliminated dual-write pattern by removing all production `play.status` writes and `actionFromLegacyStatus` fallback, making `play.action` the sole canonical decision-routing field.

## What Was Done

### Task 1: Remove play.status writes (commits: 3e9e1ff7)

**market-inference.ts** (`applyWave1DecisionFields`): Removed three `play.status = ...` assignments across PLAY/LEAN/PASS branches. Only `play.action` and `play.classification` are set now.

**transform/index.ts** (L2983 area): Removed the `status: hardPass ? 'PASS' : resolvedDisplayDecision.status` line from the play object spread. The `action` field was already the canonical emitted field.

### Task 2: Remove actionFromLegacyStatus and play.status reads (commit: 9d7f497a)

**decision.ts**:
- Removed `actionFromLegacyStatus` function (7 lines)
- Removed `legacyAction` variable and its `??` line in the resolution chain
- Removed `hasCanonicalDecisionFields` guard (no longer needed without legacyAction)
- Removed `status?: Play['status']` from `resolvePlayDisplayDecision` parameter type

**shared.ts** (`isActionableProjectionPlay`): Removed `toToken(play.status)` from the `statusSignals` array. Array now contains only `decision_v2.official_status` and `play.action`.

**legacy-repair.ts** (`getSourcePlayAction`): Removed `legacyStatus`, `normalizedLegacyStatus` computation and the `!normalizedLegacyStatus` guard. Early return now checks only `hasExplicitAction` and `hasClassification`. Also removed unused `ExpressionStatus` import.

### Task 3: Update Play type and test assertions (commit: 3b62cb2d)

**game-card.ts**: Changed `status: ExpressionStatus` to `status?: ExpressionStatus` with `@deprecated` JSDoc annotation. Historical DB rows may still carry this field.

**game-card-transform-mlb-game-lines.test.js**: Updated assertion from `card.play.status === 'PASS'` to `card.play.action === 'PASS'`.

**game-card-decision.test.js**: Updated parity test section — status fallback cases now assert `PASS` (correct, since status is no longer a decision input). Updated comment from `action > classification > status > PASS` to `action > classification > PASS`.

**market-inference.test.ts**: Removed stale `assert.equal(play.status, 'FIRE')` assertion and `status?` from play type definition.

**transform/index.ts (L2865)**: Removed `status: sourcePlay?.status` from a `resolvePlayDisplayDecision` call (would have been a TS error since status was removed from the parameter type).

**transform/index.ts (L3573)**: Removed `status: play.status` from another `resolvePlayDisplayDecision` call (same TS error fix).

### Task 4: Full test suite + acceptance verification

All relevant test suites pass:
- `test:card-decision` — PASSED
- `test:filters` (includes filters-pass-play-main-view-regression) — PASSED
- `game-card-transform-mlb-game-lines` (direct node run) — PASSED
- `npm run build` — PASSED (zero TypeScript errors)

## Edge Cases Encountered

**Pre-existing test failures:** `test:transform:sport`, `test:transform:truth-price`, `test:transform:evidence` fail with `ENOENT: transform.ts not found`. These tests reference `src/lib/game-card/transform.ts` which doesn't exist (the actual file is `transform/index.ts`). Confirmed pre-existing via git log — unrelated to this WI.

**PropPlayRow.status / route-handler.ts carve-out:** `route-handler.ts` L720-721 and L3935 still read `play.status`. Per WI-1015 acceptance criteria, `route-handler.ts` is WI-1013's scope. These reads were not touched.

**fallbackDecision.status in GameCardItem.tsx:** The acceptance grep matched `fallbackDecision.status` references. `fallbackDecision` is typed as `DecisionModel` (not `Play`), and `DecisionModel.status` is a separate concept — the legacy decision engine output, not the play object's routing field. Left unchanged (different semantic, not in scope).

**Second resolvePlayDisplayDecision call with status:** Found two additional call sites in transform/index.ts (L2865, L3573) that passed `status: play.status`. These would have been TypeScript errors after removing `status` from the parameter type — fixed as part of Task 3.

## Acceptance Verification

- `grep -rn "play\.status" web/src/components/ web/src/app/ --include="*.ts" --include="*.tsx"` → zero results
- `actionFromLegacyStatus` does not exist anywhere in the codebase
- `transform/index.ts` no longer emits `status` on the play object spread
- `Play.status` is optional and annotated `@deprecated` in game-card.ts
- Build: zero TypeScript errors

## Commits

| Commit | Description |
|--------|-------------|
| 3e9e1ff7 | Remove play.status writes from market-inference.ts and transform/index.ts |
| 9d7f497a | Remove actionFromLegacyStatus fallback and play.status reads |
| 3b62cb2d | Mark Play.status deprecated-optional, update test assertions to use action |

## Self-Check

- [x] web/src/lib/games/market-inference.ts modified — confirmed via git log
- [x] web/src/lib/game-card/transform/index.ts modified — confirmed via git log
- [x] web/src/lib/game-card/decision.ts modified — confirmed via git log
- [x] web/src/lib/game-card/transform/legacy-repair.ts modified — confirmed via git log
- [x] web/src/components/cards/shared.ts modified — confirmed via git log
- [x] web/src/lib/types/game-card.ts modified — confirmed via git log
- [x] All test suites pass (build clean, card-decision, filters, mlb-game-lines)
