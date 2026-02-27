---
phase: quick
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/pull_odds_hourly.js
  - apps/worker/src/__tests__/ingest-stable-game-ids.test.js
  - apps/worker/src/__tests__/job-key-audit.test.js
  - packages/odds/src/index.js
  - docs/ARCHITECTURE.md
  - docs/INGEST_PROOF.md
autonomous: true
requirements: [HARDENING-01, HARDENING-02, HARDENING-03, HARDENING-04, HARDENING-05, HARDENING-06]

must_haves:
  truths:
    - "pull_odds_hourly marks job failed if normalizedGames < rawGames * 0.6 for any sport"
    - "skippedMissingFields count is returned in job result"
    - "Stable game ID test passes deterministically across two sequential ingest runs with zero network calls"
    - "Job key audit test validates last 50 job_runs entries against known-good patterns"
    - "packages/odds/src/index.js exports only fetchOdds() with DO NOT WRITE DB HERE comment"
    - "docs/ARCHITECTURE.md documents T-120 tolerance band [115, 125] explicitly"
    - "docs/INGEST_PROOF.md exists with proof commands, expected output, sample output, and troubleshooting"
  artifacts:
    - path: "apps/worker/src/jobs/pull_odds_hourly.js"
      provides: "Contract check: fail job when normalization drops >40% of games"
    - path: "apps/worker/src/__tests__/ingest-stable-game-ids.test.js"
      provides: "Stable game ID regression — deterministic, no network"
    - path: "apps/worker/src/__tests__/job-key-audit.test.js"
      provides: "Job key pattern audit against last 50 job_runs"
    - path: "packages/odds/src/index.js"
      provides: "Explicit adapter API — fetchOdds() only, no DB writes"
    - path: "docs/ARCHITECTURE.md"
      provides: "T-120 tolerance band documented"
    - path: "docs/INGEST_PROOF.md"
      provides: "Runbook with proof commands, expected shape, sample output, troubleshooting"
  key_links:
    - from: "apps/worker/src/jobs/pull_odds_hourly.js"
      to: "packages/odds/src/normalize.js"
      via: "skippedMissingFields returned by normalizeGames"
      pattern: "skippedMissingFields"
    - from: "apps/worker/src/__tests__/ingest-stable-game-ids.test.js"
      to: "apps/worker/src/jobs/pull_odds_hourly.js"
      via: "mocked @cheddar-logic/odds, real DB path"
      pattern: "jest.mock.*@cheddar-logic/odds"
---

<objective>
Pre-ship hardening: six targeted improvements to make the ingest pipeline production-safe with contract guards, regression tests, adapter clarity, and operational documentation.

Purpose: Close the remaining gaps before production cutover — normalization failures are currently silent, game ID stability has no regression test, job key patterns are unvalidated, the adapter API boundary is implicit, T-120 tolerance is undocumented, and ops has no runbook.

Output: Modified pull_odds_hourly.js, two new test files, cleaned-up adapter, two updated/created doc files.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md

# Source files being modified
@apps/worker/src/jobs/pull_odds_hourly.js
@packages/odds/src/index.js
@packages/odds/src/normalize.js
@docs/ARCHITECTURE.md
@MIGRATION.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Contract check + skippedMissingFields in pull_odds_hourly.js</name>
  <files>apps/worker/src/jobs/pull_odds_hourly.js</files>
  <action>
    After the per-sport fetchOdds call returns, add a normalization contract check.

    The fetchOdds call returns `{ games: normalizedGames, errors: fetchErrors }` but does NOT expose rawGames count. To make this check work, update the fetchOdds return in packages/odds/src/index.js to also return `rawCount` (the length of rawGames before normalization). Then in pull_odds_hourly.js:

    1. Destructure `rawCount` from fetchOdds return alongside `games` and `errors`.
    2. Accumulate `skippedMissingFields` per sport: `skippedMissingFields += (rawCount - normalizedGames.length)`.
    3. After each sport's fetchOdds call (before the per-game loop), add the contract check:
       ```js
       if (rawCount > 0 && normalizedGames.length < rawCount * 0.6) {
         console.error(`[PullOdds] CONTRACT VIOLATION: ${sport} normalized ${normalizedGames.length}/${rawCount} games (threshold 60%). Marking job failed.`);
         markJobRunFailure(jobRunId, `Normalization dropped too many games for ${sport}: ${normalizedGames.length}/${rawCount}`);
         return { success: false, jobRunId, jobKey, contractViolation: true, sport, normalizedCount: normalizedGames.length, rawCount };
       }
       ```
    4. Include `skippedMissingFields` in the final success return alongside `gamesUpserted`, `snapshotsInserted`, `errors`.

    In packages/odds/src/index.js: Change the fetchOdds return from `{ games, errors }` to `{ games, errors, rawCount: rawGames.length }`. When rawGames is not an array (error path), return `rawCount: 0`.

    Do NOT change the normalization logic in normalize.js — only surface the counts.
  </action>
  <verify>
    Run: `cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && node -e "const { pullOddsHourly } = require('./src/jobs/pull_odds_hourly'); console.log('module loads OK')"`
    Confirm no syntax errors. Optionally run existing tests: `cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npm test -- --testPathPattern=pull_odds_hourly 2>&1 | tail -20`
  </verify>
  <done>
    pull_odds_hourly.js returns `{ success: false, contractViolation: true }` when normalizedGames < rawGames * 0.6.
    Final success result includes `skippedMissingFields` count.
    packages/odds/src/index.js returns `rawCount` in all code paths.
  </done>
</task>

<task type="auto">
  <name>Task 2: Stable game ID regression test + job key audit test</name>
  <files>
    apps/worker/src/__tests__/ingest-stable-game-ids.test.js
    apps/worker/src/__tests__/job-key-audit.test.js
  </files>
  <action>
    CREATE apps/worker/src/__tests__/ingest-stable-game-ids.test.js:

    Pure deterministic test — no network, no real DB writes. Jest mock for @cheddar-logic/odds.

    ```js
    /**
     * Regression test: stable game IDs across repeated ingest runs.
     * Seeds a fixed normalized payload for 2 games, runs ingest logic twice,
     * asserts game IDs are identical. No network. Pure deterministic.
     */
    'use strict';

    jest.mock('@cheddar-logic/odds', () => ({
      fetchOdds: jest.fn()
    }));

    jest.mock('@cheddar-logic/data', () => ({
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      shouldRunJobKey: jest.fn().mockReturnValue(true),
      upsertGame: jest.fn(),
      insertOddsSnapshot: jest.fn(),
      withDb: jest.fn(async (fn) => fn())
    }));

    const { fetchOdds } = require('@cheddar-logic/odds');
    const { upsertGame } = require('@cheddar-logic/data');
    const { pullOddsHourly } = require('../jobs/pull_odds_hourly');

    const FIXED_GAMES = [
      {
        games: [
          {
            gameId: 'fixed-game-001',
            sport: 'NHL',
            homeTeam: 'Toronto Maple Leafs',
            awayTeam: 'Montreal Canadiens',
            gameTimeUtc: '2026-03-01T00:00:00Z',
            capturedAtUtc: '2026-02-27T12:00:00Z',
            market: {},
            odds: { h2hHome: -150, h2hAway: 130, total: 6.0, spreadHome: -1.5, spreadAway: 1.5, monelineHome: -150, monelineAway: 130 }
          },
          {
            gameId: 'fixed-game-002',
            sport: 'NHL',
            homeTeam: 'Boston Bruins',
            awayTeam: 'Tampa Bay Lightning',
            gameTimeUtc: '2026-03-01T02:00:00Z',
            capturedAtUtc: '2026-02-27T12:00:00Z',
            market: {},
            odds: { h2hHome: -120, h2hAway: 100, total: 5.5, spreadHome: -1.5, spreadAway: 1.5, monelineHome: -120, monelineAway: 100 }
          }
        ],
        errors: [],
        rawCount: 2
      }
    ];

    function mockFetchOddsForSport(sport) {
      if (sport === 'NHL') return FIXED_GAMES[0];
      return { games: [], errors: [], rawCount: 0 };
    }

    describe('Stable Game IDs', () => {
      beforeEach(() => {
        jest.clearAllMocks();
        fetchOdds.mockImplementation(({ sport }) => Promise.resolve(mockFetchOddsForSport(sport)));
      });

      test('game IDs are identical across two sequential ingest runs', async () => {
        // Run 1
        await pullOddsHourly({ jobKey: 'test-run-1' });
        const firstRunCalls = upsertGame.mock.calls.map(call => call[0].id);

        jest.clearAllMocks();
        fetchOdds.mockImplementation(({ sport }) => Promise.resolve(mockFetchOddsForSport(sport)));
        // Re-enable shouldRunJobKey for second run
        require('@cheddar-logic/data').shouldRunJobKey.mockReturnValue(true);

        // Run 2
        await pullOddsHourly({ jobKey: 'test-run-2' });
        const secondRunCalls = upsertGame.mock.calls.map(call => call[0].id);

        // Filter to only NHL games
        const firstNHL = firstRunCalls.filter(id => id.startsWith('game-nhl-'));
        const secondNHL = secondRunCalls.filter(id => id.startsWith('game-nhl-'));

        expect(firstNHL.length).toBe(2);
        expect(secondNHL.length).toBe(2);
        expect(firstNHL.sort()).toEqual(secondNHL.sort());
        expect(firstNHL).toContain('game-nhl-fixed-game-001');
        expect(firstNHL).toContain('game-nhl-fixed-game-002');
      });

      test('game ID format is game-{sport-lower}-{gameId}', async () => {
        await pullOddsHourly({ jobKey: 'test-format-check' });
        const ids = upsertGame.mock.calls.map(call => call[0].id);
        const nhlIds = ids.filter(id => id.startsWith('game-nhl-'));
        nhlIds.forEach(id => {
          expect(id).toMatch(/^game-nhl-[a-z0-9-]+$/);
        });
      });
    });
    ```

    ---

    CREATE apps/worker/src/__tests__/job-key-audit.test.js:

    Queries job_runs and validates jobKey patterns. Uses real DB (initDb) so this is an integration test — run with node directly if Jest DB isolation is a concern, but write as Jest test with describe.

    ```js
    /**
     * Job Key Audit — validates jobKey patterns in last 50 job_runs.
     *
     * Valid patterns:
     *   - null (manual/CLI runs)
     *   - odds|hourly|YYYY-MM-DD|HH
     *   - {sport}|fixed|YYYY-MM-DD|HHmm    (sport = nhl/nba/mlb/nfl)
     *   - {sport}|tminus|{game_id}|{minutes}
     *   - fpl|daily|YYYY-MM-DD
     *   - fpl|deadline|GW{N}|T-{N}h
     */
    'use strict';

    const {
      initDb,
      getDatabase
    } = require('@cheddar-logic/data');

    const VALID_PATTERNS = [
      // odds hourly: odds|hourly|2026-02-27|15
      /^odds\|hourly\|\d{4}-\d{2}-\d{2}\|\d{2}$/,
      // sport fixed: nhl|fixed|2026-02-27|0900
      /^(nhl|nba|mlb|nfl|soccer)\|fixed\|\d{4}-\d{2}-\d{2}\|\d{4}$/,
      // sport tminus: nhl|tminus|game-nhl-2026-02-27-van-sea|120
      /^(nhl|nba|mlb|nfl|soccer)\|tminus\|[a-zA-Z0-9_|-]+\|\d+$/,
      // fpl daily: fpl|daily|2026-02-27
      /^fpl\|daily\|\d{4}-\d{2}-\d{2}$/,
      // fpl deadline: fpl|deadline|GW27|T-24h
      /^fpl\|deadline\|GW\d+\|T-\d+h$/
    ];

    function isValidJobKey(jobKey) {
      if (jobKey === null || jobKey === undefined || jobKey === '') return true;
      return VALID_PATTERNS.some(pattern => pattern.test(jobKey));
    }

    describe('Job Key Audit', () => {
      let db;

      beforeAll(async () => {
        await initDb();
        db = getDatabase();
      });

      test('last 50 job_runs have valid or null jobKey', () => {
        const rows = db.prepare(`
          SELECT id, job_name, job_key, status, started_at
          FROM job_runs
          ORDER BY started_at DESC
          LIMIT 50
        `).all();

        if (rows.length === 0) {
          console.warn('[JobKeyAudit] No job_runs found — skipping pattern assertions');
          return;
        }

        const violations = rows.filter(row => !isValidJobKey(row.job_key));

        if (violations.length > 0) {
          console.error('[JobKeyAudit] Invalid job keys found:');
          violations.forEach(v => {
            console.error(`  id=${v.id} job_name=${v.job_name} job_key=${v.job_key}`);
          });
        }

        expect(violations).toHaveLength(0);
      });

      test('odds ingest job keys include hour bucket (YYYY-MM-DD|HH)', () => {
        const rows = db.prepare(`
          SELECT job_key FROM job_runs
          WHERE job_name = 'pull_odds_hourly'
            AND job_key IS NOT NULL
          ORDER BY started_at DESC
          LIMIT 20
        `).all();

        rows.forEach(({ job_key }) => {
          expect(job_key).toMatch(/^odds\|hourly\|\d{4}-\d{2}-\d{2}\|\d{2}$/);
        });
      });

      test('sport model job keys include date+window for fixed or game_id+minutes for tminus', () => {
        const rows = db.prepare(`
          SELECT job_name, job_key FROM job_runs
          WHERE job_name IN ('run_nhl_model', 'run_nba_model', 'run_mlb_model', 'run_nfl_model')
            AND job_key IS NOT NULL
          ORDER BY started_at DESC
          LIMIT 30
        `).all();

        rows.forEach(({ job_name, job_key }) => {
          const valid = isValidJobKey(job_key);
          if (!valid) {
            console.error(`  INVALID: job_name=${job_name} job_key=${job_key}`);
          }
          expect(valid).toBe(true);
        });
      });
    });
    ```

    Both files go under apps/worker/src/__tests__/ — matching the existing test convention in that directory.
  </action>
  <verify>
    For stable ID test (mocked, no DB needed):
    `cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npx jest --testPathPattern="ingest-stable-game-ids" --no-coverage 2>&1 | tail -30`

    For job key audit (requires DB):
    `cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npx jest --testPathPattern="job-key-audit" --no-coverage 2>&1 | tail -30`

    Both must exit with status 0 and show PASS.
  </verify>
  <done>
    ingest-stable-game-ids.test.js passes: IDs are identical across both runs, format assertions hold.
    job-key-audit.test.js passes: last 50 job_runs all have null or a pattern-matching jobKey (with a no-op skip if DB is empty).
  </done>
</task>

<task type="auto">
  <name>Task 3: Adapter cleanup, T-120 docs, and INGEST_PROOF.md runbook</name>
  <files>
    packages/odds/src/index.js
    docs/ARCHITECTURE.md
    docs/INGEST_PROOF.md
  </files>
  <action>
    PART A — packages/odds/src/index.js adapter cleanup:

    Add the following comment block at the very top of the file (before the existing JSDoc block):

    ```js
    /**
     * ============================================================
     * ADAPTER API — PUBLIC CONTRACT
     * ============================================================
     * Export: fetchOdds({ sport, hoursAhead })
     *
     * DO NOT WRITE DB HERE.
     * This package fetches and normalizes odds only.
     * DB persistence is the responsibility of pull_odds_hourly.js.
     * ============================================================
     */
    ```

    Ensure module.exports contains ONLY `{ fetchOdds }`. If any other functions are exported, remove them. (Currently it exports only fetchOdds — confirm and leave it.)

    PART B — docs/ARCHITECTURE.md T-120 docs:

    Find the section "### Betting Engine Scheduling" (around line 195). After the line about T-minus tolerance:
    ```
    - Tolerance band: ±5 minutes per window
    ```
    Add these two lines:
    ```
    - T-120 triggers only when `minutes_to_start` is within **[115, 125]** (±5 min tolerance around 120).
    - A game 150 minutes away (outside [115, 125]) should NOT trigger T-120. This is correct behavior.
    ```

    Note: ARCHITECTURE.md is wrapped in a markdown code block starting with ` ```md ` on line 3. Make sure edits are inside that code block, after the tolerance band bullet.

    PART C — Create docs/INGEST_PROOF.md:

    Create the file with the following content exactly:

    ```markdown
    # Ingest Proof Runbook

    Use these commands to verify the odds ingest pipeline is working correctly.

    ---

    ## Proof Commands

    **Command 1: Run one odds ingest cycle**

    ```bash
    cd /path/to/cheddar-logic/apps/worker
    npm run job:pull-odds
    ```

    **Command 2: Verify DB counts after ingest**

    ```bash
    cd /path/to/cheddar-logic/packages/data
    node -e "
    const { initDb, getDatabase } = require('@cheddar-logic/data');
    initDb().then(() => {
      const db = getDatabase();
      const games = db.prepare('SELECT COUNT(*) as n FROM games').get().n;
      const snaps = db.prepare('SELECT COUNT(*) as n FROM odds_snapshots').get().n;
      const jobs  = db.prepare('SELECT COUNT(*) as n FROM job_runs WHERE job_name = ?').get('pull_odds_hourly').n;
      console.log({ games, odds_snapshots: snaps, pull_odds_hourly_runs: jobs });
    });
    "
    ```

    ---

    ## Expected Output Shape

    After a successful ingest, `npm run job:pull-odds` logs:

    ```
    [PullOdds] Starting job run: job-pull-odds-<timestamp>-<id>
    [PullOdds] Recording job start...
    [PullOdds] Fetching odds for: NHL, NBA, MLB, NFL
    [PullOdds] Processing NHL...
    [Odds] Fetching NHL (36h horizon)...
    [Odds] Got <N> raw games for NHL
    [PullOdds]   Fetched <N> games
    ...
    [PullOdds] ✅ Job complete: <N> games upserted, <N> snapshots inserted
    ```

    DB count query returns:
    ```json
    { "games": 25, "odds_snapshots": 28, "pull_odds_hourly_runs": 3 }
    ```

    Numbers will grow with each run (snapshots always insert, games upsert idempotently).

    ---

    ## Sample Output (Proof Snapshot — 2026-02-27)

    Source: MIGRATION.md Step D proof snapshot.

    ```
    pullOddsHourly jobKey odds|hourly|test2:
      gamesUpserted: 22
      snapshotsInserted: 22
      success: true

    DB counts after run:
      games: 25
      odds_snapshots: 28
    ```

    ---

    ## Troubleshooting

    ### Failure 1: Provider returned 0 games

    **Symptom:** `[PullOdds] No games returned for <sport>` — gamesUpserted stays 0.

    **Likely causes:**
    - shared-data odds-fetcher cache is stale or empty for that sport
    - `hoursAhead=36` window has no upcoming games (off-season, late night)
    - shared-data module not found at expected path

    **Fix:** Check `packages/odds/src/index.js` path to shared-data:
    ```js
    sharedDataOddsFetcher = require('/path/to/shared-data/lib/odds-fetcher.js');
    ```
    Confirm the file exists and getUpcomingGames returns a non-empty array for the sport.

    ---

    ### Failure 2: Normalization skipped too many games (contract violation)

    **Symptom:** `[PullOdds] CONTRACT VIOLATION: <sport> normalized <N>/<M> games (threshold 60%). Marking job failed.` — job exits with `success: false`.

    **Likely causes:**
    - Provider payload shape changed (missing `home_team`, `away_team`, or `commence_time` fields)
    - A new sport's data format differs from expected schema in normalize.js

    **Fix:** Inspect raw payload from getUpcomingGames. Compare against normalize.js required fields:
    `gameId`, `home_team`, `away_team`, `commence_time`. Update normalize.js field mappings if provider changed.

    ---

    ### Failure 3: DB path mismatch

    **Symptom:** `Error: SQLITE_CANTOPEN: unable to open database file` or games count stays 0 despite successful log output.

    **Likely causes:**
    - packages/data is looking for DB at a path that doesn't exist yet
    - Running from wrong working directory (initDb uses relative path resolution)
    - DB file was deleted or moved

    **Fix:** Run `npm run job:pull-odds` from `apps/worker/` directory (not project root).
    Check packages/data/src/db.js for DB_PATH resolution. Ensure the data directory is writable.
    ```bash
    ls -la /path/to/cheddar-logic/packages/data/db/
    ```
    ```
    ```

    ---

    _Last verified: 2026-02-27. See MIGRATION.md Step D for full proof transcript._
    ```

    Note: Replace all `/path/to/cheddar-logic` placeholders with the actual absolute path if running on a specific machine. The runbook uses relative paths in npm scripts which resolve from the correct working directory.
  </action>
  <verify>
    Adapter: `node -e "const m = require('./packages/odds/src/index.js'); console.log(Object.keys(m))"` from project root — should print `[ 'fetchOdds' ]`.

    Docs: Confirm both files exist:
    - `ls /Users/ajcolubiale/projects/cheddar-logic/docs/INGEST_PROOF.md`
    - grep for T-120 line in ARCHITECTURE.md: `grep -n "115, 125" /Users/ajcolubiale/projects/cheddar-logic/docs/ARCHITECTURE.md`
  </verify>
  <done>
    packages/odds/src/index.js has DO NOT WRITE DB HERE comment at top and exports only fetchOdds.
    docs/ARCHITECTURE.md has T-120 tolerance [115, 125] documented with the "should NOT trigger" clarification.
    docs/INGEST_PROOF.md exists with: two proof commands, expected output shape, 2026-02-27 sample snapshot, three troubleshooting entries.
  </done>
</task>

</tasks>

<verification>
Run all worker tests to confirm nothing regressed:
`cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npm test 2>&1 | tail -40`

Confirm new test files pass individually:
`cd /Users/ajcolubiale/projects/cheddar-logic/apps/worker && npx jest --testPathPattern="ingest-stable-game-ids|job-key-audit" --no-coverage 2>&1 | tail -30`

Verify adapter exports:
`node -e "const m = require('/Users/ajcolubiale/projects/cheddar-logic/packages/odds/src/index.js'); console.log(Object.keys(m))"`

Verify docs exist:
`ls /Users/ajcolubiale/projects/cheddar-logic/docs/INGEST_PROOF.md && echo "OK"`
</verification>

<success_criteria>
- pull_odds_hourly.js logs CONTRACT VIOLATION and returns success:false when normalizedGames < rawGames * 0.6
- skippedMissingFields appears in job result
- ingest-stable-game-ids.test.js: PASS — two runs produce identical game IDs, format is game-{sport-lower}-{gameId}
- job-key-audit.test.js: PASS — last 50 job_runs have null or pattern-matching jobKey
- packages/odds/src/index.js: exports only { fetchOdds }, has DO NOT WRITE DB HERE header
- docs/ARCHITECTURE.md: contains T-120 tolerance [115, 125] with "should NOT trigger" note
- docs/INGEST_PROOF.md: exists with proof commands, expected shape, proof snapshot, 3 troubleshooting entries
</success_criteria>

<output>
After completion, create `.planning/quick/1-pre-ship-hardening-contract-checks-stabl/1-SUMMARY.md`
</output>
