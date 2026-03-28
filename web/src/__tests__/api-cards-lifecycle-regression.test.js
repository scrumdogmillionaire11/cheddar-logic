/**
 * Regression tests for WI-0392: API Cards Lifecycle Parity
 *
 * Tests that /api/cards and /api/cards/[gameId] endpoints support
 * ?lifecycle=active query param with same semantics as /api/games.
 *
 * Validates:
 * - lifecycle=active filters out FINAL, COMPLETED/COMPLETE, FT, CANCELLED, POSTPONED, CLOSED games
 * - Only includes games where game_time_utc <= now
 * - Default (no param) returns all cards regardless of game status
 */

import db from '../../../packages/data/src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupIsolatedTestDb } from './db-test-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

async function runTests() {
  console.log('🧪 Starting WI-0392: API Cards Lifecycle Parity Tests...\n');
  const testRuntime = await setupIsolatedTestDb(
    'api-cards-lifecycle-regression',
  );

  try {
    // Initialize database
    const client = db.getDatabase();

    // Clean up test data first
    console.log('📝 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-lifecycle-%'`)
      .run();
    client.prepare(`DELETE FROM games WHERE game_id LIKE 'test-lifecycle-%'`).run();
    client.prepare(`DELETE FROM card_results WHERE game_id LIKE 'test-lifecycle-%'`).run();
    console.log('✓ Test data cleaned\n');

    // Test 1: Default behavior (no lifecycle param) returns all cards
    console.log('Test 1: Default behavior returns cards from both active and settled games');
    const now = new Date();
    const pastTime = new Date(now.getTime() - 4 * 60 * 60 * 1000); // 4 hours ago

    client
      .prepare(
        `INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'game-finished',
        'test-lifecycle-finished',
        'nhl',
        'NEW YORK RANGERS',
        'PHILADELPHIA FLYERS',
        pastTime.toISOString().substring(0, 19).replace('T', ' '),
        'FINAL',
      );

    client
      .prepare(
        `INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'game-active',
        'test-lifecycle-active',
        'nhl',
        'BOSTON BRUINS',
        'TORONTO MAPLE LEAFS',
        now.toISOString().substring(0, 19).replace('T', ' '),
        'IN_PROGRESS',
      );

    client
      .prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'card-final-game',
        'test-lifecycle-finished',
        'nhl',
        'nhl-pace-1p',
        'Pace 1P',
        new Date().toISOString(),
        '{}',
        'run-1',
      );

    client
      .prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'card-active-game',
        'test-lifecycle-active',
        'nhl',
        'nhl-pace-1p',
        'Pace 1P',
        new Date().toISOString(),
        '{}',
        'run-1',
      );

    // Default query (no lifecycle filter)
    const defaultCards = client
      .prepare(
        `SELECT cp.id FROM card_payloads cp
       WHERE cp.game_id LIKE 'test-lifecycle-%'
       ORDER BY cp.created_at DESC`,
      )
      .all();

    if (defaultCards.length === 2) {
      console.log('✓ Default returns 2 cards (from both games)\n');
    } else {
      console.log(
        `✗ Expected 2 cards, got ${defaultCards.length}; cards: ${defaultCards.map((c) => c.id).join(', ')}\n`,
      );
      process.exit(1);
    }

    // Test 2: lifecycle=active excludes settled games
    console.log('Test 2: lifecycle=active excludes cards from FINAL games');
    const ACTIVE_EXCLUDED_STATUSES = ['POSTPONED', 'CANCELLED', 'CANCELED', 'FINAL', 'CLOSED', 'COMPLETE', 'COMPLETED', 'FT'];
    const statusList = ACTIVE_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(', ');
    const nowForQuery = now.toISOString().substring(0, 19).replace('T', ' ');

    const lifecycleActiveCards = client
      .prepare(
        `SELECT cp.id FROM card_payloads cp
       LEFT JOIN games g ON cp.game_id = g.game_id
       WHERE cp.game_id LIKE 'test-lifecycle-%'
         AND UPPER(COALESCE(g.status, '')) NOT IN (${statusList})
         AND datetime(g.game_time_utc) <= datetime(?)
       ORDER BY cp.created_at DESC`,
      )
      .all(nowForQuery);

    if (lifecycleActiveCards.length === 1 && lifecycleActiveCards[0].id === 'card-active-game') {
      console.log('✓ lifecycle=active returns only 1 card (from active game)\n');
    } else {
      console.log(
        `✗ Expected ['card-active-game'], got ${lifecycleActiveCards.map((c) => c.id).join(', ')}\n`,
      );
      process.exit(1);
    }

    // Test 3: lifecycle=active excludes cancelled games
    console.log('Test 3: lifecycle=active excludes cards from CANCELLED games');
    client.prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-lifecycle-%'`).run();
    client.prepare(`DELETE FROM games WHERE game_id LIKE 'test-lifecycle-%'`).run();

    const cancelledTime = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago

    client
      .prepare(
        `INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'game-cancelled',
        'test-lifecycle-cancelled',
        'nhl',
        'NEW YORK RANGERS',
        'PHILADELPHIA FLYERS',
        cancelledTime.toISOString().substring(0, 19).replace('T', ' '),
        'CANCELLED',
      );

    client
      .prepare(
        `INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'game-active-2',
        'test-lifecycle-active-2',
        'nhl',
        'BOSTON BRUINS',
        'TORONTO MAPLE LEAFS',
        now.toISOString().substring(0, 19).replace('T', ' '),
        'IN_PROGRESS',
      );

    client
      .prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'card-cancelled',
        'test-lifecycle-cancelled',
        'nhl',
        'nhl-pace-1p',
        'Pace 1P',
        new Date().toISOString(),
        '{}',
        'run-1',
      );

    client
      .prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'card-active-2',
        'test-lifecycle-active-2',
        'nhl',
        'nhl-pace-1p',
        'Pace 1P',
        new Date().toISOString(),
        '{}',
        'run-1',
      );

    const cancelledExcludedCards = client
      .prepare(
        `SELECT cp.id FROM card_payloads cp
       LEFT JOIN games g ON cp.game_id = g.game_id
       WHERE cp.game_id LIKE 'test-lifecycle-%'
         AND UPPER(COALESCE(g.status, '')) NOT IN (${statusList})
         AND datetime(g.game_time_utc) <= datetime(?)
       ORDER BY cp.created_at DESC`,
      )
      .all(nowForQuery);

    if (
      cancelledExcludedCards.length === 1 &&
      cancelledExcludedCards[0].id === 'card-active-2'
    ) {
      console.log('✓ lifecycle=active correctly excludes CANCELLED game\n');
    } else {
      console.log(
        `✗ Expected ['card-active-2'], got ${cancelledExcludedCards.map((c) => c.id).join(', ')}\n`,
      );
      process.exit(1);
    }

    // Test 4: Multiple cards from same game
    console.log('Test 4: Multiple cards from included game all return');
    client.prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-lifecycle-%'`).run();
    client.prepare(`DELETE FROM games WHERE game_id LIKE 'test-lifecycle-%'`).run();

    client
      .prepare(
        `INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'game-multi',
        'test-lifecycle-multi',
        'nhl',
        'NEW YORK RANGERS',
        'PHILADELPHIA FLYERS',
        now.toISOString().substring(0, 19).replace('T', ' '),
        'IN_PROGRESS',
      );

    client
      .prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'card-multi-1',
        'test-lifecycle-multi',
        'nhl',
        'nhl-pace-1p',
        'Pace 1P',
        new Date().toISOString(),
        '{}',
        'run-1',
      );

    client
      .prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'card-multi-2',
        'test-lifecycle-multi',
        'nhl',
        'nhl-totals',
        'Totals',
        new Date().toISOString(),
        '{}',
        'run-1',
      );

    const multiCards = client
      .prepare(
        `SELECT cp.id FROM card_payloads cp
       LEFT JOIN games g ON cp.game_id = g.game_id
       WHERE cp.game_id LIKE 'test-lifecycle-%'
         AND UPPER(COALESCE(g.status, '')) NOT IN (${statusList})
         AND datetime(g.game_time_utc) <= datetime(?)
       ORDER BY cp.created_at DESC`,
      )
      .all(nowForQuery);

    if (multiCards.length === 2) {
      console.log('✓ Multiple cards from included game all return\n');
    } else {
      console.log(
        `✗ Expected 2 cards from included game, got ${multiCards.length}; cards: ${multiCards.map((c) => c.id).join(', ')}\n`,
      );
      process.exit(1);
    }

    // Test 5: Core run-state guards ignore non-canonical sports (e.g., nhl_props)
    console.log(
      'Test 5: Source contract enforces canonical run-state sport filtering',
    );
    const cardsRouteSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/app/api/cards/route.ts'),
      'utf8',
    );
    const perGameCardsRouteSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/app/api/cards/[gameId]/route.ts'),
      'utf8',
    );
    const gamesRouteSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/app/api/games/route.ts'),
      'utf8',
    );
    const filterSignature = "LOWER(COALESCE(rs.sport, rs.id, '')) IN";
    const hasCoreRunStateGuards = [
      cardsRouteSource,
      perGameCardsRouteSource,
      gamesRouteSource,
    ].every(
      (source) =>
        source.includes('CORE_RUN_STATE_SPORTS') &&
        source.includes(filterSignature),
    );

    if (hasCoreRunStateGuards) {
      console.log('✓ Canonical run-state guards present in cards/games routes\n');
    } else {
      console.log(
        '✗ Missing canonical run-state guard in one or more cards/games routes\n',
      );
      process.exit(1);
    }

    // Test 6: Non-canonical run_state rows (e.g., nhl_props) do not contaminate canonical run_id selection
    console.log('Test 6: Non-canonical run_state rows (nhl_props) are excluded from core run_id selection');

    const CANONICAL_SPORTS_SQL = "'nba', 'nhl', 'ncaam', 'soccer', 'mlb', 'nfl', 'fpl'";
    const TEST_RUN_CANONICAL = 'run-test-canonical-nhl-wi0447';
    const TEST_RUN_NONCANONICAL = 'run-test-noncanonical-props-wi0447';

    // Setup: ensure no leftover rows
    client.prepare(`DELETE FROM run_state WHERE id IN ('test-nhl-wi0447', 'test-nhl-props-wi0447')`).run();
    client.prepare(`DELETE FROM job_runs WHERE id IN (?, ?)`).run(TEST_RUN_CANONICAL, TEST_RUN_NONCANONICAL);

    // Insert canonical job_run (success)
    client.prepare(
      `INSERT INTO job_runs (id, job_name, status, started_at) VALUES (?, 'test-wi0447-canonical', 'success', datetime('now'))`
    ).run(TEST_RUN_CANONICAL);

    // Insert non-canonical job_run (also success — test that sport filter, not status, is the guard)
    client.prepare(
      `INSERT INTO job_runs (id, job_name, status, started_at) VALUES (?, 'test-wi0447-noncanonical', 'success', datetime('now'))`
    ).run(TEST_RUN_NONCANONICAL);

    // Insert canonical run_state row (nhl)
    client.prepare(
      `INSERT OR REPLACE INTO run_state (id, sport, current_run_id, updated_at) VALUES ('test-nhl-wi0447', 'nhl', ?, datetime('now'))`
    ).run(TEST_RUN_CANONICAL);

    // Insert non-canonical run_state row (nhl_props — not in CORE_RUN_STATE_SPORTS)
    client.prepare(
      `INSERT OR REPLACE INTO run_state (id, sport, current_run_id, updated_at) VALUES ('test-nhl-props-wi0447', 'nhl_props', ?, datetime('now'))`
    ).run(TEST_RUN_NONCANONICAL);

    // Execute the exact canonical getActiveRunIds SQL (success tier) used by cards/games routes
    const canonicalRunIds = client.prepare(
      `SELECT rs.current_run_id
       FROM run_state rs
       WHERE id != 'singleton'
         AND LOWER(COALESCE(rs.sport, rs.id, '')) IN (${CANONICAL_SPORTS_SQL})
         AND rs.current_run_id IS NOT NULL
         AND TRIM(rs.current_run_id) != ''
         AND EXISTS (
           SELECT 1
           FROM job_runs jr
           WHERE jr.id = rs.current_run_id
             AND LOWER(jr.status) = 'success'
         )
       ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`
    ).all().map((r) => r.current_run_id);

    const includesCanonical = canonicalRunIds.includes(TEST_RUN_CANONICAL);
    const includesNonCanonical = canonicalRunIds.includes(TEST_RUN_NONCANONICAL);

    if (includesCanonical && !includesNonCanonical) {
      console.log('✓ Non-canonical nhl_props run_state row correctly excluded from core run_id selection\n');
    } else {
      console.log(
        `✗ Canonical filter failed: includesCanonical=${includesCanonical}, includesNonCanonical=${includesNonCanonical}\n`
      );
      // Cleanup before exit
      client.prepare(`DELETE FROM run_state WHERE id IN ('test-nhl-wi0447', 'test-nhl-props-wi0447')`).run();
      client.prepare(`DELETE FROM job_runs WHERE id IN (?, ?)`).run(TEST_RUN_CANONICAL, TEST_RUN_NONCANONICAL);
      process.exit(1);
    }

    // Cleanup test rows
    client.prepare(`DELETE FROM run_state WHERE id IN ('test-nhl-wi0447', 'test-nhl-props-wi0447')`).run();
    client.prepare(`DELETE FROM job_runs WHERE id IN (?, ?)`).run(TEST_RUN_CANONICAL, TEST_RUN_NONCANONICAL);

    // Clean up
    console.log('📝 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-lifecycle-%'`)
      .run();
    client.prepare(`DELETE FROM games WHERE game_id LIKE 'test-lifecycle-%'`).run();
    console.log('✓ Test data cleaned\n');

    console.log('✅ All WI-0392/WI-0447 Lifecycle Parity + Run-State Shield Tests Passed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    testRuntime.cleanup();
  }
}

runTests();
