/*
 * Results endpoint behavioral contract tests
 *
 * Covers three invariants using seeded fixtures and a real isolated Next server:
 *   1. Dedupe: two picks on the same game+market reduce to one ledger row by default;
 *              dedupe=false returns both.
 *   2. Payload-missing visibility: a card_results row without a matching card_payloads
 *              entry still appears in the ledger (payload_data=null is allowed).
 *   3. Settlement coverage metadata: response meta contains displayedFinal,
 *              settledFinalDisplayed, and missingFinalDisplayed numeric fields.
 *
 * Run: npm --prefix web run test:results:behavioral-contract
 */

// @ts-ignore
import db from '../../../../packages/data/src/db.js';
// @ts-ignore
import { setupIsolatedTestDb, startIsolatedNextServer } from '../db-test-runtime.js';

import assert from 'node:assert/strict';

const TEST_PREFIX = 'test-rbc';

function insertBase(
  client: ReturnType<typeof db.getDatabase>,
  gameId: string,
  cardId: string,
  sport: string,
  createdAt: string,
  overrides: {
    line?: number;
    cardType?: string;
    payloadData?: string;
    skipDisplayLog?: boolean;
    skipResults?: boolean;
    confidencePct?: number;
    result?: string;
    pnlUnits?: number;
  } = {},
) {
  const line = overrides.line ?? 6.5;
  const confidencePct = overrides.confidencePct ?? 62.0;
  // Use a card type that avoids the partial unique index (uq_card_payloads_call_per_game)
  // which enforces one %-call card per (game_id, card_type). Non-call types are unrestricted.
  const cardType = overrides.cardType ?? `${sport}-totals-call`;
  const payloadData = overrides.payloadData ?? JSON.stringify({
    confidence_pct: confidencePct,
    decision_basis: 'ODDS_BACKED',
    play: { decision_v2: { official_status: 'PLAY' }, period: 'FULL_GAME' },
    recommended_bet_type: 'total',
    market_type: 'total',
    selection: 'OVER',
    line,
    locked_price: -110,
    home_team: 'Home',
    away_team: 'Away',
  });

  client
    .prepare(
      `INSERT OR IGNORE INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-row`, sport, gameId, 'Home', 'Away',
      createdAt, 'final', createdAt, createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId, gameId, sport, cardType, `${sport} Total`,
      createdAt, payloadData, `${TEST_PREFIX}-run`,
    );

  if (!overrides.skipDisplayLog) {
    client
      .prepare(
        `INSERT INTO card_display_log
         (pick_id, run_id, game_id, sport, market_type, selection, line, odds, confidence_pct, displayed_at, api_endpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cardId, `${TEST_PREFIX}-run`, gameId, sport.toUpperCase(),
        'total', 'OVER', line, -110, confidencePct, createdAt, '/api/cards',
      );
  }

  if (!overrides.skipResults) {
    client
      .prepare(
        `INSERT INTO card_results
         (id, card_id, game_id, sport, card_type, recommended_bet_type, status,
          result, settled_at, pnl_units, market_key, market_type,
          selection, line, locked_price, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${cardId}-result`, cardId, gameId, sport, cardType, 'total',
        'settled', overrides.result ?? 'win', createdAt,
        overrides.pnlUnits ?? 1,
        `${sport}:${gameId}:total:OVER`, 'total', 'OVER', line, -110,
        createdAt, createdAt,
      );
  }

  client
    .prepare(
      `INSERT OR IGNORE INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-game-result`, gameId, sport, 4, 3, 'final', 'manual',
      createdAt, createdAt, createdAt,
    );
}

async function getJson(
  baseUrl: string,
  path: string,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${path} should return 200`);
  return { response, payload: await response.json() as Record<string, unknown> };
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('results-behavioral-contract');
  let server: { baseUrl: string; stop: () => Promise<void> } | null = null;

  try {
    const client = db.getDatabase();
    const createdAt = '2026-04-22T18:00:00.000Z';

    // --- Invariant 1: Dedupe ---
    // Two different cards for the SAME game + same market (total/OVER). With dedupe=true
    // (default), only the higher-confidence pick survives. With dedupe=false, both appear.
    const dedupeGameId = `${TEST_PREFIX}-dedupe-game`;
    insertBase(client, dedupeGameId, `${TEST_PREFIX}-dedupe-card-a`, 'nhl', createdAt, {
      confidencePct: 65.0,
    });
    // card-b: use a non-call card type to avoid the partial unique index
    // (uq_card_payloads_call_per_game enforces one %-call per game_id+card_type).
    // The dedupe partition is on game_id+market+selection — card_type is not a partition key —
    // so card-a (65%) wins over card-b (60%) and only one row appears under dedupe=true.
    insertBase(client, dedupeGameId, `${TEST_PREFIX}-dedupe-card-b`, 'nhl', createdAt, {
      confidencePct: 60.0,
      cardType: 'nhl-totals-v2',
    });

    // --- Invariant 2: Payload-missing visibility ---
    // card_results with a stub/empty payload_data (missing confidence and decision fields).
    // The row must still appear in the ledger even when payload fields are absent — the
    // ledger query uses LEFT JOIN card_payloads, so minimal payloads must not crash or hide the row.
    const noPayloadGameId = `${TEST_PREFIX}-nopayload-game`;
    insertBase(client, noPayloadGameId, `${TEST_PREFIX}-nopayload-card`, 'mlb', createdAt, {
      payloadData: '{}',
    });

    // --- Invariant 3: Settlement coverage metadata ---
    // One additional displayed-final card without a card_results row → missingFinalDisplayed > 0.
    const missingResultsGameId = `${TEST_PREFIX}-missing-results-game`;
    const missingCardId = `${TEST_PREFIX}-missing-card`;

    client
      .prepare(
        `INSERT OR IGNORE INTO games
         (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${missingResultsGameId}-row`, 'mlb', missingResultsGameId, 'Home D', 'Away D',
        createdAt, 'final', createdAt, createdAt,
      );
    client
      .prepare(
        `INSERT INTO card_display_log
         (pick_id, run_id, game_id, sport, market_type, selection, line, odds, confidence_pct, displayed_at, api_endpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        missingCardId, `${TEST_PREFIX}-run`, missingResultsGameId, 'MLB',
        'total', 'OVER', 7.0, -115, 57.0, createdAt, '/api/cards',
      );
    client
      .prepare(
        `INSERT OR IGNORE INTO game_results
         (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${missingResultsGameId}-game-result`, missingResultsGameId, 'mlb', 5, 3, 'final', 'manual',
        createdAt, createdAt, createdAt,
      );

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'results-behavioral-contract',
      readinessPath: '/api/results?limit=5',
    });

    // --- Assert Invariant 1: Dedupe ---
    const { payload: defaultPayload } = await getJson(server.baseUrl, '/api/results?limit=50');
    const defaultData = defaultPayload.data as Record<string, unknown>;
    const defaultLedger = defaultData.ledger as Array<Record<string, unknown>>;
    const dedupeDefaultRows = defaultLedger.filter(
      (row) => (row.gameId ?? row.game_id) === dedupeGameId,
    );
    assert.equal(
      dedupeDefaultRows.length,
      1,
      'dedupe=true (default): two picks on same game+market must collapse to one ledger row',
    );

    const { payload: noDedupePayload } = await getJson(
      server.baseUrl,
      '/api/results?limit=50&dedupe=0',
    );
    const noDedupeData = noDedupePayload.data as Record<string, unknown>;
    const noDedupeLedger = noDedupeData.ledger as Array<Record<string, unknown>>;
    const dedupeOffRows = noDedupeLedger.filter(
      (row) => (row.gameId ?? row.game_id) === dedupeGameId,
    );
    assert.equal(
      dedupeOffRows.length,
      2,
      'dedupe=false: both picks on same game+market must appear in ledger',
    );

    // --- Assert Invariant 2: Payload-missing visibility ---
    // A card with a stub/empty payload_data ('{}') must still appear in the ledger.
    // Payload fields (confidencePct, decisionTier, etc.) will be null/absent but must not
    // prevent the row from appearing — the API should not filter on payload field presence.
    const noPayloadRows = defaultLedger.filter(
      (row) => (row.gameId ?? row.game_id) === noPayloadGameId,
    );
    assert.equal(
      noPayloadRows.length,
      1,
      'card with stub/empty payload_data must still appear in ledger (payload fields are optional)',
    );

    // --- Assert Invariant 3: Settlement coverage metadata ---
    const meta = defaultData.meta as Record<string, unknown>;
    assert.ok(meta, 'response data must include meta');
    assert.equal(typeof meta.displayedFinal, 'number', 'meta.displayedFinal must be a number');
    assert.equal(typeof meta.settledFinalDisplayed, 'number', 'meta.settledFinalDisplayed must be a number');
    assert.equal(typeof meta.missingFinalDisplayed, 'number', 'meta.missingFinalDisplayed must be a number');
    assert.ok(
      (meta.missingFinalDisplayed as number) > 0,
      'missingFinalDisplayed must be > 0 when a displayed-final card has no card_results',
    );
    assert.equal(
      meta.missingFinalDisplayed,
      (meta.displayedFinal as number) - (meta.settledFinalDisplayed as number),
      'missingFinalDisplayed must equal displayedFinal - settledFinalDisplayed',
    );

    console.log('✅ Results endpoint behavioral contract tests passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ Results endpoint behavioral contract tests failed');
  console.error(error);
  process.exit(1);
});
