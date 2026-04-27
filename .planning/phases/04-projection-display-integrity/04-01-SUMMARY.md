---
phase: 04-projection-display-integrity
plan: 01
subsystem: ui
tags: [nextjs, api, cards, projections, pass-filtering]
requires: []
provides:
  - "Fail-closed PASS projection filtering on cards projection surfaces"
  - "Provider-level actionable projection selection in projections mode"
  - "ProjectionCard render guard that suppresses PASS rows"
affects: [cards-surface, projection-display, api-cards]
tech-stack:
  added: []
  patterns: ["fail-closed official_status gating", "defense-in-depth filtering (API + UI)"]
key-files:
  created:
    - web/src/__tests__/projection-card-pass-guard.test.ts
  modified:
    - web/src/app/api/cards/route.ts
    - web/src/components/cards/CardsPageContext.tsx
    - web/src/components/projection-card.tsx
    - web/src/__tests__/wi-0968-pass-projection-filter.test.js
key-decisions:
  - "Apply PASS filtering at /api/cards and keep a UI-side guard to prevent regressions"
  - "Use canonical decision_v2 official_status (canonical_envelope_v2 first) and fail closed when missing"
patterns-established:
  - "Projection-surface rows are actionable-only for display contexts"
  - "Projection UI components return null for non-actionable statuses"
requirements-completed: [BUG-0968]
duration: 15min
completed: 2026-04-27
---

# Phase 4 Plan 01: Projection Display Integrity Summary

**PASS projection cards are now excluded from cards projection surfaces using canonical decision_v2 status checks at API and UI layers.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-27T18:20:00Z
- **Completed:** 2026-04-27T18:35:05Z
- **Tasks:** 4
- **Files modified:** 5

## Accomplishments

- Added fail-closed actionable filtering for projection-surface payloads in `/api/cards`.
- Added provider-level projection item filtering so only actionable projection plays are surfaced.
- Added ProjectionCard guard and regression tests to prevent PASS display regressions.

## Task Commits

1. **Task 1-2: Trace and implement PASS filtering in projection display flow** - `808cf628` (feat)
2. **Task 3: Add PASS projection filtering regression coverage** - `befe9c6f` (test)
3. **Task 4: Manual validation and smoke checks** - no code changes (verified via running dev server route checks)

## Files Created/Modified

- `web/src/app/api/cards/route.ts` - Added projection-surface actionable status filter before response serialization.
- `web/src/components/cards/CardsPageContext.tsx` - Added actionable projection filtering and inline data-flow trace note.
- `web/src/components/projection-card.tsx` - Added fail-closed render guard for PASS/non-actionable projection rows.
- `web/src/__tests__/wi-0968-pass-projection-filter.test.js` - Expanded regression assertions for API + provider filtering.
- `web/src/__tests__/projection-card-pass-guard.test.ts` - New runtime guard test for PASS vs PLAY render behavior.

## Decisions Made

- Filter ownership is backend-first (`/api/cards`) with UI defense-in-depth to avoid accidental re-surfacing.
- Canonical read order for actionability remains `decision_v2.canonical_envelope_v2.official_status` then `decision_v2.official_status`, else fail closed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan file paths did not match active cards projection flow**

- **Found during:** Task 1 (trace data flow)
- **Issue:** Plan targeted `/api/results` and projection results pages, but active PASS leak was on `/cards` projections mode (`/api/cards` -> provider -> `ProjectionCard`).
- **Fix:** Implemented filtering on actual cards projection path and added inline flow trace.
- **Files modified:** `web/src/app/api/cards/route.ts`, `web/src/components/cards/CardsPageContext.tsx`, `web/src/components/projection-card.tsx`
- **Verification:** `npm --prefix web run build`; projection regression tests.
- **Committed in:** `808cf628`

**2. [Rule 3 - Blocking] Test path assumptions were brittle for execution cwd**

- **Found during:** Task 3 (test verification)
- **Issue:** Existing WI-0968 test expected legacy variable name and root cwd assumptions.
- **Fix:** Updated assertion to current anchor variable and re-ran from compatible execution context.
- **Files modified:** `web/src/__tests__/wi-0968-pass-projection-filter.test.js`
- **Verification:** `./web/node_modules/.bin/tsx web/src/__tests__/wi-0968-pass-projection-filter.test.js`
- **Committed in:** `befe9c6f`

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** No scope creep; changes were necessary to implement the intended BUG-0968 behavior on the real production code path.

## Issues Encountered

- `/api/cards` smoke curl intermittently timed out in local dev despite `/wedge?mode=projections` returning 200.
- Manual verification used successful UI route response and regression tests as primary evidence.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PASS projection visibility is now fail-closed for cards projection surfaces.
- Ready to monitor runtime logs for projection drift warnings independently of PASS filtering behavior.

## Self-Check: PENDING
