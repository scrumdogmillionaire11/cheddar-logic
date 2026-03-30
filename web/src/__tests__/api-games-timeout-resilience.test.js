import assert from 'node:assert/strict';

import {
  buildGamesResponseData,
  buildGamesSuccessPayload,
  buildGamesTimeoutFallbackPayload,
} from '../lib/games/route-handler.ts';

function buildPerf(overrides = {}) {
  return {
    dbReadyMs: 25,
    loadGamesMs: 80,
    cardsQueryMs: 120,
    cardsParseMs: 140,
    cardRows: 3,
    totalMs: 365,
    ...overrides,
  };
}

function buildRow(overrides = {}) {
  return {
    id: 'row-1',
    game_id: 'game-1',
    sport: 'NBA',
    home_team: 'Boston Celtics',
    away_team: 'New York Knicks',
    game_time_utc: '2026-03-30 00:00:00',
    status: 'scheduled',
    created_at: '2026-03-29T23:00:00.000Z',
    h2h_home: -145,
    h2h_away: 125,
    h2h_book: 'draftkings',
    h2h_home_book: 'draftkings',
    h2h_away_book: 'draftkings',
    total: 221.5,
    total_book: 'draftkings',
    total_line_over: 221.5,
    total_line_over_book: 'draftkings',
    total_line_under: 221.5,
    total_line_under_book: 'draftkings',
    spread_home: -4.5,
    spread_away: 4.5,
    spread_home_book: 'draftkings',
    spread_away_book: 'draftkings',
    spread_price_home: -110,
    spread_price_home_book: 'draftkings',
    spread_price_away: -110,
    spread_price_away_book: 'draftkings',
    total_price_over: -108,
    total_price_over_book: 'draftkings',
    total_price_under: -112,
    total_price_under_book: 'draftkings',
    spread_is_mispriced: 0,
    spread_misprice_type: null,
    spread_misprice_strength: null,
    spread_outlier_book: null,
    spread_outlier_delta: null,
    spread_review_flag: 0,
    spread_consensus_line: -4.5,
    spread_consensus_confidence: 'high',
    spread_dispersion_stddev: 0.25,
    spread_source_book_count: 6,
    total_is_mispriced: 0,
    total_misprice_type: null,
    total_misprice_strength: null,
    total_outlier_book: null,
    total_outlier_delta: null,
    total_review_flag: 0,
    total_consensus_line: 221.5,
    total_consensus_confidence: 'high',
    total_dispersion_stddev: 0.3,
    total_source_book_count: 6,
    h2h_consensus_home: -142,
    h2h_consensus_away: 122,
    h2h_consensus_confidence: 'high',
    odds_captured_at: '2026-03-29T23:05:00.000Z',
    projection_inputs_complete: true,
    projection_missing_inputs: [],
    source_mapping_ok: true,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    ...overrides,
  };
}

function buildPlay() {
  return {
    cardType: 'nba-spread-call',
    cardTitle: 'Celtics -4.5',
    prediction: 'HOME',
    confidence: 0.71,
    tier: 'BEST',
    reasoning: 'Edge at consensus spread',
    evPassed: true,
    driverKey: 'nba-spread-model',
    projectedTotal: 223.1,
    edge: 1.4,
    status: 'FIRE',
    kind: 'PLAY',
    market_type: 'SPREAD',
    selection: { side: 'HOME', team: 'Boston Celtics' },
    line: -4.5,
    price: -110,
    reason_codes: ['EDGE_OK'],
    tags: ['wave1'],
    decision_v2: {
      direction: 'HOME',
      support_score: 0.7,
      conflict_score: 0.1,
      drivers_used: ['spread-model'],
      driver_reasons: ['market edge'],
      watchdog_status: 'OK',
      watchdog_reason_codes: [],
      missing_data: {
        missing_fields: [],
        source_attempts: [],
      },
      official_status: 'PLAY',
      primary_reason_code: 'EDGE_OK',
      pipeline_version: 'v2',
    },
  };
}

console.log('🧪 API games timeout resilience tests');

const row = buildRow();
const play = buildPlay();
const fullData = buildGamesResponseData([row], 'pregame', {
  truePlayMap: new Map([['game-1', play]]),
  playsMap: new Map([['game-1', [play]]]),
});
assert.equal(fullData.length, 1, 'full data should include the sample game');
assert.equal(fullData[0].true_play?.cardType, 'nba-spread-call');
assert.equal(fullData[0].plays.length, 1);
assert.equal(fullData[0].odds?.spreadHome, -4.5);

const fullPayload = buildGamesSuccessPayload({
  data: fullData,
  currentRunId: 'run-1',
  runStatus: { state: 'active' },
  perf: buildPerf({ totalMs: 240 }),
  responseMode: 'full',
  isDev: false,
});
assert.equal(fullPayload.meta.response_mode, 'full');
assert.equal(fullPayload.meta.timeout_fallback, false);
assert.equal(fullPayload.meta.cache_age_ms, null);

const degradedPayload = buildGamesTimeoutFallbackPayload({
  rows: [row],
  lifecycleMode: 'pregame',
  currentRunId: 'run-1',
  runStatus: { state: 'active' },
  perf: buildPerf({ totalMs: 5001 }),
  timeoutStage: 'cards_query',
  cacheEntry: null,
  isDev: false,
});
assert.ok(
  degradedPayload,
  'timeout with usable base rows should return degraded payload',
);
assert.equal(degradedPayload.meta.response_mode, 'degraded_base_games');
assert.equal(degradedPayload.meta.timeout_fallback, true);
assert.equal(degradedPayload.meta.timeout_stage, 'cards_query');
assert.equal(degradedPayload.data[0].true_play, null);
assert.equal(degradedPayload.data[0].plays.length, 0);
assert.equal(degradedPayload.data[0].odds?.total, 221.5);

const cachedPayload = buildGamesSuccessPayload({
  data: fullData,
  currentRunId: 'run-1',
  runStatus: { state: 'active' },
  perf: buildPerf({ totalMs: 180 }),
  responseMode: 'full',
  isDev: true,
});
const stalePayload = buildGamesTimeoutFallbackPayload({
  rows: null,
  lifecycleMode: 'pregame',
  currentRunId: 'run-1',
  runStatus: { state: 'active' },
  perf: buildPerf({ totalMs: 4700 }),
  timeoutStage: 'load_games',
  cacheEntry: {
    payload: cachedPayload,
    cachedAt: Date.now() - 1500,
  },
  isDev: true,
});
assert.ok(
  stalePayload,
  'timeout with no fresh rows and a last-good cache should return stale cache',
);
assert.equal(stalePayload.meta.response_mode, 'stale_cache');
assert.equal(stalePayload.meta.timeout_fallback, true);
assert.equal(stalePayload.meta.timeout_stage, 'load_games');
assert.ok(
  typeof stalePayload.meta.cache_age_ms === 'number' &&
    stalePayload.meta.cache_age_ms >= 1000,
  'stale cache payload should include a cache age',
);
assert.equal(
  stalePayload.meta.perf_ms?.total,
  4700,
  'stale cache response should expose current request perf, not cached perf',
);
assert.equal(stalePayload.data[0].plays.length, 1);

const hardFailureFallback = buildGamesTimeoutFallbackPayload({
  rows: null,
  lifecycleMode: 'pregame',
  currentRunId: 'run-1',
  runStatus: { state: 'active' },
  perf: buildPerf({ totalMs: 5000 }),
  timeoutStage: 'load_games',
  cacheEntry: null,
  isDev: false,
});
assert.equal(
  hardFailureFallback,
  null,
  'timeout without fresh rows or cache should preserve hard-fail path',
);

console.log('✅ API games timeout resilience tests passed');
