# DB Truth Ownership Inventory (WI-0899)

Date: 2026-04-16

## Purpose

This inventory defines the stateful table universe used by the WI-0899 audit. It separates migration-managed runtime tables from non-migration runtime tables and migration-transient rename tables.

## Extraction Basis

- Migration DDL scan: `packages/data/db/migrations/**/*.sql` (`CREATE TABLE`, `ALTER TABLE`, `RENAME TO`)
- Runtime DDL scan in data/worker code:
  - `packages/data/src/migrate.js` (`migrations` table)
  - `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` (`mlb_game_pk_map` table)
  - `apps/worker/src/jobs/pull_nhl_team_stats.js` (`team_stats` table)

## A) Migration-Managed Runtime Tables

These are migration-backed and expected to exist in production writer DBs.

1. `auth_magic_links`
2. `calibration_models`
3. `calibration_predictions`
4. `calibration_reports`
5. `card_display_log`
6. `card_payloads`
7. `card_results`
8. `clv_entries`
9. `clv_ledger`
10. `daily_performance_reports`
11. `decision_events`
12. `decision_records`
13. `game_id_map`
14. `game_results`
15. `games`
16. `job_runs`
17. `mlb_game_weather`
18. `mlb_pitcher_game_logs`
19. `mlb_pitcher_stats`
20. `model_health_snapshots`
21. `model_outputs`
22. `nhl_goalie_starters`
23. `odds_ingest_failures`
24. `odds_snapshots`
25. `pipeline_health`
26. `player_availability`
27. `player_blk_logs`
28. `player_blk_rates`
29. `player_pp_rates`
30. `player_prop_lines`
31. `player_shot_logs`
32. `potd_bankroll`
33. `potd_daily_stats`
34. `potd_plays`
35. `potd_shadow_candidates`
36. `projection_audit`
37. `projection_proxy_evals`
38. `prop_event_mappings`
39. `prop_odds_usage_log`
40. `revoked_tokens`
41. `run_state`
42. `sessions`
43. `subscriptions`
44. `team_metrics_cache`
45. `tminus_pull_log`
46. `token_quota_ledger`
47. `tracked_players`
48. `tracking_stats`
49. `users`

## B) Runtime-Created, Non-Migration Tables

These are stateful and currently created in runtime code, not migrations.

1. `migrations`

- Created in: `packages/data/src/migrate.js`
- Role: migration ledger for applied SQL files.

1. `mlb_game_pk_map`

- Created in: `apps/worker/src/jobs/pull_mlb_pitcher_stats.js`
- Role: game ID bridge used by MLB settlement jobs.

1. `team_stats`

- Created in: `apps/worker/src/jobs/pull_nhl_team_stats.js`
- Role: NHL team context cache consumed by NHL player shots model.

## C) Migration-Transient Rename/Rebuild Tables

These are temporary during migration execution and are not intended as stable runtime truth tables.

1. `card_payloads_new`
2. `card_results_new`
3. `decision_events_new`
4. `decision_records_new`
5. `card_payloads_old`

## Reconciliation Summary

- Stateful runtime tables in scope for truth classification: 52 (`49` migration-managed + `3` runtime-created/non-migration).
- Transient migration-only tables excluded from runtime truth ownership registry: 5.
- WI-0899 audit file (`docs/audits/db-truth-ownership.md`) reconciles all 52 runtime tables above.
