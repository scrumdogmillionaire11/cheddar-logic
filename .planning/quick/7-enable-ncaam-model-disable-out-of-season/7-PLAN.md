---
phase: quick-7
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/pull_odds_hourly.js
  - .env
  - env.example
autonomous: true
requirements:
  - QUICK-7-ncaam-enable
  - QUICK-7-mlb-nfl-disable
  - QUICK-7-api-quota-audit

must_haves:
  truths:
    - "NCAAM odds are fetched each hourly pull and stored in DB"
    - "MLB and NFL odds are NOT fetched (saving API tokens during off-season)"
    - "MLB and NFL model jobs do NOT run (no cards generated for games that don't exist)"
    - "Daily token cost is documented and within quota"
  artifacts:
    - path: "apps/worker/src/jobs/pull_odds_hourly.js"
      provides: "Odds ingest using config-driven sport list (not hardcoded)"
      contains: "getActiveSports"
    - path: ".env"
      provides: "Runtime flags matching current season reality"
      contains: "ENABLE_MLB_MODEL=false"
  key_links:
    - from: "apps/worker/src/jobs/pull_odds_hourly.js"
      to: "packages/odds/src/config.js"
      via: "getActiveSports() import"
      pattern: "getActiveSports"
    - from: "apps/worker/src/schedulers/main.js"
      to: "ENABLE_NCAAM_MODEL env var"
      via: "enabledSports() filter"
      pattern: "ENABLE_NCAAM_MODEL"
---

<objective>
Enable NCAAM odds ingest and model execution; disable MLB and NFL for the off-season; document API token math to confirm we stay within quota.

Purpose: MLB is in spring training (no real games), NFL is in offseason — both waste API tokens. NCAAM (college basketball) is in season with active games. The odds API charges tokens per sport per fetch; running 4 sports hourly is wasteful and needs to be right-sized.

Output: pull_odds_hourly fetches NHL + NBA + NCAAM only (driven by config.js active flags), MLB/NFL model jobs are disabled via env flags, and daily token cost is documented inline.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

# Key files to understand before editing
@apps/worker/src/jobs/pull_odds_hourly.js
@packages/odds/src/config.js
@apps/worker/src/schedulers/main.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Wire pull_odds_hourly to use config-driven active sports list</name>
  <files>apps/worker/src/jobs/pull_odds_hourly.js</files>
  <action>
    The current `pull_odds_hourly.js` hardcodes `activeSports = ['NHL', 'NBA', 'MLB', 'NFL']` (line 70), completely ignoring:
    - The `active: false` flags on MLB and NFL in config.js
    - NCAAM, which has `active: true` and is in season

    Fix: Replace the hardcoded array with a call to `getActiveSports()` from `@cheddar-logic/odds`.

    1. Add import at top of file (after existing requires):
       ```js
       const { getActiveSports, getTokensForFetch } = require('@cheddar-logic/odds');
       ```

    2. Replace the hardcoded line:
       ```js
       // BEFORE (line ~70):
       const activeSports = ['NHL', 'NBA', 'MLB', 'NFL'];

       // AFTER:
       const activeSports = getActiveSports();
       ```

    3. Add a log line immediately after so we can see what's being fetched each run:
       ```js
       const tokenCost = getTokensForFetch(activeSports);
       console.log(`[PullOdds] Active sports (from config): ${activeSports.join(', ')} | tokens/fetch: ${tokenCost} | ~${tokenCost * 24}/day`);
       ```

    IMPORTANT: Do NOT change the DB write logic, idempotency gate, or contract check — only the sport list derivation changes.

    After this change, the sport list is entirely controlled by `active: true/false` in packages/odds/src/config.js:
    - NHL: active=true → fetched
    - NBA: active=true → fetched
    - NCAAM: active=true → fetched (was missing before)
    - MLB: active=false → skipped
    - NFL: active=false → skipped

    Daily token math (document in code comment near the log line):
    ```
    // Token math (2026-02-27, current season):
    // NHL:   2 tokens/fetch × 24 fetches/day = 48 tokens/day
    // NBA:   3 tokens/fetch × 24 fetches/day = 72 tokens/day
    // NCAAM: 3 tokens/fetch × 24 fetches/day = 72 tokens/day
    // Total: 8 tokens/fetch × 24 fetches/day = 192 tokens/day
    // The Odds API free tier: 500 tokens/month → not viable for production
    // Paid tier: 10,000+ tokens/month → 192/day = 5,760/month (OK on starter plan)
    ```
  </action>
  <verify>
    Run: `node -e "const {getActiveSports} = require('./packages/odds/src/config'); console.log(getActiveSports())"` from `/Users/ajcolubiale/projects/cheddar-logic`

    Expected output: `[ 'NHL', 'NBA', 'NCAAM' ]` (MLB and NFL absent because active=false)

    Then check the modified file does not contain the string `'NHL', 'NBA', 'MLB', 'NFL'` (hardcoded list is gone).
  </verify>
  <done>pull_odds_hourly derives its sport list from getActiveSports(), logging shows NHL/NBA/NCAAM at 8 tokens/fetch, MLB and NFL are absent from the fetch loop.</done>
</task>

<task type="auto">
  <name>Task 2: Update .env and env.example to reflect season reality</name>
  <files>.env, env.example</files>
  <action>
    The scheduler's `enabledSports()` function gates model execution via env flags. Currently:
    - `.env` has `ENABLE_MLB_MODEL=true` — MLB is off-season, spring training only
    - `.env` has `ENABLE_NFL_MODEL=true` — NFL offseason ended Feb 15
    - `.env` has NO `ENABLE_NCAAM_MODEL` entry — defaults to enabled (correct) but undocumented

    Update `.env`:
    1. Change `ENABLE_MLB_MODEL=true` → `ENABLE_MLB_MODEL=false`
    2. Change `ENABLE_NFL_MODEL=true` → `ENABLE_NFL_MODEL=false`
    3. Add `ENABLE_NCAAM_MODEL=true` after the NBA line (between ENABLE_NBA_MODEL and ENABLE_NFL_MODEL)

    Add a comment block above the enable flags in `.env` documenting when to re-enable:
    ```
    # Season gate: disable models for off-season sports to avoid wasted runs
    # MLB: re-enable ~March 20 when regular season starts (spring training games don't matter for betting)
    # NFL: re-enable ~September 1 when regular season starts
    # NCAAM: March Madness runs through ~April 7
    ```

    Update `env.example` with the same changes:
    1. Add `ENABLE_NCAAM_MODEL=true` after the NBA line
    2. Change the MLB and NFL comments to show `false` as the off-season default
    3. Add the same season gate comment block

    Do NOT touch any other env vars. Do NOT change ENABLE_ODDS_PULL, ENABLE_NHL_MODEL, ENABLE_NBA_MODEL, or ENABLE_FPL_MODEL.
  </action>
  <verify>
    Check `.env` contains:
    - `ENABLE_MLB_MODEL=false`
    - `ENABLE_NFL_MODEL=false`
    - `ENABLE_NCAAM_MODEL=true`

    Run: `node -e "process.env.ENABLE_MLB_MODEL='false'; process.env.ENABLE_NFL_MODEL='false'; process.env.ENABLE_NCAAM_MODEL='true'; const {enabledSports} = require('./apps/worker/src/schedulers/main'); console.log(enabledSports())"` from `/Users/ajcolubiale/projects/cheddar-logic`

    Expected output includes `ncaam` and excludes `mlb` and `nfl`.
  </verify>
  <done>.env has ENABLE_MLB_MODEL=false, ENABLE_NFL_MODEL=false, ENABLE_NCAAM_MODEL=true. enabledSports() returns nhl, nba, ncaam (and soccer/fpl per existing flags). env.example is updated to match.</done>
</task>

</tasks>

<verification>
After both tasks:

1. Active sports config check:
   ```
   node -e "const {getActiveSports,getTokensForFetch}=require('./packages/odds/src/config'); const s=getActiveSports(); console.log(s, 'tokens/fetch:', getTokensForFetch(s))"
   ```
   Expected: `[ 'NHL', 'NBA', 'NCAAM' ] tokens/fetch: 8`

2. Scheduler enabled sports check:
   ```
   node -e "require('dotenv').config(); const {enabledSports}=require('./apps/worker/src/schedulers/main'); console.log(enabledSports())"
   ```
   Expected: includes `ncaam`, excludes `mlb` and `nfl`

3. Grep confirms no hardcoded sport list in pull_odds_hourly:
   ```
   grep -n "NHL.*NBA.*MLB.*NFL" apps/worker/src/jobs/pull_odds_hourly.js
   ```
   Expected: no matches
</verification>

<success_criteria>
- pull_odds_hourly fetches NHL, NBA, and NCAAM — not MLB or NFL
- Daily token cost documented: 8 tokens/fetch × 24 = 192 tokens/day
- ENABLE_MLB_MODEL=false and ENABLE_NFL_MODEL=false in .env
- ENABLE_NCAAM_MODEL=true in .env and env.example
- No model runs fire for MLB or NFL (scheduler gates them out)
- NCAAM cards will be generated when NCAAM games appear in the 36h horizon
</success_criteria>

<output>
After completion, create `.planning/quick/7-enable-ncaam-model-disable-out-of-season/7-SUMMARY.md` with what was changed, token math confirmed, and any issues found.
</output>
```
