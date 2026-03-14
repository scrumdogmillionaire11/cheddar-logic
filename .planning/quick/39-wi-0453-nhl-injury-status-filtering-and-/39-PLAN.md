---
phase: 39-wi-0453-nhl-injury-status-filtering-and
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/pull_nhl_player_shots.js
  - apps/worker/src/jobs/run_nhl_player_shots_model.js
  - apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js
  - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
  - packages/data/db/migrations/030_add_player_availability.sql
  - docs/NHL_PLAYER_SHOTS_PROP_MARKET.md
  - docs/PROP_MARKET_EXPANSION_GUIDE.md
autonomous: true
requirements:
  - WI-0453
  - WI-0454

must_haves:
  truths:
    - "Players with NHL API status injured/IR/inactive are skipped in pull_nhl_player_shots and logged with name + reason"
    - "NHL_SOG_EXCLUDE_PLAYER_IDS continues to work as manual override (tested)"
    - "run_nhl_player_shots_model skips card generation for players with no valid recent logs"
    - "run_nhl_model.js goalie UNKNOWN state produces NEUTRALIZED adjustment_trust — confirmed in code and test"
    - "All 32 NHL team abbreviations are in TEAM_ABBREV_TO_NAME; missing abbrev logs a startup warning"
    - "Synthetic fallback line is deterministic (Math.round(mu * 2) / 2) with explicit log message"
    - "1P card generation is gated behind NHL_SOG_1P_CARDS_ENABLED env flag (defaults off)"
    - "setCurrentRunId is called on every successful model run regardless of card count"
    - "run_state is updated even when 0 cards are created"
    - "docs/PROP_MARKET_EXPANSION_GUIDE.md exists with 4-file pattern, registration checklist, Odds API keys, edge thresholds, token cost guidance"
    - "NHL_PLAYER_SHOTS_PROP_MARKET.md updated with injury check step and 1P flag docs"
  artifacts:
    - path: "apps/worker/src/jobs/pull_nhl_player_shots.js"
      provides: "Injury status check before shot log fetch"
    - path: "apps/worker/src/jobs/run_nhl_player_shots_model.js"
      provides: "All 7 hardening gaps fixed"
    - path: "packages/data/db/migrations/030_add_player_availability.sql"
      provides: "player_availability table for injury status tracking"
    - path: "apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js"
      provides: "Injury filter test coverage"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js"
      provides: "Model hardening test coverage"
    - path: "docs/PROP_MARKET_EXPANSION_GUIDE.md"
      provides: "Multi-sport prop expansion guide"
  key_links:
    - from: "pull_nhl_player_shots.js"
      to: "NHL API /player/{id}/landing"
      via: "checkPlayerAvailability — inspect payload.currentTeamRoster.statusCode"
      pattern: "statusCode.*injured|IR|scratched"
    - from: "run_nhl_player_shots_model.js"
      to: "setCurrentRunId"
      via: "Always called in success path regardless of cardsCreated count"
      pattern: "setCurrentRunId.*jobRunId"
    - from: "run_nhl_player_shots_model.js"
      to: "NHL_SOG_1P_CARDS_ENABLED"
      via: "env flag guard before 1P card generation block"
      pattern: "NHL_SOG_1P_CARDS_ENABLED"
---

<objective>
Implement WI-0453 (NHL injury status filtering) and WI-0454 (NHL player shots hardening + multi-sport prop expansion guide) in full.

Purpose: Replace the manual NHL_SOG_EXCLUDE_PLAYER_IDS workaround with automated injury filtering, harden the shots prop pipeline against the 7 known production gaps, and produce a reusable guide for adding new prop markets across sports.

Output: Updated pull/model jobs with injury guards, all 32 teams mapped, deterministic fallback, 1P flag, run_state always updated, canonical game ID helper, opponent factor from team_metrics_cache, migration file, test coverage, and two updated/created docs.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md

Relevant source (read before implementing):
@apps/worker/src/jobs/pull_nhl_player_shots.js
@apps/worker/src/jobs/run_nhl_player_shots_model.js
@docs/NHL_PLAYER_SHOTS_PROP_MARKET.md
@WORK_QUEUE/WI-0454.md
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: WI-0453 — Injury filtering in pull job + model guard + migration</name>
  <files>
    apps/worker/src/jobs/pull_nhl_player_shots.js
    apps/worker/src/jobs/run_nhl_player_shots_model.js
    packages/data/db/migrations/030_add_player_availability.sql
    apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js
    apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
  </files>
  <behavior>
    - pull_nhl_player_shots: fetchPlayerLanding returns payload; check payload.currentTeamRoster?.statusCode or payload.status field; statuses that mean skip: "injured", "IR", "LTIR", "Injured Reserve", "scratched", "suspended", "inactive" (case-insensitive includes check). Log: "[NHLPlayerShots] Skipping {playerName} ({playerId}): status={status}". NHL_SOG_EXCLUDE_PLAYER_IDS manual override still applies before the status check.
    - pull_nhl_player_shots: if injury status cannot be determined (field absent), proceed normally (fail open).
    - run_nhl_player_shots_model: the existing `l5Games.length < 5` guard at line 160 is the secondary guard — it already covers the "no valid recent logs" case. Add explicit log: "[run-nhl-player-shots-model] Skipping {playerName}: fewer than 5 recent game logs (possible injury/absence)".
    - run_nhl_model.js goalie audit: resolveGoalieState with UNKNOWN starter_state returns adjustment_trust='NEUTRALIZED' per nhl-goalie-state.js line 163. This path is sound. Confirm in test: unknown goalie should NOT cause confidence crash — it neutralizes the goalie driver weight, not zeroes total confidence. Document findings in code comment above resolveGoalieState call.
    - Migration 030: create player_availability table with columns: player_id INTEGER NOT NULL, sport TEXT NOT NULL DEFAULT 'NHL', status TEXT NOT NULL, status_reason TEXT, checked_at TEXT NOT NULL, PRIMARY KEY (player_id, sport). This table is populated by pull_nhl_player_shots for future cross-job status sharing.
    - Tests for pull_nhl_player_shots: mock fetchPlayerLanding to return payload with status='injured'; assert player is skipped and not upserted. Mock payload with no status field; assert player proceeds normally. Mock NHL_SOG_EXCLUDE_PLAYER_IDS with one player id; assert that player is excluded even if status=healthy.
    - Tests for run_nhl_player_shots_model: mock DB query returning a player with only 3 logs (fewer than 5); assert no card is generated and skip log is emitted.
  </behavior>
  <action>
    1. Read pull_nhl_player_shots.js in full before editing.

    2. Add `checkInjuryStatus(payload)` function after `resolvePlayerName`. Inspect `payload?.status` (string) or `payload?.currentTeamRoster?.statusCode` for injury indicators. Return `{ skip: true, reason: statusString }` or `{ skip: false }`. Injury keywords (case-insensitive): "injur", "ir", "ltir", "scratch", "suspend", "inactive". Fail open: if neither field exists, return `{ skip: false }`.

    3. In the player loop inside `pullNhlPlayerShots`, after `fetchPlayerLanding` returns `payload`, call `checkInjuryStatus(payload)`. If `skip: true`, log the skip with playerName resolved via `resolvePlayerName(payload)` and `continue`. Do this AFTER the `excludeIds` check so the manual override still fires first.

    4. Create `packages/data/db/migrations/030_add_player_availability.sql`:
    ```sql
    CREATE TABLE IF NOT EXISTS player_availability (
      player_id INTEGER NOT NULL,
      sport TEXT NOT NULL DEFAULT 'NHL',
      status TEXT NOT NULL,
      status_reason TEXT,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (player_id, sport)
    );
    ```

    5. In `run_nhl_player_shots_model.js`, update the existing `if (l5Games.length < 5) { continue; }` block to log: `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): fewer than 5 recent game logs (possible injury/absence)`.

    6. In `run_nhl_model.js`, add a comment above the `resolveGoalieState` call (line ~1174) documenting the degradation path: "UNKNOWN starter_state → adjustment_trust=NEUTRALIZED → goalie driver weight zeroed, not total confidence. This is the sound path for unconfirmed/injured goalies."

    7. Create `apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js`. Pattern from existing tests (execSync-style or unit-style). Use Jest mocks. Test structure:
       - Mock `fetchPlayerLanding` (jest.mock or inject-style) to return injured payload → assert `upsertPlayerShotLog` not called, console.log contains "Skipping"
       - Mock `fetchPlayerLanding` to return payload with no status field → assert `upsertPlayerShotLog` called
       - Test `NHL_SOG_EXCLUDE_PLAYER_IDS` path: set env var to include player 8478402 → assert skipped before fetch

    8. Create `apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js`. Mock DB to return a player with 3 logs (not 5). Assert no card inserted. Assert log contains "fewer than 5".

    Note: The test files do not yet exist. Write them from scratch using Jest. Import the module under test with dependency injection or use jest.mock for the data layer (require('@cheddar-logic/data')). Mirror the pattern from `run_nba_model.test.js` for DB mock setup.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/pull_nhl_player_shots.test.js --no-coverage 2>&1 | tail -20</automated>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/run_nhl_player_shots_model.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    - pull_nhl_player_shots.js has checkInjuryStatus and logs skipped players by name + status
    - run_nhl_player_shots_model.js logs skip reason when l5Games.length < 5
    - migration 030 file exists with player_availability table DDL
    - Both new test files pass with at least 3 assertions each covering: injury skip, fail-open on missing status, exclude-ids override
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: WI-0454 — 7 hardening gaps in run_nhl_player_shots_model.js</name>
  <files>
    apps/worker/src/jobs/run_nhl_player_shots_model.js
    apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
  </files>
  <behavior>
    - Gap 2: TEAM_ABBREV_TO_NAME must contain all 32 NHL teams. Startup warning if a player's team_abbrev is not found.
    - Gap 3: Synthetic fallback is `Math.round(mu * 2) / 2` (no random). Log: "[synthetic-fallback] line=X is deterministic (no real line available)".
    - Gap 4: opponentFactor sourced from team_metrics_cache via getDatabase(). Query: SELECT shots_against_pg, league_avg_shots_against_pg FROM team_metrics_cache WHERE team_abbrev = ? AND sport = 'nhl'. If both values exist and league_avg > 0: opponentFactor = shots_against_pg / league_avg_shots_against_pg. If query returns nothing, opponentFactor defaults to 1.0 with a debug log.
    - Gap 5: `if (process.env.NHL_SOG_1P_CARDS_ENABLED !== 'true') { /* skip 1P generation */ }` guard wraps entire 1P card block. Default is off.
    - Gap 6: Add `resolveCanonicalGameId(gameId, homeTeam, awayTeam, gameTime, db)` helper. Query game_id_map WHERE espn_game_id = gameId; if found return canonical_game_id. Fallback: query games WHERE LOWER(home_team)=LOWER(homeTeam) AND LOWER(away_team)=LOWER(awayTeam) AND ABS(julianday(game_time_utc) - julianday(?)) < 0.010416 (15 min = 0.010416 days) ORDER BY game_time_utc LIMIT 1; return that game_id. If no match, return original gameId. Call this at the top of the per-game loop to get `resolvedGameId`; use resolvedGameId for card storage (id, gameId fields on card object).
    - Gap 7: Move `setCurrentRunId(jobRunId, 'nhl_props')` out of the `if (cardsCreated > 0)` block. Always call it in the success path (before the final console.log). Keep the try/catch wrapper.
    - Tests: add to existing run_nhl_player_shots_model.test.js — test that setCurrentRunId is called even when 0 cards are created; test that 1P cards are NOT generated when NHL_SOG_1P_CARDS_ENABLED is unset; test that synthetic fallback line equals Math.round(mu * 2) / 2 (deterministic across 10 calls with same mu).
  </behavior>
  <action>
    1. Read run_nhl_player_shots_model.js in full before editing.

    2. Replace the partial TEAM_ABBREV_TO_NAME map with the complete 32-team map:
    ```js
    const TEAM_ABBREV_TO_NAME = {
      ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres',
      CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks',
      COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars',
      DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
      LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens',
      NSH: 'Nashville Predators', NJD: 'New Jersey Devils', NYI: 'New York Islanders',
      NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers',
      PIT: 'Pittsburgh Penguins', SEA: 'Seattle Kraken', SJS: 'San Jose Sharks',
      STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs',
      UTA: 'Utah Hockey Club', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights',
      WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
    };
    ```
    Add startup warning in the per-player loop: if `player.team_abbrev` is defined but not in TEAM_ABBREV_TO_NAME, log `[${JOB_NAME}] WARN: team_abbrev '${player.team_abbrev}' not found in TEAM_ABBREV_TO_NAME map — player ${player.player_name} may not match any game`.

    3. Add `resolveCanonicalGameId(gameId, homeTeam, awayTeam, gameTime, db)` function before `runNHLPlayerShotsModel`. Try game_id_map first (table may not exist — wrap in try/catch). Fallback: time+team proximity match in games table. Return original gameId on any error.

    4. In the per-game loop, at top: `const resolvedGameId = resolveCanonicalGameId(gameId, homeTeam, awayTeam, game.game_time_utc, db);`. Use `resolvedGameId` in all card `id` and `gameId` fields (replace all `gameId` references in card object with `resolvedGameId`).

    5. Replace synthetic fallback lines:
       - Full game: `Math.round((mu + (Math.random() - 0.5) * 1.0) * 2) / 2` → `Math.round(mu * 2) / 2`
       - 1P: `Math.round((mu1p + (Math.random() - 0.5) * 0.5) * 2) / 2` → `Math.round(mu1p * 2) / 2`
       - After each synthetic assignment add: `console.log(\`[synthetic-fallback] line=${marketLine} is deterministic (no real line available)\`);`

    6. Add opponentFactor derivation. After resolving `resolvedGameId` and before calling `calcMu`, determine the opponent team for this player (if player is home team, opponent = awayTeam abbrev, and vice versa). Query:
    ```sql
    SELECT shots_against_pg, league_avg_shots_against_pg
    FROM team_metrics_cache
    WHERE LOWER(team_abbrev) = LOWER(?) AND LOWER(sport) = 'nhl'
    LIMIT 1
    ```
    If row found and `league_avg_shots_against_pg > 0`: `opponentFactor = row.shots_against_pg / row.league_avg_shots_against_pg`. Else `opponentFactor = 1.0` with debug log. Pass computed opponentFactor into `calcMu` and `calcMu1p`. Add `// paceFactor: 1.0 — TODO: source from team pace stats when available (e.g. corsi_for_pct from team_metrics_cache)` comment.

    7. Add 1P flag guard. Before the `if (firstPeriodEdge.tier === 'HOT' || ...)` block, add:
    ```js
    const sog1pEnabled = process.env.NHL_SOG_1P_CARDS_ENABLED === 'true';
    if (!sog1pEnabled) {
      // 1P cards disabled. Set NHL_SOG_1P_CARDS_ENABLED=true to enable.
    }
    ```
    Wrap the entire 1P card creation block in `if (sog1pEnabled) { ... }`.

    8. Move `setCurrentRunId(jobRunId, 'nhl_props')` out of `if (cardsCreated > 0)` block. Place it unconditionally in the success path after `markJobRunSuccess(jobRunId, result)`, inside a try/catch with error log.

    9. Update the test file (from Task 1) to add: test setCurrentRunId is always called, test 1P flag default-off, test deterministic fallback line.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/run_nhl_player_shots_model.test.js --no-coverage 2>&1 | tail -20</automated>
    <automated>node -e "const m = require('./apps/worker/src/jobs/run_nhl_player_shots_model.js'); const keys = Object.keys(require('./apps/worker/src/jobs/run_nhl_player_shots_model.js')); console.log('exports:', keys);" 2>&1 | head -5</automated>
  </verify>
  <done>
    - TEAM_ABBREV_TO_NAME has exactly 32 entries
    - Synthetic fallback uses Math.round(mu * 2) / 2 (no Math.random)
    - 1P card block gated by NHL_SOG_1P_CARDS_ENABLED env flag
    - setCurrentRunId called unconditionally on success
    - resolveCanonicalGameId helper exists and is called per-game
    - opponentFactor queries team_metrics_cache (with 1.0 fallback)
    - Tests pass covering: 0-card run_state update, 1P flag off, deterministic line
  </done>
</task>

<task type="auto">
  <name>Task 3: Docs — PROP_MARKET_EXPANSION_GUIDE.md + NHL_PLAYER_SHOTS_PROP_MARKET.md update</name>
  <files>
    docs/PROP_MARKET_EXPANSION_GUIDE.md
    docs/NHL_PLAYER_SHOTS_PROP_MARKET.md
  </files>
  <action>
    1. Read docs/NHL_PLAYER_SHOTS_PROP_MARKET.md in full.

    2. Update NHL_PLAYER_SHOTS_PROP_MARKET.md:
       - Add `NHL_SOG_EXCLUDE_PLAYER_IDS` to the Environment Variables table: "Comma-separated player IDs to skip (manual override — takes precedence over injury check)"
       - Add `NHL_SOG_1P_CARDS_ENABLED` to env vars table: "Set to 'true' to enable 1P card generation (default: false — 1P Odds API market is unreliable)"
       - Add section "## Injury Check" after the Data Flow section:
         "pull_nhl_player_shots checks each player's availability status from the NHL API landing payload before fetching shot logs. Players with status containing 'injur', 'IR', 'LTIR', 'scratch', 'suspend', or 'inactive' are skipped and logged by name and reason. NHL_SOG_EXCLUDE_PLAYER_IDS provides a manual override that skips players before the status check. If the status field is absent from the API response the player proceeds normally (fail-open)."
       - Add section "## 1P Cards" clarifying that 1P lines are almost always synthetic and cards are disabled by default via NHL_SOG_1P_CARDS_ENABLED.

    3. Create docs/PROP_MARKET_EXPANSION_GUIDE.md with these sections:

    ```
    # Prop Market Expansion Guide

    ## Overview
    [Short intro: the 4-file pattern, when to use it, relationship to core model pipeline]

    ## The 4-File Pattern
    Every new player prop market requires exactly these 4 files:
    1. pull_{sport}_{prop}.js — fetches prop lines from Odds API
    2. run_{sport}_{prop}_model.js — reads stat logs, computes projection, generates PROP cards
    3. npm scripts in apps/worker/package.json
    4. docs/{SPORT}_{PROP}_PROP_MARKET.md

    Detail each file's contract: inputs, outputs, env flags, dry-run behavior.

    ## Registration Checklist
    New prop markets MUST be registered or cards will be silently dropped:
    - web/src/app/api/games/route.ts → ACTIVE_SPORT_CARD_TYPE_CONTRACT[SPORT].playProducerCardTypes
    - web/src/app/api/games/route.ts → CORE_RUN_STATE_SPORTS
    - web/src/app/api/cards/route.ts → CORE_RUN_STATE_SPORTS

    ## Odds API Market Keys
    [Full table from WI-0454: NHL SOG, NBA points/rebounds/assists/3s, MLB Ks, NFL pass yds]

    ## Edge Classification Thresholds
    HOT >= 0.8 edge, WATCH >= 0.5 edge are the NHL SOG defaults.
    All new markets must have thresholds backtest-calibrated before going live.
    Do not reuse NHL SOG thresholds without validation.

    ## Token Cost Planning
    Formula: events_per_day × runs_per_day × days_in_season ≈ monthly_token_budget
    Gate all new markets behind {SPORT}_{PROP}_ENABLED=false env flags.
    Example: NHL SOG at 5-8 games/day, 2 runs/day = ~300-500 tokens/month.

    ## Known Limitations (NHL SOG reference implementation)
    - Player list is a static env var (NHL_SOG_PLAYER_IDS) — quarterly review required
    - 1P lines are unreliable from Odds API — disabled by default
    - opponentFactor sourced from team_metrics_cache; defaults to 1.0 if no data
    - paceFactor hardcoded to 1.0 until team pace data is available
    ```

    Write the actual full content (not placeholders). Reference the NHL SOG pipeline as the canonical example throughout.
  </action>
  <verify>
    <automated>test -f /Users/ajcolubiale/projects/cheddar-logic/docs/PROP_MARKET_EXPANSION_GUIDE.md && echo "EXISTS" || echo "MISSING"</automated>
    <automated>grep -c "NHL_SOG_1P_CARDS_ENABLED\|Injury Check" /Users/ajcolubiale/projects/cheddar-logic/docs/NHL_PLAYER_SHOTS_PROP_MARKET.md</automated>
  </verify>
  <done>
    - docs/PROP_MARKET_EXPANSION_GUIDE.md exists with all 5 sections: 4-file pattern, registration checklist, Odds API market keys, edge thresholds, token cost formula
    - NHL_PLAYER_SHOTS_PROP_MARKET.md contains injury check section and NHL_SOG_1P_CARDS_ENABLED env var entry
  </done>
</task>

</tasks>

<verification>
1. `npm --prefix apps/worker test -- src/jobs/__tests__/pull_nhl_player_shots.test.js` passes
2. `npm --prefix apps/worker test -- src/jobs/__tests__/run_nhl_player_shots_model.test.js` passes
3. `grep -c "ANA\|BOS\|WPG\|UTA" apps/worker/src/jobs/run_nhl_player_shots_model.js` returns >= 4 (spot check 4 of 32 teams)
4. `grep "Math.random" apps/worker/src/jobs/run_nhl_player_shots_model.js` returns empty (random removed)
5. `grep "NHL_SOG_1P_CARDS_ENABLED" apps/worker/src/jobs/run_nhl_player_shots_model.js` returns a match
6. `grep "setCurrentRunId" apps/worker/src/jobs/run_nhl_player_shots_model.js` shows call outside the `cardsCreated > 0` conditional
7. `test -f packages/data/db/migrations/030_add_player_availability.sql && echo ok`
8. `test -f docs/PROP_MARKET_EXPANSION_GUIDE.md && echo ok`
</verification>

<success_criteria>
- Players with injury/IR/scratched status from NHL API are automatically skipped in pull_nhl_player_shots, logged by name and reason
- NHL_SOG_EXCLUDE_PLAYER_IDS manual override continues to work (tested)
- run_nhl_player_shots_model.js has all 32 NHL teams mapped and logs startup warning for unknown abbrevs
- Synthetic fallback line is deterministic across runs (no Math.random)
- 1P card generation is off by default (NHL_SOG_1P_CARDS_ENABLED flag)
- setCurrentRunId called on every successful run regardless of card count
- resolveCanonicalGameId helper exists and is called per-game
- opponentFactor derived from team_metrics_cache with 1.0 fallback
- All test files pass
- docs/PROP_MARKET_EXPANSION_GUIDE.md created with full content
- docs/NHL_PLAYER_SHOTS_PROP_MARKET.md updated with injury check step and 1P flag
</success_criteria>

<output>
After completion, create `.planning/quick/39-wi-0453-nhl-injury-status-filtering-and-/39-SUMMARY.md` with:
- What was changed in each file
- Injury check implementation approach (which payload fields are checked)
- Confirmation that all 32 NHL teams are in the map (list any that were uncertain)
- opponentFactor query and fallback behavior documented
- Test coverage summary
- Any gaps explicitly deferred with rationale
</output>
