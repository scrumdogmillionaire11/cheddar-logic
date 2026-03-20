---
phase: quick-56
plan: 01
subsystem: ui
tags: [react, typescript, props-view, day-grouping, sort]

# Dependency graph
requires: []
provides:
  - Props view default sort changed from signal_strength to start_time
  - Day-grouped render for props view with Today/Tomorrow/date section headers
affects: [cards-page-client, props-view, game-card-filters]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - propGroupedByDate useMemo mirrors groupedByDate pattern — ET day bucketing via Intl.DateTimeFormat en-CA + en-US formatters
    - Day header style shared between game view and props view: text-xs font-semibold text-cloud/50 uppercase tracking-wider px-1 pb-2 pt-1 border-b border-white/10 mb-3

key-files:
  created: []
  modified:
    - web/src/lib/game-card/filters.ts
    - web/src/components/cards-page-client.tsx

key-decisions:
  - "Default props sort changed to start_time so users see upcoming games in chronological order, not by model confidence"
  - "propGroupedByDate useMemo placed immediately after groupedByDate to keep day-grouping logic co-located"
  - "Grouped render uses propGroupedByDate.length > 0 guard (not propCards.length) so empty-state handling is consistent"

patterns-established:
  - "Day-grouping useMemo: iterate sorted cards, detect key change with Intl.DateTimeFormat en-CA, label via en-US weekday/month/day formatter, push groups sequentially"

requirements-completed:
  - SORT-PROPS-BY-DAY-AND-TIME

# Metrics
duration: 8min
completed: 2026-03-20
---

# Quick Task 56: Sort Player Props View by Day and Start Time Summary

**Props view now renders with ET day section headers (Today / Tomorrow / date) and cards sorted by game start time ascending, replacing the flat confidence-sorted list**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-20T00:00:00Z
- **Completed:** 2026-03-20T00:08:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `DEFAULT_PROPS_FILTERS.sortMode` changed from `signal_strength` to `start_time` — props now default to chronological order
- Added `propGroupedByDate` useMemo that groups `propCards` by ET calendar day using same pattern as game view `groupedByDate`
- Replaced flat `propCards.map(...)` render with day-grouped render block containing Today/Tomorrow/date section headers styled identically to game view

## Task Commits

1. **Task 1: Set props default sort to start_time** - `50bc60d` (feat)
2. **Task 2: Add day-grouped rendering to props view** - `f20a6aa` (feat)

## Files Created/Modified
- `web/src/lib/game-card/filters.ts` - Changed `DEFAULT_PROPS_FILTERS.sortMode` from `signal_strength` to `start_time`
- `web/src/components/cards-page-client.tsx` - Added `propGroupedByDate` useMemo + replaced flat props render with day-grouped render block

## Decisions Made
- Default sort changed to `start_time` rather than adding a new prop or flag — the simplest change with correct semantics
- `propGroupedByDate` placed immediately after `groupedByDate` to keep all day-grouping logic co-located in the file
- Used `propGroupedByDate.length > 0` as the render guard (not `propCards.length`) for consistency with the grouped structure

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Props view now shows day-grouped cards sorted by start time, matching the game view UX pattern
- No further changes needed for this feature

---
*Phase: quick-56*
*Completed: 2026-03-20*
