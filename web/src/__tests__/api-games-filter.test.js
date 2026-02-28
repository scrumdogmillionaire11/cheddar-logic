/**
 * /api/games Filter Tests
 *
 * Verifies:
 * 1. Games before ET midnight are excluded
 * 2. Games from today (ET) and future are included
 * 3. Seed-style games (fractional-second timestamps) are not in the DB
 * 4. ET midnight computation is DST-aware and produces a valid UTC string
 */

import db from '../../../packages/data/src/db.js';

// ---------------------------------------------------------------------------
// Helper: same ET-midnight logic as the route
// ---------------------------------------------------------------------------
function computeEtMidnightUtc(now = new Date()) {
  const etDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(now);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName').value;
  const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
  const sign = offsetHours < 0 ? '-' : '+';
  const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
  const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
  // Truncate to seconds — matches route.ts behaviour; sub-second precision
  // causes SQLite datetime() comparison to exclude the midnight boundary.
  return localMidnight.toISOString().substring(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Helper: run the same SQL the route uses
// ---------------------------------------------------------------------------
function queryGamesAfterMidnight(client, midnightUtc) {
  return client
    .prepare(
      `SELECT game_id, game_time_utc FROM games
       WHERE datetime(game_time_utc) >= ?
       ORDER BY game_time_utc ASC`
    )
    .all(midnightUtc);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('🧪 Starting /api/games filter tests...\n');
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

  // -------------------------------------------------------------------------
  // Section 1: ET midnight computation
  // -------------------------------------------------------------------------
  console.log('── Section 1: ET midnight computation ──');

  const midnightUtc = computeEtMidnightUtc();
  assert(typeof midnightUtc === 'string', 'computeEtMidnightUtc returns a string');
  assert(!isNaN(new Date(midnightUtc).getTime()), 'Result is a valid date');
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(midnightUtc), 'Format is YYYY-MM-DD HH:MM:SS');

  // ET is UTC-4 (EDT) or UTC-5 (EST); midnight ET = 04:00 or 05:00 UTC
  const utcHour = parseInt(midnightUtc.split(' ')[1].split(':')[0], 10);
  assert(utcHour === 4 || utcHour === 5, `UTC hour is 4 (EDT) or 5 (EST), got ${utcHour}`);

  // DST-specific check: Feb/Mar/Nov are EST (-5); Jun/Jul/Aug are EDT (-4)
  const month = new Date().getMonth() + 1; // 1-indexed
  const isEST = month <= 2 || month === 11 || month === 12; // rough — winter months
  const isEDT = month >= 4 && month <= 10;
  if (isEST) assert(utcHour === 5, 'Winter month: midnight ET = 05:00 UTC (EST)');
  if (isEDT) assert(utcHour === 4, 'Summer month: midnight ET = 04:00 UTC (EDT)');

  console.log();

  // -------------------------------------------------------------------------
  // Section 2: Filter logic — using synthetic test games
  // -------------------------------------------------------------------------
  console.log('── Section 2: Date filter logic ──');

  const TEST_PREFIX = 'test-filter-';
  // Clean up any leftover test data
  client.prepare(`DELETE FROM games WHERE game_id LIKE '${TEST_PREFIX}%'`).run();

  const etMidnight = new Date(midnightUtc.replace(' ', 'T') + 'Z');

  // Build test cases relative to ET midnight
  const testGames = [
    {
      id: `${TEST_PREFIX}yesterday-evening`,
      offset: -4 * 60 * 60 * 1000,      // 4h before midnight ET (yesterday evening)
      expectIncluded: false,
      label: 'Yesterday evening game (4h before ET midnight) excluded',
    },
    {
      id: `${TEST_PREFIX}one-minute-before`,
      offset: -60 * 1000,               // 1 min before midnight ET
      expectIncluded: false,
      label: '1 minute before ET midnight excluded',
    },
    {
      id: `${TEST_PREFIX}at-midnight`,
      offset: 0,                         // exactly midnight ET
      expectIncluded: true,
      label: 'Game at ET midnight included',
    },
    {
      id: `${TEST_PREFIX}early-morning`,
      offset: 4 * 60 * 60 * 1000,       // 4h after ET midnight (early morning today)
      expectIncluded: true,
      label: 'Early morning today (4h after ET midnight) included',
    },
    {
      id: `${TEST_PREFIX}tonight`,
      offset: 19 * 60 * 60 * 1000,      // 7 PM ET
      expectIncluded: true,
      label: 'Tonight (7 PM ET) included',
    },
    {
      id: `${TEST_PREFIX}tomorrow`,
      offset: 30 * 60 * 60 * 1000,      // tomorrow
      expectIncluded: true,
      label: 'Tomorrow included',
    },
  ];

  // Insert test games (minimal row — only required columns)
  for (const g of testGames) {
    const gameTime = new Date(etMidnight.getTime() + g.offset).toISOString();
    client
      .prepare(
        `INSERT OR REPLACE INTO games
           (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
         VALUES (?, 'TEST', ?, 'Home', 'Away', ?, 'scheduled', datetime('now'), datetime('now'))`
      )
      .run(`id-${g.id}`, g.id, gameTime);
  }

  const results = queryGamesAfterMidnight(client, midnightUtc);
  const resultIds = new Set(results.map((r) => r.game_id));

  for (const g of testGames) {
    if (g.expectIncluded) {
      assert(resultIds.has(g.id), g.label);
    } else {
      assert(!resultIds.has(g.id), g.label);
    }
  }

  // Clean up test games
  client.prepare(`DELETE FROM games WHERE game_id LIKE '${TEST_PREFIX}%'`).run();
  console.log();

  // -------------------------------------------------------------------------
  // Section 3: No seed data in production DB
  // -------------------------------------------------------------------------
  console.log('── Section 3: No seed data in DB ──');

  const seedGames = client
    .prepare(`SELECT game_id, game_time_utc FROM games WHERE game_time_utc LIKE '%T%:%:%.___%'`)
    .all();

  assert(
    seedGames.length === 0,
    `No seed-style games (fractional-second timestamps) in DB — found ${seedGames.length}`
  );

  if (seedGames.length > 0) {
    seedGames.forEach((g) =>
      console.error(`    Seed game still present: ${g.game_id} @ ${g.game_time_utc}`)
    );
  }

  // Verify no fake game_id patterns from seed-test-odds.js
  const fakePatterns = ['nhl-2026-02-2', 'nba-2026-02-2', 'soccer-epl-2026-02-2', 'ncaam-2026-02-2'];
  for (const pattern of fakePatterns) {
    const found = client
      .prepare(`SELECT COUNT(*) as c FROM games WHERE game_id LIKE '${pattern}%'`)
      .get();
    assert(found.c === 0, `No fake game_ids matching '${pattern}%' in DB`);
  }

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
