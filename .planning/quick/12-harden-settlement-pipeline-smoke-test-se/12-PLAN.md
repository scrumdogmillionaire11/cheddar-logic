---
phase: quick-12
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/settle_game_results.js
  - apps/worker/src/jobs/settle_pending_cards.js
  - apps/worker/src/jobs/__tests__/settle_game_results.test.js
  - apps/worker/src/jobs/__tests__/settle_pending_cards.test.js
autonomous: true
requirements: [SETTLE-01, SETTLE-02, SETTLE-03, SETTLE-04]

must_haves:
  truths:
    - "settle_game_results smoke test passes: teamsMatch handles alias variants, job_runs recorded as success, game_results row written with correct fields"
    - "Team alias map resolves known mismatches (e.g. 'LA Kings' -> 'Los Angeles Kings', 'NY Rangers' -> 'New York Rangers')"
    - "settle_pending_cards smoke test passes: HOME win -> status=settled result=win pnl_units=0.909, AWAY win -> win 0.909, HOME loss -> loss -1.0, PUSH -> push 0.0, NEUTRAL skipped"
    - "Double-settlement guard verified: re-running settlePendingCards on already-settled rows leaves them unchanged"
    - "tracking_stats upserted after settle_pending_cards with correct wins/losses/pushes counts and totalPnlUnits math"
  artifacts:
    - path: "apps/worker/src/jobs/__tests__/settle_game_results.test.js"
      provides: "Smoke tests for ESPN matching, alias map, game_results upsert, job_runs recording"
    - path: "apps/worker/src/jobs/__tests__/settle_pending_cards.test.js"
      provides: "Smoke tests for W/L/push logic, pnl_units math, NEUTRAL skip, double-settlement guard, tracking_stats"
    - path: "apps/worker/src/jobs/settle_game_results.js"
      provides: "Updated with TEAM_ALIAS_MAP used in teamsMatch"
    - path: "apps/worker/src/jobs/settle_pending_cards.js"
      provides: "Unchanged structure — guard verified by test"
  key_links:
    - from: "settle_game_results.js TEAM_ALIAS_MAP"
      to: "teamsMatch() function"
      via: "alias normalization before substring compare"
      pattern: "TEAM_ALIAS_MAP\\[.*\\]"
    - from: "settle_pending_cards.js WHERE status='pending'"
      to: "double-settlement guard"
      via: "SQL filter prevents re-processing settled rows"
      pattern: "status = 'pending'"
    - from: "card_results.pnl_units"
      to: "tracking_stats.total_pnl_units"
      via: "SUM(pnl_units) GROUP BY sport"
      pattern: "SUM\\(pnl_units\\)"
---

<objective>
Harden the settlement pipeline by: (1) adding a team-name alias map to settle_game_results.js for ESPN name matching, (2) writing in-process smoke tests for both settlement jobs using seeded DB data, (3) verifying pnl_units math and the double-settlement guard through explicit test cases.

Purpose: Settlement jobs are untested. Before relying on them in production nightly sweeps, we need smoke test coverage proving W/L/push logic, pnl math, ESPN alias matching, NEUTRAL skip, and idempotency all work correctly.
Output: Two test files that pass under `npm test` in apps/worker, plus the alias map patch to settle_game_results.js.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@apps/worker/src/jobs/settle_game_results.js
@apps/worker/src/jobs/settle_pending_cards.js
@apps/worker/src/jobs/__tests__/run_nhl_model.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add team-name alias map to settle_game_results.js + write smoke test</name>
  <files>
    apps/worker/src/jobs/settle_game_results.js
    apps/worker/src/jobs/__tests__/settle_game_results.test.js
  </files>
  <action>
    PART A — Patch settle_game_results.js:

    Add a TEAM_ALIAS_MAP constant after the ESPN_SPORT_MAP block. This maps short/regional names from our odds-API data to ESPN canonical display names:

    ```js
    /**
     * Team name alias map — resolves common mismatches between odds-API team names
     * and ESPN displayName values. Keys are lowercase. Values are canonical ESPN forms.
     */
    const TEAM_ALIAS_MAP = {
      // NHL
      'la kings':           'los angeles kings',
      'la ducks':           'anaheim ducks',
      'nj devils':          'new jersey devils',
      'ny islanders':       'new york islanders',
      'ny rangers':         'new york rangers',
      'tb lightning':       'tampa bay lightning',
      'vegas golden knights': 'vegas golden knights',
      // NBA
      'la lakers':          'los angeles lakers',
      'la clippers':        'los angeles clippers',
      'ny knicks':          'new york knicks',
      'nola pelicans':      'new orleans pelicans',
      'gs warriors':        'golden state warriors',
      // NCAAM — odds APIs vary widely; add as discovered
    };

    /**
     * Normalize a team name through the alias map (lowercase key lookup).
     * Falls back to original string if no alias found.
     */
    function normalizeTeamName(name) {
      if (!name) return '';
      const lower = name.toLowerCase().trim();
      return TEAM_ALIAS_MAP[lower] || lower;
    }
    ```

    Update the `teamsMatch` function to normalize both names through `normalizeTeamName` before the existing substring/word comparison:

    ```js
    function teamsMatch(ourName, espnName) {
      if (!ourName || !espnName) return false;
      const a = normalizeTeamName(ourName);
      const b = normalizeTeamName(espnName);
      if (a === b) return true;
      if (a.includes(b) || b.includes(a)) return true;
      const espnWords = b.split(/\s+/).filter(w => w.length > 2);
      return espnWords.some(word => a.includes(word));
    }
    ```

    Export `teamsMatch` and `normalizeTeamName` for testability — add to module.exports at the bottom alongside `settleGameResults`:
    ```js
    module.exports = { settleGameResults, teamsMatch, normalizeTeamName };
    ```

    PART B — Write smoke test file:

    Create `apps/worker/src/jobs/__tests__/settle_game_results.test.js`.

    The test has TWO sections:

    Section 1 — Unit tests for teamsMatch + alias map (no DB, no ESPN):
    - Import `{ teamsMatch, normalizeTeamName }` from `../settle_game_results`
    - Test exact match: `teamsMatch('Boston Bruins', 'Boston Bruins')` -> true
    - Test alias: `teamsMatch('LA Kings', 'Los Angeles Kings')` -> true (alias normalizes 'la kings' to 'los angeles kings')
    - Test alias reverse: `teamsMatch('Los Angeles Kings', 'LA Kings')` -> true
    - Test substring: `teamsMatch('Toronto Maple Leafs', 'Maple Leafs')` -> true
    - Test no match: `teamsMatch('Boston Bruins', 'New York Rangers')` -> false
    - Test null safety: `teamsMatch(null, 'Boston Bruins')` -> false
    - Test normalizeTeamName: `normalizeTeamName('NY Rangers')` -> `'new york rangers'`
    - Test normalizeTeamName fallback: `normalizeTeamName('Unknown Team')` -> `'unknown team'` (lowercased, no alias)

    Section 2 — In-process settle_game_results job smoke test with seeded DB:
    Use TEST_DB_PATH = '/tmp/cheddar-settle-games-test.db'.
    Pattern: `initDb()` -> seed games row -> run `settleGameResults()` in-process with mocked ESPN -> verify game_results written.

    Since ESPN is external, use Jest module mocking. Mock `../espn-client` so `espnGet` returns controlled scoreboard data:

    ```js
    // Mock ESPN client before requiring the job
    jest.mock('../../espn-client', () => ({
      espnGet: jest.fn()
    }));
    const { espnGet } = require('../../espn-client');
    ```

    In `beforeAll`:
    - Set `process.env.DATABASE_PATH = TEST_DB_PATH`
    - Delete DB file if exists
    - `await initDb()`
    - Seed one past game into `games` table directly via `db.prepare(...).run(...)`:
      ```js
      db.prepare(`
        INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc)
        VALUES ('game-nhl-test001', 'test001', 'NHL', 'Boston Bruins', 'Toronto Maple Leafs', ?)
      `).run(new Date(Date.now() - 5 * 3600000).toISOString());
      ```
    - Configure espnGet mock to return a minimal scoreboard:
      ```js
      espnGet.mockResolvedValue({
        events: [{
          id: 'espn-evt-1',
          competitions: [{
            status: { type: { completed: true } },
            competitors: [
              { homeAway: 'home', score: '4', team: { displayName: 'Boston Bruins' } },
              { homeAway: 'away', score: '2', team: { displayName: 'Toronto Maple Leafs' } }
            ]
          }]
        }]
      });
      ```

    Tests in Section 2:
    1. `settleGameResults()` returns `{ success: true, gamesSettled: 1 }`
    2. `game_results` table has one row with `game_id='test001'`, `final_score_home=4`, `final_score_away=2`, `status='final'`
    3. `job_runs` has a row with `job_name='settle_game_results'`, `status='success'`
    4. Running `settleGameResults()` again (same DB state, game_results.status='final') produces `gamesSettled: 0` (already settled — excluded by the subquery)

    Teardown: `closeDatabase()` + delete DB file.

    IMPORTANT: Import path from the test file to the job: `require('../settle_game_results')` (one level up from __tests__). Import `@cheddar-logic/data` for `initDb, getDatabase, closeDatabase`.
  </action>
  <verify>
    cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npx jest src/jobs/__tests__/settle_game_results.test.js --no-coverage 2>&1 | tail -20
  </verify>
  <done>
    All tests pass (green). teamsMatch alias tests pass. In-process smoke test confirms game_results row written with correct scores, job_runs recorded as success, re-run produces gamesSettled=0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write smoke test for settle_pending_cards covering W/L/push, pnl math, NEUTRAL skip, double-settlement guard, tracking_stats</name>
  <files>
    apps/worker/src/jobs/__tests__/settle_pending_cards.test.js
  </files>
  <action>
    Create `apps/worker/src/jobs/__tests__/settle_pending_cards.test.js`.

    TEST_DB_PATH = '/tmp/cheddar-settle-cards-test.db'

    Import pattern:
    ```js
    const fs = require('fs');
    const { initDb, getDatabase, closeDatabase, upsertGameResult } = require('@cheddar-logic/data');
    const { settlePendingCards } = require('../settle_pending_cards');
    ```

    Helper to run a DB query:
    ```js
    function queryDb(fn) {
      const db = getDatabase();
      return fn(db);
    }
    ```

    Setup in beforeAll:
    1. `process.env.DATABASE_PATH = TEST_DB_PATH`
    2. Delete DB file if exists
    3. `await initDb()`
    4. Seed directly via `getDatabase().prepare(...).run(...)` — do NOT go through insertCardPayload (it triggers auto-enrollment, but here we need manual control):

    Seed `games` FIRST (required before card_payloads/card_results because both tables declare `FOREIGN KEY (game_id) REFERENCES games(game_id)`):
    ```js
    const PAST = new Date(Date.now() - 5 * 3600000).toISOString();
    const insertGame = db.prepare(`
      INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertGame.run('g-home-win',  'g-home-win',  'NHL', 'Home Team', 'Away Team', PAST);
    insertGame.run('g-home-loss', 'g-home-loss', 'NHL', 'Home Team', 'Away Team', PAST);
    insertGame.run('g-away-win',  'g-away-win',  'NBA', 'Home Team', 'Away Team', PAST);
    insertGame.run('g-push',      'g-push',      'NHL', 'Home Team', 'Away Team', PAST);
    insertGame.run('g-neutral',   'g-neutral',   'NHL', 'Home Team', 'Away Team', PAST);
    ```

    Seed `card_payloads`:
    ```sql
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES
      ('cp-home-win',  'g-home-win',  'NHL', 'driver', 'Test', NOW_ISO, '{"prediction":"HOME","recommended_bet_type":"moneyline"}'),
      ('cp-home-loss', 'g-home-loss', 'NHL', 'driver', 'Test', NOW_ISO, '{"prediction":"HOME","recommended_bet_type":"moneyline"}'),
      ('cp-away-win',  'g-away-win',  'NBA', 'driver', 'Test', NOW_ISO, '{"prediction":"AWAY","recommended_bet_type":"moneyline"}'),
      ('cp-push',      'g-push',      'NHL', 'driver', 'Test', NOW_ISO, '{"prediction":"HOME","recommended_bet_type":"moneyline"}'),
      ('cp-neutral',   'g-neutral',   'NHL', 'driver', 'Test', NOW_ISO, '{"prediction":"NEUTRAL","recommended_bet_type":"moneyline"}')
    ```

    Seed `card_results` (status='pending' for all):
    ```sql
    INSERT INTO card_results (id, card_id, game_id, sport, card_type, recommended_bet_type, status)
    VALUES
      ('cr-home-win',  'cp-home-win',  'g-home-win',  'NHL', 'driver', 'moneyline', 'pending'),
      ('cr-home-loss', 'cp-home-loss', 'g-home-loss', 'NHL', 'driver', 'moneyline', 'pending'),
      ('cr-away-win',  'cp-away-win',  'g-away-win',  'NBA', 'driver', 'moneyline', 'pending'),
      ('cr-push',      'cp-push',      'g-push',      'NHL', 'driver', 'moneyline', 'pending'),
      ('cr-neutral',   'cp-neutral',   'g-neutral',   'NHL', 'driver', 'moneyline', 'pending')
    ```

    Seed `game_results` using `upsertGameResult()` (the exported helper):
    - g-home-win: home=4, away=2, status='final' (HOME wins)
    - g-home-loss: home=1, away=3, status='final' (HOME loses)
    - g-away-win: home=88, away=99, status='final' (AWAY wins, NBA points)
    - g-push: home=3, away=3, status='final' (tie — push)
    - g-neutral: home=5, away=2, status='final' (NEUTRAL card — should be skipped)

    Use `upsertGameResult({ id: 'gr-...', gameId: '...', sport: '...', finalScoreHome: N, finalScoreAway: N, status: 'final', resultSource: 'test', settledAt: new Date().toISOString() })` for each.

    Run: `const result = await settlePendingCards()` once at end of beforeAll.

    Tests (individual `test()` blocks):

    1. "returns success with cardsSettled=4 (NEUTRAL skipped)":
       `expect(result.success).toBe(true); expect(result.cardsSettled).toBe(4)`

    2. "HOME win: status=settled, result=win, pnl_units=0.909":
       Query `card_results WHERE id='cr-home-win'`. Assert `status='settled'`, `result='win'`, `Math.abs(pnl_units - 0.909) < 0.0001`

    3. "HOME loss: status=settled, result=loss, pnl_units=-1.0":
       Query `card_results WHERE id='cr-home-loss'`. Assert `status='settled'`, `result='loss'`, `pnl_units === -1.0`

    4. "AWAY win: status=settled, result=win, pnl_units=0.909":
       Query `card_results WHERE id='cr-away-win'`. Assert `status='settled'`, `result='win'`, `Math.abs(pnl_units - 0.909) < 0.0001`

    5. "PUSH: status=settled, result=push, pnl_units=0.0":
       Query `card_results WHERE id='cr-push'`. Assert `status='settled'`, `result='push'`, `pnl_units === 0.0`

    6. "NEUTRAL card: remains pending (not settled)":
       Query `card_results WHERE id='cr-neutral'`. Assert `status='pending'`

    7. "tracking_stats upserted with correct aggregates":
       Query `tracking_stats WHERE sport='NHL'`. NHL has: home-win(W 0.909), home-loss(L -1.0), push(P 0.0), neutral(skipped) → wins=1, losses=1, pushes=1, totalPnlUnits≈(0.909 + -1.0 + 0.0)=-0.091.
       Assert: `wins=1, losses=1, pushes=1`, `Math.abs(total_pnl_units - (-0.091)) < 0.001`
       Query `tracking_stats WHERE sport='NBA'`: wins=1, losses=0, pushes=0, totalPnlUnits≈0.909.

    8. "double-settlement guard: re-running does NOT change settled rows":
       Run `await settlePendingCards()` a second time. Assert `result2.cardsSettled === 0`. Re-query cr-home-win: still `result='win'`, `pnl_units` unchanged.

    9. "settled_at is set on settled rows":
       Query cr-home-win. Assert `settled_at` is not null and is a valid ISO timestamp.

    10. "job_runs records settle_pending_cards as success":
        Query `job_runs WHERE job_name='settle_pending_cards' AND status='success'`. Assert row exists.

    afterAll: `closeDatabase()` + delete DB file.

    SEEDING NOTE: Since `card_payloads` uses a foreign-key-like pattern but no FK enforcement, direct INSERT is fine. Use `db.prepare(...).run(...)` with `NOW_ISO = new Date().toISOString()` as a JS variable, not SQL NOW(). SQLite does not have NOW() — use string values directly in the JS.

    Do NOT use `execSync` — this entire test is in-process. `settlePendingCards()` is called directly. This avoids needing a real ESPN network connection.
  </action>
  <verify>
    cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npx jest src/jobs/__tests__/settle_pending_cards.test.js --no-coverage 2>&1 | tail -30
  </verify>
  <done>
    All 10 tests pass. pnl_units assertions are within floating-point tolerance. NEUTRAL card remains pending. Double-settlement guard confirmed (second run returns cardsSettled=0). tracking_stats rows exist with correct aggregate math.
  </done>
</task>

</tasks>

<verification>
Run full worker test suite to confirm no regressions:

cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npm test -- --no-coverage 2>&1 | tail -30

Expect: all existing tests still pass + 2 new test files pass.

Also confirm module.exports of settle_game_results.js includes teamsMatch and normalizeTeamName:
grep "module.exports" /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/settle_game_results.js
</verification>

<success_criteria>
- `settle_game_results.test.js` passes: alias map resolves known variants, teamsMatch correct for 6 cases, in-process job smoke test with mocked ESPN writes game_results row, re-run produces gamesSettled=0
- `settle_pending_cards.test.js` passes: all 10 tests green, pnl math correct, NEUTRAL skipped, tracking_stats aggregates correct, double-settlement guard confirmed
- Full `npm test` in apps/worker passes with no regressions
- `teamsMatch` and `normalizeTeamName` exported from settle_game_results.js
</success_criteria>

<output>
After completion, create `.planning/quick/12-harden-settlement-pipeline-smoke-test-se/12-SUMMARY.md` following the summary template.
</output>
