# Feature Status Matrix

**WI-0904** — Quick-reference status matrix. See `dead-feature-liquidation.md` for full registry with recommendations.

**Status key:** `live` | `partially-wired` | `inert` | `dead-safe` | `dead-dangerous`

---

## Pages

| Route | Status | Linked from Nav? | Notes |
| --- | --- | --- | --- |
| `/` | live | — | Home |
| `/cards` | live | no | Main card feed |
| `/wedge` | live | yes | Auth disabled intentionally |
| `/play-of-the-day` | partially-wired | yes | Requires `ENABLE_POTD=true` |
| `/results` | live | yes | Settlement/results |
| `/market-pulse` | live | no | Consider nav link |
| `/props-feed` | live | no | NHL shots/blk + MLB Ks |
| `/fpl` | partially-wired | yes | Product frozen (STATE.md); shows stale data |
| `/education` | live | yes | Static content |
| `/admin` | live | yes | Admin-only |
| `/subscribe` | **dead-dangerous** | no (redirect target) | No subscription path exists |
| `/analytics` | **dead-dangerous** | no | Hardcoded stale game ID; claims live data |
| `/legal/*` | live | no | Static |

---

## API Routes

| Route | Status | Notes |
| --- | --- | --- |
| `GET /api/cards` | live | Core |
| `GET /api/cards/[gameId]` | live | Core |
| `GET /api/games` | live | Core |
| `GET /api/potd` | partially-wired | Requires `ENABLE_POTD` |
| `GET /api/market-pulse` | live | |
| `GET /api/results` | live | |
| `GET /api/results/projection-accuracy` | live | |
| `GET /api/results/projection-settled` | live | |
| `GET /api/performance` | live | |
| `GET /api/team-metrics` | live | |
| `GET /api/props/player-shots` | live | |
| `GET /api/props/player-blk` | live | |
| `GET /api/props/pitcher-ks` | live | |
| `POST /api/props/shots` | partially-wired | No UI consumer; stateless calc endpoint |
| `GET /api/model-outputs` | partially-wired | Only MLB writes it; NFL/FPL frozen |
| `GET /api/admin/*` | live | Admin tools |
| `GET /api/auth/logout` | partially-wired | Auth walls disabled; route is correct |
| `GET /api/auth/token` | partially-wired | Dev tool; prod IP-allowlist guard in place |
| `results/projection-metrics.ts` | inert | Not a route file; missing `route.ts` suffix |

---

## Worker Jobs (Scheduler)

| Job | Status | Default | Notes |
| --- | --- | --- | --- |
| `pull_odds_hourly` | live | on | Core |
| `pull_schedule_nba` | live | on | |
| `pull_schedule_nhl` | live | on | |
| `run_nhl_model` | live | on | `ENABLE_NHL_MODEL` |
| `run_nba_model` | live | on | `ENABLE_NBA_MODEL` |
| `run_mlb_model` | live | on | `ENABLE_MLB_MODEL` |
| `refresh_team_metrics_daily` | live | on | |
| `settle_pending_cards` | live | on | |
| `settle_game_results` | live | on | |
| `check_pipeline_health` | live | opt-in | `ENABLE_PIPELINE_HEALTH_WATCHDOG` |
| `check_odds_health` | live | on | |
| `dr_claire_health_report` | live | always | |
| `run_clv_snapshot` | live | on | nightly 03:00 ET |
| `run_daily_performance_report` | live | on | nightly 03:30 ET |
| `run_residual_validation` | live | on | nightly 04:30 ET |
| `run_calibration_report` | live | on | nightly 03:00 ET |
| `pull_nhl_player_shots` | live | on | player-props scheduler |
| `run_nhl_player_shots_model` | live | on | player-props scheduler |
| `sync_nhl_player_availability` | live | on | player-props scheduler |
| `pull_nhl_player_blk` | live | on | player-props scheduler |
| `ingest_nst_blk_rates` | live | on | player-props scheduler |
| `sync_nhl_sog_player_ids` | live | on | player-props scheduler |
| `sync_nhl_blk_player_ids` | live | on | player-props scheduler |
| `run_potd_engine` | partially-wired | opt-in | `ENABLE_POTD` |
| `post_discord_cards` | partially-wired | opt-in | `ENABLE_DISCORD_CARD_WEBHOOKS` |
| `potd_settlement_mirror` | partially-wired | opt-in | requires `ENABLE_POTD` |
| `potd_shadow_settlement` | partially-wired | opt-in | requires `ENABLE_POTD` |
| `run_fpl_model` | partially-wired | **⚠ default-on** | Product frozen; **must set `ENABLE_FPL_MODEL=false` in prod** |
| `run_nfl_model` | partially-wired | gated-off | Scheduler returns `[]`; no data layer |
| `report_settlement_health` | partially-wired | CLI only | Not scheduled |
| `report_telemetry_calibration` | partially-wired | CLI only | Not scheduled |
| `backfill_card_results` | inert | CLI only | Keep for maintenance |
| `backfill_period_token` | inert | CLI only | Migration complete; candidate for deletion |
| `resettle_historical_cards` | inert | CLI only | Keep for emergency re-settlement |
| `import_historical_settled_results` | inert | CLI only | Delete after 2026-07-01 |
| `reset_potd_today` | inert | CLI only | Emergency ops tool |
| `run_model_audit` | inert | CLI only | Manual audit cadence |
| `validate_no_closing_line_sub` | inert | CI only | |
| `performance_drift_report` | inert | CLI only | |
| `scorecard` | inert | CLI only | |
