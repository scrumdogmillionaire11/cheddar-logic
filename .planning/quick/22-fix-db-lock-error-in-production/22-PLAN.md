# Quick Task 22: fix DB lock error in production - Plan

## Tasks

### Task 1: Fix stale DB lock detection (PID recycling in containers)
- **File:** `packages/data/src/db.js`
- **Action:** Add `isLockOwnerAlive(lockInfo)` that cross-checks `/proc/{pid}` ctime on Linux against lock's `startedAt`. If the process at that PID started after the lock was written, the original owner died and the PID was recycled.
- **Done:** Added function and replaced `!isProcessAlive(Number(lockInfo.pid))` with `!isLockOwnerAlive(lockInfo)`

### Task 2: Fix dev plays not showing (null run_id test seeds)
- **File:** `web/src/app/api/games/route.ts`
- **Action:** Always migrate null `run_id` card_payloads to `'bootstrap-initial'` (not just when all are null). Fixes partial migration state where dev seed data inserted without run_ids is excluded by the `run_id IN (...)` filter.
- **Done:** Changed bootstrap logic in `ensureRunStateSchema`
