# Quick Task 22: fix DB lock error in production - Summary

## Changes

### 1. `packages/data/src/db.js` — Stale lock / PID recycling fix
Added `isLockOwnerAlive(lockInfo)` which extends the existing `isProcessAlive` check with Linux-specific PID recycling detection. When a container restarts, the lock file persists on the mounted volume (`/opt/data/`). The new container may reuse the same PID for an unrelated process, causing `process.kill(pid, 0)` to return true even though the original DB owner is gone. The fix reads `/proc/{pid}` ctime and compares it to the lock's `startedAt` — if the process is newer than the lock, it's a recycled PID and the lock is stale.

### 2. `web/src/app/api/games/route.ts` — Dev plays not showing
The `ensureRunStateSchema` bootstrap previously only migrated null `run_id` values when ALL payloads had null run_ids. In a partial state (526 with 'bootstrap-initial', 10 test seeds with null), the nulls were left untouched and excluded by `run_id IN ('bootstrap-initial')`. Fix: always `UPDATE card_payloads SET run_id = 'bootstrap-initial' WHERE run_id IS NULL`, so test/seed data shows up in dev. The run_state update only fires if run_state has no current_run_id set, preserving production run tracking.

## Root Causes
- **Production lock**: PID recycling in Docker containers — lock file on persistent volume, new container reuses PID
- **Dev no plays**: Dev seed cards inserted without `run_id`, bootstrap condition too strict to catch partial null state
