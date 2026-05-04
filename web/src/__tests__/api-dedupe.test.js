/**
 * API Dedupe Behavior Tests
 *
 * Verifies:
 * 1. Default dedupe returns latest per market identity
 * 2. dedupe=none returns all cards in creation order
 * 3. Distinct same-type markets survive default dedupe
 * 4. Timestamp ties are deterministic via id DESC tie-break
 * 5. Run-scoped query safely falls back when active run has no matching rows
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
  console.log('🧪 Starting API Dedupe Behavior Tests...\n');
  const testRuntime = await setupIsolatedTestDb('api-dedupe');

  try {
    const cardsRouteSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/app/api/cards/route.ts'),
      'utf8',
    );
    const cardsQuerySource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/lib/cards/query.ts'),
      'utf8',
    );

    if (
      !cardsRouteSource.includes("buildMarketIdentityKeyExpression('cp')") ||
      !cardsRouteSource.includes('PARTITION BY market_identity_key') ||
      !cardsQuerySource.includes('export function buildMarketIdentityKeyExpression')
    ) {
      console.log(
        '❌ FAIL: cards route/query do not expose the market_identity_key dedupe contract',
      );
      process.exit(1);
    }
    console.log('✓ Route/query source uses market_identity_key dedupe\n');

    // Initialize database
    const client = db.getDatabase();

    // Clean up test data first
    console.log('📝 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-dedupe-%'`)
      .run();
    client
      .prepare(`DELETE FROM model_outputs WHERE game_id LIKE 'test-dedupe-%'`)
      .run();
    console.log('✓ Test data cleaned\n');

    // Insert test game
    const testSuffix = Date.now().toString(36);
    const testGameId = `test-dedupe-nhl-${testSuffix}`;
    const cardType = 'nhl-model-output';
    const sport = 'nhl'; // Use lowercase to match CHECK constraint
    const runId = `test-run-${testSuffix}`;
    const card1Id = `card-${testSuffix}-1`;
    const card2Id = `card-${testSuffix}-2`;
    const card3Id = `card-${testSuffix}-3`;
    const cardAltId = `card-${testSuffix}-alt-1`;
    const tieGameId = `test-dedupe-nhl-tie-${testSuffix}`;
    const tieCardType = 'nhl-model-output';
    const tieCardLowId = `card-${testSuffix}-tie-a`;
    const tieCardHighId = `card-${testSuffix}-tie-b`;
    const runScopeGameId = `test-dedupe-runscope-${testSuffix}`;
    const runScopeCardId = `card-${testSuffix}-runscope-1`;

    // Insert required game rows first (FK constraint on card_payloads)
    const now = new Date();
    const futureTime = new Date(now.getTime() + 3 * 3600000).toISOString();
    const insertGame = client.prepare(
      `INSERT OR REPLACE INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Home', 'Away', ?, 'scheduled', datetime('now'), datetime('now'))`,
    );
    insertGame.run(`game-row-${testGameId}`, sport, testGameId, futureTime);
    insertGame.run(`game-row-${tieGameId}`, sport, tieGameId, futureTime);
    insertGame.run(`game-row-${runScopeGameId}`, sport, runScopeGameId, futureTime);

    console.log('📋 Inserting test cards...');
    const card1CreatedAt = new Date(now.getTime() - 60000).toISOString(); // 1 min old
    const card2CreatedAt = new Date(now.getTime() - 30000).toISOString(); // 30 sec old
    const card3CreatedAt = now.toISOString(); // just now (latest)

    // Insert three cards for the same game and type with different timestamps
    const payload1 = {
      market_type: 'TOTAL',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 5.5,
      confidence: 0.62,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };

    const payload2 = {
      market_type: 'TOTAL',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 5.5,
      confidence: 0.65,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };

    const payload3 = {
      market_type: 'TOTAL',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 5.5,
      confidence: 0.68,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };

    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card1Id,
        testGameId,
        sport,
        cardType,
        'Test Card 1 (Oldest)',
        JSON.stringify(payload1),
        card1CreatedAt,
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );

    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card2Id,
        testGameId,
        sport,
        cardType,
        'Test Card 2 (Middle)',
        JSON.stringify(payload2),
        card2CreatedAt,
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );

    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card3Id,
        testGameId,
        sport,
        cardType,
        'Test Card 3 (Latest)',
        JSON.stringify(payload3),
        card3CreatedAt,
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );

    console.log(`✓ Inserted 3 cards for game_id: ${testGameId}\n`);

    // Test 1: Default dedupe (should return only latest exact market identity)
    console.log('🧪 Test 1: Default dedupe returns latest exact market identity');
    const dedupeSQL = `
      WITH ranked AS (
        SELECT cp.*,
          ROW_NUMBER() OVER (
            PARTITION BY ${buildMarketIdentityKeyExpr('cp')}
            ORDER BY cp.created_at DESC, cp.id DESC
          ) AS rn
        FROM card_payloads cp
        WHERE cp.game_id = ? AND cp.sport = ?
      )
      SELECT id, card_title, created_at FROM ranked WHERE rn = 1
    `;

    const dedupeResult = client.prepare(dedupeSQL).all(testGameId, sport);
    if (dedupeResult.length === 1 && dedupeResult[0].id === card3Id) {
      console.log(`✅ PASS: Returns only latest card (${card3Id})`);
      console.log(`   Card title: ${dedupeResult[0].card_title}\n`);
    } else {
      console.log(`❌ FAIL: Expected 1 card (${card3Id}), got:`, dedupeResult);
      process.exit(1);
    }

    // Test 2: No dedupe (should return all 3 in reverse creation order)
    console.log('🧪 Test 2: No dedupe (dedupe=none)');
    const noDedupeSQL = `
      SELECT id, card_title, created_at FROM card_payloads
      WHERE game_id = ? AND sport = ?
      ORDER BY created_at DESC, id DESC
    `;

    const noDedupeResult = client.prepare(noDedupeSQL).all(testGameId, sport);
    if (
      noDedupeResult.length === 3 &&
      noDedupeResult[0].id === card3Id &&
      noDedupeResult[1].id === card2Id &&
      noDedupeResult[2].id === card1Id
    ) {
      console.log(
        '✅ PASS: Returns all 3 cards in correct order (latest first)',
      );
      noDedupeResult.forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.card_title} (${r.id})`);
      });
      console.log();
    } else {
      console.log(
        `❌ FAIL: Expected 3 cards in order [${card3Id}, ${card2Id}, ${card1Id}], got:`,
        noDedupeResult,
      );
      process.exit(1);
    }

    // Test 3: Distinct same-type markets should not dedupe together
    console.log(
      '🧪 Test 3: Distinct same-type markets survive default dedupe',
    );
    const altCardType = cardType;
    const altPayload = {
      market_type: 'TOTAL',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 6.5,
      confidence: 0.58,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };
    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cardAltId,
        testGameId,
        sport,
        altCardType,
        'Alt Total 6.5',
        JSON.stringify(altPayload),
        card1CreatedAt,
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );

    const dedupeWithAltSQL = `
      WITH ranked AS (
        SELECT cp.*,
          ROW_NUMBER() OVER (
            PARTITION BY ${buildMarketIdentityKeyExpr('cp')}
            ORDER BY cp.created_at DESC, cp.id DESC
          ) AS rn
        FROM card_payloads cp
        WHERE cp.game_id = ?
      )
      SELECT id, card_type, card_title FROM ranked WHERE rn = 1
      ORDER BY created_at DESC, id DESC
    `;

    const dedupeWithAltResult = client
      .prepare(dedupeWithAltSQL)
      .all(testGameId);
    if (
      dedupeWithAltResult.length === 2 &&
      dedupeWithAltResult.some((r) => r.id === card3Id) &&
      dedupeWithAltResult.some((r) => r.id === cardAltId)
    ) {
      console.log('✅ PASS: Distinct same-type lines survive dedupe');
      dedupeWithAltResult.forEach((r) => {
        console.log(`   ${r.id} (${r.card_title})`);
      });
      console.log();
    } else {
      console.log(
        '❌ FAIL: Expected 2 cards (latest 5.5 + separate 6.5 market), got:',
        dedupeWithAltResult,
      );
      process.exit(1);
    }

    // Test 4: Deterministic tie-break under identical created_at timestamp
    console.log(
      '🧪 Test 4: Deterministic tie-break with identical created_at timestamps',
    );
    const tieCreatedAt = new Date(now.getTime() + 1000).toISOString();
    client
      .prepare(
        `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tieCardLowId,
        tieGameId,
        sport,
        tieCardType,
        'Tie Card A',
        JSON.stringify(payload1),
        tieCreatedAt,
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );
    client
      .prepare(
        `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tieCardHighId,
        tieGameId,
        sport,
        tieCardType,
        'Tie Card B',
        JSON.stringify(payload2),
        tieCreatedAt,
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );
    const tieDedupeResult = client
      .prepare(
        `WITH ranked AS (
           SELECT cp.*,
             ROW_NUMBER() OVER (
               PARTITION BY ${buildMarketIdentityKeyExpr('cp')}
               ORDER BY cp.created_at DESC, cp.id DESC
             ) AS rn
           FROM card_payloads cp
           WHERE cp.game_id = ? AND cp.card_type = ?
         )
         SELECT id FROM ranked WHERE rn = 1`,
      )
      .all(tieGameId, tieCardType);
    if (
      tieDedupeResult.length === 1 &&
      tieDedupeResult[0].id === tieCardHighId
    ) {
      console.log(
        `✅ PASS: Tie-break picks lexicographically higher id (${tieCardHighId})`,
      );
      console.log();
    } else {
      console.log(
        `❌ FAIL: Expected tie winner ${tieCardHighId}, got:`,
        tieDedupeResult,
      );
      process.exit(1);
    }

    // Test 5: Run-scoped fallback behavior mirrors API safety semantics
    console.log(
      '🧪 Test 5: Run-scoped fallback returns base rows when scoped set is empty',
    );
    const activeRunIds = [`active-run-missing-${testSuffix}`];
    client
      .prepare(
        `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runScopeCardId,
        runScopeGameId,
        sport,
        cardType,
        'Run Scope Fallback Card',
        JSON.stringify(payload3),
        now.toISOString(),
        new Date(now.getTime() + 3600000).toISOString(),
        runId,
      );

    const baseWhere = [
      'cp.game_id = ?',
      'cp.sport = ?',
      "(cp.expires_at IS NULL OR datetime(cp.expires_at) > datetime('now'))",
      "cp.sport != 'FPL'",
      "cp.card_type NOT IN ('welcome-home', 'welcome-home-v2')",
    ];
    const baseParams = [runScopeGameId, sport];
    const runIdPlaceholders = activeRunIds.map(() => '?').join(', ');
    const runScopedWhere = [
      ...baseWhere,
      `cp.run_id IN (${runIdPlaceholders})`,
    ];
    const sqlForWhere = (whereSql) => `
      SELECT cp.id
      FROM card_payloads cp
      LEFT JOIN games g ON cp.game_id = g.game_id
      WHERE ${whereSql}
      ORDER BY COALESCE(g.game_time_utc, cp.created_at) ASC, cp.created_at DESC, cp.id DESC
    `;
    const runScopedRows = client
      .prepare(sqlForWhere(runScopedWhere.join(' AND ')))
      .all(...baseParams, ...activeRunIds);
    if (runScopedRows.length !== 0) {
      console.log(
        '❌ FAIL: Expected run-scoped query to return 0 rows, got:',
        runScopedRows,
      );
      process.exit(1);
    }

    const fallbackRows = client
      .prepare(sqlForWhere(baseWhere.join(' AND ')))
      .all(...baseParams);
    if (fallbackRows.length === 1 && fallbackRows[0].id === runScopeCardId) {
      console.log('✅ PASS: Fallback query returned base rows as expected');
      console.log();
    } else {
      console.log(
        `❌ FAIL: Expected fallback row ${runScopeCardId}, got:`,
        fallbackRows,
      );
      process.exit(1);
    }

    // Test 6: Per-type run-scope fallback - active run has type A but not type B
    console.log(
      '🧪 Test 6: Per-type run-scope fallback - both types visible when active run only covers one type',
    );
    const perTypeSuffix = `pt-${testSuffix}`;
    const perTypeGameId = `test-dedupe-pertype-${perTypeSuffix}`;
    const activeRun = `active-run-pertype-${perTypeSuffix}`;
    const oldRun = `old-run-pertype-${perTypeSuffix}`;
    const typeA = 'nhl-totals';
    const typeB = 'nhl-pace-1p';
    const cardTypeAId = `card-${perTypeSuffix}-typeA`;
    const cardTypeBId = `card-${perTypeSuffix}-typeB`;

    insertGame.run(`game-row-${perTypeGameId}`, sport, perTypeGameId, futureTime);

    // typeA card in active run
    client.prepare(`INSERT INTO card_payloads
      (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      cardTypeAId, perTypeGameId, sport, typeA, 'Totals (active run)',
      JSON.stringify(payload1), now.toISOString(), new Date(now.getTime() + 3600000).toISOString(), activeRun,
    );

    // typeB card only in old run (active run has no typeB row for this game)
    client.prepare(`INSERT INTO card_payloads
      (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      cardTypeBId, perTypeGameId, sport, typeB, 'Pace 1P (old run)',
      JSON.stringify(payload2), new Date(now.getTime() - 60000).toISOString(), new Date(now.getTime() + 3600000).toISOString(), oldRun,
    );

    // Per-type fallback predicate: include if in active run OR no active-run row for same game+type
    const activeRunIds2 = [activeRun];
    const runIdPlaceholders2 = activeRunIds2.map(() => '?').join(', ');
    const perTypeSql = `
      WITH ranked AS (
        SELECT cp.*,
          ROW_NUMBER() OVER (
            PARTITION BY ${buildMarketIdentityKeyExpr('cp')}
            ORDER BY cp.created_at DESC, cp.id DESC
          ) AS rn
        FROM card_payloads cp
        WHERE cp.game_id = ?
          AND (
            cp.run_id IN (${runIdPlaceholders2})
            OR NOT EXISTS (
              SELECT 1 FROM card_payloads inner_cp
              WHERE inner_cp.game_id = cp.game_id
                AND inner_cp.card_type = cp.card_type
                AND inner_cp.run_id IN (${runIdPlaceholders2})
            )
          )
      )
      SELECT id, card_type FROM ranked WHERE rn = 1 ORDER BY card_type
    `;

    const perTypeResult = client.prepare(perTypeSql).all(
      perTypeGameId, ...activeRunIds2, ...activeRunIds2,
    );

    if (
      perTypeResult.length === 2 &&
      perTypeResult.some((r) => r.id === cardTypeAId && r.card_type === typeA) &&
      perTypeResult.some((r) => r.id === cardTypeBId && r.card_type === typeB)
    ) {
      console.log(`✅ PASS: Both type A (active run) and type B (fallback) returned`);
      perTypeResult.forEach((r) => console.log(`   ${r.id} (${r.card_type})`));
      console.log();
    } else {
      console.log(`❌ FAIL: Expected both typeA and typeB; got:`, perTypeResult);
      process.exit(1);
    }

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE game_id LIKE 'test-dedupe-%'`)
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
