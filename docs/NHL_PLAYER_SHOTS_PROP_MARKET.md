# NHL Player Shots On Goal — Prop Market Process

## Overview

The NHL player shots on goal (SOG) pipeline remains active as a projection-only prop lane. Cards are generated from the model projection (`mu`) and synthetic reference lines; live Odds API prop-line ingestion has been removed to prevent event-level token burn.

## Data Flow

```
NHL Stats API (api.nhle.com)
  └── sync_nhl_sog_player_ids.js      — Fetches top SOG shooters (daily)
        └── tracked_players table      — Active player IDs for shots_on_goal market

NHL API (api-web.nhle.com)
  └── pull_nhl_player_shots.js        — Fetches recent game logs per tracked player
        └── player_shot_logs table     — Stores shots, TOI, opponent per game

run_nhl_player_shots_model.js
  ├── Reads: player_shot_logs (L5 core + 10-game breakout context)
  ├── Reads: games (upcoming NHL schedule)
  ├── Resolves: synthetic fallback lines only
  ├── Runs: nhl-player-shots model (calcMu, calcMu1p, classifyEdge)
  └── Writes: card_payloads (PROP cards for HOT/WATCH edges)
```

## Job Execution Order

Run in this order before each NHL card cycle:

1. `npm --prefix apps/worker run job:sync-nhl-sog-player-ids` — refresh tracked NHL SOG player IDs (scheduled daily at 04:00 ET)
2. `npm --prefix apps/worker run job:pull-schedule-nhl` — refresh game schedule
3. `npm --prefix apps/worker run job:pull-nhl-player-shots` — fetch recent player logs used by the L5 core model and the 10-game breakout overlay context
4. `npm --prefix apps/worker run job:run-nhl-player-shots-model` — generate cards

## Injury Check

`pull_nhl_player_shots` checks each player's availability status from the NHL API landing payload before fetching shot logs. Players with a status field containing any of `"injur"`, `"IR"`, `"LTIR"`, `"scratch"`, `"suspend"`, or `"inactive"` (case-insensitive) are skipped and logged by name and reason:

```
[NHLPlayerShots] Skipping Connor McDavid (8478402): status=injured
```

Two payload fields are inspected (in priority order):

1. `payload.status` — direct status string on the player object
2. `payload.currentTeamRoster.statusCode` — roster-level status code

`NHL_SOG_EXCLUDE_PLAYER_IDS` provides a manual override that skips players before the status check. If neither status field is present in the API response the player proceeds normally (fail-open behavior — the pull job never silently skips players due to missing fields).

## 1P Cards

First-period SOG cards are disabled by default. They remain a synthetic, projection-only path and should not depend on live 1P prop lines.

When enabled, a card is created for HOT or WATCH first-period edges (same thresholds as full-game). When disabled, the 1P classifyEdge call is still made internally but no card is inserted.

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ODDS_API_KEY` | Yes | — | The Odds API key |
| `ENABLE_NHL_SOG_PLAYER_SYNC` | No | `false` (disabled — explicit opt-in; applies to both schedulers) | Enables daily tracked-player sync job in the NHL and player-props schedulers |
| `NHL_SOG_TOP_SHOOTERS_COUNT` | No | `50` | Number of shooters to track from NHL stats API sync |
| `NHL_SOG_MIN_GAMES_PLAYED` | No | `20` | Minimum games played required for tracked-player sync eligibility |
| `NHL_SOG_SEASON_ID` | No | Auto-derived | Optional override for NHL season ID (e.g., `20252026`) |
| `NHL_SOG_PLAYER_IDS` | No | — | Fallback comma-separated IDs if `tracked_players` has no active entries |
| `NHL_SOG_EXCLUDE_PLAYER_IDS` | No | — | Comma-separated player IDs to skip (manual override — takes precedence over injury check) |
| `NHL_SOG_1P_CARDS_ENABLED` | No | `false` | Set to `'true'` to enable 1P card generation (default: false — 1P Odds API market is unreliable) |
| `NHL_SOG_SLEEP_MS` | No | `500` | Sleep between player log fetches (rate limit guard) |
| `NHL_SOG_FETCH_RETRIES` | No | `4` | Retry count for NHL API fetch failures |

## Token Cost

This lane no longer consumes Odds API prop tokens. It relies on NHL stat pulls plus synthetic reference lines at model time.

## Market Line Resolution

The runner now uses a **synthetic line** using the configured projection floor (`NHL_SOG_PROJECTION_LINE`, default `2.5`; 1P scales from the full-game floor). Cards created from this path include `market_line_source: "synthetic_fallback"` in the payload.

## Model

The SOG model (`apps/worker/src/models/nhl-player-shots.js`) is a JS port of `cheddar-nhl/src/nhl_sog/engine/mu.py`.

**Inputs:** L5 SOG values (most recent first), shotsPer60, projToi, opponentFactor, paceFactor, isHome

**Outputs:**
- `mu` — expected SOG for full game
- `mu1p` — expected SOG for 1st period (~32% of full-game mu)

**Edge classification thresholds (backtest-calibrated Feb 2026):**
- HOT: |edge| >= 0.8 and confidence >= 0.50
- WATCH: |edge| >= 0.5 and confidence >= 0.50
- COLD: everything else

Cards are only created for HOT or WATCH tiers.

## Breakout Overlay (full game only)

The full-game runner adds a bounded breakout overlay for rising-usage OVER candidates. The core model remains L5-based; the overlay only adds advisory context and may lift the adopted full-game projection when all existing guards still pass.

- Lookback: uses up to the last 10 games for `baseline_toi`, `baseline_shots60`, recent TOI trend, and recent shots/60 trend.
- Full-game only: 1P cards do not use the breakout overlay.
- Bounds:
  - projected TOI uplift capped at `+2.5`
  - EV shots/60 uplift capped at `+15%`
- Required blockers remain authoritative:
  - `PROJECTION_CONFLICT`
  - `PROJECTION_ANOMALY`
  - role-blocked cases
  - missing real line / missing prices
  - negative priced-edge behavior
- Position-specific matchup is intentionally neutral in this WI via `position_env_factor = 1.0`.

Full-game payloads may include an optional root-level `breakout` object:

```json
{
  "baseline_toi": 17.8,
  "baseline_shots60": 8.1,
  "baseline_sog_mu": 2.4,
  "tonight_toi_proj": 19.9,
  "adjusted_shots60": 9.3,
  "breakout_sog_mu": 3.1,
  "delta_mu": 0.5,
  "score": 4,
  "flags": ["TOI_TREND_UP", "SHOTS60_TREND_UP", "BREAKOUT_CANDIDATE"],
  "eligible": true
}
```

Breakout flags are also surfaced through the existing full-game decision flag surfaces so downstream consumers do not need a new contract.

## Card Types

| card_type | period | Description |
|---|---|---|
| `nhl-player-shots` | full_game | Full game SOG O/U |
| `nhl-player-shots-1p` | first_period | First period SOG O/U |

## Prop Line DB Schema

```sql
player_prop_lines (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  game_id TEXT NOT NULL,           -- FK to games.game_id
  odds_event_id TEXT,              -- The Odds API event ID
  player_name TEXT NOT NULL,
  prop_type TEXT NOT NULL,         -- 'shots_on_goal'
  period TEXT NOT NULL,            -- 'full_game' | 'first_period'
  line REAL NOT NULL,              -- O/U line (e.g., 3.5)
  over_price INTEGER,              -- American odds (e.g., -115)
  under_price INTEGER,
  bookmaker TEXT,
  fetched_at TEXT NOT NULL
)
```

## Known Limitations / Future Work

- **Projection-only lane:** Real prop-line ingestion has been intentionally removed. Existing historical `player_prop_lines` rows are not part of the current runtime contract.
- **Breakout overlay is full-game only:** WI-0592 does not change 1P behavior.
- **Tracked-player sync dependency:** `pull_nhl_player_shots` prefers DB-backed tracked IDs from `tracked_players` (`sport=nhl`, `market=shots_on_goal`). If the sync job has not run or returns no active rows, the job falls back to `NHL_SOG_PLAYER_IDS`.
- **Player name matching:** Historical line lookup concerns are no longer part of the active runtime path.
- **opponentFactor / paceFactor:** Sourced from `team_metrics_cache` when available. `opponentFactor` uses `shots_against_pg / league_avg_shots_against_pg`; `paceFactor` uses the average of team+opponent pace proxies (`pace_proxy`, `paceFactor`, `pace`, `corsi_for_pct/50`, or `shots_for_pg / league_avg_shots_for_pg`). Missing cache data fails open to `1.0`.

---

## Two-Stage Model — projectSogV2 (added 2026-03-20)

`projectSogV2` separates projection from pricing so trend and value cannot be conflated. Additive export alongside `calcMu`/`classifyEdge` — no existing callers are broken.

### Stage 1 — Project SOG_mu

```
EV_shot_rate = weightedRateBlend(season/60, l10/60, l5/60)  // 0.35/0.35/0.30
PP_shot_rate = weightedRateBlend(season/60, l10/60, l5/60)

Raw_SOG_mu = (EV_shot_rate * toi_proj_ev / 60) + (PP_shot_rate * toi_proj_pp / 60)

SOG_mu = Raw_SOG_mu
       * shot_env_factor         [0.92-1.08]
       * opponent_suppression    [0.90-1.10]
       * goalie_rebound_factor   [0.97-1.03]
       * trailing_script_factor  [0.95-1.08]
       * trend_factor            [0.93-1.07]
```

trend_factor = clamp(1 + (l5_ev/season_ev - 1) * 0.35 * role_weight, 0.93, 1.07)
where role_weight = 1.0 (HIGH) / 0.5 (MEDIUM) / 0.0 (LOW)

### Stage 2 — Market / Pricing Layer

For each line L: fair_over_prob = P(Poisson(SOG_mu) > L), edge_over_pp = fair - implied,
EV = fair_prob * payout_decimal_minus_1 - (1 - fair_prob)

### Invariants

- trend_factor adjusts SOG_mu only; does not manufacture edge
- No official play when market_price_over is missing (edge_over_pp = null)
- No official play when role_stability = LOW (ROLE_IN_FLUX flag)

### Tests

`apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js` — 25 unit + smoke tests.

## Telemetry Reporting

`npm --prefix apps/worker run job:report-telemetry-calibration -- --json --days 30` now includes a dedicated `nhlShotsBreakoutCalibration` section and matching `nhl_shots_breakout_calibration` text block. The report compares settled full-game NHL `shots_on_goal` OVER props split into breakout-tagged vs non-breakout-tagged buckets for hit rate, ROI, and CLV.
