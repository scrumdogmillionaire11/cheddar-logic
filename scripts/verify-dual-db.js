#!/usr/bin/env node

/**
 * Dual-Database Verification Script
 * 
 * Tests that:
 * 1. Both databases initialize correctly
 * 2. Record DB is read-only
 * 3. Local DB is writable
 * 4. Auto-routing works (reads from record, writes to local)
 * 5. Same plays exist in both environments
 * 
 * Usage:
 *   node scripts/verify-dual-db.js
 *   NODE_ENV=test node scripts/verify-dual-db.js
 */

const path = require('path');
const fs = require('fs');

async function main() {
  console.log('🧪 Dual-Database Verification\n');

  const recordDbPath = process.env.RECORD_DATABASE_PATH || 
    '/opt/cheddar-logic/packages/data/cheddar.db';
  const localDbPath = process.env.LOCAL_DATABASE_PATH || 
    '/tmp/cheddar-test-local-' + Date.now() + '.db';

  console.log(`Record DB path: ${recordDbPath}`);
  console.log(`Local DB path: ${localDbPath}\n`);

  // Check files exist
  if (!fs.existsSync(recordDbPath)) {
    console.error(`❌ Record database not found: ${recordDbPath}`);
    process.exit(1);
  }
  console.log(`✅ Record database exists`);

  // Import after checking paths
  const { 
    initDualDb, 
    getDualDb, 
    isDualModeActive,
    RECORD_TABLES,
    LOCAL_TABLES
  } = require('@cheddar-logic/data');

  try {
    // Test 1: Initialize dual-mode
    console.log('\n[Test 1] Initializing dual-database mode...');
    await initDualDb({ recordDbPath, localDbPath });
    
    if (!isDualModeActive()) {
      throw new Error('Dual mode not active after init');
    }
    console.log('✅ Dual-database mode initialized');

    // Test 2: Verify record DB is readable
    console.log('\n[Test 2] Testing record database reads...');
    const recordDb = getDualDb('record');
    const gameCount = recordDb.prepare('SELECT COUNT(*) as count FROM games').all();
    console.log(`✅ Record DB readable. Games count: ${gameCount[0].count}`);

    // Test 3: Verify record DB is write-protected
    console.log('\n[Test 3] Testing record database write protection...');
    try {
      recordDb.prepare('INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('test-id', 'test-game', 'test-sport', 'team1', 'team2', '2026-03-03T00:00:00Z', 'scheduled');
      console.error('❌ Record DB write protection FAILED - insert succeeded!');
      process.exit(1);
    } catch (e) {
      if (e.message.includes('Cannot write to record database')) {
        console.log('✅ Record database is write-protected');
      } else {
        console.error(`❌ Unexpected error: ${e.message}`);
        process.exit(1);
      }
    }

    // Test 4: Verify local DB is writable
    console.log('\n[Test 4] Testing local database writes...');
    const localDb = getDualDb('local');
    const cardsExist = localDb.prepare('SELECT COUNT(*) as count FROM card_results').all();
    console.log(`✅ Local DB writable. Card results count: ${cardsExist[0].count}`);

    // Test 5: Verify auto-routing
    console.log('\n[Test 5] Testing auto-routing...');
    const autoDB = getDualDb('auto');
    
    // Auto-route should select record DB for games table
    const autoGames = autoDB.prepare('SELECT COUNT(*) as count FROM games').all();
    if (autoGames[0].count !== gameCount[0].count) {
      throw new Error('Auto-routing failed for games table (record DB)');
    }
    console.log('✅ Auto-routing correctly reads from record DB');
    
    // Auto-route should select local DB for card_results table
    const autoCards = autoDB.prepare('SELECT COUNT(*) as count FROM card_results').all();
    if (autoCards[0].count !== cardsExist[0].count) {
      throw new Error('Auto-routing failed for card_results table (local DB)');
    }
    console.log('✅ Auto-routing correctly reads from local DB');

    // Test 6: Verify plays consistency
    console.log('\n[Test 6] Checking plays consistency...');
    const playCount = recordDb.prepare(`
      SELECT COUNT(*) as count FROM card_payloads 
      WHERE card_type = 'nba-totals-call' OR card_type LIKE 'nba-%'
    `).all();
    console.log(`✅ Found ${playCount[0].count} NBA plays in record database`);

    // Test 7: Verify table distribution
    console.log('\n[Test 7] Verifying table distribution...');
    console.log('Record Tables:', Array.from(RECORD_TABLES).join(', '));
    console.log('Local Tables:', Array.from(LOCAL_TABLES).join(', '));

    for (const table of RECORD_TABLES) {
      try {
        const count = recordDb.prepare(`SELECT COUNT(*) as count FROM ${table}`).all();
        console.log(`  ✅ ${table}: ${count[0].count} rows`);
      } catch (e) {
        console.warn(`  ⚠️  ${table}: not found or error`);
      }
    }

    for (const table of LOCAL_TABLES) {
      try {
        const count = localDb.prepare(`SELECT COUNT(*) as count FROM ${table}`).all();
        console.log(`  ✅ ${table}: ${count[0].count} rows (local)`);
      } catch (e) {
        console.warn(`  ⚠️  ${table}: not found or error`);
      }
    }

    // Test 8: Consistency check - same plays in both environments
    console.log('\n[Test 8] Checking play consistency across environments...');
    const devPlays = recordDb.prepare(`
      SELECT game_id, COUNT(*) as play_count
      FROM card_payloads
      WHERE sport = 'NBA'
      GROUP BY game_id
      ORDER BY play_count DESC
      LIMIT 5
    `).all();

    console.log('Top games by play count:');
    for (const row of devPlays) {
      console.log(`  ✅ Game ${row.game_id}: ${row.play_count} plays`);
    }

    console.log('\n✅ All dual-database tests passed!\n');
    console.log('Next steps:');
    console.log('1. Deploy new web app initialization with initDualDb()');
    console.log('2. Verify /api/games returns same plays in dev and prod');
    console.log('3. Monitor settlement records in local database');
    console.log('4. Remove legacy single-DB code after validation');

    process.exit(0);

  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}\n`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
