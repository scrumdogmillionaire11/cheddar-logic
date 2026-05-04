/*
 * Regression coverage for WI-1236:
 *   1. /api/games dedupe uses canonical game_id (not sport|away|home|date).
 *   2. Same-day rematches remain as separate response rows.
 *   3. Degraded response states (degraded_base_games, stale_cache) set game_state on each data row.
 *
 * Run (from repo root): node web/src/__tests__/api-games-dedupe-and-degraded-state.test.js
 */

import assert from 'node:assert';
import path from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
process.chdir(path.resolve(__dirname, '../..'));
await import('tsx/esm');

const { prepareGamesServiceRows } = await import('../lib/games/service-layer.ts');
const {
  buildGamesResponseData,
  buildGamesTimeoutFallbackPayload,
} = await import('../lib/games/route-handler.ts');

console.log('🧪 WI-1236: /api/games dedupe and degraded-state tests\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides = {}) {
  return {
    id: 'row-' + Math.random().toString(36).slice(2),
    game_id: 'gid-' + Math.random().toString(36).slice(2),
    sport: 'NBA',
    home_team: 'LAL',
    away_team: 'BOS',
    game_time_utc: '2026-05-10T00:00:00Z',
    status: 'scheduled',
    created_at: '2026-05-09T10:00:00Z',
    odds_captured_at: null,
    h2h_home: -110,
    h2h_away: -110,
    h2h_book: null,
    h2h_home_book: null,
    h2h_away_book: null,
    total: 220.5,
    total_book: null,
    total_line_over: null,
    total_line_over_book: null,
    total_line_under: null,
    total_line_under_book: null,
    spread_home: -3.5,
    spread_away: 3.5,
    spread_home_book: null,
    spread_away_book: null,
    spread_price_home: null,
    spread_price_home_book: null,
    spread_price_away: null,
    spread_price_away_book: null,
    total_price_over: null,
    total_price_over_book: null,
    total_price_under: null,
    total_price_under_book: null,
    spread_is_mispriced: null,
    spread_misprice_type: null,
    spread_misprice_strength: null,
    spread_outlier_book: null,
    spread_outlier_delta: null,
    spread_review_flag: null,
    spread_consensus_line: null,
    spread_consensus_confidence: null,
    spread_dispersion_stddev: null,
    spread_source_book_count: null,
    total_is_mispriced: null,
    total_misprice_type: null,
    total_misprice_strength: null,
    total_outlier_book: null,
    total_outlier_delta: null,
    total_review_flag: null,
    total_consensus_line: null,
    total_consensus_confidence: null,
    total_dispersion_stddev: null,
    total_source_book_count: null,
    h2h_consensus_home: null,
    h2h_consensus_away: null,
    h2h_consensus_confidence: null,
    public_bets_pct_home: null,
    public_bets_pct_away: null,
    public_handle_pct_home: null,
    public_handle_pct_away: null,
    splits_source: null,
    projection_inputs_complete: null,
    projection_missing_inputs: [],
    source_mapping_ok: null,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    ...overrides,
  };
}

function makePerf() {
  return {
    dbReadyMs: 0,
    loadGamesMs: 0,
    cardsQueryMs: 0,
    cardsParseMs: 0,
    cardRows: 0,
    totalMs: 0,
    stageMetrics: {
      'games.query.ms': 0,
      'games.service.ms': 0,
      'games.transform.ms': 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: Same-day rematches with different game_ids stay as separate rows
// ---------------------------------------------------------------------------
console.log('🧪 Test 1: Same-day rematches (different game_id) remain separate');
{
  const sharedDate = '2026-05-10T00:00:00Z';
  const game1 = makeRow({
    game_id: 'gid-doubleheader-1',
    sport: 'MLB',
    home_team: 'NYY',
    away_team: 'BOS',
    game_time_utc: sharedDate,
    h2h_home: -150,
    h2h_away: 130,
  });
  const game2 = makeRow({
    game_id: 'gid-doubleheader-2',
    sport: 'MLB',
    home_team: 'NYY',
    away_team: 'BOS',
    game_time_utc: sharedDate,
    h2h_home: -145,
    h2h_away: 125,
  });

  const { deduplicatedRows } = prepareGamesServiceRows({
    rows: [game1, game2],
    lifecycleMode: 'pregame',
    playsMap: new Map(),
  });

  assert.strictEqual(
    deduplicatedRows.length,
    2,
    `Expected 2 rows (doubleheader), got ${deduplicatedRows.length}`,
  );
  const ids = deduplicatedRows.map((r) => r.game_id).sort();
  assert.deepStrictEqual(
    ids,
    ['gid-doubleheader-1', 'gid-doubleheader-2'],
    'Both game_ids must survive deduplication unchanged',
  );
  console.log('✅ PASS: Both doubleheader games appear as separate rows\n');
}

// ---------------------------------------------------------------------------
// Test 2: Duplicate rows with the same game_id collapse to most-recent odds
// ---------------------------------------------------------------------------
console.log('🧪 Test 2: Duplicate game_id rows collapse to most-recent odds snapshot');
{
  const older = makeRow({
    game_id: 'gid-dupe',
    sport: 'NBA',
    home_team: 'MIA',
    away_team: 'CHI',
    odds_captured_at: '2026-05-10T08:00:00Z',
    h2h_home: -105,
    h2h_away: -115,
  });
  const newer = makeRow({
    game_id: 'gid-dupe',
    sport: 'NBA',
    home_team: 'MIA',
    away_team: 'CHI',
    odds_captured_at: '2026-05-10T09:30:00Z',
    h2h_home: -108,
    h2h_away: -112,
  });

  const { deduplicatedRows } = prepareGamesServiceRows({
    rows: [older, newer],
    lifecycleMode: 'pregame',
    playsMap: new Map(),
  });

  assert.strictEqual(
    deduplicatedRows.length,
    1,
    `Expected 1 row after same-game_id dedupe, got ${deduplicatedRows.length}`,
  );
  assert.strictEqual(
    deduplicatedRows[0].odds_captured_at,
    '2026-05-10T09:30:00Z',
    'Should keep the row with the most recent odds_captured_at',
  );
  console.log('✅ PASS: Duplicate game_id rows collapsed; most-recent odds kept\n');
}

// ---------------------------------------------------------------------------
// Test 3: buildGamesResponseData defaults game_state to 'healthy'
// ---------------------------------------------------------------------------
console.log('🧪 Test 3: buildGamesResponseData defaults game_state to "healthy"');
{
  const row = makeRow({ game_id: 'gid-healthy', h2h_home: -120, h2h_away: 100 });
  const data = buildGamesResponseData([row], 'pregame');

  assert.strictEqual(data.length, 1);
  assert.strictEqual(
    data[0].game_state,
    'healthy',
    'Default game_state must be "healthy"',
  );
  console.log('✅ PASS: game_state defaults to "healthy"\n');
}

// ---------------------------------------------------------------------------
// Test 4: buildGamesResponseData propagates gameState: 'degraded'
// ---------------------------------------------------------------------------
console.log('🧪 Test 4: buildGamesResponseData propagates gameState option');
{
  const row = makeRow({ game_id: 'gid-degraded' });
  const data = buildGamesResponseData([row], 'pregame', { gameState: 'degraded' });

  assert.strictEqual(data.length, 1);
  assert.strictEqual(
    data[0].game_state,
    'degraded',
    'game_state must reflect the gameState option',
  );
  console.log('✅ PASS: gameState option propagates to data rows\n');
}

// ---------------------------------------------------------------------------
// Test 5: buildGamesTimeoutFallbackPayload degraded_base_games path
// ---------------------------------------------------------------------------
console.log('🧪 Test 5: Timeout fallback with rows → response_mode=degraded_base_games, game_state=degraded');
{
  const row = makeRow({ game_id: 'gid-timeout', h2h_home: -110, h2h_away: -110 });

  const payload = buildGamesTimeoutFallbackPayload({
    rows: [row],
    lifecycleMode: 'pregame',
    currentRunId: null,
    runStatus: null,
    perf: makePerf(),
    timeoutStage: 'cards_query',
    cacheEntry: null,
    isDev: false,
  });

  assert.ok(payload, 'Payload must not be null when rows are provided');
  assert.strictEqual(
    payload.meta.response_mode,
    'degraded_base_games',
    'response_mode must be "degraded_base_games"',
  );
  assert.strictEqual(
    payload.meta.timeout_fallback,
    true,
    'timeout_fallback must be true',
  );
  assert.strictEqual(payload.data.length, 1);
  assert.strictEqual(
    payload.data[0].game_state,
    'degraded',
    'Each data row must carry game_state="degraded" in the degraded_base_games path',
  );
  console.log('✅ PASS: degraded_base_games path sets game_state="degraded" on all rows\n');
}

// ---------------------------------------------------------------------------
// Test 6: buildGamesTimeoutFallbackPayload stale_cache path
// ---------------------------------------------------------------------------
console.log('🧪 Test 6: Timeout fallback with cache entry → response_mode=stale_cache, game_state=stale');
{
  const cachedRow = makeRow({ game_id: 'gid-cached', h2h_home: -120, h2h_away: 100 });
  const cachedData = buildGamesResponseData([cachedRow], 'pregame', { gameState: 'healthy' });

  const cacheEntry = {
    payload: {
      success: true,
      data: cachedData,
      meta: {
        current_run_id: 'run-abc',
        generated_at: new Date().toISOString(),
        run_status: null,
        items_count: cachedData.length,
        response_mode: 'full',
        timeout_fallback: false,
        cache_age_ms: null,
        stage_metrics: {
          'games.query.ms': 0,
          'games.service.ms': 0,
          'games.transform.ms': 0,
        },
      },
    },
    cachedAt: Date.now() - 5000,
  };

  const payload = buildGamesTimeoutFallbackPayload({
    rows: null,
    lifecycleMode: 'pregame',
    currentRunId: null,
    runStatus: null,
    perf: makePerf(),
    timeoutStage: 'db_ready',
    cacheEntry,
    isDev: false,
  });

  assert.ok(payload, 'Payload must not be null when cache entry is provided');
  assert.strictEqual(
    payload.meta.response_mode,
    'stale_cache',
    'response_mode must be "stale_cache"',
  );
  assert.strictEqual(
    payload.meta.timeout_fallback,
    true,
    'timeout_fallback must be true',
  );
  assert.ok(
    typeof payload.meta.cache_age_ms === 'number' && payload.meta.cache_age_ms >= 0,
    'cache_age_ms must be a non-negative number',
  );
  assert.strictEqual(payload.data.length, 1);
  assert.strictEqual(
    payload.data[0].game_state,
    'stale',
    'Each data row must carry game_state="stale" in the stale_cache path',
  );
  console.log('✅ PASS: stale_cache path sets game_state="stale" on all rows\n');
}

// ---------------------------------------------------------------------------
// Test 7: Null rows + null cache entry → null (no payload served)
// ---------------------------------------------------------------------------
console.log('🧪 Test 7: No rows and no cache → null payload');
{
  const payload = buildGamesTimeoutFallbackPayload({
    rows: null,
    lifecycleMode: 'pregame',
    currentRunId: null,
    runStatus: null,
    perf: makePerf(),
    timeoutStage: 'db_open',
    cacheEntry: null,
    isDev: false,
  });

  assert.strictEqual(
    payload,
    null,
    'Must return null when neither rows nor cache are available',
  );
  console.log('✅ PASS: null rows + null cache returns null\n');
}

console.log('✅ All WI-1236 tests passed!');
