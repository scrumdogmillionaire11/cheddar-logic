/*
 * /api/results performance budget (WI-1210)
 *
 * This test bypasses the HTTP route on purpose. The route includes a cache layer and
 * diagnostics path that make in-process timing and heap measurements non-repeatable.
 * Instead, the harness calls the query + aggregation layers directly against an
 * isolated test DB.
 *
 * Methodology:
 * - Seed 500 settled rows with deterministic payload JSON and display metadata
 * - Run each variant 5 times
 * - Discard the first run to let the JIT and SQLite page cache warm
 * - Report the max of the remaining 4 runs
 * - Capture heap delta only for the limit=200 dedupe=false variant
 *
 * Budget derivation:
 * - WI-1210 recorded branch baselines on 2026-04-29 after the full 5-run/discard-1 method
 * - Default: local max 15 ms -> 15 x 1.5 = 22.5 -> rounded up to 25 ms
 * - limit=200 dedupe=true: local max 16 ms -> 16 x 1.5 = 24 -> rounded up to 25 ms
 * - limit=200 dedupe=false: local max 18 ms -> 18 x 1.5 = 27 -> rounded up to 30 ms
 * - sport=NBA: local max 8 ms -> 8 x 1.5 = 12 -> rounded up to 15 ms
 * - Heap delta (limit=200 dedupe=false only): 6.6 MB -> 6.6 x 1.5 = 9.9 -> rounded up to 10 MB
 *
 * Run: npm --prefix web run test:api:results:performance-budget
 */

// @ts-expect-error -- JS module lacks type declarations
import db from '../../../packages/data/src/db.js';

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import cheddarData from '@cheddar-logic/data';
import { PROJECTION_TRACKING_CARD_TYPES } from '../app/api/results/projection-metrics';
import {
  queryLedgerRowsForIds,
  queryResultsReportingData,
  type ResultsRequestFilters,
} from '../lib/results/query-layer';
import {
  buildResultsAggregation,
  buildResultsResponseBody,
} from '../lib/results/transform-layer';
// @ts-expect-error -- JS module lacks type declarations
import { setupIsolatedTestDb } from './db-test-runtime.js';

const { closeReadOnlyInstance, getDatabaseReadOnly } = cheddarData as {
  closeReadOnlyInstance: typeof import('@cheddar-logic/data').closeReadOnlyInstance;
  getDatabaseReadOnly: typeof import('@cheddar-logic/data').getDatabaseReadOnly;
};

type MarketConfig = {
  sport: 'nba' | 'nfl' | 'mlb';
  pairCount: number;
  cardTypes: [string, string];
  recommendedBetType: 'total' | 'spread' | 'moneyline';
  marketType: 'total' | 'spread' | 'moneyline';
};

type VariantConfig = {
  name: 'default' | 'limit200' | 'limit200_nodupe' | 'sport_filter';
  filters: ResultsRequestFilters;
  expectedDedupedIds: number;
  expectedLedgerRows: number;
  heapMeasured: boolean;
};

type VariantMeasurement = {
  name: VariantConfig['name'];
  maxMs: number;
  heapDeltaMb: number | null;
};

type VariantBudget = {
  maxMs: number;
  heapDeltaMb: number | null;
  assertionLabel: string;
};

const TEST_PREFIX = 'perf-fixture';
const ROW_COUNT = 500;
const RUNS_PER_VARIANT = 5;
const DISCARD_RUNS = 1;
const RUN_ID = `${TEST_PREFIX}-run`;

const MARKET_CONFIGS: readonly MarketConfig[] = [
  {
    sport: 'nba',
    pairCount: 84,
    cardTypes: ['nba-totals-call', 'nba-pace-totals'],
    recommendedBetType: 'total',
    marketType: 'total',
  },
  {
    sport: 'nfl',
    pairCount: 83,
    cardTypes: ['nfl-spread-call', 'nfl-spread-model'],
    recommendedBetType: 'spread',
    marketType: 'spread',
  },
  {
    sport: 'mlb',
    pairCount: 83,
    cardTypes: ['mlb-full-game-ml', 'mlb-ml-call'],
    recommendedBetType: 'moneyline',
    marketType: 'moneyline',
  },
] as const;

const VARIANTS: readonly VariantConfig[] = [
  {
    name: 'default',
    filters: {
      limit: 50,
      sport: null,
      cardCategory: null,
      minConfidence: null,
      market: null,
      includeOrphaned: false,
      dedupe: true,
      diagnosticsEnabled: false,
      includeProjectionSummaries: true,
      includeLedger: true,
    },
    expectedDedupedIds: 250,
    expectedLedgerRows: 50,
    heapMeasured: false,
  },
  {
    name: 'limit200',
    filters: {
      limit: 200,
      sport: null,
      cardCategory: null,
      minConfidence: null,
      market: null,
      includeOrphaned: false,
      dedupe: true,
      diagnosticsEnabled: false,
      includeProjectionSummaries: true,
      includeLedger: true,
    },
    expectedDedupedIds: 250,
    expectedLedgerRows: 200,
    heapMeasured: false,
  },
  {
    name: 'limit200_nodupe',
    filters: {
      limit: 200,
      sport: null,
      cardCategory: null,
      minConfidence: null,
      market: null,
      includeOrphaned: false,
      dedupe: false,
      diagnosticsEnabled: false,
      includeProjectionSummaries: true,
      includeLedger: true,
    },
    expectedDedupedIds: 500,
    expectedLedgerRows: 200,
    heapMeasured: true,
  },
  {
    name: 'sport_filter',
    filters: {
      limit: 50,
      sport: 'NBA',
      cardCategory: null,
      minConfidence: null,
      market: null,
      includeOrphaned: false,
      dedupe: true,
      diagnosticsEnabled: false,
      includeProjectionSummaries: true,
      includeLedger: true,
    },
    expectedDedupedIds: 84,
    expectedLedgerRows: 50,
    heapMeasured: false,
  },
] as const;

const VARIANT_BUDGETS: Record<VariantConfig['name'], VariantBudget> = {
  default: {
    maxMs: 25,
    heapDeltaMb: null,
    assertionLabel: 'limit=50 dedupe=true sport=all',
  },
  limit200: {
    maxMs: 25,
    heapDeltaMb: null,
    assertionLabel: 'limit=200 dedupe=true',
  },
  limit200_nodupe: {
    maxMs: 30,
    heapDeltaMb: 10,
    assertionLabel: 'limit=200 dedupe=false',
  },
  sport_filter: {
    maxMs: 15,
    heapDeltaMb: null,
    assertionLabel: 'limit=50 dedupe=true sport=NBA',
  },
};

function padCardIndex(index: number): string {
  return String(index).padStart(3, '0');
}

function buildPayloadData(options: {
  cardId: string;
  sport: MarketConfig['sport'];
  homeTeam: string;
  awayTeam: string;
  officialStatus: 'PLAY' | 'LEAN';
  recommendedBetType: MarketConfig['recommendedBetType'];
  marketType: MarketConfig['marketType'];
  selection: 'OVER' | 'UNDER' | 'HOME' | 'AWAY';
  line: number | null;
  lockedPrice: number;
  confidencePct: number;
  pairIndex: number;
}) {
  const payload = {
    confidence_pct: options.confidencePct,
    decision_basis: 'ODDS_BACKED',
    play: {
      decision_v2: {
        official_status: options.officialStatus,
        direction: options.selection,
        reasons: {
          support: [
            `tempo:${options.sport}:${options.pairIndex % 7}`,
            `matchup:${options.homeTeam}:${options.awayTeam}`,
            `market:${options.marketType}:${options.selection}`,
          ],
          blockers: [],
        },
      },
      period: 'FULL_GAME',
      selection: {
        side: options.selection,
      },
    },
    recommended_bet_type: options.recommendedBetType,
    market_type: options.marketType,
    selection: options.selection,
    line: options.line,
    locked_price: options.lockedPrice,
    home_team: options.homeTeam,
    away_team: options.awayTeam,
    confidence_band: options.confidencePct >= 67 ? 'HIGH' : 'MED',
    analytics: {
      fixture_id: options.cardId,
      version: 'wi-1210-phase1',
      features: {
        recent_form: [
          'pace-adjusted efficiency edge',
          'closing-line resistance snapshot',
          'injury-adjusted rotation stability',
          'travel and rest normalization',
        ],
        justification:
          'Deterministic regression payload for results query perf harness. ' +
          'This field intentionally pads payload size so the test exercises realistic ' +
          'JSON extraction and parse work in the results reporting path.',
        evidence_window: {
          lookback_games: 12,
          offense_rank: 18 + (options.pairIndex % 11),
          defense_rank: 9 + (options.pairIndex % 13),
          volatility_bucket: `bucket-${options.pairIndex % 5}`,
        },
      },
      operator_notes:
        `card=${options.cardId} sport=${options.sport} pair=${options.pairIndex} ` +
        `selection=${options.selection} status=${options.officialStatus} ` +
        'seeded for repeatable high-cardinality regression coverage.',
    },
  };

  const serialized = JSON.stringify(payload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  assert.ok(
    bytes >= 1000 && bytes <= 2500,
    `fixture payload size must stay realistic (1-2 KB); got ${bytes} bytes for ${options.cardId}`,
  );
  return serialized;
}

function buildSelection(config: MarketConfig, pairIndex: number): 'OVER' | 'UNDER' | 'HOME' | 'AWAY' {
  if (config.marketType === 'total') {
    return pairIndex % 2 === 0 ? 'OVER' : 'UNDER';
  }
  return pairIndex % 2 === 0 ? 'HOME' : 'AWAY';
}

function buildLine(config: MarketConfig, pairIndex: number): number | null {
  if (config.marketType === 'moneyline') return null;
  if (config.marketType === 'total') return 210.5 + (pairIndex % 9);
  return Number(((pairIndex % 7) + 1.5).toFixed(1));
}

function buildMarketKey(
  config: MarketConfig,
  gameId: string,
  selection: 'OVER' | 'UNDER' | 'HOME' | 'AWAY',
): string {
  return `${config.sport}:${gameId}:${config.marketType}:${selection}`;
}

function insertFixtureRow(
  client: ReturnType<typeof db.getDatabase>,
  options: {
    cardId: string;
    gameId: string;
    sport: MarketConfig['sport'];
    cardType: string;
    homeTeam: string;
    awayTeam: string;
    createdAt: string;
    confidencePct: number;
    officialStatus: 'PLAY' | 'LEAN';
    recommendedBetType: MarketConfig['recommendedBetType'];
    marketType: MarketConfig['marketType'];
    selection: 'OVER' | 'UNDER' | 'HOME' | 'AWAY';
    line: number | null;
    lockedPrice: number;
    pairIndex: number;
    result: 'win' | 'loss';
  },
) {
  const payloadData = buildPayloadData({
    cardId: options.cardId,
    sport: options.sport,
    homeTeam: options.homeTeam,
    awayTeam: options.awayTeam,
    officialStatus: options.officialStatus,
    recommendedBetType: options.recommendedBetType,
    marketType: options.marketType,
    selection: options.selection,
    line: options.line,
    lockedPrice: options.lockedPrice,
    confidencePct: options.confidencePct,
    pairIndex: options.pairIndex,
  });

  client
    .prepare(
      `INSERT OR IGNORE INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${options.gameId}-row`,
      options.sport,
      options.gameId,
      options.homeTeam,
      options.awayTeam,
      options.createdAt,
      'final',
      options.createdAt,
      options.createdAt,
    );

  client
    .prepare(
      `INSERT OR IGNORE INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${options.gameId}-final`,
      options.gameId,
      options.sport,
      100 + (options.pairIndex % 12),
      96 + (options.pairIndex % 10),
      'final',
      'perf-fixture',
      options.createdAt,
      options.createdAt,
      options.createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.cardId,
      options.gameId,
      options.sport,
      options.cardType,
      `${options.sport.toUpperCase()} ${options.marketType}`,
      options.createdAt,
      payloadData,
      RUN_ID,
    );

  client
    .prepare(
      `INSERT INTO card_display_log
       (pick_id, run_id, game_id, sport, market_type, selection, line, odds, confidence_pct, displayed_at, api_endpoint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.cardId,
      RUN_ID,
      options.gameId,
      options.sport.toUpperCase(),
      options.marketType,
      options.selection,
      options.line,
      options.lockedPrice,
      options.confidencePct,
      options.createdAt,
      '/api/cards',
    );

  client
    .prepare(
      `INSERT INTO card_results
       (id, card_id, game_id, sport, card_type, recommended_bet_type, status,
        result, settled_at, pnl_units, market_key, market_type,
        selection, line, locked_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${options.cardId}-result`,
      options.cardId,
      options.gameId,
      options.sport,
      options.cardType,
      options.recommendedBetType,
      'settled',
      options.result,
      options.createdAt,
      options.result === 'win' ? 1 : -1,
      buildMarketKey(options as MarketConfig, options.gameId, options.selection),
      options.marketType,
      options.selection,
      options.line,
      options.lockedPrice,
      options.createdAt,
      options.createdAt,
    );
}

function seedHighCardinalityFixture(client: ReturnType<typeof db.getDatabase>) {
  let cardIndex = 1;

  for (const config of MARKET_CONFIGS) {
    for (let pairIndex = 0; pairIndex < config.pairCount; pairIndex += 1) {
      const gameId = `${TEST_PREFIX}-${config.sport}-game-${String(pairIndex + 1).padStart(3, '0')}`;
      const homeTeam = `${config.sport.toUpperCase()} Home ${String(pairIndex + 1).padStart(3, '0')}`;
      const awayTeam = `${config.sport.toUpperCase()} Away ${String(pairIndex + 1).padStart(3, '0')}`;
      const selection = buildSelection(config, pairIndex);
      const line = buildLine(config, pairIndex);
      const lockedPrice = -110 + (pairIndex % 4) * 5;

      for (let rowOffset = 0; rowOffset < 2; rowOffset += 1) {
        const cardId = `${TEST_PREFIX}-${padCardIndex(cardIndex)}`;
        const createdAt = new Date(Date.UTC(2026, 3, 1, 12, pairIndex % 24, cardIndex % 60)).toISOString();
        const confidenceBase = 57 + (pairIndex % 11);
        const confidencePct = rowOffset === 0 ? confidenceBase + 6 : confidenceBase + 1;
        const officialStatus = rowOffset === 0 ? 'PLAY' : 'LEAN';
        const result = (pairIndex + rowOffset) % 2 === 0 ? 'win' : 'loss';

        insertFixtureRow(client, {
          cardId,
          gameId,
          sport: config.sport,
          cardType: config.cardTypes[rowOffset],
          homeTeam,
          awayTeam,
          createdAt,
          confidencePct,
          officialStatus,
          recommendedBetType: config.recommendedBetType,
          marketType: config.marketType,
          selection,
          line,
          lockedPrice,
          pairIndex,
          result,
        });

        cardIndex += 1;
      }
    }
  }

  assert.equal(cardIndex - 1, ROW_COUNT, `fixture should seed exactly ${ROW_COUNT} rows`);

  const cardPayloadCount = client.prepare(`SELECT COUNT(*) AS count FROM card_payloads`).get() as { count: number };
  const cardResultsCount = client.prepare(`SELECT COUNT(*) AS count FROM card_results`).get() as { count: number };
  const displayLogCount = client.prepare(`SELECT COUNT(*) AS count FROM card_display_log`).get() as { count: number };
  const gameCount = client.prepare(`SELECT COUNT(*) AS count FROM games`).get() as { count: number };

  assert.equal(cardPayloadCount.count, ROW_COUNT, 'fixture must seed 500 card_payloads rows');
  assert.equal(cardResultsCount.count, ROW_COUNT, 'fixture must seed 500 card_results rows');
  assert.equal(displayLogCount.count, ROW_COUNT, 'fixture must seed 500 card_display_log rows');
  assert.equal(gameCount.count, 250, 'fixture must seed 250 unique games for dedupe coverage');
}

function measureVariant(variant: VariantConfig): VariantMeasurement {
  const retainedDurations: number[] = [];
  const retainedHeapDeltasMb: number[] = [];

  for (let runIndex = 0; runIndex < RUNS_PER_VARIANT; runIndex += 1) {
    if (variant.heapMeasured) {
      global.gc?.();
    }

    const heapBefore = variant.heapMeasured ? process.memoryUsage().heapUsed : null;
    const startedAt = performance.now();

    let readOnlyDb: ReturnType<typeof getDatabaseReadOnly> | null = null;

    try {
      readOnlyDb = getDatabaseReadOnly();
      const queryData = queryResultsReportingData(
        readOnlyDb,
        variant.filters,
        PROJECTION_TRACKING_CARD_TYPES,
      );

      assert.equal(
        queryData.dedupedIds.length,
        variant.expectedDedupedIds,
        `${variant.name}: unexpected deduped id count`,
      );

      const aggregation = buildResultsAggregation(
        queryData.actionableRows,
        queryData.projectionTrackingRows,
      );
      const ledgerRows = queryLedgerRowsForIds(
        readOnlyDb,
        aggregation.oddsBackedLedgerIds,
        queryData.schema,
        variant.filters.limit,
      );
      const responseBody = buildResultsResponseBody(
        aggregation,
        ledgerRows,
        variant.filters,
        queryData.meta,
      );

      assert.equal(responseBody.success, true, `${variant.name}: response success should be true`);
      assert.equal(
        responseBody.data.ledger.length,
        variant.expectedLedgerRows,
        `${variant.name}: unexpected ledger row count`,
      );
      assert.equal(
        responseBody.data.meta.returnedCount,
        variant.expectedDedupedIds,
        `${variant.name}: unexpected returnedCount`,
      );

      if (variant.name === 'sport_filter') {
        const sportTokens = new Set(
          responseBody.data.ledger.map((row) => String(row.sport || '').toUpperCase()),
        );
        assert.deepEqual(
          [...sportTokens],
          ['NBA'],
          'sport_filter: ledger rows must stay inside the NBA filter',
        );
      }
    } finally {
      if (readOnlyDb) {
        closeReadOnlyInstance(readOnlyDb);
      }
    }

    const durationMs = performance.now() - startedAt;
    const heapAfter = variant.heapMeasured ? process.memoryUsage().heapUsed : null;

    if (runIndex >= DISCARD_RUNS) {
      retainedDurations.push(durationMs);
      if (heapBefore !== null && heapAfter !== null) {
        retainedHeapDeltasMb.push((heapAfter - heapBefore) / (1024 * 1024));
      }
    }
  }

  assert.equal(
    retainedDurations.length,
    RUNS_PER_VARIANT - DISCARD_RUNS,
    `${variant.name}: retained run count mismatch`,
  );

  return {
    name: variant.name,
    maxMs: Math.max(...retainedDurations),
    heapDeltaMb:
      retainedHeapDeltasMb.length > 0
        ? Math.max(...retainedHeapDeltasMb)
        : null,
  };
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('api-results-performance-budget');

  try {
    const client = db.getDatabase();
    seedHighCardinalityFixture(client);
    db.closeDatabase();

    const measurements = VARIANTS.map(measureVariant);
    assert.equal(measurements.length, 4, 'all performance variants must be measured');

    for (const measurement of measurements) {
      const heapToken =
        measurement.heapDeltaMb === null
          ? 'n/a'
          : measurement.heapDeltaMb.toFixed(1);
      console.log(
        `[perf] variant=${measurement.name.padEnd(16)} runs=${RUNS_PER_VARIANT} ` +
          `discard=${DISCARD_RUNS} max_ms=${Math.round(measurement.maxMs)} ` +
          `heap_delta_mb=${heapToken}`,
      );
    }

    for (const measurement of measurements) {
      const budget = VARIANT_BUDGETS[measurement.name];
      const roundedMs = Math.round(measurement.maxMs);
      assert.ok(
        roundedMs <= budget.maxMs,
        `query+agg took ${roundedMs} ms, budget is ${budget.maxMs} ms (variant: ${budget.assertionLabel})`,
      );

      if (budget.heapDeltaMb !== null) {
        assert.notEqual(
          measurement.heapDeltaMb,
          null,
          `heap delta measurement missing for variant: ${budget.assertionLabel}`,
        );
        assert.ok(
          (measurement.heapDeltaMb as number) <= budget.heapDeltaMb,
          `heap delta was ${(measurement.heapDeltaMb as number).toFixed(1)} MB, budget is ${budget.heapDeltaMb.toFixed(1)} MB (variant: ${budget.assertionLabel})`,
        );
      }
    }
  } finally {
    try {
      db.closeDatabase();
    } catch {
      // Best-effort close for the mutable test connection before temp dir cleanup.
    }
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('[api-results-performance-budget] failed', error);
  process.exitCode = 1;
});
