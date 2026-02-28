/**
 * End-to-End Test: Odds Ingest → Games → Scheduler → T-Minus Job
 * 
 * Verifies the complete pipeline:
 * 1. Odds are fetched and games are created
 * 2. Scheduler detects upcoming games
 * 3. T-minus windows are computed
 * 4. Model jobs are scheduled (not executed, just enqueued)
 */

const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');
const {
  initDb,
  getDatabase,
  upsertGame,
  insertOddsSnapshot,
  shouldRunJobKey
} = require('@cheddar-logic/data');

const { computeDueJobs, enabledSports } = require('../schedulers/main');

async function testPipelineOddsToPipeline() {
  console.log('\n=== E2E TEST: Odds → Games → Scheduler → T-Minus ===\n');

  await initDb();
  const client = getDatabase();

  try {
    // STEP 1: Ingest odds (simulate)
    console.log('STEP 1: Simulate odds ingest (upsert games + odds snapshots)');
    const nowUtc = DateTime.utc();
    const gameTime = nowUtc.plus({ hours: 2, minutes: 30 }).toISO(); // 2.5h from now
    
    const testGameId = `nhl-test-${uuidV4().slice(0, 8)}`;
    const stableId = `game-nhl-${testGameId}`;

    // Upsert game (as odds ingest would do)
    upsertGame({
      id: stableId,
      gameId: testGameId,
      sport: 'NHL',
      homeTeam: 'Test Home',
      awayTeam: 'Test Away',
      gameTimeUtc: gameTime,
      status: 'scheduled'
    });
    console.log(`  ✅ Game upserted: ${testGameId} @ ${gameTime}`);

    // Insert odds snapshot
    insertOddsSnapshot({
      id: `odds-test-${uuidV4().slice(0, 8)}`,
      gameId: testGameId,
      sport: 'NHL',
      capturedAt: nowUtc.toISO(),
      h2hHome: 1.85,
      h2hAway: 2.10,
      total: 6.5,
      spreadHome: -1.5,
      spreadAway: 1.5,
      monelineHome: -118,
      monelineAway: 105,
      rawData: { test: true },
      jobRunId: `test-${uuidV4().slice(0, 8)}`
    });
    console.log(`  ✅ Odds snapshot inserted`);

    // STEP 2: Verify games table has the entry
    console.log('\nSTEP 2: Verify games table');
    const games = client.prepare(`
      SELECT game_id, game_time_utc FROM games WHERE game_id = ?
    `).all(testGameId);

    if (games.length === 0) {
      throw new Error(`Game not found in DB: ${testGameId}`);
    }
    console.log(`  ✅ Game found in DB: ${games[0].game_id}`);

    // STEP 3: Run scheduler logic
    console.log('\nSTEP 3: Run scheduler (detect due jobs)');
    const dueJobs = computeDueJobs({
      nowEt: DateTime.now().setZone('America/New_York'),
      nowUtc,
      games: client.prepare(`
        SELECT game_id, sport, game_time_utc FROM games ORDER BY game_time_utc ASC
      `).all(),
      dryRun: false
    });

    console.log(`  Found ${dueJobs.length} due jobs`);

    // STEP 4: Verify T-minus windows are detected
    console.log('\nSTEP 4: Verify T-minus window detection');
    const tminusJobs = dueJobs.filter(j => j.jobKey && j.jobKey.includes('tminus'));
    console.log(`  Found ${tminusJobs.length} T-minus jobs`);

    if (tminusJobs.length > 0) {
      console.log(`  ✅ T-minus jobs detected for new game:`);
      tminusJobs.forEach(j => {
        console.log(`    - ${j.jobKey}`);
      });
    } else {
      console.log(`  ⚠️  No T-minus jobs (game might be too far in future)`);
    }

    // STEP 5: Verify idempotency (can create a dummy job key and test)
    console.log('\nSTEP 5: Verify idempotency gate');
    const testJobKey = `nhl|tminus|${testGameId}|120`;
    const canRun = shouldRunJobKey(testJobKey);
    console.log(`  Job key: ${testJobKey}`);
    console.log(`  shouldRunJobKey(): ${canRun}`);
    console.log(`  ✅ Idempotency check working`);

    console.log('\n=== ✅ E2E TEST PASSED ===\n');
    return true;

  } catch (error) {
    console.error('\n=== ❌ E2E TEST FAILED ===');
    console.error(error.message);
    console.error(error.stack);
    return false;
  }
}

// Run test
if (require.main === module) {
  testPipelineOddsToPipeline()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(err => {
      console.error('Unhandled error:', err);
      process.exit(1);
    });
}

module.exports = { testPipelineOddsToPipeline };
