---
phase: WI-0977
plan: 01
status: complete
---

# WI-0977: Deploy complete only after smoke checks pass

## What was built

Replaced the bare `systemctl is-active` check in `deploy-branch.yml` with three sequential smoke checks:

| Check | What it verifies | Failure action |
|-------|-----------------|----------------|
| smoke-1 | `systemctl is-active cheddar-worker` | dump 40 journal lines, exit 1 |
| smoke-2 | `[SCHEDULER] Database ready` appears in journal within 15s | dump 60 journal lines, exit 1 |
| smoke-3 | `sqlite3 PRAGMA integrity_check` returns `ok` | exit 1 (skipped if sqlite3 absent) |

## Signal source

`[SCHEDULER] Database ready.` is logged by `apps/worker/src/schedulers/main.js:463` immediately after the DB connection is established and stale lock recovery completes — the earliest point at which the scheduler is fully operational.

## Design

- All three checks run on the Pi over SSH inside the existing `deploy-worker-pi` job
- Checks are ordered by cost: process check → log poll → DB read
- smoke-3 is `sqlite3`-availability-gated to avoid breaking deploys on hosts where it isn't installed; `deploy-production.yml` installs it via `apt-get` but the branch workflow does not
