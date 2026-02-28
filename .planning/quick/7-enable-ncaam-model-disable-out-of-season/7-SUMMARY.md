---
phase: quick-7
plan: "01"
subsystem: worker-scheduler
tags: [odds-ingest, scheduler, season-management, ncaam, config-driven]
dependency_graph:
  requires: [packages/odds/src/config.js]
  provides: [config-driven odds ingest, season-gated model execution]
  affects: [apps/worker/src/jobs/pull_odds_hourly.js, .env, env.example]
tech_stack:
  added: []
  patterns: [config-driven sport list, env-gated model execution]
key_files:
  modified:
    - apps/worker/src/jobs/pull_odds_hourly.js
    - env.example
  not_committed:
    - .env (gitignored — contains ODDS_API_KEY; updated locally)
decisions:
  - "Use getActiveSports() from config.js as the single source of truth for odds fetch sport list"
  - ".env is gitignored so only env.example committed; local .env updated separately"
metrics:
  duration: "18 minutes"
  completed: "2026-02-28"
  tasks_completed: 2
  files_modified: 3
---

# Quick Task 7: Enable NCAAM Model, Disable Out-of-Season MLB/NFL — Summary

**One-liner:** Config-driven odds ingest (NHL+NBA+NCAAM, 8 tokens/fetch, 192/day) with env-gated model execution disabling MLB and NFL for off-season.

---

## What Was Done

### Task 1: Wire pull_odds_hourly to config-driven active sports (commit: 21e088f)

**Problem:** `pull_odds_hourly.js` had a hardcoded sport list `['NHL', 'NBA', 'MLB', 'NFL']` that completely ignored:
- The `active: false` flags on MLB and NFL already set in `packages/odds/src/config.js`
- NCAAM which had `active: true` and is in season

**Fix:**
- Imported `getActiveSports` and `getTokensForFetch` from `@cheddar-logic/odds`
- Replaced hardcoded array with `getActiveSports()` call
- Added log line: `[PullOdds] Active sports (from config): NHL, NBA, NCAAM | tokens/fetch: 8 | ~192/day`
- Added inline token math comment block

**Result:** Sport list is now entirely controlled by `active: true/false` in `config.js`. Adding or removing a sport requires editing one file only.

**Verified:**
```
$ node -e "const {getActiveSports}=require('./packages/odds/src/config'); console.log(getActiveSports())"
[ 'NHL', 'NBA', 'NCAAM' ]
```
No hardcoded list remains in `pull_odds_hourly.js`.

---

### Task 2: Update .env and env.example to reflect season reality (commit: f2931d9)

**Problem:**
- `.env` had `ENABLE_MLB_MODEL=true` — MLB is off-season (spring training only)
- `.env` had `ENABLE_NFL_MODEL=true` — NFL offseason
- `.env` had no `ENABLE_NCAAM_MODEL` entry — defaulted to enabled but undocumented

**Fix applied to `.env` (local, gitignored):**
- `ENABLE_MLB_MODEL=false`
- `ENABLE_NFL_MODEL=false`
- `ENABLE_NCAAM_MODEL=true` (added between NBA and MLB lines)
- Season gate comment block with re-enable dates

**Fix applied to `env.example` (committed):**
- Same flags and comment block as .env
- Note: `env.example` was not previously committed — this is its first commit

**Verified:**
```
$ node -e "process.env.ENABLE_MLB_MODEL='false'; process.env.ENABLE_NFL_MODEL='false'; process.env.ENABLE_NCAAM_MODEL='true'; ... enabledSports()"
[ 'nhl', 'nba', 'soccer', 'ncaam' ]
```
MLB and NFL absent. NCAAM present. FPL absent (ENABLE_FPL_MODEL=false — unchanged).

---

## Token Math Confirmed

| Sport | Markets          | Tokens/Fetch | Fetches/Day | Tokens/Day |
|-------|-----------------|-------------|------------|------------|
| NHL   | h2h + totals    | 2           | 24         | 48         |
| NBA   | h2h + totals + spreads | 3  | 24         | 72         |
| NCAAM | h2h + totals + spreads | 3  | 24         | 72         |
| **Total** |             | **8**       | **24**     | **192**    |

- Free tier: 500 tokens/month — not viable for production (used up in ~2.5 days)
- Starter paid tier: 10,000+ tokens/month — 192/day = 5,760/month (well within quota)

Disabled (0 tokens saved):
- MLB: 2 tokens/fetch x 24 = 48/day saved
- NFL: 3 tokens/fetch x 24 = 72/day saved
- **Total savings vs old config: 120 tokens/day (5 → 8 reduction, actually savings from not doing MLB+NFL)**

---

## Success Criteria Verification

| Criterion | Status |
|-----------|--------|
| pull_odds_hourly fetches NHL, NBA, NCAAM — not MLB or NFL | PASS |
| Daily token cost documented: 8 tokens/fetch x 24 = 192/day | PASS |
| ENABLE_MLB_MODEL=false in .env | PASS (local) |
| ENABLE_NFL_MODEL=false in .env | PASS (local) |
| ENABLE_NCAAM_MODEL=true in .env and env.example | PASS |
| No model runs fire for MLB or NFL | PASS (scheduler gates via enabledSports()) |
| NCAAM cards will generate when games appear in 36h horizon | PASS (enabledSports returns ncaam) |

---

## Deviations from Plan

**1. [Rule 1 - Finding] .env is gitignored**
- **Found during:** Task 2 commit
- **Issue:** `.env` contains a real API key (`ODDS_API_KEY`) so it is correctly gitignored. The plan listed `.env` in `files_modified` without noting the gitignore status.
- **Fix:** Updated `.env` locally (verified correct), committed only `env.example` to git.
- **Impact:** None — behavior identical at runtime. Local `.env` has the correct flags.

None of the plan logic required modification — only the commit scope differed.

---

## Commits

| Task | Commit  | Message |
|------|---------|---------|
| 1    | 21e088f | feat(quick-7): wire pull_odds_hourly to config-driven active sports via getActiveSports() |
| 2    | f2931d9 | chore(quick-7): update env.example for season reality (disable MLB/NFL, enable NCAAM) |
