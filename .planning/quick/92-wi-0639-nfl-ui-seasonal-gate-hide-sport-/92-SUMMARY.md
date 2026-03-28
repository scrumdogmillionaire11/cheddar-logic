---
phase: quick-92
plan: "01"
subsystem: web-ui
tags: [nfl, seasonal-gate, filter-panel, ui-cleanup]
dependency_graph:
  requires: [WI-0638]
  provides: [WI-0639]
  affects: [web/src/components/filter-panel.tsx, web/src/lib/game-card/filters.ts, web/src/components/cards-page-client.tsx]
tech_stack:
  added: [web/src/lib/game-card/season-gates.ts]
  patterns: [date-range seasonal gate, pure helper function, TDD red-green]
key_files:
  created:
    - web/src/lib/game-card/season-gates.ts
    - web/src/__tests__/season-gates.test.js
  modified:
    - web/src/components/filter-panel.tsx
    - web/src/lib/game-card/filters.ts
    - web/src/components/cards-page-client.tsx
decisions:
  - "isNflSeason() uses getMonth() 0-based index: month >= 8 || month <= 1 covers Sep–Dec and Jan–Feb"
  - "NFL_SPORTS const computed at module init in filters.ts; no runtime overhead"
  - "TRACKED_SPORTS changed from as const tuple to Sport[] to allow conditional expression"
  - "Sport type union unchanged — API rows still carry NFL value"
metrics:
  duration_minutes: 12
  completed_date: "2026-03-28"
  tasks_completed: 2
  files_changed: 5
---

# Phase quick-92 Plan 01: NFL UI Seasonal Gate Summary

**One-liner:** Pure `isNflSeason()` date-range gate (Sep–Feb = true) hides NFL filter pill and removes NFL from default filter state during off-season months.

## What Was Implemented

WI-0639: NFL seasonal gate for the cards UI. The NFL model is inactive during March–August, so showing the NFL filter pill confuses users. A single pure helper `isNflSeason()` gates NFL visibility across three UI surfaces. When September arrives, NFL reappears automatically with no deploy required.

### Files Created

- **web/src/lib/game-card/season-gates.ts** — `isNflSeason(now?: Date): boolean` using `month >= 8 || month <= 1` (September through February)
- **web/src/__tests__/season-gates.test.js** — 5 boundary assertions (Aug→false, Sep→true, Jan→true, Feb→true, Mar→false)

### Files Modified

- **web/src/components/filter-panel.tsx** — `sportOptions` now conditionally excludes NFL when off-season
- **web/src/lib/game-card/filters.ts** — `NFL_SPORTS` const computed at module load; all three `DEFAULT_*_FILTERS.sports` reference it
- **web/src/components/cards-page-client.tsx** — `TRACKED_SPORTS` changed from `as const` tuple to `Sport[]` with conditional expression

## Verification Results

All 4 verification commands passed:

| Command | Result |
|---------|--------|
| `npx tsc --noEmit --project web/tsconfig.json` | Exit 0 (no type errors) |
| `npm --prefix web run lint` | Exit 0 |
| `npm --prefix web run test:ui:cards` | Exit 0 — UI cards smoke test passed |
| `node web/src/__tests__/season-gates.test.js` | season-gates: all assertions passed |

Current date is March 2026 (off-season), so NFL is absent from all filter surfaces immediately.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (TDD) | 4efcdc7 | feat(quick-92): add isNflSeason() seasonal gate + boundary tests |
| Task 2 | 56ffef1 | feat(quick-92): wire isNflSeason gate into filter-panel, filters, cards-page-client |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `web/src/lib/game-card/season-gates.ts` — FOUND
- `web/src/__tests__/season-gates.test.js` — FOUND
- Commit 4efcdc7 — FOUND
- Commit 56ffef1 — FOUND
