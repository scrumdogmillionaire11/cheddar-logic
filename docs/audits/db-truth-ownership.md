# DB Truth Ownership Audit (WI-0899)

Date: 2026-04-16

## Scope and Method

This audit classifies every stateful runtime table as canonical, derived/cache, display-only, or mixed-risk and maps where API/UI read paths treat derived state as authoritative.

Universe source: `docs/audits/db-truth-ownership.inventory.md`.

Evidence used:

- Migrations in `packages/data/db/migrations/**/*.sql`
- Data-layer writes in `packages/data/src/**`
- Worker writes in `apps/worker/src/jobs/**`
- Web/API read paths in `web/src/app/api/**` and `web/src/lib/games/**`

## Classification Legend

- `canonical`: source-of-truth business state used for core outcomes.
- `derived/cache`: computed or external snapshot state; can be recomputed/refetched.
- `display-only`: UI surfacing/log projection state; not settlement truth.
- `mixed-risk`: table is operationally important or writer ownership is ambiguous/non-migration; drift can change behavior materially.

## Per-Table Truth Ownership Registry

| Table | Owner process | Primary write paths | Mutability policy | Truth class | Post-write mutation permissions |
| --- | --- | --- | --- | --- | --- |
| `auth_magic_links` | Mixed (auth/runtime) | `packages/data/src/db/auth-store.js` | Insert + consume/expire lifecycle | mixed-risk | Allowed for token lifecycle only |
| `users` | Mixed (auth + ops scripts) | `packages/data/src/comped-users.js` | Upsert profile/flags | mixed-risk | Allowed for account lifecycle/admin flags |
| `subscriptions` | Mixed (auth + ops scripts) | `packages/data/src/comped-users.js` | Upsert subscription state | mixed-risk | Allowed for billing/status lifecycle |
| `sessions` | Mixed (auth/runtime) | `packages/data/src/db/auth-store.js` | Insert + refresh + revoke | mixed-risk | Allowed for session lifecycle only |
| `revoked_tokens` | Mixed (auth/runtime) | `packages/data/src/db/auth-store.js` | Append + TTL cleanup | mixed-risk | Allowed for revocation + expiry cleanup |
| `job_runs` | Worker | `packages/data/src/db/job-runs.js` | Insert + status updates | mixed-risk | Allowed for run start/finish/fail/recover |
| `run_state` | Worker | `packages/data/src/db/job-runs.js`, `packages/data/src/db-multi.js` | Singleton upsert per sport/id | mixed-risk | Allowed for current run pointer updates |
| `games` | Worker | `packages/data/src/db/games.js`, `apps/worker/src/jobs/sync_game_statuses.js` | Upsert + status transitions | canonical | Allowed for schedule/status updates |
| `game_results` | Worker | `packages/data/src/db/results.js`, settlement/import jobs | Upsert final outcomes | canonical | Allowed until game finalization, then corrective backfill only |
| `card_payloads` | Worker | `packages/data/src/db/cards.js`, model jobs | Insert + targeted payload/status updates | canonical | Allowed for model emit and controlled settlement metadata updates |
| `card_results` | Worker | `packages/data/src/db/cards.js`, settlement jobs | Insert + repeated status/result updates | canonical | Allowed through settlement lifecycle |
| `decision_records` | Worker | `packages/data/src/db/cards.js` | Upsert by decision key | canonical | Allowed for authority decision reconciliation |
| `decision_events` | Worker | `packages/data/src/db/cards.js` | Append event stream | canonical | Append-only (except corrective replay) |
| `model_outputs` | Worker | `packages/data/src/db/models.js` | Insert + prune | derived/cache | Allowed for model cache management |
| `odds_snapshots` | Worker | `packages/data/src/db/odds.js` | Insert + enrichment updates + prune | derived/cache | Allowed for ingest enrichment and retention pruning |
| `odds_ingest_failures` | Worker | `packages/data/src/db/odds.js` | Upsert by failure key | derived/cache | Allowed for ingest observability |
| `tracking_stats` | Worker | `packages/data/src/db/tracking.js` | Upsert aggregates + reset/recompute | derived/cache | Allowed for aggregate recomputation |
| `projection_audit` | Worker | `packages/data/src/db/tracking.js`, `apps/worker/src/jobs/settle_pending_cards.js` | Insert-or-ignore audit rows | derived/cache | Append-only (duplicate-safe) |
| `team_metrics_cache` | Worker | `packages/data/src/db/tracking.js` | Upsert + date-based cleanup | derived/cache | Allowed for cache refresh + retention cleanup |
| `pipeline_health` | Worker | `apps/worker/src/jobs/check_pipeline_health.js` | Append health checks | derived/cache | Append-only |
| `token_quota_ledger` | Worker | `packages/data/src/db/quota.js` | Upsert by provider+period | derived/cache | Allowed for quota accounting only |
| `player_shot_logs` | Worker | `packages/data/src/db/players.js` | Upsert by player/game | derived/cache | Allowed for feed refresh |
| `player_blk_logs` | Worker | `packages/data/src/db/players.js` | Upsert by player/game | derived/cache | Allowed for feed refresh |
| `player_blk_rates` | Worker | `packages/data/src/db/players.js` | Upsert by player/season | derived/cache | Allowed for derived-rate refresh |
| `player_pp_rates` | Worker | `packages/data/src/db/players.js` | Upsert by player/season | derived/cache | Allowed for derived-rate refresh |
| `player_prop_lines` | Worker | `packages/data/src/db/players.js` | Upsert by market key | derived/cache | Allowed for prop-line refresh |
| `player_availability` | Worker | `packages/data/src/db/players.js` | Upsert by player/sport | mixed-risk | Allowed for availability refresh only |
| `tracked_players` | Worker | `packages/data/src/db/players.js` | Upsert + sync-state updates | mixed-risk | Allowed for sync bookkeeping |
| `prop_event_mappings` | Worker | `packages/data/src/db/players.js` | Upsert mapping records | derived/cache | Allowed for mapping reconciliation |
| `prop_odds_usage_log` | Worker | `packages/data/src/db/players.js`, cleanup in `packages/data/src/db/scheduler.js` | Insert + time-window cleanup | derived/cache | Allowed for usage telemetry + retention cleanup |
| `mlb_pitcher_stats` | Worker | `apps/worker/src/jobs/pull_mlb_pitcher_stats.js`, `pull_mlb_statcast.js` | Upsert by pitcher id | derived/cache | Allowed for ingest refresh |
| `mlb_pitcher_game_logs` | Worker | `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` | Upsert by pitcher/game | derived/cache | Allowed for ingest refresh |
| `mlb_game_weather` | Worker | `apps/worker/src/jobs/pull_mlb_weather.js` | Upsert by date/home | derived/cache | Allowed for ingest refresh |
| `nhl_goalie_starters` | Worker | `apps/worker/src/jobs/pull_nhl_goalie_starters.js` | Replace/upsert starter rows | derived/cache | Allowed for ingest refresh |
| `game_id_map` | Worker | `packages/data/src/db/games.js` | Upsert external-id mapping | mixed-risk | Allowed for provider mapping updates |
| `card_display_log` | Worker (historically web-touched) | `packages/data/src/db/cards.js`, settlement/log jobs | Upsert latest display record + dedupe cleanup | display-only | Allowed for display telemetry only |
| `tminus_pull_log` | Worker | Scheduler/queue data layer (`packages/data/src/db/scheduler.js`) | Insert + retention cleanup | derived/cache | Allowed for queue telemetry |
| `projection_proxy_evals` | Worker | `packages/data/src/db/projection-accuracy.js` | Insert-or-replace by key | derived/cache | Allowed for proxy-eval refresh |
| `calibration_predictions` | Worker | `packages/data/src/calibration-utils.js`, report jobs | Insert + status/result updates | derived/cache | Allowed for calibration lifecycle |
| `calibration_reports` | Worker | `apps/worker/src/jobs/run_calibration_report.js` | Insert report snapshots | derived/cache | Append-oriented |
| `calibration_models` | Worker | `apps/worker/src/jobs/fit_calibration_models.js` | Upsert by sport/market | derived/cache | Allowed for model refresh |
| `clv_ledger` | Worker | `packages/data/src/db-telemetry.js` | Insert + late outcome/price update | derived/cache | Allowed for CLV lifecycle updates |
| `clv_entries` | Worker | Performance pipeline jobs/reports | Insert + residual enrichment | derived/cache | Allowed for analytics enrichment |
| `daily_performance_reports` | Worker | `apps/worker/src/jobs/run_daily_performance_report.js` | Upsert by date/market/sport | derived/cache | Allowed for daily recompute |
| `model_health_snapshots` | Worker | `apps/worker/src/jobs/dr_claire_health_report.js` | Upsert by sport/run window | derived/cache | Allowed for health telemetry recompute |
| `potd_daily_stats` | Worker | `apps/worker/src/jobs/potd/run_potd_engine.js` | Upsert by play date | derived/cache | Allowed for daily rollup recompute |
| `potd_shadow_candidates` | Worker | `apps/worker/src/jobs/potd/run_potd_engine.js` | Insert candidate rows | derived/cache | Append-only per run/date |
| `potd_plays` | Worker | `apps/worker/src/jobs/potd/run_potd_engine.js`, `potd/settlement-mirror.js` | Insert + status/result updates | canonical | Allowed through play lifecycle |
| `potd_bankroll` | Worker | `apps/worker/src/jobs/potd/run_potd_engine.js`, `potd/settlement-mirror.js` | Insert bankroll events + cleanup | canonical | Append-first, deletes only for controlled resets |
| `team_metrics_cache` | Worker | `packages/data/src/db/tracking.js` | Upsert + cleanup | derived/cache | Allowed for cache management |
| `migrations` | Worker migration engine | `packages/data/src/migrate.js` | Append applied migration names | mixed-risk | Append-only, no manual edits |
| `mlb_game_pk_map` | Worker (runtime DDL, non-migration) | `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` | Upsert by game key | mixed-risk | Allowed for mapping refresh only |
| `team_stats` | Worker (runtime DDL, non-migration) | `apps/worker/src/jobs/pull_nhl_team_stats.js` | Upsert by team/season/home_road | mixed-risk | Allowed for ingest refresh only |

## Read-Path Authority Map (API/UI)

| Surface | Tables read as effective authority | Risk note |
| --- | --- | --- |
| `web/src/app/api/cards/route.ts` | `card_payloads`, `card_results`, `games`, plus `run_state`/`job_runs` freshness gates | Stale/failed run-state can suppress or stale-gate otherwise valid cards |
| `web/src/app/api/cards/[gameId]/route.ts` | `card_payloads`, `card_results`, `games`, plus `run_state`/`job_runs` | Same gate-risk; per-game path can diverge from global cards path if gate inputs drift |
| `web/src/lib/games/validators.ts` | `run_state`, `job_runs`, `card_payloads` | Validator treats operational tables as truth for API allowance |
| `web/src/lib/games/route-handler.ts` | `games`, `game_results`, `card_results`, `card_payloads`, `odds_snapshots`, `player_availability`, `tracked_players`, `game_id_map`, `odds_ingest_failures` | Derived odds/availability/mapping strongly influence surfaced game state |
| `web/src/app/api/results/route.ts` | `card_results`, `card_payloads`, `game_results`, `clv_ledger`, `card_display_log` | `card_display_log` is display-derived but used as a join/filter authority |
| `web/src/app/api/results/projection-settled/route.ts` | `projection_proxy_evals`, `card_payloads`, `games` | Projection audit table is derived and can diverge from card lifecycle status |
| `web/src/app/api/performance/route.ts` | `daily_performance_reports`, `calibration_reports` | Performance UI is entirely derived-report driven |
| `web/src/app/api/props/*` | `player_shot_logs`, `player_blk_logs`, `mlb_pitcher_game_logs`, `mlb_pitcher_stats` | Prop surfaces are fully cache-driven and stale-sensitive |

## Lie-Risk Tables and Guard Proposals

High-risk means derived/mixed tables can materially alter API/UI truth when stale, missing, or drifted.

| High-risk table | Why it can lie | Proposed guard |
| --- | --- | --- |
| `card_display_log` | Display-derived rows can hide valid settled cards or duplicate/suppress result visibility | Add API-side parity guard: if `card_display_log` join cardinality differs from `card_results` baseline beyond threshold, fallback to `card_results`-anchored set and emit alert |
| `run_state` | Stale run pointer can mark fresh data as stale (or vice versa) | Add max-age invariant and cross-check against newest `card_payloads.created_at`; if mismatch, mark gate degraded and do not hard-block |
| `job_runs` | Missing/incorrect terminal status can block or over-allow surfaces | Add status freshness timeout with explicit `UNKNOWN_RUN_STATUS` path and telemetry |
| `odds_snapshots` | Latest-snapshot query can surface stale odds as current truth | Enforce per-sport max snapshot age and minimum book/source count before treating snapshot as actionable |
| `player_availability` | Missing or stale checks can flip eligibility/driver narratives | Require `checked_at` freshness windows; stale rows must map to explicit `unknown` state, never `active` |
| `tracked_players` | Sync bookkeeping drift can mask incomplete availability sync | Add reconciliation job comparing tracked count vs checked count, with fail-open/closed policy documented |
| `game_id_map` | Provider ID mismatch can route reads to wrong game | Add uniqueness and reverse-lookup consistency checks with hard telemetry on collision/mismatch |
| `projection_proxy_evals` | Derived proxy status can conflict with canonical settlement state | Require explicit source tag in API response and avoid using proxy table to infer canonical bet settlement |
| `mlb_game_pk_map` | Runtime-created non-migration table; missing rows break MLB settlement bridge | Promote to migration-managed schema and add pre-settlement readiness check |
| `team_stats` | Runtime-created non-migration cache can silently disappear/drift | Promote to migration-managed schema and add model-side null-safe fallback telemetry budget |
| `users`/`subscriptions`/`sessions`/`auth_magic_links`/`revoked_tokens` | Writer ownership not clearly isolated under single-writer DB contract | Add explicit ownership ADR note and enforce one writer boundary (or isolate auth state to separate DB) |

## Single-Writer Contract Findings

- No direct web-side SQL mutation calls were found in `web/src/app/api/**` or `web/src/lib/games/**` (`db.exec`, `stmt.run`, SQL write verbs).
- However, mixed-risk remains where table writer ownership is not migration-governed (`mlb_game_pk_map`, `team_stats`) or where auth-state writer boundary is not explicitly isolated.

## Manual Trace (Model -> Settlement -> API)

Trace target: one game card from model output to settlement and surfacing.

1. Model output write lands in `card_payloads` and `card_results` (worker-owned).
2. Settlement jobs mutate `card_results` and may write projection telemetry (`projection_audit`, `tracking_stats`, `clv_ledger` flows).
3. Cards/game routes surface from `card_payloads` + `card_results` with freshness gates (`run_state`, `job_runs`) and context joins (`games`, `odds_snapshots`).
4. Results route uses `card_results` but can narrow via `card_display_log`, creating display-derived authority risk.

Outcome: canonical identity is explicit (`card_payloads`/`card_results`/`game_results`), but derived operational tables (`run_state`, `job_runs`, `card_display_log`, `odds_snapshots`) materially affect what users see and are principal lie-risk vectors.

## WI-0899 Acceptance Check

- Every stateful runtime table classified with owner, write path, mutability policy, and truth class: yes.
- Lie-risk list and high-risk guard proposals: yes.
- API/UI read-path authority map with derived-authority callouts: yes.
- Post-write mutation permissions documented per table: yes.
- Inventory reconciliation against migration/runtime universe: yes (`docs/audits/db-truth-ownership.inventory.md`).
