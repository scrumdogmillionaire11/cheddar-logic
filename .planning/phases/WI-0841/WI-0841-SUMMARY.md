# WI-0841 Summary: NBA Dynamic Impact Players

**Completed:** 2026-04-09
**Commit:** 631cdd1

## What Was Done

Replaced the static 41-name `NBA_IMPACT_PLAYERS` `Set` in `run_nba_model.js` with a
dynamic, ESPN-injury-feed-driven impact player determination.

### Changes

**`packages/data/src/team-metrics.js`**
- Added `buildNbaImpactContext({ teamName, teamInfo, seasonYear })` — fetches ESPN
  injury feed, filters to `OUT`/`DOUBTFUL`/`DTD` players, fetches each player's
  game log, classifies as starter (≥3 starts in last 5) or top-3 scorer.
- Added `finalizeNbaImpactContext()` — normalizes player snapshots, computes
  `isImpactPlayer`, returns `{ available, generatedAt, players }`.
- `getTeamMetricsWithGames` now accepts `includeImpactContext: true` option and
  returns `impactContext` field on result.

**`packages/data/src/espn-client.js`**
- Added `fetchNbaInjuries()` and `fetchNbaPlayerGameLog()` ESPN API clients.

**`apps/worker/src/jobs/run_nba_model.js`**
- Removed static `NBA_IMPACT_PLAYERS` 41-name `Set`.
- Added `buildNbaAvailabilityGate(homeImpactContext, awayImpactContext)` — converts
  impact context into `{ missingFlags, uncertainFlags, availabilityFlags }`.
- Added `applyNbaImpactGateToCard(card, availabilityGate)` — caps card tier to `LEAN`
  when `key_player_out` is in `missingFlags`; attaches `availability_flags` to `raw_data`.
- `applyNbaTeamContext` now fetches `impactContext` for both teams and builds the gate.
- Gate applied to all card types (base projection + market call cards).

## Tests

- `apps/worker/src/__tests__/nba-availability-gate.test.js` — 2 tests:
  1. Starter OUT → tier capped at LEAN, `key_player_out` in `missing_inputs`
  2. No injuries → FIRE card unchanged
- All existing `run_nba_model`, `nba-team-context`, `team-metrics` tests pass.

## Acceptance Criteria Status

- [x] Static `NBA_IMPACT_PLAYERS` set removed
- [x] Dynamic determination via ESPN OUT/DOUBTFUL + starter/top-scorer filter
- [x] Fallback (no ESPN data) = no cap (fail-open)
- [x] Test: starter OUT → LEAN cap
- [x] Test: no injuries → no downgrade
