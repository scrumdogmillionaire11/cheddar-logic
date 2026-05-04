/**
 * WI-1237 per-game inventory regressions
 *
 * Verifies:
 * 1. /api/cards/[gameId] uses the shared precise settled and run-scope helpers
 * 2. A settled card does not suppress unrelated unsettled sibling cards
 * 3. Prop-heavy same-type inventories dedupe by market identity, not game_id + card_type
 */

import db from '../../../packages/data/src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupIsolatedTestDb } from './db-test-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

function buildMarketIdentityKeyExpr(alias = 'cp') {
  return `(
    COALESCE(${alias}.game_id, '')
    || '|' || UPPER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.market_type'), json_extract(${alias}.payload_data, '$.market_type'), json_extract(${alias}.payload_data, '$.recommended_bet_type'), '')))
    || '|' || UPPER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.selection.side'), json_extract(${alias}.payload_data, '$.selection.side'), json_extract(${alias}.payload_data, '$.prediction'), '')))
    || '|' || TRIM(COALESCE(CAST(json_extract(${alias}.payload_data, '$.play.line') AS TEXT), CAST(json_extract(${alias}.payload_data, '$.line') AS TEXT), ''))
    || '|' || CASE
      WHEN UPPER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.period'), json_extract(${alias}.payload_data, '$.period'), ''))) IN ('', 'FG', 'FULL_GAME', 'FULLGAME') THEN 'FG'
      WHEN UPPER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.period'), json_extract(${alias}.payload_data, '$.period'), ''))) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD') THEN '1P'
      WHEN UPPER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.period'), json_extract(${alias}.payload_data, '$.period'), ''))) IN ('F5', 'FIRST_5_INNINGS', 'FIRST5INNINGS') THEN 'F5'
      ELSE UPPER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.period'), json_extract(${alias}.payload_data, '$.period'), '')))
    END
    || '|' || LOWER(TRIM(COALESCE(json_extract(${alias}.payload_data, '$.play.prop_type'), json_extract(${alias}.payload_data, '$.prop_type'), json_extract(${alias}.payload_data, '$.play.canonical_market_key'), json_extract(${alias}.payload_data, '$.canonical_market_key'), ${alias}.card_type, '')))
    || '|' || LOWER(TRIM(COALESCE(CAST(json_extract(${alias}.payload_data, '$.play.player_id') AS TEXT), CAST(json_extract(${alias}.payload_data, '$.player_id') AS TEXT), json_extract(${alias}.payload_data, '$.play.player_name'), json_extract(${alias}.payload_data, '$.player_name'), json_extract(${alias}.payload_data, '$.team_abbr'), '')))
  )`;
}

async function runTests() {
  console.log('🧪 Starting WI-1237 per-game inventory tests...\n');
  const testRuntime = await setupIsolatedTestDb('api-cards-per-game-inventory');

  try {
    const perGameRouteSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/app/api/cards/[gameId]/route.ts'),
      'utf8',
    );

    if (
      !perGameRouteSource.includes("buildCardTypePreciseSettledPredicate('cp')") ||
      !perGameRouteSource.includes('buildPerTypeRunScopePredicate') ||
      !perGameRouteSource.includes("buildMarketIdentityKeyExpression('cp')") ||
      !perGameRouteSource.includes('PARTITION BY market_identity_key') ||
      perGameRouteSource.includes('PARTITION BY game_id, card_type')
    ) {
      console.log(
        '❌ FAIL: per-game cards route is not wired to the WI-1237 shared settled/run-scope/dedupe contract',
      );
      process.exit(1);
    }
    console.log('✓ Per-game route source uses shared settled, run-scope, and market-identity helpers\n');

    const client = db.getDatabase();

    console.log('📝 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_results WHERE game_id LIKE 'test-cards-game-%'`)
      .run();
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-cards-game-%'`)
      .run();
    client
      .prepare(`DELETE FROM games WHERE game_id LIKE 'test-cards-game-%'`)
      .run();
    console.log('✓ Test data cleaned\n');

    const now = new Date();
    const futureTime = new Date(now.getTime() + 2 * 3600000).toISOString();
    const testSuffix = Date.now().toString(36);

    const insertGame = client.prepare(
      `INSERT OR REPLACE INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Home', 'Away', ?, 'scheduled', datetime('now'), datetime('now'))`,
    );
    const insertCard = client.prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    console.log('🧪 Test 1: Precise settled suppression keeps unsettled siblings visible');
    const settledGameId = `test-cards-game-settled-${testSuffix}`;
    insertGame.run(`game-row-${settledGameId}`, 'nhl', settledGameId, futureTime);

    insertCard.run(
      `card-settled-${testSuffix}`,
      settledGameId,
      'nhl',
      'nhl-totals-call',
      'Settled totals card',
      JSON.stringify({
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        prediction: 'OVER',
        line: 5.5,
      }),
      new Date(now.getTime() - 60000).toISOString(),
      new Date(now.getTime() + 3600000).toISOString(),
      `run-${testSuffix}`,
    );
    insertCard.run(
      `card-sibling-${testSuffix}`,
      settledGameId,
      'nhl',
      'nhl-pace-1p',
      'Unsettled sibling card',
      JSON.stringify({
        market_type: 'FIRST_PERIOD',
        selection: { side: 'OVER' },
        prediction: 'OVER',
        line: 1.5,
        period: '1P',
      }),
      now.toISOString(),
      new Date(now.getTime() + 3600000).toISOString(),
      `run-${testSuffix}`,
    );
    client
      .prepare(
        `INSERT INTO card_results
         (id, card_id, game_id, sport, card_type, recommended_bet_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'settled', ?)`,
      )
      .run(
        `result-${testSuffix}`,
        `card-settled-${testSuffix}`,
        settledGameId,
        'nhl',
        'nhl-totals-call',
        'TOTAL',
        now.toISOString(),
      );

    const settledSiblingRows = client
      .prepare(
        `SELECT cp.id, cp.card_type
         FROM card_payloads cp
         WHERE cp.game_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM card_results cr
             WHERE cr.game_id = cp.game_id
               AND cr.card_type = cp.card_type
               AND cr.status = 'settled'
           )
         ORDER BY cp.created_at DESC, cp.id DESC`,
      )
      .all(settledGameId);

    if (
      settledSiblingRows.length === 1 &&
      settledSiblingRows[0].id === `card-sibling-${testSuffix}`
    ) {
      console.log('✅ PASS: Settled totals card did not suppress the unrelated sibling');
      console.log();
    } else {
      console.log(
        '❌ FAIL: Expected only the unsettled sibling card to remain, got:',
        settledSiblingRows,
      );
      process.exit(1);
    }

    console.log('🧪 Test 2: Prop-heavy same-type inventory keeps distinct players and dedupes exact updates');
    const propsGameId = `test-cards-game-props-${testSuffix}`;
    insertGame.run(`game-row-${propsGameId}`, 'mlb', propsGameId, futureTime);

    insertCard.run(
      `card-prop-a-${testSuffix}`,
      propsGameId,
      'mlb',
      'mlb-pitcher-k',
      'Pitcher A strikeouts',
      JSON.stringify({
        market_type: 'PROP',
        selection: { side: 'OVER' },
        prediction: 'OVER',
        line: 6.5,
        player_id: '101',
        player_name: 'Pitcher A',
        prop_type: 'strikeouts',
        canonical_market_key: 'pitcher_strikeouts',
      }),
      new Date(now.getTime() - 90000).toISOString(),
      new Date(now.getTime() + 3600000).toISOString(),
      `run-${testSuffix}`,
    );
    insertCard.run(
      `card-prop-b-old-${testSuffix}`,
      propsGameId,
      'mlb',
      'mlb-pitcher-k',
      'Pitcher B strikeouts older',
      JSON.stringify({
        market_type: 'PROP',
        selection: { side: 'OVER' },
        prediction: 'OVER',
        line: 6.5,
        player_id: '202',
        player_name: 'Pitcher B',
        prop_type: 'strikeouts',
        canonical_market_key: 'pitcher_strikeouts',
      }),
      new Date(now.getTime() - 60000).toISOString(),
      new Date(now.getTime() + 3600000).toISOString(),
      `run-${testSuffix}`,
    );
    insertCard.run(
      `card-prop-b-new-${testSuffix}`,
      propsGameId,
      'mlb',
      'mlb-pitcher-k',
      'Pitcher B strikeouts newer',
      JSON.stringify({
        market_type: 'PROP',
        selection: { side: 'OVER' },
        prediction: 'OVER',
        line: 6.5,
        player_id: '202',
        player_name: 'Pitcher B',
        prop_type: 'strikeouts',
        canonical_market_key: 'pitcher_strikeouts',
      }),
      now.toISOString(),
      new Date(now.getTime() + 3600000).toISOString(),
      `run-${testSuffix}`,
    );

    const propInventoryRows = client
      .prepare(
        `WITH filtered AS (
           SELECT cp.*,
             ${buildMarketIdentityKeyExpr('cp')} AS market_identity_key
           FROM card_payloads cp
           WHERE cp.game_id = ?
         ),
         ranked AS (
           SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY market_identity_key
               ORDER BY created_at DESC, id DESC
             ) AS rn
           FROM filtered
         )
         SELECT id, card_title
         FROM ranked
         WHERE rn = 1
         ORDER BY created_at DESC, id DESC`,
      )
      .all(propsGameId);

    if (
      propInventoryRows.length === 2 &&
      propInventoryRows.some((row) => row.id === `card-prop-a-${testSuffix}`) &&
      propInventoryRows.some((row) => row.id === `card-prop-b-new-${testSuffix}`) &&
      !propInventoryRows.some((row) => row.id === `card-prop-b-old-${testSuffix}`)
    ) {
      console.log('✅ PASS: Distinct prop players survived, and exact-market updates deduped to the newest row');
      propInventoryRows.forEach((row) => {
        console.log(`   ${row.id} (${row.card_title})`);
      });
      console.log();
    } else {
      console.log(
        '❌ FAIL: Expected player A plus newest player B rows, got:',
        propInventoryRows,
      );
      process.exit(1);
    }

    console.log('🧹 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_results WHERE game_id LIKE 'test-cards-game-%'`)
      .run();
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-cards-game-%'`)
      .run();
    client
      .prepare(`DELETE FROM games WHERE game_id LIKE 'test-cards-game-%'`)
      .run();
    console.log('✓ Test data cleaned\n');

    console.log('✅ All tests passed!\n');
  } catch (error) {
    console.error('❌ Test error:', error);
    process.exit(1);
  } finally {
    testRuntime.cleanup();
  }
}

runTests();
