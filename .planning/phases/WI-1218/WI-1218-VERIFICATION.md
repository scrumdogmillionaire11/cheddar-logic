---
phase: WI-1218+WI-1219
verified: 2026-04-30T00:00:00Z
status: passed
score: 15/15 criteria verified
re_verification: false
---

# WI-1218 + WI-1219 Verification Report

**Verified:** 2026-04-30
**Status:** PASSED — all 15 acceptance criteria satisfied
**Re-verification:** No — initial verification

---

## WI-1218: Move Inline schema guards to numbered migrations (R-02)

**Goal:** Eliminate inline DDL guards (`ensureCardPayloadRunIdColumn`, `ensureActualResultColumn`) from `packages/data/src/db/cards.js` and replace them with a numbered migration + idempotency handler in `migrate.js`. Enforce the constraint in CI.

### Criterion 1 — Migration file exists with correct SQL

**Status: PASS**

`packages/data/db/migrations/090_add_card_payloads_actual_result.sql` exists and its sole content is:

```sql
ALTER TABLE card_payloads ADD COLUMN actual_result TEXT;
```

Evidence: file read, line 3.

---

### Criterion 2 — `migrate.js` handles duplicate-column skip for `actual_result`

**Status: PASS**

`packages/data/src/migrate.js` lines 145–212 contain the following block (pattern matches the `isDuplicateRunId` pattern):

```js
const isActualResultMigration = file === '090_add_card_payloads_actual_result.sql';
const isDuplicateActualResult = message.includes('duplicate column name: actual_result');

if (isActualResultMigration && isDuplicateActualResult) {
  // strips the ALTER TABLE line from sql and re-executes
  // records migration as applied
  // continues to next migration
}
```

This is structurally identical to the `isDuplicateRunId` block at lines 172–191 and the `isDuplicatePrimary` block at lines 151–169.

---

### Criterion 3 — `ensureCardPayloadRunIdColumn` deleted from `cards.js`

**Status: PASS**

`grep -rn "ensureCardPayloadRunIdColumn" packages/data/src/` returns zero matches. The function does not appear anywhere in `packages/data/src/db/cards.js` (1412 lines read in full).

---

### Criterion 4 — `ensureActualResultColumn` deleted from `cards.js`; all call sites removed

**Status: PASS**

`grep -rn "ensureActualResultColumn" packages/data/src/` returns zero matches. Neither the function definition nor any call site appears in `cards.js` or anywhere else under `packages/data/src/`.

---

### Criterion 5 — CI `validate` job includes fail-if-match inline DDL step

**Status: PASS**

`.github/workflows/ci.yml` lines 54–59:

```yaml
- name: Forbid inline DB DDL in data db modules
  run: |
    if grep -R -nE "db\.exec.*(ALTER TABLE|CREATE TABLE)" packages/data/src/db --include="*.js"; then
      echo "Inline DDL via db.exec is forbidden in packages/data/src/db"
      exit 1
    fi
```

The step name, grep pattern, error message, and `exit 1` all match the acceptance criterion exactly. It runs within the `validate` job (line 9).

---

### Criterion 6 — Zero matches for `ensureCardPayloadRunIdColumn|ensureActualResultColumn` in `packages/data/src/`

**Status: PASS**

Live grep across `packages/data/src/` (all `.js` files) returns no matches for either function name. Verified by running the guard pattern directly.

---

### Criterion 7 — Inline DDL guard: no matches for `db.exec.*(ALTER TABLE|CREATE TABLE)` in `packages/data/src/db/*.js`

**Status: PASS**

`grep -R -nE "db\.exec.*(ALTER TABLE|CREATE TABLE)" packages/data/src/db --include="*.js"` returns no output. The guard that CI enforces would pass clean.

---

### Bonus artifact — Idempotency test

`packages/data/src/__tests__/migrate-actual-result-idempotency.test.js` exists (119 lines) and covers:
- Clean DB gets `actual_result` column via migration 090
- Pre-existing `actual_result` column is skipped without duplicate-column error and migration is recorded

---

**WI-1218 Verdict: COMPLETE**

All 7 acceptance criteria satisfied.

---

## WI-1219: Add Nightly Scheduled DB Backup to Worker Scheduler (R-04)

**Goal:** Deliver a nightly DB backup executed by the worker scheduler at 02:00 ET (in-process path) with a systemd timer fallback at 02:47 ET when the worker is down. Single-writer protection prevents the timer path from running while the worker is active.

### Criterion 1 — `nightly_db_backup.js` exists with correct structure

**Status: PASS**

`apps/worker/src/jobs/nightly_db_backup.js` exists (73 lines). Verified:

- Deterministic daily `jobKey` format: `nightly_db_backup|${nowEt.toISODate()}` (set at line 62 in `require.main` block; the scheduler constructs it identically at main.js line 401).
- `wasJobKeyRecentlySuccessful(jobKey, 1200)` called at line 22 (1200 = 20 hours in minutes).
- `dbBackup.backupDatabase('nightly')` called at line 40.
- `insertJobRun` at line 37, `markJobRunSuccess` at line 48, `markJobRunFailure` at lines 44 and 53.

All structural requirements met.

---

### Criterion 2 — Scheduler dispatches `nightly_db_backup` job

**Status: PASS**

`apps/worker/src/schedulers/main.js`:
- Line 71: `const { nightlyDbBackup } = require('../jobs/nightly_db_backup');`
- Lines 398–409: nightly sweep block triggers at `isFixedDue(nowEt, '02:00')`, builds `nightlyDbBackupKey`, pushes job entry with `jobName: 'nightly_db_backup'` and calls `nightlyDbBackup({ jobKey: nightlyDbBackupKey, dryRun })`.

---

### Criterion 3 — `cheddar-db-backup.service` exists with correct attributes

**Status: PASS**

`deploy/systemd/cheddar-db-backup.service` exists. Verified:
- `User=babycheeses11` (line 7)
- `EnvironmentFile=/opt/cheddar-logic/.env.production` (line 10)
- `Type=oneshot` (line 6)
- `ExecStart=/opt/cheddar-logic/scripts/run-db-backup.sh` (line 11)

---

### Criterion 4 — `cheddar-db-backup.timer` exists with correct schedule

**Status: PASS**

`deploy/systemd/cheddar-db-backup.timer` exists. Verified:
- `Persistent=true` (line 7)
- `Timezone=America/New_York` (line 6)
- `OnCalendar=*-*-* 02:47:00` (line 5) — daily at 02:47 ET

---

### Criterion 5 — Fail-safe: refuses to run while `cheddar-worker.service` is active

**Status: PASS**

The `.service` file delegates to `scripts/run-db-backup.sh`. That script (lines 14–16):

```bash
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$WORKER_SERVICE"; then
  echo "[run-db-backup] ${WORKER_SERVICE} is active — skipping timer backup (scheduler handles in-process path)"
  exit 0
fi
```

`WORKER_SERVICE` defaults to `cheddar-worker` (line 11). The script exits 0 (no backup) when the worker service is active. This satisfies "service or the backing script refuses to run while cheddar-worker.service is active."

---

### Criterion 6 — `scripts/run-db-backup.sh` exists

**Status: PASS**

`scripts/run-db-backup.sh` exists (22 lines). It is a lock-safe wrapper: checks worker service state, exits early if worker is active, otherwise calls `node apps/worker/src/jobs/nightly_db_backup.js`.

---

### Criterion 7 — Test file for `nightly_db_backup.js` exists and tests job guards

**Status: PASS**

`apps/worker/src/__tests__/nightly_db_backup.test.js` exists (124 lines). Tests verified to cover:

1. Runs backup and records success when all guards pass
2. Skips when `wasJobKeyRecentlySuccessful` returns true (`reason: 'recently_succeeded'`)
3. Skips when `shouldRunJobKey` returns false (`reason: 'already_running'`)
4. Records failure when `backupDatabase` returns null
5. Records failure when `backupDatabase` throws
6. `dryRun=true` skips backup and job run recording
7. Runs without `jobKey` — skips guard checks, still backs up

All guard paths are covered.

---

### Criterion 8 — `CHEDDAR_DB_BACKUP_RETENTION_HOURS` and `CHEDDAR_DB_BACKUP_MAX_FILES` in `env.example`

**Status: PASS**

`env.example` lines 268–271:

```
# CHEDDAR_DB_BACKUP_RETENTION_HOURS — delete backups older than this many hours (default 24)
CHEDDAR_DB_BACKUP_RETENTION_HOURS=24
# CHEDDAR_DB_BACKUP_MAX_FILES — hard cap on backup file count, oldest pruned first (default 12)
CHEDDAR_DB_BACKUP_MAX_FILES=12
```

Both variables documented with descriptions and default values.

---

**WI-1219 Verdict: COMPLETE**

All 8 acceptance criteria satisfied.

---

## Summary

| WI | Criteria | Passed | Failed | Verdict |
|----|----------|--------|--------|---------|
| WI-1218 | 7 | 7 | 0 | COMPLETE |
| WI-1219 | 8 | 8 | 0 | COMPLETE |
| **Total** | **15** | **15** | **0** | **ALL COMPLETE** |

No anti-patterns or stubs detected. No items requiring human verification.

---

_Verified: 2026-04-30_
_Verifier: Claude (gsd-verifier)_
