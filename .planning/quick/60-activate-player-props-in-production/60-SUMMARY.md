---
phase: quick
plan: 60
subsystem: web
tags: [feature-flag, player-props, production, next-js]
dependency_graph:
  requires: [WI-0527, WI-0528, WI-0529, WI-0530, WI-0531]
  provides: [player-props-tab-live-in-production]
  affects: [web/src/components/cards-page-client.tsx]
tech_stack:
  added: []
  patterns: [NEXT_PUBLIC_ env vars baked at build time]
key_files:
  created: []
  modified:
    - .env.production (gitignored — local Pi update required)
    - .env.production.example
decisions:
  - .env.production is gitignored; Pi must be updated manually via git pull (which restores tracked files) plus the untracked .env.production edit applied separately or from scratch using the example file
metrics:
  duration: ~5 minutes
  completed: 2026-03-20
---

# Quick Task 60: Activate Player Props in Production — Summary

**One-liner:** Flipped NEXT_PUBLIC_ENABLE_PLAYER_PROPS to true in .env.production and .env.production.example to activate the player props tab at cheddarlogic.com after Pi rebuild.

## What Was Done

Task 1 of 2 complete. The NEXT_PUBLIC_ENABLE_PLAYER_PROPS flag was enabled in both environment files:

- `.env.production.example` (tracked): changed `false` → `true` on line 33 — committed in 7b572d3
- `.env.production` (gitignored): added `NEXT_PUBLIC_ENABLE_PLAYER_PROPS=true` under a new "Feature Flags" section — updated locally, NOT committed (file is intentionally gitignored since it contains real API keys)

Task 2 (checkpoint:human-verify) requires a manual rebuild on the Pi — see Awaiting section below.

## Commits

| Hash    | Message                                                                 |
|---------|-------------------------------------------------------------------------|
| 7b572d3 | feat(quick-60): enable NEXT_PUBLIC_ENABLE_PLAYER_PROPS=true in example env |

## Awaiting

The Next.js `NEXT_PUBLIC_*` variable is baked into the bundle at build time, not read at runtime. To activate the Props tab at cheddarlogic.com, the Pi must:

1. Pull latest code: `git pull origin main`
2. Copy the .env.production.example changes into the live .env.production (or manually add the flag line)
3. Rebuild: `cd /opt/cheddar-logic/web && npm run build`
4. Restart service: `pm2 restart cheddar-web`
5. Verify: visit https://cheddarlogic.com — the "Props" tab should appear alongside Cards and Results

## Deviations from Plan

**1. [Rule 3 - Blocking] .env.production is gitignored**

- **Found during:** Task 1
- **Issue:** `.env.production` contains real API keys and is listed in `.gitignore`. `git add .env.production` fails with "ignored file" error.
- **Fix:** Committed `.env.production.example` (the tracked reference file) and applied the flag change to the local `.env.production` directly. The Pi operator must add the flag to their live `.env.production` (or rebuild from the updated example). This is the correct production secret management pattern for this repo.
- **Files modified:** .env.production.example (committed), .env.production (local only)
- **Commit:** 7b572d3

## Self-Check: PASSED

- .env.production.example contains NEXT_PUBLIC_ENABLE_PLAYER_PROPS=true: confirmed
- .env.production contains NEXT_PUBLIC_ENABLE_PLAYER_PROPS=true: confirmed (local, gitignored)
- Commit 7b572d3 exists: confirmed
