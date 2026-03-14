# Prop Market Expansion Guide

## Overview

This guide describes how to add a new player prop market to cheddar-logic. Every new prop market follows the same 4-file pattern used by the NHL Shots on Goal (SOG) pipeline — the canonical reference implementation. New markets are gated behind environment flags and must be registered in the web layer or cards will be silently dropped.

---

## The 4-File Pattern

Every new player prop market requires exactly these 4 files:

### 1. `apps/worker/src/jobs/pull_{sport}_{prop}.js`

**Purpose:** Fetch O/U prop lines from The Odds API and upsert them into `player_prop_lines`.

**Contract:**
- Reads `ODDS_API_KEY` and a `{SPORT}_{PROP}_PROP_EVENTS_ENABLED` env flag
- If the flag is not `'true'`, exits immediately (no quota consumed)
- Fetches one event per game in the 36h window
- Upserts rows to `player_prop_lines` with `(sport, game_id, player_name, prop_type, period, bookmaker)`
- Supports `--dry-run` flag (logs what would happen, no writes)
- Calls `insertJobRun` / `markJobRunSuccess` / `markJobRunFailure`

**Odds API market key:** See the Odds API Market Keys table below.

**Reference:** `apps/worker/src/jobs/pull_nhl_player_shots_props.js`

### 2. `apps/worker/src/jobs/run_{sport}_{prop}_model.js`

**Purpose:** Read stat logs from DB, run the projection model, generate PROP cards.

**Contract:**
- Reads player stat logs from a sport-specific table (e.g., `player_shot_logs`)
- Requires at least 5 recent game logs per player — skips with explicit log if fewer
- Calls `getPlayerPropLine()` for real O/U line; falls back to deterministic synthetic line: `Math.round(mu * 2) / 2`
- Logs `[synthetic-fallback] line=X is deterministic (no real line available)` when using fallback
- Only creates cards for HOT or WATCH edge tiers (calibrated per-market — do not reuse NHL SOG thresholds)
- Calls `setCurrentRunId(jobRunId, '{sport}_props')` unconditionally in the success path
- Supports a `{SPORT}_{PROP}_1P_CARDS_ENABLED` flag if first-period lines are available
- Gate the entire job behind a `{SPORT}_{PROP}_ENABLED` flag defaulting to `false`

**Reference:** `apps/worker/src/jobs/run_nhl_player_shots_model.js`

### 3. `apps/worker/package.json` npm scripts

Add two scripts:

```json
"job:pull-{sport}-{prop}-props": "node src/jobs/pull_{sport}_{prop}_props.js",
"job:run-{sport}-{prop}-model": "node src/jobs/run_{sport}_{prop}_model.js"
```

Run order per card cycle:

1. `job:pull-schedule-{sport}` — refresh game schedule
2. `job:pull-{sport}-stat-logs` — fetch player stat logs (equivalent to pull_nhl_player_shots)
3. `job:pull-{sport}-{prop}-props` — fetch real O/U lines
4. `job:run-{sport}-{prop}-model` — generate cards

### 4. `docs/{SPORT}_{PROP}_PROP_MARKET.md`

**Required sections:**

- Overview
- Data Flow (diagram showing NHL API / stat source → pull job → DB table → model → cards)
- Job Execution Order (numbered list)
- Environment Variables (table)
- Injury Check (how unavailable players are filtered)
- Market Line Resolution (bookmaker priority order)
- Model (inputs, outputs, edge thresholds)
- Card Types (full_game, first_period if applicable)
- Known Limitations / Future Work

**Reference:** `docs/NHL_PLAYER_SHOTS_PROP_MARKET.md`

---

## Registration Checklist

New prop markets MUST be registered in the web layer or cards will be silently dropped from the games and cards API surfaces.

### Required registration points:

**`web/src/app/api/games/route.ts`**

- Add the new card type to `ACTIVE_SPORT_CARD_TYPE_CONTRACT[SPORT].playProducerCardTypes`
- Add the sport to `CORE_RUN_STATE_SPORTS` if not already present

**`web/src/app/api/cards/route.ts`**

- Add the sport to `CORE_RUN_STATE_SPORTS` if not already present

**`apps/worker/src/jobs/run_nhl_model.js` (or equivalent)** (if applicable)

- Register the play producer in the card type contract (see how `nhl-player-shots` is registered as a `playProducerCardType`)

**Verification:** After registration, confirm that cards appear in the `/api/games` and `/api/cards` responses. A missing registration produces no error — cards are simply excluded silently.

---

## Odds API Market Keys

Use these market keys in your pull job when calling The Odds API `/sports/{sport}/events/{eventId}/odds` endpoint.

| Sport | Prop Type | Odds API Market Key | Notes |
|---|---|---|---|
| NHL | Shots on goal (full game) | `player_shots_on_goal` | Reliably available |
| NHL | Shots on goal (1st period) | `player_shots_on_goal_1p` | Unreliable — rarely offered |
| NBA | Points | `player_points` | Reliably available |
| NBA | Rebounds | `player_rebounds` | Reliably available |
| NBA | Assists | `player_assists` | Reliably available |
| NBA | Threes made | `player_threes` | Reliably available |
| MLB | Strikeouts (pitcher) | `batter_total_strikeouts` | Available on game days |
| NFL | Passing yards | `player_pass_yds` | Available for weekly slate |

**Finding new market keys:** Use `GET /sports/{sport}/events` to get event IDs, then `GET /sports/{sport}/events/{eventId}/odds?markets=player_*` to discover available market keys. Market key availability varies by sport, bookmaker, and time relative to game start.

---

## Edge Classification Thresholds

HOT and WATCH thresholds must be calibrated per market via backtest before going live. Do not reuse NHL SOG thresholds without validation on the new market's distribution.

**NHL SOG reference thresholds (backtest-calibrated Feb 2026):**

- HOT: `|edge| >= 0.8` and `confidence >= 0.50`
- WATCH: `|edge| >= 0.5` and `confidence >= 0.50`
- COLD: everything else

`edge` is defined as `mu - market_line` (projected minus market). These values reflect the NHL SOG distribution and may not transfer to other markets. A market with higher variance (e.g., NFL passing yards) will require wider thresholds; a market with lower variance (e.g., NBA assists for a facilitating guard) may warrant tighter ones.

**Calibration process:**

1. Run the model on historical data with known outcomes
2. Measure conversion rate (actual > line) for HOT, WATCH, and COLD buckets
3. Set thresholds where conversion rate diverges meaningfully from 50%
4. Document calibration date and sample size in the market's doc file

---

## Token Cost Planning

The Odds API charges 1 token per event per market per fetch. Plan budget before enabling any new market.

**Formula:**

```
events_per_day × runs_per_day × days_in_season ≈ monthly_token_budget
```

**NHL SOG example:**

- 5-8 games/day, 1 market (`player_shots_on_goal`), 2 runs/day
- = 10-16 tokens/day = ~300-500 tokens/month (regular season only)
- Adding `player_shots_on_goal_1p` would double this

**Rules:**

- Gate every new market behind `{SPORT}_{PROP}_ENABLED=false` by default
- Enable in staging first and monitor token consumption via Odds API dashboard
- Do not enable multiple new markets simultaneously — isolate token attribution
- 1P markets are almost always unreliable and double token cost; disable by default via `{SPORT}_{PROP}_1P_CARDS_ENABLED=false`

---

## Known Limitations (NHL SOG Reference Implementation)

These limitations are documented for context when designing new markets. Some will be resolved; others are accepted trade-offs.

- **Player list is static:** `NHL_SOG_PLAYER_IDS` is a manually maintained comma-separated env var. Review quarterly as rosters change. Future: auto-discover tracked players from the stat log table.

- **1P lines are unreliable:** The Odds API does not consistently offer `player_shots_on_goal_1p`. 1P cards are disabled by default via `NHL_SOG_1P_CARDS_ENABLED`. Synthetic fallback is deterministic (`Math.round(mu1p * 2) / 2`) but not calibrated to market.

- **opponentFactor from team_metrics_cache:** The `team_metrics_cache` table stores `shots_against_pg` and `league_avg_shots_against_pg` for NHL teams. If no row exists for the opponent, `opponentFactor` defaults to `1.0` (neutral). Populate `team_metrics_cache` via a scheduled metrics job to improve projections.

- **paceFactor hardcoded to 1.0:** Corsi/Fenwick pace data is not yet sourced. A comment marks the placeholder: `// paceFactor: 1.0 — TODO: source from team pace stats when available`.

- **Player name matching:** Real line lookup is case-insensitive by `player_name`. If The Odds API uses a different name format than the stat source (e.g., "Alex DeBrincat" vs "Alexander DeBrincat"), lines will not match. Monitor `market_line_source: "synthetic_fallback"` in card payloads as a signal of name mismatch.

- **Injury filtering is pull-job-only:** `pull_nhl_player_shots` checks injury status from the NHL API and skips injured players. The model runner (`run_nhl_player_shots_model`) performs a secondary guard via `l5Games.length < 5` — injured players who haven't played recently will naturally fall below this threshold. The `player_availability` table (migration 030) is available for cross-job sharing of injury status if needed.
