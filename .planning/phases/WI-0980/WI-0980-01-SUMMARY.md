---
phase: WI-0980
plan: 01
status: complete
---

# WI-0980: Block deploy on runtime config drift

## What was built

Config drift check added as the first step in the `deploy-branch.yml` SSH script — runs before the worker is stopped, so a failed check leaves the Pi fully untouched.

## Required keys checked

| Key | Failure mode |
|-----|-------------|
| `CHEDDAR_DB_PATH` | hard fail — no DB path = nowhere to migrate or run |
| `TZ` | hard fail — missing TZ causes silent scheduling drift (all window times use server TZ) |
| `NODE_ENV` | warning only — not `production` is suspicious but not always fatal |

## Why before worker stop

A config drift failure means `.env.production` is misconfigured. Stopping the worker first and then discovering the config is wrong would leave the service down for no reason. This ordering ensures the running worker is never interrupted by a config check failure.
