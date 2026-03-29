---
phase: quick-102
plan: 01
subsystem: scripts, docs
tags: [roi, settlement, market-analysis, read-only, reporting]
dependency_graph:
  requires: [WI-0607, WI-0626, WI-0557]
  provides: [WI-0647]
  affects: [model-promotion-decisions, market-quarantine-decisions]
tech_stack:
  added: []
  patterns: [getDatabaseReadOnly/closeReadOnlyInstance, sqlite_master guard, json_extract metadata]
key_files:
  created:
    - scripts/settlement-roi-report.js
    - docs/SETTLEMENT_ROI_GUIDE.md
  modified: []
decisions:
  - "resolveDatabasePath() returns {dbPath, source, isExplicitFile} object — extract .dbPath for display"
  - "Script guards clv_ledger join with sqlite_master check so it works on DBs without CLV data"
metrics:
  duration: "~5 minutes"
  completed: "2026-03-29T23:42:36Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Quick-102 Plan 01: WI-0647 Cross-Market Settlement ROI Report Summary

**One-liner:** Read-only SQLite script querying card_results for per-market win-rate/ROI/recommendation with PROMOTE/WATCH/QUARANTINE/INSUFFICIENT_DATA thresholds and per-sport rollup, plus operator guide.

## Files Created

- `scripts/settlement-roi-report.js` — Read-only ROI analysis script (commit `9ef8f99`)
- `docs/SETTLEMENT_ROI_GUIDE.md` — Operator guide for interpreting and acting on report output (commit `dd08600`)

## Implementation Details

### DB Access Pattern

Uses `getDatabaseReadOnly()` from `packages/data/src/db.js` (re-exported from `packages/data/src/db/connection.js`), always closed in `finally` block via `closeReadOnlyInstance(db)`. No write operations anywhere in the script.

### CLV Ledger Guard

Script checks `sqlite_master` for `clv_ledger` existence before building the SQL query. If absent, `NULL` is used for `avg_clv` and the `LEFT JOIN` is omitted. Header line reports `CLV data: yes/no` so operator knows at a glance.

### market_period_token Derivation

Derived via `json_extract(cr.metadata, '$.market_period_token')` with `COALESCE`-style `CASE` fallback to `'FULL_GAME'` when the field is absent.

### Thresholds Implemented

| Rule | Condition |
|------|-----------|
| PROMOTE | `win_rate > 0.54` AND `settled_count >= MIN_SETTLED` |
| WATCH | `win_rate >= 0.50` AND `settled_count >= MIN_SETTLED` |
| QUARANTINE | `win_rate < 0.50` AND `settled_count >= MIN_SETTLED` |
| INSUFFICIENT_DATA | `settled_count < MIN_SETTLED` OR `win_rate == null` |

Default `MIN_SETTLED = 20`, overridable via `--min-settled=N`.

### CLI Flags

- `--sport=NBA` — filter output to single sport
- `--min-settled=N` — override minimum settled threshold
- `--help` / `-h` — usage output

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed resolveDatabasePath() return value display**
- **Found during:** Task 1 verification
- **Issue:** `resolveDatabasePath()` returns `{dbPath, source, isExplicitFile}` object, not a string — displayed as `[object Object]` in header
- **Fix:** Extract `.dbPath` property from result object
- **Files modified:** `scripts/settlement-roi-report.js`
- **Commit:** `9ef8f99`

## Self-Check: PASSED

Files exist:
- FOUND: scripts/settlement-roi-report.js
- FOUND: docs/SETTLEMENT_ROI_GUIDE.md

Commits exist:
- FOUND: 9ef8f99 (settlement-roi-report.js)
- FOUND: dd08600 (SETTLEMENT_ROI_GUIDE.md)

Syntax check: `node --check scripts/settlement-roi-report.js` exits 0.

Runtime verified against dev DB: per-market table and per-sport rollup both produced correctly. Missing DB path prints clear error and exits 1.
