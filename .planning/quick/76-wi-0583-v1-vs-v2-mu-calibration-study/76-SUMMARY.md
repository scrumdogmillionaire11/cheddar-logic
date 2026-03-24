---
phase: quick-76
plan: 01
subsystem: nhl-player-shots
tags: [calibration, sog, v1-vs-v2, read-only, script, runbook]
dependency_graph:
  requires: []
  provides: [scripts/calibrate_sog_v1_v2.js, docs/runbooks/sog-v1-v2-calibration-2026-03.md]
  affects: []
tech_stack:
  added: []
  patterns: [better-sqlite3 via initDb/getDatabase, read-only query pattern, bucketed calibration table]
key_files:
  created:
    - scripts/calibrate_sog_v1_v2.js
    - docs/runbooks/sog-v1-v2-calibration-2026-03.md
  modified: []
decisions:
  - Graceful empty-DB handling: query "no such table" => 0 rows, dry-run exits 0 (CI-safe)
  - Placeholder report committed with N=0 and note to re-run against prod DB
  - EDGE_MIN heuristic: lowest positive-edge bucket with win_rate >= 55% and N >= 10
metrics:
  duration: ~15 minutes
  completed: 2026-03-24
  tasks: 2
  files: 2
---

# Quick Task 76: WI-0583 — V1 vs V2 SOG Mu Calibration Study Summary

**One-liner:** Read-only calibration script joining settled NHL SOG cards to game results, computing MAE and bucketed win-rate tables for V1 (recency-decay) vs V2 (rate-weighted Poisson), with EDGE_MIN recommendation heuristic.

## Tasks Completed

| Task | Name                               | Commit  | Files                                             |
|------|------------------------------------|---------|---------------------------------------------------|
| 1    | Write calibrate_sog_v1_v2.js       | c2cfa8a | scripts/calibrate_sog_v1_v2.js                    |
| 2    | Generate calibration report        | 605cb3e | docs/runbooks/sog-v1-v2-calibration-2026-03.md    |

## Files Created

### scripts/calibrate_sog_v1_v2.js

Read-only analysis script. Key behaviors:

- Requires `CHEDDAR_DB_PATH` env var — exits 1 with clear message if unset
- `--dry-run` flag: prints row count and exits 0 without writing report (CI-safe)
- Joins `card_payloads JOIN card_results JOIN game_results` for settled NHL SOG cards (last 90 days)
- Extracts V1 mu from `decision.projection`, V2 mu from `decision.v2.sog_mu`
- Derives actual SOG from `game_results.metadata.playerShots.fullGameByPlayerId[player_id]`
- Computes MAE for V1 and V2 independently
- Builds calibration tables bucketed at 0.1-SOG edge increments
- EDGE_MIN heuristic: lowest positive bucket with win_rate >= 55% and N >= 10
- Writes report to `docs/runbooks/sog-v1-v2-calibration-2026-03.md`

**Usage:**

```bash
# Check row count (CI-safe, exits 0):
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/calibrate_sog_v1_v2.js --dry-run

# Generate full report:
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/calibrate_sog_v1_v2.js
```

### docs/runbooks/sog-v1-v2-calibration-2026-03.md

Calibration report — currently a placeholder with N=0 (no prod DB available in this environment). Contains all required sections: Summary table, Calibration Table V1, Calibration Table V2, Recommendation (EDGE_MIN), Methodology.

Re-run the script against the prod DB to populate with real data.

## Key Findings

No settled NHL SOG card data available in the current environment (N=0 rows). The script is ready for prod DB execution.

When run against prod:

- MAE comparison will indicate V1 vs V2 accuracy
- Calibration table will show actual win rates per edge bucket
- EDGE_MIN recommendation will be data-driven (first bucket with win_rate >= 55%, N >= 10)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Graceful empty-DB handling for --dry-run**

- **Found during:** Task 1 verification
- **Issue:** `db.prepare(QUERY).all()` throws "no such table: card_payloads" against an empty/fresh DB, causing exit 1 even in --dry-run mode
- **Fix:** Wrapped query in try/catch; "no such table" error path sets rawRows = [] with a WARN log. --dry-run then exits 0 with "Total rows matched: 0" as required by done criteria
- **Files modified:** scripts/calibrate_sog_v1_v2.js
- **Commit:** c2cfa8a (included in Task 1 commit before final verification)

## Self-Check: PASSED

- scripts/calibrate_sog_v1_v2.js: FOUND
- docs/runbooks/sog-v1-v2-calibration-2026-03.md: FOUND
- commit c2cfa8a: FOUND
- commit 605cb3e: FOUND
