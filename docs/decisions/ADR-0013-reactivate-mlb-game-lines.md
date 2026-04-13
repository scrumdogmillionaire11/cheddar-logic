# ADR-0013: Reactivate MLB Game Lines

- Status: Accepted
- Date: 2026-04-13
- Work item: WI-0930

## Context

The repo already contains MLB full-game total and full-game moneyline model and
card pathways, including canonical card types `mlb-full-game` and
`mlb-full-game-ml`.

Those game-line paths are currently suppressed by shared odds configuration and
MLB scheduler defaults that force MLB into projection-only mode. That mismatch
leaves NHL and NBA operating as active odds-backed game-line sports while MLB
remains artificially disabled even though the full-game pathways already exist.

At the same time, MLB F5 and MLB pitcher-K remain intentionally separate
projection-only lanes and are not part of this reactivation.

## Decision

MLB full-game total and MLB full-game moneyline are active, odds-backed
game-line lanes.

Featured MLB odds scope is:

- `h2h`
- `totals`

Repo-wide defaults must reflect that policy:

- `SPORTS_CONFIG.MLB.active` is expected to be `true` during MLB season.
- MLB scheduler/job defaults use the standard odds-backed flow when global
  `ENABLE_WITHOUT_ODDS_MODE` is false.
- ESPN-direct MLB seeding remains a without-odds fallback path, not the normal
  MLB operating mode.

## Explicit Exceptions

This ADR does **not** reactivate or promote:

- MLB F5
- MLB pitcher-K
- MLB spread

Those lanes remain projection-only or otherwise out of scope until a future WI
changes them deliberately.

## Consequences

- MLB joins NBA and NHL as an active odds-backed game-line sport in shared odds
  config and worker health checks.
- Existing full-game MLB card types can surface without special web work.
- Health checks and operator docs must stop describing MLB as intentionally
  disabled by default.
- F5 and pitcher-K remain unchanged.
