---
phase: WI-0862-scanner-snapshot-shape-fix
plan: "01"
subsystem: mispricing-scanner
tags: [bug-fix, mispricing-scanner, snapshot-parsing, odds-scanning]
status: complete
completed: "2026-04-10"
duration: "~15 minutes"

requires: []
provides:
  - "parseSnapshotPayload handles both flat prod shape and wrapped shape"
  - "scanLineDiscrepancies returns results on prod-stored snapshots"
  - "scanOddsDiscrepancies returns results on prod-stored snapshots"
affects:
  - WI-0856  # Market Pulse API route — now unblocked

tech-stack:
  added: []
  patterns:
    - "Nullish-coalescing fallback for dual-shape payload parsing"

key-files:
  created: []
  modified:
    - packages/models/src/mispricing-scanner.js
    - packages/models/src/__tests__/mispricing-scanner.test.js

decisions:
  - "Used nullish coalescing (??) over conditional to handle null/undefined markets cleanly"
  - "Tested both shapes in-suite rather than separate test file to stay with existing format"

metrics:
  tasks_completed: 2/2
  assertions_before: 42
  assertions_after: 48
  regressions: 0
---

# Phase WI-0862 Plan 01: Scanner Snapshot Shape Fix Summary

**One-liner:** Fix `parseSnapshotPayload` nullish-coalescing fallback so prod-stored flat `{ spreads, totals, h2h }` snapshots are parsed correctly, unblocking Market Pulse API (WI-0856).

## What Was Done

### Task 1 — Fix `parseSnapshotPayload` fallback (commit e045d33)

In `packages/models/src/mispricing-scanner.js` line 325, replaced:

```js
// BEFORE — only handled markets-wrapped shape; prod data always returned {}
markets: payload && payload.markets ? payload.markets : {},

// AFTER — handles both shapes via nullish coalescing
markets: payload?.markets
  ?? (payload?.spreads || payload?.totals || payload?.h2h ? payload : {}),
```

**Root cause:** `pull_odds_hourly.js` stores `rawData: normalized.market` — a flat `{ spreads, totals, h2h }` object with no `markets` wrapper. The scanner was reading `payload.markets` which was always `undefined` on prod data, causing `scanLineDiscrepancies` and `scanOddsDiscrepancies` to return `[]` for all 180+ prod snapshots.

### Task 2 — Regression tests for prod shape (commit ed41aba)

Added 6 new assertions to `packages/models/src/__tests__/mispricing-scanner.test.js` covering:

1. `prod-shape: scanLineDiscrepancies finds LineGap` — flat spreads, no markets wrapper
2. `prod-shape: LineGap carries correct sport`
3. `prod-shape: LineGap outlierBook is BetMGM`
4. `wrapped-shape: scanLineDiscrepancies still finds LineGap (backward compat)`
5. `prod-shape: scanOddsDiscrepancies finds OddsGap` — flat h2h
6. `prod-shape: OddsGap carries correct sport`

## Test Results

| Suite | Before | After |
|---|---|---|
| mispricing-scanner assertions | 42 pass | 48 pass |
| Test suites | 1/1 pass | 1/1 pass |
| Regressions | — | 0 |

## Commits

| Hash | Type | Description |
|---|---|---|
| e045d33 | fix | parseSnapshotPayload fallback for flat prod shape |
| ed41aba | test | regression tests for prod-stored snapshot shape |

## Decisions Made

| Decision | Rationale |
|---|---|
| `??` over ternary | Cleaner null/undefined handling; explicit fallback chain |
| Fallback to `payload` when spreads/totals/h2h present | Preserves existing `markets` read-path; only expands for flat shape |
| `{}` as final fallback | Keeps existing null-payload guard intact |

## Deviations from Plan

None — plan executed exactly as written. The Task 2 action block had already been patched prior to execution to use correct field names (`book/home/away/price_home/price_away`) and custom assert helper.

## Next Phase Readiness

- **WI-0856** (Market Pulse API route) is now unblocked — scanner will return actual gaps from prod data.
- **Human verification recommended:** Run `scanLineDiscrepancies` against live prod snapshots during an active game window and confirm `gaps.length > 0`.
