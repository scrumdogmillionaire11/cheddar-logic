---
phase: WI-0879
plan: "01"
subsystem: potd
tags: [potd, reasoning, signal-engine, migration, web, typescript]
requires: []
provides:
  - deterministic reasoning string on every scored POTD candidate
  - reasoning persisted to potd_plays DB column (migration 073)
  - reasoning threaded through card_payloads payload_data JSON
  - reasoning surfaced via PotdApiPlay web contract and UI card
affects: []
tech-stack:
  added: []
  patterns:
    - deterministic string builder from scored signal fields (qualityLabel + buildReasoningString)
    - migration-first nullable-column addition pattern
key-files:
  created:
    - packages/data/db/migrations/073_add_reasoning_to_potd_plays.sql
  modified:
    - apps/worker/src/jobs/potd/signal-engine.js
    - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
    - apps/worker/src/jobs/potd/run_potd_engine.js
    - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
    - web/src/lib/potd-server.ts
    - web/src/components/play-of-the-day-client.tsx
    - web/src/__tests__/api-potd.test.js
    - web/src/__tests__/ui-potd-smoke.test.js
decisions:
  - "Reasoning string built deterministically from scored fields only — no LLM, no new deps"
  - "qualityLabel() uses 0.67/0.5 thresholds: strong/solid/below average"
  - "MLB FULL_MODEL projection source gets distinct prefix: 'Full model projection backs'"
  - "reasoning column added as nullable TEXT (no default) — old rows remain NULL"
  - "api-potd.test.js DB-helper assertions migrated to potd-server.ts (where helpers live)"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-12"
---

# Phase WI-0879 Plan 01: POTD Reasoning String Summary

**One-liner:** Deterministic reasoning string built from scored signal fields, persisted to `potd_plays.reasoning` (migration 073), threaded through `card_payloads.payload_data`, and surfaced on the web API + UI card.

---

## Objective

Add a human-readable, LLM-free reasoning string to every Play of the Day selection, making the signal engine's decision auditable at every layer of the stack.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add reasoning builder to signal-engine scoreCandidate | 460142f | signal-engine.js, signal-engine.test.js |
| 2 | Persist reasoning to potd_plays and potd-call payload | da07a33 | 073 migration, run_potd_engine.js, run-potd-engine.test.js |
| 3 | Surface reasoning on web API and UI | 30d4b13 | potd-server.ts, play-of-the-day-client.tsx, api-potd.test.js, ui-potd-smoke.test.js |

---

## Decisions Made

### 1. Deterministic string format (no LLM)

Two formats:
- **Standard:** `"Model likes SELECTION at PRICE: edge +Xpp, win prob Y%, line value QUALITY, market consensus QUALITY."`
- **MLB FULL_MODEL:** `"Full model projection backs SELECTION at PRICE: edge +Xpp, win prob Y%, line value QUALITY, market consensus QUALITY."`

Quality thresholds: `strong` (≥ 0.67), `solid` (≥ 0.5), `below average` (< 0.5).

### 2. Nullable column

`reasoning TEXT` added with no default. Existing rows remain NULL; the UI conditionally renders only when `today.reasoning` is truthy.

### 3. api-potd.test.js DB-helper assertion fix

Pre-existing test failure: test was checking `route.ts` for `getDatabaseReadOnly`/`closeReadOnlyInstance`, but those helpers live in `potd-server.ts` (route delegates via `getPotdResponseData()`). Fixed assertions to check `potd-server.ts`. Also removed `.run(` from the route-level read-only token list (it appears in comments/potd-server but not route).

---

## Verification Results

| Suite | Tests | Result |
|-------|-------|--------|
| signal-engine.test.js | 16 / 16 | ✅ Pass |
| run-potd-engine.test.js | 7 / 7 | ✅ Pass |
| api-potd.test.js (source fallback) | — | ✅ Pass |
| ui-potd-smoke.test.js (source fallback) | — | ✅ Pass |
| TypeScript (web npx tsc --noEmit) | — | ✅ Exit 0 |

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing test assertion in api-potd.test.js**

- **Found during:** Task 3
- **Issue:** `validatePotdSourceContract()` was asserting `getDatabaseReadOnly` and `closeReadOnlyInstance` exist in `route.ts`, but they live in `potd-server.ts`. Test was already failing on the branch before WI-0879 changes.
- **Fix:** Rewrote assertions to check `potd-server.ts` for DB helpers; kept `route.ts` checks for the response shape contract (today/history/bankroll/schedule).
- **Files modified:** `web/src/__tests__/api-potd.test.js`
- **Commit:** 30d4b13

---

## Next Phase Readiness

No blockers. Reasoning will be NULL for all historical rows. Future improvements (e.g. richer reasoning for props markets, history display) can be done as additive changes.
