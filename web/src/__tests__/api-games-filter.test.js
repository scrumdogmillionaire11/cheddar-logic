/**
 * /api/games lifecycle filter tests
 *
 * Verifies:
 * 1. Default pregame mode excludes started games
 * 2. Active mode includes started games, with status sanity exclusions
 * 3. Derived lifecycle/display fields are present in route contract
 * 4. Settled exclusion remains enforced in route SQL contract
 */

import db from '../../../packages/data/src/db.js';

function toSqlUtc(date) {
  return date.toISOString().substring(0, 19).replace('T', ' ');
}

function queryPreGame(client, startUtc, nowUtc, endUtc = null) {
  return client
    .prepare(
      `SELECT game_id, game_time_utc, status
       FROM games g
       WHERE datetime(g.game_time_utc) >= ?
         AND NOT EXISTS (
           SELECT 1
           FROM card_results cr
           WHERE cr.game_id = g.game_id
             AND cr.status = 'settled'
         )
         AND datetime(g.game_time_utc) > datetime(?)
         ${endUtc ? 'AND datetime(g.game_time_utc) <= ?' : ''}
       ORDER BY g.game_time_utc ASC`,
    )
    .all(...(endUtc ? [startUtc, nowUtc, endUtc] : [startUtc, nowUtc]));
}

function queryActive(client, startUtc, nowUtc, endUtc = null) {
  return client
    .prepare(
      `SELECT game_id, game_time_utc, status
       FROM games g
       WHERE datetime(g.game_time_utc) >= ?
         AND NOT EXISTS (
           SELECT 1
           FROM card_results cr
           WHERE cr.game_id = g.game_id
             AND cr.status = 'settled'
         )
         AND datetime(g.game_time_utc) <= datetime(?)
         AND UPPER(COALESCE(g.status, '')) NOT IN ('POSTPONED', 'CANCELLED', 'CANCELED', 'FINAL', 'CLOSED', 'COMPLETE', 'COMPLETED', 'FT')
         AND NOT EXISTS (
           SELECT 1
           FROM game_results gr
           WHERE gr.game_id = g.game_id
             AND UPPER(COALESCE(gr.status, '')) IN ('FINAL', 'FT', 'COMPLETE', 'COMPLETED', 'CLOSED')
         )
         ${endUtc ? 'AND datetime(g.game_time_utc) <= ?' : ''}
       ORDER BY g.game_time_utc ASC`,
    )
    .all(...(endUtc ? [startUtc, nowUtc, endUtc] : [startUtc, nowUtc]));
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('🧪 Starting /api/games lifecycle filter tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.error(`  ✗ ${label}`);
      failed++;
    }
  }

  await db.initDb();
  const client = db.getDatabase();

  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const fs = fsModule.default || fsModule;
  const path = pathModule.default || pathModule;
  const routePath = path.resolve('src/app/api/games/route.ts');
  const routeSource = fs.readFileSync(routePath, 'utf8');

  console.log('── Section 1: Route contract assertions ──');

  assert(
    routeSource.includes("lifecycle_mode: lifecycleMode") &&
      routeSource.includes('display_status: displayStatus'),
    'route emits derived lifecycle fields (lifecycle_mode/display_status)',
  );
  assert(
    routeSource.includes("cr.status = 'settled'"),
    'route preserves settled exclusion contract',
  );
  assert(
    routeSource.includes('ACTIVE_EXCLUDED_STATUSES'),
    'route defines active-mode non-live status exclusions',
  );
  assert(
    routeSource.includes('FINAL_GAME_RESULT_STATUSES') &&
      routeSource.includes('FROM game_results gr'),
    'route excludes games already finalized in game_results during active mode',
  );
  assert(
    !routeSource.includes('include_started') &&
      !routeSource.includes('active_plays'),
    'route uses canonical lifecycle query param only (legacy aliases removed)',
  );
  assert(
    routeSource.includes("searchParams.get('sport')") &&
      routeSource.includes('AND UPPER(g.sport) = ?'),
    'route applies sport query param as SQL filter in both base window and game rows query',
  );
  assert(
    !routeSource.includes('raw_status:'),
    'route no longer emits raw_status field',
  );
  assert(
    routeSource.includes('activeStartUtc') &&
      routeSource.includes('ACTIVE_LOOKBACK_HOURS') &&
      routeSource.includes("lifecycleMode === 'active' ? activeStartUtc : gamesStartUtc"),
    'route uses rolling activeStartUtc for active mode (not todayUtc) to include late-night in-progress games',
  );

  console.log();

  console.log('── Section 2: Lifecycle query behavior ──');

  const TEST_PREFIX = 'test-filter-';
  // Clean up any leftover test data (delete child rows first due to FK constraints)
  client
    .prepare(`DELETE FROM card_payloads WHERE game_id LIKE '${TEST_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM game_results WHERE game_id LIKE '${TEST_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM games WHERE game_id LIKE '${TEST_PREFIX}%'`)
    .run();

  const now = new Date();
  const nowUtc = toSqlUtc(now);
  const startUtc = toSqlUtc(new Date(now.getTime() - 48 * 60 * 60 * 1000));
  const endUtc = toSqlUtc(new Date(now.getTime() + 48 * 60 * 60 * 1000));

  const testGames = [
    {
      id: `${TEST_PREFIX}future-scheduled`,
      offsetMs: 2 * 60 * 60 * 1000,
      status: 'scheduled',
      expectPreGame: true,
      expectActive: false,
      label: 'Future scheduled game is pregame-only',
    },
    {
      id: `${TEST_PREFIX}past-live`,
      offsetMs: -90 * 60 * 1000,
      status: 'in_progress',
      expectPreGame: false,
      expectActive: true,
      label: 'Started in_progress game is active-only',
    },
    {
      id: `${TEST_PREFIX}past-scheduled`,
      offsetMs: -60 * 60 * 1000,
      status: 'scheduled',
      expectPreGame: false,
      expectActive: true,
      label: 'Started scheduled game is treated as active by time rule',
    },
    {
      id: `${TEST_PREFIX}past-scheduled-final-result`,
      offsetMs: -59 * 60 * 1000,
      status: 'scheduled',
      expectPreGame: false,
      expectActive: false,
      hasFinalGameResult: true,
      label: 'Started scheduled game with final game_results row is excluded from active mode',
    },
    {
      id: `${TEST_PREFIX}past-postponed`,
      offsetMs: -75 * 60 * 1000,
      status: 'postponed',
      expectPreGame: false,
      expectActive: false,
      label: 'Started postponed game is excluded from active mode',
    },
    {
      id: `${TEST_PREFIX}past-cancelled`,
      offsetMs: -70 * 60 * 1000,
      status: 'cancelled',
      expectPreGame: false,
      expectActive: false,
      label: 'Started cancelled game is excluded from active mode',
    },
    {
      id: `${TEST_PREFIX}past-final`,
      offsetMs: -65 * 60 * 1000,
      status: 'final',
      expectPreGame: false,
      expectActive: false,
      label: 'Started final game is excluded from active mode',
    },
    {
      id: `${TEST_PREFIX}past-completed`,
      offsetMs: -64 * 60 * 1000,
      status: 'completed',
      expectPreGame: false,
      expectActive: false,
      label: 'Started completed game is excluded from active mode',
    },
    {
      id: `${TEST_PREFIX}past-ft`,
      offsetMs: -63 * 60 * 1000,
      status: 'ft',
      expectPreGame: false,
      expectActive: false,
      label: 'Started FT game is excluded from active mode',
    },
  ];

  for (const g of testGames) {
    const gameTime = new Date(now.getTime() + g.offsetMs).toISOString();
    client
      .prepare(
        `INSERT OR REPLACE INTO games
           (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
         VALUES (?, 'nhl', ?, 'Home', 'Away', ?, ?, datetime('now'), datetime('now'))`,

      )
      .run(`id-${g.id}`, g.id, gameTime, g.status);

    if (g.hasFinalGameResult) {
      client
        .prepare(
          `INSERT OR REPLACE INTO game_results
             (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
           VALUES (?, ?, 'nhl', 77, 70, 'final', 'manual', datetime('now'), datetime('now'), datetime('now'))`,

        )
        .run(`gr-${g.id}`, g.id);
    }
  }

  const pregameResults = queryPreGame(client, startUtc, nowUtc, endUtc);
  const activeResults = queryActive(client, startUtc, nowUtc, endUtc);
  const pregameIds = new Set(pregameResults.map((r) => r.game_id));
  const activeIds = new Set(activeResults.map((r) => r.game_id));

  for (const g of testGames) {
    if (g.expectPreGame) {
      assert(pregameIds.has(g.id), `${g.label} (pregame)`);
    } else {
      assert(!pregameIds.has(g.id), `${g.label} (pregame)`);
    }

    if (g.expectActive) {
      assert(activeIds.has(g.id), `${g.label} (active)`);
    } else {
      assert(!activeIds.has(g.id), `${g.label} (active)`);
    }
  }

  const impossibleNowUtc = toSqlUtc(
    new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  );
  const activeEmpty = queryActive(client, startUtc, impossibleNowUtc, endUtc);
  assert(activeEmpty.length === 0, 'Active mode can return zero results cleanly');

  client
    .prepare(`DELETE FROM card_payloads WHERE game_id LIKE '${TEST_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM game_results WHERE game_id LIKE '${TEST_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM games WHERE game_id LIKE '${TEST_PREFIX}%'`)
    .run();
  console.log();

  // ── Section 3: Prod-parity regression — late-night game before ET midnight ──
  // Regression for WI-0594: games started before today's ET midnight boundary
  // (e.g. 10pm ET the previous calendar day = ~2-3am UTC today) were excluded
  // from active mode because gamesStartUtc used today's ET midnight as the lower
  // bound. The fix uses a rolling 36h activeStartUtc for active mode.

  console.log('── Section 3: Prod-parity regression — late-night in-progress game ──');

  const PROD_PARITY_PREFIX = 'test-prod-parity-';
  client
    .prepare(`DELETE FROM card_payloads WHERE game_id LIKE '${PROD_PARITY_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM game_results WHERE game_id LIKE '${PROD_PARITY_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM games WHERE game_id LIKE '${PROD_PARITY_PREFIX}%'`)
    .run();

  // Simulate a game that started 20 hours ago (past ET midnight but still live)
  const lateNightGameId = `${PROD_PARITY_PREFIX}late-night-live`;
  const lateNightGameTime = new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString();
  client
    .prepare(
      `INSERT OR REPLACE INTO games
         (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, 'nhl', ?, 'Home', 'Away', ?, 'in_progress', datetime('now'), datetime('now'))`,
    )
    .run(`id-${lateNightGameId}`, lateNightGameId, lateNightGameTime);

  // compute a todayUtc equivalent (midnight today ET, expressed as UTC)
  const etDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(now).find((p) => p.type === 'timeZoneName').value;
  const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
  const absH = Math.abs(offsetHours).toString().padStart(2, '0');
  const signCh = offsetHours < 0 ? '-' : '+';
  const localMidnight = new Date(`${etDateStr}T00:00:00${signCh}${absH}:00`);
  const todayUtcStr = localMidnight.toISOString().substring(0, 19).replace('T', ' ');
  const rollingStartUtc = toSqlUtc(new Date(now.getTime() - 36 * 60 * 60 * 1000));

  // With todayUtc as startUtc: game started 20h ago may fall before midnight ET →
  // must check whether it falls before todayUtcStr
  const activeWithTodayStart = queryActive(client, todayUtcStr, nowUtc, endUtc);
  const activeIdsWithToday = new Set(activeWithTodayStart.map((r) => r.game_id));
  const gameStartedBeforeTodayEt = new Date(lateNightGameTime).getTime() < localMidnight.getTime();

  if (gameStartedBeforeTodayEt) {
    assert(
      !activeIdsWithToday.has(lateNightGameId),
      'Late-night in-progress game (before ET midnight) is MISSING when startUtc=todayUtc [confirms regression exists]',
    );
  }

  // With rolling 36h startUtc: game must appear
  const activeWithRollingStart = queryActive(client, rollingStartUtc, nowUtc, endUtc);
  const activeIdsWithRolling = new Set(activeWithRollingStart.map((r) => r.game_id));
  assert(
    activeIdsWithRolling.has(lateNightGameId),
    'Late-night in-progress game (started 20h ago) IS visible when startUtc=rolling-36h [fix verified]',
  );

  // Ensure final-result game still excluded even with rolling start
  const lateNightFinalId = `${PROD_PARITY_PREFIX}late-night-final`;
  const lateNightFinalTime = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();
  client
    .prepare(
      `INSERT OR REPLACE INTO games
         (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, 'nhl', ?, 'Home', 'Away', ?, 'in_progress', datetime('now'), datetime('now'))`,
    )
    .run(`id-${lateNightFinalId}`, lateNightFinalId, lateNightFinalTime);
  client
    .prepare(
      `INSERT OR REPLACE INTO game_results
         (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, 'nhl', 3, 1, 'final', 'manual', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(`gr-${lateNightFinalId}`, lateNightFinalId);

  const activeWithFinalResult = queryActive(client, rollingStartUtc, nowUtc, endUtc);
  const activeIdsFinalResult = new Set(activeWithFinalResult.map((r) => r.game_id));
  assert(
    !activeIdsFinalResult.has(lateNightFinalId),
    'Late-night game with final game_results is excluded from active even with rolling-36h startUtc',
  );

  client
    .prepare(`DELETE FROM card_payloads WHERE game_id LIKE '${PROD_PARITY_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM game_results WHERE game_id LIKE '${PROD_PARITY_PREFIX}%'`)
    .run();
  client
    .prepare(`DELETE FROM games WHERE game_id LIKE '${PROD_PARITY_PREFIX}%'`)
    .run();
  console.log();

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------
  db.closeDatabase();
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\n❌ Tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed');
  }
}

runTests().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
