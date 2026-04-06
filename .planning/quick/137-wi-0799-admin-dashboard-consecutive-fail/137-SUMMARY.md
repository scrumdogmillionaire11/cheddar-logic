---
phase: quick-137
plan: "01"
subsystem: web/admin
tags: [admin-dashboard, ui, pipeline-health, triage]
dependency_graph:
  requires: []
  provides: [streak-badge, stale-muting]
  affects: [web/src/app/admin/page.tsx]
tech_stack:
  added: []
  patterns: [streak-walk, stale-threshold, conditional-render]
key_files:
  created: []
  modified:
    - web/src/app/admin/page.tsx
decisions:
  - "Streak badge renders nothing for ok status or streak < 2 — keeps noise low for healthy checks"
  - "Stale threshold is 35 minutes — tunable via STALE_THRESHOLD_MS constant"
  - "Stale cards replace live age with 'check dormant' pill; opacity-50 gives immediate visual triage signal"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-05"
  tasks_completed: 2
  files_modified: 1
---

# Quick Task 137: Admin Dashboard Consecutive Fail Streak Badge + Stale Muting

**One-liner:** Snapshot cards now show `failed × N` / `warning × N` streak badges (consecutive same-status) and fade dormant cards (>35min) to opacity-50 with a "check dormant" pill.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add computeStreak, isStale, StreakBadge helpers | 3ccce3b | web/src/app/admin/page.tsx |
| 2 | Update snapshot card render — streak badge + stale muting | 20135cb | web/src/app/admin/page.tsx |

## What Was Built

### computeStreak(rows, phase, checkName)
Filters the full health history to rows matching the given phase:checkName key. Walks from newest-first; counts consecutive rows with the same status as the first (current) row. Returns 0 if no matching rows, 1 if single row.

### isStale(ts)
Returns true when `Date.now() - new Date(ts).getTime() > STALE_THRESHOLD_MS` (35 minutes). Wrapped in try/catch; returns false on parse failure.

### StreakBadge({ status, streak })
Returns null when status is 'ok' or streak < 2. Otherwise renders a muted color pill:
- `failed` → red-toned pill: `bg-red-500/10 text-red-400/70 border border-red-500/20`
- `warning` → yellow-toned pill: `bg-yellow-500/10 text-yellow-400/70 border border-yellow-500/20`
- Text: `failed × N` / `warning × N`

### Card render updates
- Per-card `streak` and `stale` computed before JSX
- Card outer div gets `opacity-50` when stale
- Age span replaced with "check dormant" pill when stale
- StreakBadge rendered below the status/age row

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed implicit-any TS error in pre-existing buildSnapshot sort**
- **Found during:** Task 1 TypeScript verification
- **Issue:** `const order = { failed: 0, warning: 1, ok: 2 }` without a type annotation caused TS7053 implicit-any index error
- **Fix:** Added `Record<string, number>` type annotation
- **Files modified:** web/src/app/admin/page.tsx
- **Commit:** 3ccce3b

## Out-of-Scope Issues (Logged, Not Fixed)

- `web/src/lib/types/index.ts` has pre-existing TS2308 duplicate export errors for `PassReasonCode` and `Sport` from `./canonical-play`. Not caused by this task; deferred.

## Checkpoint Awaiting Human Verification

Task 3 is a `checkpoint:human-verify`. Two code tasks are complete and committed. Verification requires visiting `/admin` in the dev server to confirm visual rendering.

## Self-Check: PASSED

Files confirmed present:
- web/src/app/admin/page.tsx — modified (FOUND)

Commits confirmed:
- 3ccce3b — FOUND
- 20135cb — FOUND
