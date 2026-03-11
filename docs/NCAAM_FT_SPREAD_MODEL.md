# NCAAM FT% Spread Model (Total < 160)

## Rule
- Sport: `NCAAM`
- Market: `SPREAD` only
- Trigger:
  - `total < 160`
  - one team `freeThrowPct > 75`
  - opponent `freeThrowPct < 75`
- Pick side: better FT% team
- Driver card type: `ncaam-ft-trend` (legacy alias accepted: `ncaam-ft-spread`)
- Confidence (v1): `0.62`

## FT Data Sources
Fallback order:
1. ESPN team statistics endpoint (parsed into `freeThrowPct`)
2. TeamRankings CSV snapshot
3. `null` (no FT driver emitted)

FT fields exposed in metrics:
- `freeThrowPct`
- `freeThrowPctSource`

## TeamRankings CSV Contract
Default path:
- `data/input/teamrankings_ncaam_ft_pct.csv`

Override path:
- `TEAMRANKINGS_NCAAM_FT_CSV_PATH=/abs/or/relative/path.csv`

Required columns:
- `team_name`
- `ft_pct`
- `season`
- `source_updated_at`

Validation:
- `ft_pct` must be numeric in `[0,100]`
- duplicate `team_name` after normalization is rejected

Staleness:
- max age controlled by `TEAMRANKINGS_NCAAM_FT_MAX_AGE_HOURS` (default `72`)
- stale or missing CSV logs warnings and is ignored

## Refresh Cadence
- Recommended: refresh TeamRankings CSV daily before scheduled model runs.
- Existing scheduler prewarm (`refresh_team_metrics_daily`) remains at `09:00 ET`.
- Scheduler now auto-queues `refresh_ncaam_ft_csv` before due NCAAM model windows
  when last successful refresh is older than the configured freshness window.

Refresh command:

```bash
npm run refresh:ncaam-ft-csv
```

Optional output override:

```bash
TEAMRANKINGS_NCAAM_FT_CSV_PATH=/abs/path/teamrankings_ncaam_ft_pct.csv npm run refresh:ncaam-ft-csv
```

Worker job command:

```bash
npm --prefix apps/worker run job:refresh-ncaam-ft-csv
```

Scheduler controls:
- `ENABLE_NCAAM_FT_REFRESH` (default `true`)
- `NCAAM_FT_REFRESH_MAX_AGE_MINUTES` (default `360`)

## Backtest
Run:

```bash
npm run backtest:ncaam-ft-spread
```

Output metrics:
- `plays`, `wins`, `losses`, `pushes`
- `win_rate_ex_push`
- `roi_units`
- `units_per_play`
- `sample_size_warning` (when plays < 100)

Backtest logic:
- latest pregame NCAAM odds snapshot per game
- final score from `game_results`
- spread grading parity with settlement job conventions
