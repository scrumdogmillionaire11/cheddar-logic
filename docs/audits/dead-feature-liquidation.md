# Dead-Feature Liquidation Audit

**WI-0904** — Classification and action plan for all exposed feature surfaces.

**Taxonomy:**
- `live` — Actively scheduled or served; real data flows; no action needed.
- `partially-wired` — Implementation exists but is opt-in via env flag, lacks a consumer, or requires a prerequisite to deliver value.
- `inert` — Exists, causes no harm, but is never invoked in normal operation.
- `dead-safe` — Safe to delete; no user-visible impact.
- `dead-dangerous` — User-facing copy claims capability that does not exist or is misleading.

**Frozen domain seed (from STATE.md):**
- FPL: WI-0662, WI-0705, WI-0706, WI-0708, WI-0709, WI-0710 — Product deprioritized; FPL is internal-only.
- NFL: WI-0766 — No live data layer; scheduler disabled by default.
- Auth: WI-0794, WI-0795, WI-0796 — Infrastructure not ready; auth walls commented out everywhere.

---

## Worker Jobs

Sources: `apps/worker/package.json`, `apps/worker/src/schedulers/main.js`, `apps/worker/src/jobs/*.js`

| Job | Script | Status | Enable Flag | Recommended Action |
|-----|--------|--------|-------------|-------------------|
| `pull_odds_hourly` | `job:pull-odds` | **live** | `ENABLE_ODDS_PULL` (default on) | none |
| `pull_schedule_nba` | `job:pull-schedule-nba` | **live** | `ENABLE_PULL_SCHEDULE_NBA` (default on) | none |
| `pull_schedule_nhl` | `job:pull-schedule-nhl` | **live** | `ENABLE_PULL_SCHEDULE_NHL` (default on) | none |
| `run_nhl_model` | `job:run-nhl-model` | **live** | `ENABLE_NHL_MODEL` | none |
| `run_nba_model` | `job:run-nba-model` | **live** | `ENABLE_NBA_MODEL` | none |
| `run_mlb_model` | `job:run-mlb-model` | **live** | `ENABLE_MLB_MODEL` | none |
| `refresh_team_metrics_daily` | `job:refresh-team-metrics` | **live** | `ENABLE_TEAM_METRICS_CACHE` (default on) | none |
| `settle_pending_cards` | `job:settle-cards` | **live** | `ENABLE_SETTLEMENT` (default on) | none |
| `settle_game_results` | `job:settle-games` | **live** | `ENABLE_SETTLEMENT` (default on) | none |
| `check_pipeline_health` | `job:check-pipeline-health` | **live** | `ENABLE_PIPELINE_HEALTH_WATCHDOG` | none |
| `check_odds_health` | `job:check-odds-health` | **live** | `ENABLE_ODDS_HEALTH_WATCHDOG` (default on) | none |
| `dr_claire_health_report` | `job:dr-claire` | **live** | always on | none |
| `pull_nhl_player_shots` | `job:pull-nhl-player-shots` | **live** | player-props scheduler | none |
| `run_nhl_player_shots_model` | `job:run-nhl-player-shots-model` | **live** | player-props scheduler | none |
| `sync_nhl_player_availability` | `job:sync-nhl-player-availability` | **live** | player-props scheduler | none |
| `pull_nhl_player_blk` | `job:pull-nhl-player-blk` | **live** | player-props scheduler | none |
| `ingest_nst_blk_rates` | `job:ingest-nst-blk-rates` | **live** | player-props scheduler | none |
| `sync_nhl_sog_player_ids` | `job:sync-nhl-sog-player-ids` | **live** | player-props scheduler | none |
| `sync_nhl_blk_player_ids` | `job:sync-nhl-blk-player-ids` | **live** | player-props scheduler | none |
| `pull_mlb_pitcher_stats` | (inline in refresh scripts) | **live** | part of `job:refresh-game-lines` | none |
| `pull_mlb_weather` | (inline in refresh scripts) | **live** | part of `job:refresh-game-lines` | none |
| `run_clv_snapshot` | (no CLI alias) | **live** | nightly 03:00 ET via scheduler | add `job:run-clv-snapshot` CLI alias for manual runs |
| `run_daily_performance_report` | (no CLI alias) | **live** | nightly 03:30 ET via scheduler | add `job:run-daily-performance-report` CLI alias |
| `run_residual_validation` | `job:run-residual-validation` | **live** | nightly 04:30 ET via scheduler | none |
| `run_calibration_report` | (no CLI alias) | **live** | nightly 03:00 ET via scheduler | add `job:run-calibration-report` CLI alias |
| `run_potd_engine` | `job:run-potd-engine` | **partially-wired** | `ENABLE_POTD` (opt-in, default off) | document that ENABLE_POTD must be set; page works without it showing a no-pick state |
| `post_discord_cards` | `job:post-discord-cards` | **partially-wired** | `ENABLE_DISCORD_CARD_WEBHOOKS` + `DISCORD_CARD_WEBHOOK_URL` (both opt-in) | none; intentionally gated |
| `potd_settlement_mirror` | `job:potd-settlement-mirror` | **partially-wired** | requires `ENABLE_POTD` | none; gated with POTD |
| `potd_shadow_settlement` | `job:potd-shadow-settlement` | **partially-wired** | requires `ENABLE_POTD` | none; gated with POTD |
| `run_fpl_model` | `job:run-fpl-model` | **partially-wired** | `ENABLE_FPL_MODEL` (default on, but product frozen) | **freeze** — do not enable; see frozen domain WI-0662 etc. Scheduler fires if flag is on; turn off via `ENABLE_FPL_MODEL=false` in production env |
| `run_nfl_model` | `job:run-nfl-model` | **partially-wired** | `ENABLE_NFL_MODEL` (scheduler returns `[]` unless env = `true`) | No live NFL odds data layer; keep gated. Verify `ENABLE_NFL_MODEL` is not `true` in production. |
| `report_settlement_health` | `job:settlement-report` | **partially-wired** | CLI only; not in scheduler | no action needed; useful diagnostics CLI |
| `report_telemetry_calibration` | `job:report-telemetry-calibration` | **partially-wired** | CLI only; not in scheduler | no action needed; useful diagnostics CLI |
| `backfill_card_results` | `job:backfill-card-results` | **inert** | one-off maintenance; not scheduled | keep as CLI runbook tool; do not delete |
| `backfill_period_token` | `job:backfill-period-token` | **inert** | one-off migration; complete | **dead-safe** — migration done; candidate for deletion after 90-day retention window |
| `resettle_historical_cards` | `job:resettle-history` | **inert** | one-off migration; complete | **dead-safe** — keep for emergency re-settlement; add comment marking as emergency-only |
| `import_historical_settled_results` | `job:import-historical-settled` | **inert** | one-off reconciliation; complete | **dead-safe** — delete after 2026-07-01 if no further imports needed |
| `reset_potd_today` | `job:reset-potd-today` | **inert** | ops utility; not scheduled | keep as CLI emergency tool; add warning comment about production impact |
| `run_model_audit` | `audit:nba`, `audit:nhl`, `audit:mlb` | **inert** | CLI audit; not in scheduler | keep; useful for manual audit cadence |
| `validate_no_closing_line_sub` | `audit:validate-no-closing-line-sub` | **inert** | CI audit only | keep in CI; no action |
| `performance_drift_report` | `audit:performance` | **inert** | CLI audit | keep; no action |
| `scorecard` | `audit:scorecard` | **inert** | CLI audit | keep; no action |

---

## Web Pages

Source: `web/src/app/**/*.tsx`

| Route | Page File | Status | Nav-Linked? | User-Visible Copy Risk | Recommended Action |
|-------|-----------|--------|-------------|------------------------|-------------------|
| `/` | `page.tsx` | **live** | — | none | none |
| `/cards` | `cards/page.tsx` | **live** | no (direct URL) | none | none |
| `/wedge` | `wedge/page.tsx` | **live** | yes (homepage) | none; auth walls commented out (intentional) | none |
| `/play-of-the-day` | `play-of-the-day/page.tsx` | **partially-wired** | yes (homepage) | page renders a no-pick state when ENABLE_POTD is off; not misleading | none; ENABLE_POTD must be on for full value |
| `/results` | `results/page.tsx` | **live** | yes (homepage) | none | none |
| `/market-pulse` | `market-pulse/page.tsx` | **live** | no | none | add nav link or homepage entry |
| `/props-feed` | `props-feed/page.tsx` | **live** | no | none | consider nav link |
| `/fpl` | `fpl/page.tsx` | **partially-wired** | yes (homepage) | **⚠ RISK**: metadata: "Fantasy Premier League player projections and signal-qualified differentials." FPL is product-frozen. Page renders stale or empty data. | Restore or disable: either re-enable FPL data pipeline OR remove homepage link and add "Coming Soon" banner. Follow-on WI required. |
| `/education` | `education/page.tsx` | **live** | yes (homepage) | none | none |
| `/admin` | `admin/page.tsx` | **live** | yes (homepage, admin-only) | none | none |
| `/subscribe` | `subscribe/page.tsx` | **dead-dangerous** | no (redirect target) | **⚠ RISK**: Page heading "Subscription Required" + "Get access to Cheddar Logic signal outputs." No subscription mechanism exists anywhere. Users are redirected here from auth-gated routes and see a dead end. | **Action required**: Convert to waitlist form, add contact link, or remove auth-gating entirely and retire this page. |
| `/analytics` | `analytics/page.tsx` | **dead-dangerous** | no | **⚠ RISK**: Claims "Model analytics and market efficiency metrics for active game slates" but hardcodes `demoGameId = 'game-nhl-2026-02-27-001'` (a past-season game). Will always render empty. API code examples in the page body hardcode the same stale game ID. | **Action required**: Delete page or replace with redirect to `/cards`. The component infrastructure (`CardsContainer`) is real; the page itself is a stale demo shell. |
| `/legal/*` | `legal/` | **live** | no (footer) | none | none |

---

## Web API Routes

Source: `web/src/app/api/**/*.ts`

| Route | Status | Consumers | Recommended Action |
|-------|--------|-----------|-------------------|
| `GET /api/cards` | **live** | CardsPageClient, wedge, cards pages | none |
| `GET /api/cards/[gameId]` | **live** | CardsContainer, game-level views | none |
| `GET /api/games` | **live** | CardsPageClient | none |
| `GET /api/potd` | **partially-wired** | PlayOfTheDayClient | none; requires ENABLE_POTD |
| `GET /api/market-pulse` | **live** | MarketPulseClient | none |
| `GET /api/results` | **live** | results page | none |
| `GET /api/results/projection-accuracy` | **live** | results components | none |
| `GET /api/results/projection-settled` | **live** | results components | none |
| `GET /api/performance` | **live** | admin / diagnostic | none |
| `GET /api/team-metrics` | **live** | scheduler/admin | none |
| `GET /api/props/player-shots` | **live** | PropsFeedClient | none |
| `GET /api/props/player-blk` | **live** | PropsFeedClient | none |
| `GET /api/props/pitcher-ks` | **live** | PropsFeedClient | none |
| `GET /api/model-outputs` | **partially-wired** | admin page | Only MLB/NFL/FPL write model_outputs; NHL+NBA write card_payloads directly. NFL and FPL are frozen. Rename route comment to clarify sports coverage. |
| `POST /api/props/shots` | **partially-wired** | no UI consumer found | Stateless calculation endpoint (`computeSogProjection`). No component calls it. Either document as internal API or add a caller. |
| `GET /api/admin/audit` | **live** | admin page | none |
| `GET /api/admin/model-health` | **live** | admin page | none |
| `GET /api/admin/odds-ingest` | **live** | admin page | none |
| `GET /api/admin/pipeline-health` | **live** | admin page | none |
| `GET /api/auth/logout` | **partially-wired** | no UI logout button found (auth walls commented out) | Auth infrastructure (WI-0794–0796) frozen. Route is correct; no action until auth is re-enabled. |
| `GET /api/auth/token` | **partially-wired** | dev/testing only | Production guard exists (IP allowlist via `TOKEN_ROUTE_ALLOWED_IPS`; returns 403 if unconfigured). Verify `TOKEN_ROUTE_ALLOWED_IPS` is absent or restricted in production `.env`. |
| `web/src/app/api/results/projection-metrics.ts` | **inert** | utility module | **dead-safe rename**: This is a `.ts` utility module, not a route. Rename to `projection-metrics.utils.ts` or move to `lib/`. The missing `route.ts` suffix means Next.js never registers it as an API endpoint. |

---

## Dead-Dangerous Summary (Requires Follow-On WIs)

| Surface | Risk | Component File | Action |
|---------|------|----------------|--------|
| `/subscribe` page | "Subscription Required" implies a subscription path exists; none does | `web/src/app/subscribe/page.tsx` | Add waitlist/contact CTA or retire auth-gating |
| `/analytics` page | "Active game slates" claims live data; hardcoded stale game ID | `web/src/app/analytics/page.tsx` | Delete or redirect to `/cards` |
| `/fpl` homepage link | FPL frozen but linked from home with "projections" copy | `web/src/app/fpl/page.tsx`, `web/src/app/page.tsx` | Remove homepage link or add banner until FPL un-freezes |

---

## Frozen Domain Registry

| Domain | Frozen WIs | Current State | Worker Job | Web Surface | Action |
|--------|-----------|---------------|-----------|-------------|--------|
| FPL | WI-0662, WI-0705–710 | Product deprioritized; internal-only | `run_fpl_model` — has scheduler, default-on flag; **must set `ENABLE_FPL_MODEL=false` in prod** | `/fpl` — live page, stale data | Disable flag in prod; remove homepage link |
| NFL | WI-0766 | No live data layer | `run_nfl_model` — has implementation, scheduler returns `[]` unless `ENABLE_NFL_MODEL=true`; verify not enabled | none | Keep gated; no web surface needed until data layer exists |
| Auth | WI-0794–0796 | Infrastructure not ready | n/a | `/subscribe`, `/api/auth/token`, `/api/auth/logout` exist but auth walls commented out everywhere | Keep routes; leave auth walls disabled; address with auth WIs when unblocked |
