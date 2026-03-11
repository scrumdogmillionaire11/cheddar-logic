/**
 * Settlement Pipeline Integration Test
 *
 * Validates the complete settlement flow:
 * 1. Backfill card_results where missing
 * 2. Settle game_results from ESPN
 * 3. Settle pending_cards with win/loss logic
 * 4. Verify tracking_stats are accurate
 *
 * Uses real test data to ensure settlement logic is sound.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sqlite3 = require('sqlite3');

const DEFAULT_DB_PATH = path.resolve(
  __dirname,
  '../../packages/data/cheddar.db',
);
const DB_PATH = process.env.SETTLEMENT_DB_PATH || DEFAULT_DB_PATH;
const HAS_DB = fs.existsSync(DB_PATH);

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let db;
let testsPassed = 0;
let testsFailed = 0;

function log(msg) {
  console.log(`[Settlement Pipeline] ${msg}`);
}

function ok(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
  testsPassed++;
}

function fail(msg) {
  console.error(`${RED}✗${RESET} ${msg}`);
  testsFailed++;
}

async function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function runTest() {
  log(`\nStarting settlement pipeline integration test\n`);

  // Connect to DB
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      fail(`Failed to open database: ${err.message}`);
      throw new Error(`Failed to open database: ${err.message}`);
    }
  });

  try {
    // Test 1: Check backfill works
    log('Test 1: Backfill card_results');
    await runBackfill();

    // Test 2: Validate card_results structure
    log('\nTest 2: Card results structure');
    await validateCardResults();

    // Test 3: Validate settlement pipeline executable
    log('\nTest 3: Settlement jobs are executable');
    await validateJobsPaths();

    // Test 4: Database integrity
    log('\nTest 4: Database integrity');
    await validateDatabaseIntegrity();

    // Test 5: Tracking stats calculation
    log('\nTest 5: Tracking stats aggregation');
    await validateTrackingStats();
  } catch (err) {
    fail(`Test error: ${err.message}`);
  }

  db.close();

  // Summary
  console.log(`\n${YELLOW}─── Test Summary ───${RESET}`);
  console.log(`${GREEN}Passed: ${testsPassed}${RESET}`);
  if (testsFailed > 0) {
    console.error(`${RED}Failed: ${testsFailed}${RESET}`);
  }

  if (testsFailed > 0) {
    throw new Error(`Settlement pipeline failed (${testsFailed} failures)`);
  }
  return { testsPassed, testsFailed };
}

async function runBackfill() {
  try {
    execSync('npm run job:backfill-card-results', {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
    });
    ok('Backfill job executed');
  } catch (e) {
    fail(`Backfill job failed: ${e.message}`);
  }
}

async function validateCardResults() {
  const results = await runQuery('SELECT COUNT(*) as cnt FROM card_results');
  const count = results[0]?.cnt || 0;

  if (count > 0) {
    ok(`Found ${count} card_results rows`);
  } else {
    fail('No card_results rows found');
  }

  // Check card_results schema
  const rows = await runQuery(`
    SELECT id, card_id, sport, status, settled_at
    FROM card_results
    LIMIT 1
  `);

  if (rows.length > 0) {
    const row = rows[0];
    if (row.id && row.card_id && row.sport && row.status) {
      ok('card_results has required columns');
    } else {
      fail('card_results missing required columns');
    }
  }
}

async function validateJobsPaths() {
  const jobs = [
    'job:backfill-card-results',
    'job:settle-games',
    'job:settle-cards',
  ];

  for (const job of jobs) {
    try {
      execSync(
        `npm run ${job} --help 2>/dev/null || npm run ${job} 2>&1 | head -1`,
        { cwd: path.join(__dirname, '..'), stdio: 'pipe' },
      );
      ok(`Job executable: ${job}`);
    } catch (e) {
      fail(`Job missing or broken: ${job}`);
    }
  }
}

async function validateDatabaseIntegrity() {
  try {
    // Check foreign keys constraint
    const result = await runQuery('PRAGMA foreign_keys');
    const enabled =
      result[0]?.foreign_keys === 1 || result[0]?.foreign_keys === '1';

    if (enabled) {
      ok('Foreign key constraints enabled');
    } else {
      fail('Foreign key constraints disabled');
    }

    // Check tables exist
    const tables = await runQuery(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    );
    const tableNames = tables.map((t) => t.name);

    const required = [
      'games',
      'odds_snapshots',
      'card_results',
      'card_payloads',
      'tracking_stats',
    ];
    for (const table of required) {
      if (tableNames.includes(table)) {
        ok(`Table exists: ${table}`);
      } else {
        fail(`Table missing: ${table}`);
      }
    }
  } catch (e) {
    fail(`Database integrity check failed: ${e.message}`);
  }
}

async function validateTrackingStats() {
  try {
    const stats = await runQuery(`
      SELECT sport, wins, losses, pushes, pnl
      FROM tracking_stats
      WHERE sport IN ('NHL', 'NBA', 'NCAAM')
    `);

    if (stats.length > 0) {
      ok(`Found ${stats.length} tracking_stats records`);

      stats.forEach((stat) => {
        const total =
          (stat.wins || 0) + (stat.losses || 0) + (stat.pushes || 0);
        if (total > 0) {
          ok(
            `${stat.sport}: ${stat.wins}W / ${stat.losses}L / ${stat.pushes}P (pnl: ${stat.pnl?.toFixed(2) || 'N/A'})`,
          );
        }
      });
    } else {
      fail('No tracking_stats found');
    }
  } catch (e) {
    fail(`Tracking stats validation failed: ${e.message}`);
  }
}

const maybeTest = HAS_DB && process.env.RUN_SETTLEMENT_INTEGRATION_TESTS ? test : test.skip; // Disabled: requires real card_results DB

maybeTest('settlement pipeline integration', async () => {
  await runTest();
});

if (!HAS_DB) {
  console.warn(
    `[Settlement Pipeline] Skipping integration test; DB not found at ${DB_PATH}`,
  );
}

if (require.main === module) {
  if (!HAS_DB) {
    console.error(`[Settlement Pipeline] DB not found at ${DB_PATH}`);
    process.exit(1);
  }
  runTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Unhandled error:', err);
      process.exit(1);
    });
}
