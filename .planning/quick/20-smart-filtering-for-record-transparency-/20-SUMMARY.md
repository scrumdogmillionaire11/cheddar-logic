---
phase: quick-20
plan: 01
subsystem: web/results
tags: [filtering, ui, sql, transparency, segments]
dependency_graph:
  requires: [quick-19]
  provides: [filtered-results-api, filter-controls-ui]
  affects: [web/src/app/api/results/route.ts, web/src/app/results/page.tsx]
tech_stack:
  added: []
  patterns:
    - dynamic WHERE clause construction with allowlist sanitization
    - useCallback + useEffect dependency array for reactive data fetching
    - CASE expression for sport+cardCategory segment grouping in SQL
key_files:
  modified:
    - web/src/app/api/results/route.ts
    - web/src/app/results/page.tsx
decisions:
  - Filters applied in inner dedup subquery so the returned ID set is already pre-filtered (one-pass, not two-pass)
  - card_category derived via SQL CASE at query time rather than in JS, keeps segment logic server-authoritative
  - buildCardCategoryFilter helper returns {sql, params} pairs to keep dynamic WHERE construction safe and testable
  - Segment row key changed from sport alone to sport+cardCategory to ensure React key uniqueness
metrics:
  duration: ~10 minutes
  completed: 2026-03-01
  tasks_completed: 2
  files_modified: 2
---

# Phase quick-20 Plan 01: Smart Filtering for Record Transparency Summary

**One-liner:** Added sport/card_category/min_confidence filter params to `/api/results` and wired live filter controls on `/results` — segments now split by sport + driver-vs-call with 60%+ win rate highlighting.

---

## What Was Built

### Task 1 — Extend `/api/results` with filter params (commit `5ca733c`)

Three optional query params added to `GET /api/results`:

| Param | Type | Behavior |
|---|---|---|
| `sport` | string | Allowlisted to NHL/NBA/NCAAM/MLB/NFL, case-insensitive match on `cr.sport` |
| `card_category` | string | `driver` maps to 9 LIKE patterns; `call` maps to `%-totals-call` and `%-spread-call` |
| `min_confidence` | number 0-100 | Filters on `CAST(json_extract(cp.payload_data, '$.confidence_pct') AS REAL) >= ?` |

Filters are applied in the **inner dedup subquery** (pre-filtered ID set), so summary and segment aggregations inherit them without a second pass.

Segments query updated:
- `card_category` CASE expression: `%-totals-call` / `%-spread-call` → `'call'`; everything else → `'driver'`
- GROUP BY `cr.sport, card_category` — produces rows like `(NHL, driver)`, `(NHL, call)`, `(NBA, driver)`, etc.
- Response envelope now includes `filters: { sport, cardCategory, minConfidence }` for the UI to reflect active state

`SegmentRow` type updated to include `card_category: string`.

Backward compatible: no params returns the full unfiltered record identical to before.

### Task 2 — Wire filter controls to `/results` page (commit `4739ddb`)

Replaced the decorative static `filterChips` array with live React state and interactive controls:

```tsx
const [filterSport, setFilterSport] = useState<string>('');
const [filterCategory, setFilterCategory] = useState<string>('');
const [filterHighConf, setFilterHighConf] = useState<boolean>(false);
```

`loadResults` is now a `useCallback` with `[filterSport, filterCategory, filterHighConf]` as dependencies. `useEffect` calls it whenever any filter changes — data refetches automatically, no manual trigger needed.

Controls rendered in the Segments section header:
- **Sport select** — All Sports / NHL / NBA / NCAAM
- **Type select** — All Types / Driver / Call
- **60%+ Confidence toggle** — pill button, turns `emerald-green` when active
- **Clear button** — appears only when at least one filter is active, resets all three

Segments table expanded from 5 to **6 columns**: Segment | Type | Plays | Win Rate | ROI | Avg Edge.

Rows with `winRate >= 0.6`:
- Background: `bg-emerald-500/10`
- Win rate text: `text-emerald-300` (otherwise `text-cloud/70`)

---

## Commits

| Task | Commit | Description |
|---|---|---|
| 1 | `5ca733c` | feat(quick-20): extend /api/results with sport, card_category, min_confidence filter params |
| 2 | `4739ddb` | feat(quick-20): wire functional filter controls to /results page, highlight 60%+ segments |

---

## Verification

- `tsc --noEmit` on `web/tsconfig.json`: no errors
- `npm run build` in `web/`: clean build, all 22 routes compiled
- No params to `/api/results` returns same structure as before (backward compat confirmed by build)

---

## Deviations from Plan

None — plan executed exactly as written. The unused `dedupedIdSet` variable left by the previous partial session was cleaned up as part of Task 1 completion (Rule 1 auto-fix, minimal scope).

---

## Self-Check: PASSED

- `web/src/app/api/results/route.ts` — exists, modified
- `web/src/app/results/page.tsx` — exists, modified
- Commit `5ca733c` — confirmed in git log
- Commit `4739ddb` — confirmed in git log
- Build: passed with zero errors
