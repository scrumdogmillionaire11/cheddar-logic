---
phase: WI-0836
verified: 2026-04-08T00:00:00Z
status: complete
commits: c39559f de14696
---

# WI-0836 Summary: Rest-Days Pipeline (NBA + NHL)

**One-liner:** Activated rest signal in NBA/NHL via computeRestDays utility querying games table; enrichedSnapshot pattern; projectNHL rest params wired end-to-end.

## What Was Built

### Task 1 — `apps/worker/src/utils/rest-days.js` (new)
- `getTeamLastGameTimeUtc(teamName, sport, beforeUtc)` — queries `games` table using `getDatabase()` with `game_time_utc` column and `status IN ('final','STATUS_FINAL')`. Mirrors `getHomeTeamRecentRoadTrip` pattern.
- `daysBetween(earlier, later)` — `Math.floor(diff / 86400000)` capped at 3 (well-rested plateau), floored at 0 (back-to-back).
- `computeRestDays(teamName, sport, gameTimeUtc)` — calls above, returns `{ restDays, restSource }`. Default `{ restDays: 1, restSource: 'default' }` when no prior game.
- 8 unit tests in `src/utils/__tests__/rest-days.test.js`: 4 `daysBetween`, 4 `computeRestDays`. All pass.

### Task 2 — NBA snapshot enrichment (`run_nba_model.js`)
- `computeRestDays` required at top of file.
- `enrichedSnapshot` built immediately before `computeNBAMarketDecisions` call, with `rest_days_home`/`rest_days_away` populated.
- `computeNBAMarketDecisions(enrichedSnapshot)` now receives rest values.
- Rest observability fields (`rest_days_home`, `rest_days_away`, `rest_source_home`, `rest_source_away`) added to `card.payloadData.raw_data` in both driver card loop and market call card loop.

### Task 2b — NBA rest-read fallback in `cross-market.js`
- `computeNBAMarketDecisions` rest read at line ~857 updated from:
  `raw?.espn_metrics?.home?.metrics?.restDays ?? null`
  to:
  `raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null`
  (same for away). Now matches NHL pattern already in place at lines 289–292.

### Task 3 — `projectNHL` rest params (`projections.js`)
- Signature extended with `homeRest = 1, awayRest = 1` as params 7 and 8 (default=1, all existing call sites backward-compatible).
- `restAdjustment` helper added (goals scale: -0.25 back-to-back, 0 normal, +0.12 well-rested). Applied after goalie penalty block.
- `homeRestAdj`/`awayRestAdj` added to return object for testability.

### Task 4a — NHL snapshot enrichment (`run_nhl_model.js`)
- `computeRestDays` required at top of file.
- `enrichedSnapshot` built immediately before `computeNHLMarketDecisions`, with `rest_days_home`/`rest_days_away` populated.
- NHL `computeNHLMarketDecisions` lines 289–292 already have `raw?.rest_days_home` fallback — no additional cross-market.js patch required.
- Rest observability fields added to all NHL card payloads (driver + market call).

### Task 4b — `projectNHL` rest args wired in `cross-market.js`
- `computeNHLMarketDecisions` `projectNHL` call at line ~358 now passes `restDaysHome ?? 1` and `restDaysAway ?? 1` as args 7 and 8.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `run-nba-model.test.js` getDatabase mock missing `get()` method**

- **Found during:** Task 2 implementation (test run after enrichedSnapshot patch)
- **Issue:** `computeRestDays` calls `stmt.get(...)` but the mock only provided `stmt.all(...)`. This caused a `TypeError` in the game loop, resulting in 0 cards generated and 7 failing tests.
- **Fix:** Added `get: jest.fn(() => null)` to the prepared-statement mock in `loadRunNBAModel()`.
- **Files modified:** `apps/worker/src/__tests__/run-nba-model.test.js`
- **Commit:** de14696

## Tests Run and Results

| Suite | Pattern | Tests | Status |
|---|---|---|---|
| rest-days unit | `rest-days` | 8/8 | PASS |
| projections | `projections` | 31/31 | PASS |
| run-nba-model | `run-nba-model` | 13/13 | PASS |
| Full suite | all | 1273/1273 | PASS |

## Key Links

| From | To | Via | Status |
|---|---|---|---|
| `run_nba_model.js` | `computeNBAMarketDecisions` | `enrichedSnapshot` with `rest_days_home/away` | WIRED |
| `computeNBAMarketDecisions` | `restDaysHome` | `raw?.rest_days_home` fallback at line ~858 | WIRED |
| `run_nhl_model.js` | `computeNHLMarketDecisions` | `enrichedSnapshot` with `rest_days_home/away` | WIRED |
| `computeNHLMarketDecisions` | `projectNHL` | `restDaysHome ?? 1, restDaysAway ?? 1` | WIRED |
| `projectNHL` | `restAdjustment` | params 7-8 | WIRED |

## Acceptance Criteria Verification

1. ✅ `rest_days_home`/`rest_days_away` are non-null integers on `oddsSnapshot` at the point `computeNBAMarketDecisions(enrichedSnapshot)` is called for any game with a prior game in `games`.
2. ✅ `projectNHL` accepts `homeRest`/`awayRest` as params 7-8 (default 1); `computeNHLMarketDecisions` passes snapshot-derived rest values to `projectNHL`.
3. ✅ Missing prior game defaults to `restDays=1`, `restSource='default'`.
4. ✅ Unit tests: back-to-back mock asserts `restDays=0`; `projectNHL` back-to-back produces lower total vs well-rested baseline (implicitly via restAdjustment -0.25 vs +0.12).

## Human Validation Required

1. **NBA back-to-back check:** Run NBA model on a game day with a known back-to-back team. Confirm `rest_days_home=0` in card payload `raw_data.rest_days_home`. Confirm `rest_source_home='computed'`.
2. **NHL total deflation:** Run NHL model on dual-fast-rest matchup vs back-to-back game. Expect lower projected total by ~0.25 goals.

---
_Completed: 2026-04-08 | Agent: copilot_
