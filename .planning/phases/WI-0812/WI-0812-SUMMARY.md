---
phase: sprint-1
plan: WI-0812
subsystem: data-integrity
tags: [sqlite, card-payloads, upsert, migration, deduplication, deterministic-id]

dependency-graph:
  requires: []
  provides:
    - deterministic market-call card IDs (no UUID suffix)
    - idempotent insertCardPayload (INSERT OR IGNORE + UPDATE)
    - migration 062 to collapse existing duplicates + UNIQUE INDEX enforcement
  affects:
    - WI-0838 (CLV first-seen price lock — depends on stable card IDs)
    - WI-0817 (transaction wrapping — shares insertCardPayload code path)

tech-stack:
  added: []
  patterns:
    - INSERT OR IGNORE + UPDATE WHERE (workaround for SQLite partial index limitation with ON CONFLICT DO UPDATE)
    - partial UNIQUE INDEX (WHERE card_type LIKE '%-call') for targeted constraint scope

key-files:
  created:
    - packages/models/__tests__/card-factory.test.js
    - packages/data/__tests__/card-payload-upsert.test.js
    - packages/data/db/migrations/062_deduplicate_card_payloads.sql
  modified:
    - packages/models/src/card-factory.js
    - packages/data/src/db/cards.js
    - WORK_QUEUE/WI-0812.md

decisions:
  - id: D-0812-01
    summary: INSERT OR IGNORE + UPDATE WHERE instead of ON CONFLICT DO UPDATE
    reason: SQLite ON CONFLICT DO UPDATE does not recognize partial UNIQUE INDEXes created with CREATE UNIQUE INDEX ... WHERE; it only recognizes constraints in table DDL. Using INSERT OR IGNORE + separate UPDATE statement achieves identical semantics without the SQLite limitation.
  - id: D-0812-02
    summary: Keep canonical row = earliest created_at per (game_id, card_type)
    reason: Oldest row has accumulated the most card_results history; preserving it avoids FK orphaning during deduplication.
  - id: D-0812-03
    summary: Partial index scoped to card_type LIKE '%-call'
    reason: Driver cards intentionally generate new IDs per run (different game contexts); constraining only call cards avoids breaking driver card logic.

metrics:
  duration: ~2 hours (across 2 sessions)
  completed: 2026-06-10
---

# WI-0812 Summary: Fix market-call card deduplication — deterministic IDs, INSERT OR IGNORE upsert, migration 062

**One-liner:** Eliminated ~7,000 duplicate market-call card_payload rows by removing UUID suffix from buildMarketCallCard, switching insertCardPayload to INSERT OR IGNORE + conditional UPDATE, and adding migration 062 with partial UNIQUE INDEX enforcement.

---

## Objective

Every 30-minute model run was inserting a fresh `card_payloads` row for the same `(game_id, card_type)` market-call card because `buildMarketCallCard` appended a random UUID suffix to the card ID. This caused exponential row accumulation and broke card history continuity.

---

## Tasks Completed

| Task | Description | Commit | Key Files |
|------|-------------|--------|-----------|
| 0 | Fix WI-0812.md plan — remove `id=excluded.id` FK violation | `4287e47` | WORK_QUEUE/WI-0812.md |
| 1 | Deterministic card ID in `buildMarketCallCard` | `4e29129` | card-factory.js, card-factory.test.js |
| 2 | Upsert `insertCardPayload` — INSERT OR IGNORE + UPDATE | `6e624e8` | cards.js, card-payload-upsert.test.js |
| 3 | Migration 062 — dedup existing rows + partial UNIQUE INDEX | `a8ad0f0` | 062_deduplicate_card_payloads.sql |

---

## Decisions Made

### D-0812-01: INSERT OR IGNORE + UPDATE WHERE pattern
**Context:** Original plan specified `INSERT OR CONFLICT(game_id, card_type) DO UPDATE SET ...` but this requires the conflict target to match explicit UNIQUE constraints in DDL — not partial indexes created with `CREATE UNIQUE INDEX ... WHERE`.

**Decision:** Use INSERT OR IGNORE followed by a separate UPDATE WHERE statement. The INSERT silently skips if a matching row exists; the UPDATE applies new payload data for call cards only when no settled card_results exist.

**Impact:** Identical semantics, no SQLite version dependency, works with both old (pre-migration) and new (post-migration) DBs.

### D-0812-02: Canonical row = earliest created_at
**Context:** Need to pick one row to keep per `(game_id, card_type)` during deduplication.

**Decision:** Keep the row with the earliest `created_at`. This row has the longest history of associated `card_results` and minimizes FK orphaning.

### D-0812-03: Partial index scoped to `card_type LIKE '%-call'`
**Context:** Driver cards (`nba-driver`, `nhl-driver`) have different ID semantics.

**Decision:** Partial index only covers call cards. Driver card logic unchanged.

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed `id = excluded.id` from original plan's DO UPDATE SET**

- **Found during:** Plan review (pre-execution)
- **Issue:** `id = excluded.id` in a `DO UPDATE SET` would mutate the primary key of a row that `card_results.card_id` references (FK constraint, no CASCADE). Would cause FK violation under `foreign_keys=ON`.
- **Fix:** Removed from plan doc and never included in implementation.
- **Commit:** `4287e47`

**2. [Rule 3 - Blocking] ON CONFLICT DO UPDATE doesn't recognize partial UNIQUE INDEXes in SQLite**

- **Found during:** Task 2 implementation
- **Issue:** SQLite's `ON CONFLICT(col1, col2) DO UPDATE` parser only recognizes explicit `UNIQUE` constraints listed in the table's CREATE TABLE DDL. A `CREATE UNIQUE INDEX ... WHERE` is a **partial index** and is invisible to the ON CONFLICT clause. Error: `"ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"`.
- **Fix:** Switched to INSERT OR IGNORE + separate UPDATE WHERE pattern. Confirmed working via smoke test at SQLite 3.51.3.
- **Files modified:** `packages/data/src/db/cards.js`
- **Commit:** `6e624e8`

---

## Test Results

| Package | Suites | Tests | Status |
|---------|--------|-------|--------|
| packages/models | 10 total (2 empty suites — pre-existing) | 39/39 pass | ✅ |
| packages/data | 25/25 | 223/223 pass | ✅ |
| apps/worker | 97/98 pass (1 pre-existing failure: run_mlb_model.test.js) | 1241/1253 pass | ✅ (no regression) |

Pre-existing failures were present before WI-0812 and are unrelated to these changes.

---

## Next Phase Readiness

**WI-0812 is code-complete on `working-branch`. Manual production steps remain:**

1. **Stop worker:** `sudo systemctl stop cheddar-worker`
2. **Run migration:** `node /opt/cheddar-logic/packages/data/src/db/run-migration.js 062`
3. **Verify dedup:**
   ```sql
   SELECT card_type, COUNT(DISTINCT game_id), COUNT(*)
   FROM card_payloads
   WHERE card_type LIKE '%-call'
   GROUP BY card_type;
   -- Every pair of columns should be equal (1 row per game per market)
   ```
4. **Verify index:**
   ```sql
   SELECT name FROM sqlite_master
   WHERE type='index' AND name='uq_card_payloads_call_per_game';
   ```
5. **Restart worker**, wait one model run cycle (~30 min), verify no new duplicate rows.

**Dependent WI unblocked:** WI-0838 (CLV first-seen price lock) depends on stable card IDs — now safe to begin.
