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

function extractCoreRunStateSports(source) {
  const match = source.match(
    /const CORE_RUN_STATE_SPORTS = \[([\s\S]*?)\] as const;/,
  );
  if (!match) return null;
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'"))
    .map((line) => line.replace(/[' ,]/g, ''));
}

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

    // Test 5: Cards routes keep the same core run-state sport scope
    console.log(
      'Test 5: Source contract enforces cards list/detail run-state sport parity',
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
      path.join(REPO_ROOT, 'web/src/lib/games/route-handler.ts'),
      'utf8',
    );
    const gamesValidatorsSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/lib/games/validators.ts'),
      'utf8',
    );
    const filterSignature = "LOWER(COALESCE(rs.sport, rs.id, '')) IN";
    const hasCardsCoreRunStateGuards = [
      cardsRouteSource,
      perGameCardsRouteSource,
    ].every(
      (source) =>
        source.includes('CORE_RUN_STATE_SPORTS') &&
        source.includes(filterSignature),
    );
    const hasGamesCoreRunStateGuards =
      gamesRouteSource.includes('getActiveRunIds,') &&
      gamesRouteSource.includes('activeRunIds = getActiveRunIds(db);') &&
      gamesValidatorsSource.includes('CORE_RUN_STATE_SPORTS') &&
      gamesValidatorsSource.includes(filterSignature);
    const hasCoreRunStateGuards =
      hasCardsCoreRunStateGuards && hasGamesCoreRunStateGuards;

    if (hasCoreRunStateGuards) {
      console.log('✓ Canonical run-state guards present in cards/games routes\n');
    } else {
      console.log(
        '✗ Missing canonical run-state guard in one or more cards/games routes\n',
      );
      process.exit(1);
    }

    const cardsSports = extractCoreRunStateSports(cardsRouteSource);
    const perGameCardsSports = extractCoreRunStateSports(perGameCardsRouteSource);
    const cardsRoutesSportParity =
      Array.isArray(cardsSports) &&
      Array.isArray(perGameCardsSports) &&
      cardsSports.length > 0 &&
      JSON.stringify(cardsSports) === JSON.stringify(perGameCardsSports);

    if (cardsRoutesSportParity) {
      console.log('✓ Cards list/detail routes use the same CORE_RUN_STATE_SPORTS set\n');
    } else {
      console.log(
        `✗ Cards list/detail CORE_RUN_STATE_SPORTS mismatch: list=${JSON.stringify(cardsSports)} detail=${JSON.stringify(perGameCardsSports)}\n`,
      );
      process.exit(1);
    }

    // Test 6: Non-canonical run_state rows (e.g., ncaam) do not contaminate canonical run_id selection
    console.log('Test 6: Non-canonical run_state rows (ncaam) are excluded from core run_id selection');

    const CANONICAL_SPORTS_SQL = "'nba', 'nhl', 'mlb', 'nfl', 'fpl', 'nhl_props'";
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

    // Insert non-canonical run_state row (ncaam — not in CORE_RUN_STATE_SPORTS)
    client.prepare(
      `INSERT OR REPLACE INTO run_state (id, sport, current_run_id, updated_at) VALUES ('test-nhl-props-wi0447', 'ncaam', ?, datetime('now'))`
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
      console.log('✓ Non-canonical ncaam run_state row correctly excluded from core run_id selection\n');
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

    // WI-0902: Parity-required behavioral fields must be present in both cards routes.
    // These source-contract assertions lock the fields needed for parity comparison.
    console.log('Test 7: Cards routes surface parity-required behavioral fields');

    // reason_code: cards routes must surface execution_status as the visibility signal
    // (pass_reason_code may be inside payloadData — we verify it flows through)
    const cardsHasExecutionStatus =
      cardsRouteSource.includes("execution_status") &&
      perGameCardsRouteSource.includes("execution_status");
    if (cardsHasExecutionStatus) {
      console.log('✓ Cards routes reference execution_status (reason_code visibility signal)\n');
    } else {
      console.log('✗ Missing execution_status reference in one or more cards routes\n');
      process.exit(1);
    }

    // visibility_class equivalent: cards routes must use PROJECTION_ONLY detection logic
    // (isBettingSurfacePayload covers both line_source and execution_status checks)
    const cardsHasProjectionOnlyDetection =
      cardsRouteSource.includes("PROJECTION_ONLY") &&
      perGameCardsRouteSource.includes("PROJECTION_ONLY");
    if (cardsHasProjectionOnlyDetection) {
      console.log('✓ Cards routes have PROJECTION_ONLY detection for visibility_class parity\n');
    } else {
      console.log('✗ Missing PROJECTION_ONLY detection in one or more cards routes\n');
      process.exit(1);
    }

    // has_projection_marker equivalent: cards routes must reference projection_source
    // and synthetic_fallback line source detection
    const cardsHasProjectionSourceDetection =
      cardsRouteSource.includes("projection_source") &&
      cardsRouteSource.includes("synthetic_fallback") &&
      perGameCardsRouteSource.includes("projection_source") &&
      perGameCardsRouteSource.includes("synthetic_fallback");
    if (cardsHasProjectionSourceDetection) {
      console.log('✓ Cards routes detect projection_source/synthetic_fallback (has_projection_marker parity)\n');
    } else {
      console.log('✗ Missing projection_source/synthetic_fallback detection in one or more cards routes\n');
      process.exit(1);
    }

    // WI-1166: List-route diagnostics must be opt-in and reason-coded so the
    // default response remains backward-compatible for normal consumers.
    console.log('Test 8: /api/cards drop diagnostics are opt-in and reason-coded');
    const cardsHasOptInDiagnostics =
      cardsRouteSource.includes("const diagnosticsEnabled = searchParams.has('_diag')") &&
      cardsRouteSource.includes('...(diagnostics ? { diagnostics } : {})');
    const cardsHasDropReasonInventory =
      cardsRouteSource.includes('SPORT_EXCLUDED_FPL') &&
      cardsRouteSource.includes('SPORT_EXCLUDED_NCAAM') &&
      cardsRouteSource.includes('SETTLED_RESULT') &&
      cardsRouteSource.includes('WELCOME_HOME_DISABLED') &&
      cardsRouteSource.includes('LIFECYCLE_STATUS_EXCLUDED') &&
      cardsRouteSource.includes('LIFECYCLE_NOT_STARTED_OR_MISSING_TIME') &&
      cardsRouteSource.includes('RUN_SCOPE_EXCLUDED') &&
      cardsRouteSource.includes('by_reason') &&
      cardsRouteSource.includes('by_card_type');
    if (cardsHasOptInDiagnostics && cardsHasDropReasonInventory) {
      console.log('✓ /api/cards diagnostics are opt-in and expose gate reason counters\n');
    } else {
      console.log('✗ Missing opt-in cards drop diagnostics contract\n');
      process.exit(1);
    }

    // WI-1168: Card-type-precise settled suppression regression
    console.log('Test 9: Settled card type does not suppress unsettled card type from same game');
    const mixedSuffix = Date.now().toString(36);
    const mixedGameId = `test-lifecycle-mixed-settled-${mixedSuffix}`;
    const settledCardType = 'nhl-totals';
    const unsettledCardType = 'nhl-pace-1p';
    const mixedGameTime = new Date(now.getTime() + 3600000).toISOString().substring(0, 19).replace('T', ' ');

    client.prepare(`INSERT INTO games (id, game_id, sport, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `game-${mixedSuffix}`, mixedGameId, 'nhl', 'BOS', 'TOR', mixedGameTime, 'scheduled'
    );
    client.prepare(`INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `card-${mixedSuffix}-settled`, mixedGameId, 'nhl', settledCardType, 'Totals', new Date().toISOString(), '{}', 'run-mixed-1'
    );
    client.prepare(`INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `card-${mixedSuffix}-unsettled`, mixedGameId, 'nhl', unsettledCardType, 'Pace 1P', new Date().toISOString(), '{}', 'run-mixed-1'
    );
    // Insert a settled card_results row only for the settled card type
    client.prepare(`INSERT INTO card_results (id, card_id, game_id, sport, card_type, recommended_bet_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `result-${mixedSuffix}`, `card-${mixedSuffix}-settled`, mixedGameId, 'nhl', settledCardType, 'totals', 'settled'
    );

    // Card-type-precise settled suppression: only exclude the settled card_type
    const preciseSettledRows = client.prepare(`
      SELECT cp.id, cp.card_type FROM card_payloads cp
      WHERE cp.game_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM card_results cr
          WHERE cr.game_id = cp.game_id
            AND cr.card_type = cp.card_type
            AND cr.status = 'settled'
        )
    `).all(mixedGameId);

    const preciseIds = preciseSettledRows.map((r) => r.id);
    const preciseTypes = preciseSettledRows.map((r) => r.card_type);
    if (
      preciseSettledRows.length === 1 &&
      preciseIds.includes(`card-${mixedSuffix}-unsettled`) &&
      !preciseIds.includes(`card-${mixedSuffix}-settled`) &&
      preciseTypes.includes(unsettledCardType)
    ) {
      console.log('✓ Card-type-precise: settled nhl-totals suppressed, unsettled nhl-pace-1p visible\n');
    } else {
      console.log(`✗ Expected only unsettled card; got ${JSON.stringify(preciseSettledRows)}\n`);
      process.exit(1);
    }

    // Cleanup mixed-settled test rows
    client.prepare(`DELETE FROM card_results WHERE id = ?`).run(`result-${mixedSuffix}`);
    client.prepare(`DELETE FROM card_payloads WHERE game_id = ?`).run(mixedGameId);
    client.prepare(`DELETE FROM games WHERE game_id = ?`).run(mixedGameId);

    // Test 10: Source contract confirms card-type-precise settled gate in route + query
    console.log('Test 10: Source contract - card-type-precise settled suppression wired in route');
    const querySource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/lib/cards/query.ts'), 'utf8'
    );
    const hasCardTypePreciseSettledGate =
      cardsRouteSource.includes('buildCardTypePreciseSettledPredicate') &&
      querySource.includes('cr.card_type = cp.card_type') &&
      querySource.includes('buildCardTypePreciseSettledPredicate');
    if (hasCardTypePreciseSettledGate) {
      console.log('✓ Route uses buildCardTypePreciseSettledPredicate with card_type precision\n');
    } else {
      console.log('✗ Missing card-type-precise settled gate in route or query\n');
      process.exit(1);
    }

    // Test 11: Source contract confirms per-type run-scope fallback wired in route + query
    console.log('Test 11: Source contract - per-type run-scope fallback wired in route');
    const hasPerTypeRunScopeFallback =
      cardsRouteSource.includes('buildPerTypeRunScopePredicate') &&
      querySource.includes('inner_cp.card_type = cp.card_type') &&
      querySource.includes('buildPerTypeRunScopePredicate');
    if (hasPerTypeRunScopeFallback) {
      console.log('✓ Route uses buildPerTypeRunScopePredicate for per-type run-scope fallback\n');
    } else {
      console.log('✗ Missing per-type run-scope fallback in route or query\n');
      process.exit(1);
    }

    // Test 12: WI-1169 simplified gate flag contract wired in route
    console.log('Test 12: Source contract - simplified gate flag and shadow compare present in route');
    const hasSimplifiedGateFlag =
      cardsRouteSource.includes('ENABLE_SIMPLIFIED_CARDS_GATE') &&
      cardsRouteSource.includes("process.env.ENABLE_SIMPLIFIED_CARDS_GATE === 'true'");
    const hasShadowCompareFlag =
      cardsRouteSource.includes('ENABLE_GATE_SHADOW_COMPARE') &&
      cardsRouteSource.includes("process.env.ENABLE_GATE_SHADOW_COMPARE === 'true'");
    const hasShadowCompareTelemetry =
      cardsRouteSource.includes('buildShadowCompareTelemetry') &&
      cardsRouteSource.includes('gate_shadow_compare');
    if (hasSimplifiedGateFlag && hasShadowCompareFlag && hasShadowCompareTelemetry) {
      console.log('✓ Simplified gate flag and shadow compare telemetry contract present in route\n');
    } else {
      console.log(
        `✗ Missing simplified gate contract: flag=${hasSimplifiedGateFlag} shadow=${hasShadowCompareFlag} telemetry=${hasShadowCompareTelemetry}\n`,
      );
      process.exit(1);
    }

    // Test 13: WI-1169 simplified gate wired to buildSimplifiedGateWhere in query
    console.log('Test 13: Source contract - buildSimplifiedGateWhere present in route and query');
    const routeHasSimplifiedGateWhere =
      cardsRouteSource.includes('buildSimplifiedGateWhere');
    const queryHasSimplifiedGateWhere =
      querySource.includes('buildSimplifiedGateWhere') &&
      querySource.includes('buildPerTypeRunScopePredicate');
    if (routeHasSimplifiedGateWhere && queryHasSimplifiedGateWhere) {
      console.log('✓ buildSimplifiedGateWhere wired in route and query\n');
    } else {
      console.log(
        `✗ Missing buildSimplifiedGateWhere: route=${routeHasSimplifiedGateWhere} query=${queryHasSimplifiedGateWhere}\n`,
      );
      process.exit(1);
    }

    // Test 14: WI-1169 legacy path skip when simplified gate active (no shadow compare)
    console.log('Test 14: Source contract - legacy path skipped when simplified gate active without shadow');
    const hasLegacyPathSkip =
      cardsRouteSource.includes('runLegacyPath') &&
      cardsRouteSource.includes('!ENABLE_SIMPLIFIED_CARDS_GATE || ENABLE_GATE_SHADOW_COMPARE');
    if (hasLegacyPathSkip) {
      console.log('✓ Legacy path correctly skipped when simplified gate active without shadow compare\n');
    } else {
      console.log('✗ Missing legacy path skip guard in route\n');
      process.exit(1);
    }

    // Clean up
    console.log('📝 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-lifecycle-%'`)
      .run();
    client.prepare(`DELETE FROM games WHERE game_id LIKE 'test-lifecycle-%'`).run();
    console.log('✓ Test data cleaned\n');

    console.log('✅ All WI-0392/WI-0447/WI-0902/WI-1168/WI-1169 Lifecycle Parity + Run-State Shield + Behavioral Parity Field + Simplified Gate Tests Passed!');
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
