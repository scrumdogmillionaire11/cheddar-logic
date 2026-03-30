---
ID: WI-0703
Goal: |
  Investigate and eliminate brief database inaccessibility windows during worker snapshot rotation.
  Ensure web server (read-only) never blocks or fails due to worker snapshot saving.
Status: queued
Priority: low
Scope: |
  - apps/worker/src/scheduler/index.js or snapshot mechanism
    - Understand when/how snapshots are saved
    - Identify lock/rename operations that block readers
  - packages/data/src/db/connection.js
    - Verify WAL mode is enabled and working
    - Check retry logic for brief file-not-found scenarios
  - deploy/systemd/cheddar-web.service
    - Verify ReadWritePaths includes /opt/data
  - Operational monitoring
    - Add logging for "database file not found" errors on web
    - Alert on persistent DB access failures
Out of scope: |
  - Frontend error handling (WI-0701)
  - Backend query timeout (WI-0702)
  - Schema migrations or new DB features
Acceptance: |
  ✓ Root cause identified: worker snapshot mechanism and impact
  ✓ WAL mode confirmed active on production SQLite
  ✓ Web server can retry briefly on file-not-found (should succeed 2nd attempt)
  ✓ Snapshot operation takes <100ms (no observable window)
  ✓ Monitoring in place for persistent DB access failures
  ✓ If new code needed: snapshot process improved to minimize reader impact
Owner agent: github-copilot
CLAIM: github-copilot 2026-03-29T23:50:49Z
Time window: 4-6 hours
Coordination flag: needs-sync (affects worker + web coordination)
Execution mode: parallel background diagnostic (non-blocking)
Tests to run: |
  N/A - investigation and monitoring setup only
Manual validation: |
  1. SSH to production server
  2. Check DB file permissions and WAL journal
  3. Monitor web logs for "database file not found" during snapshot
  4. Verify no correlation between snapshot timing and user-reported outages
  5. Add scheduled log analysis for DB access errors
Decision link: false
PR requirements: |
  - Linked to debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
  - Investigation findings documented in ADR if findings warrant changes
  - Monitoring/alerting setup for persistent DB access failures
---

# Investigation: Worker Snapshot DB Contention

## Problem
Production sees transient HTTP 502 on `/api/games` intermittently. Correlation suggests timing overlap with worker snapshot saves.

## Root Cause Hypothesis
Worker writes CHEDDAR_DB_PATH periodically (snapshot save); during file lock or rename operations, brief window where web server cannot read DB → getDatabaseReadOnly() throws "database file not found" → caught as 500 → CF proxies as 502.

## Investigation Scope
1. **Snapshot mechanism**: When/how does worker save snapshots? What file ops are involved?
2. **WAL mode**: Is WAL mode active? Does it allow concurrent reader+writer safely?
3. **File locks**: Any advisory locks preventing reads during snapshot?
4. **Retry logic**: Should web server retry brief-lived "file not found" errors?
5. **Monitoring**: Are we logging these failures? Can we correlate with snapshot timing?

## Expected Outcomes
- Document exact snapshot sequence and timing
- Confirm WAL mode is working as intended
- Identify whether webserver needs retry logic for transient file-not-found
- If snapshot process is the culprit, propose optimization (e.g., atomic swap, WAL checkpointing)

## Implementation Notes
- Read packages/data/src/db/connection.js WAL config
- Trace through worker snapshot code path
- Check production logs for "database file not found" correlation
- Add enhanced logging around DB access failures (include timestamp, retry count)

## Related

- Debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
- WI-0701 (frontend resilience)
- WI-0702 (backend timeout)
- ADR-0002 (single-writer DB contract)

## Execution Notes (2026-03-29)

- Confirmed current worker path does not rotate/swap the live DB file in place; backup utility (`apps/worker/src/utils/db-backup.js`) uses `fs.copyFileSync` to backup targets, not primary-file rename.
- Confirmed WAL is enabled in writer and reader open paths (`packages/data/src/db/connection.js`), and web service has required write/read paths configured (`deploy/systemd/cheddar-web.service`).
- Implemented transient read-only open retry in `getDatabaseReadOnly()` with bounded retry window and interval:
  - `CHEDDAR_DB_READ_RETRY_MS` (default `300`)
  - `CHEDDAR_DB_READ_RETRY_INTERVAL_MS` (default `25`)
- Added persistent-failure diagnostics in DB connection layer:
  - failure streak tracking for repeated read-open failures
  - escalates from warning to error at streak >= 3 within 60s
  - recovery log emitted when transient failures self-heal
