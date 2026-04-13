'use strict';

const {
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
  assertNoSilentMarketDrop,
  REASON_CODES,
} = require('./market-eval');

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------
function buildCard(overrides = {}) {
  return {
    market: 'full_game_ml',
    sport: 'MLB',
    status: undefined,
    classification: undefined,
    ev_threshold_passed: null,
    missing_inputs: [],
    reason_codes: [],
    pass_reason_code: null,
    edge: null,
    fair_price: null,
    win_probability: null,
    ...overrides,
  };
}

const DEFAULT_CTX = { game_id: 'game-001', sport: 'MLB' };

// ---------------------------------------------------------------------------
// Test 1: null card → REJECTED_INPUTS
// ---------------------------------------------------------------------------
describe('evaluateSingleMarket: null card', () => {
  test('returns REJECTED_INPUTS with MISSING_MARKET_ODDS when card is null', () => {
    const result = evaluateSingleMarket(null, DEFAULT_CTX);
    expect(result.status).toBe('REJECTED_INPUTS');
    expect(result.reason_codes).toContain(REASON_CODES.MISSING_MARKET_ODDS);
    expect(result.inputs_ok).toBe(false);
    expect(result.candidate_id).toBe('game-001::unknown');
  });

  test('returns REJECTED_INPUTS for malformed cards with no status or threshold fields', () => {
    const result = evaluateSingleMarket(buildCard(), DEFAULT_CTX);
    expect(result.status).toBe('REJECTED_INPUTS');
    expect(result.reason_codes).toContain(
      REASON_CODES.UNCLASSIFIED_MARKET_STATE,
    );
    expect(result.inputs_ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: watchdog reason codes → REJECTED_WATCHDOG
// ---------------------------------------------------------------------------
describe('evaluateSingleMarket: watchdog gate', () => {
  test('returns REJECTED_WATCHDOG with WATCHDOG_UNSAFE_FOR_BASE when watchdog reasons are present', () => {
    const card = buildCard({
      status: 'FIRE',
      ev_threshold_passed: true,
      watchdog_reason_codes: ['CONSISTENCY_MISSING'],
    });

    const result = evaluateSingleMarket(card, DEFAULT_CTX);
    expect(result.status).toBe('REJECTED_WATCHDOG');
    expect(result.watchdog_ok).toBe(false);
    expect(result.reason_codes).toContain(REASON_CODES.WATCHDOG_UNSAFE_FOR_BASE);
    expect(result.reason_codes).toContain('CONSISTENCY_MISSING');
    expect(result.official_tier).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// Test 3: ev_threshold_passed=false → REJECTED_THRESHOLD + EDGE_BELOW_THRESHOLD
// ---------------------------------------------------------------------------
describe('evaluateSingleMarket: ev_threshold_passed=false', () => {
  test('returns REJECTED_THRESHOLD with EDGE_BELOW_THRESHOLD when ev_threshold_passed is false', () => {
    const card = buildCard({ ev_threshold_passed: false });
    const result = evaluateSingleMarket(card, DEFAULT_CTX);
    expect(result.status).toBe('REJECTED_THRESHOLD');
    expect(result.reason_codes).toContain(REASON_CODES.EDGE_BELOW_THRESHOLD);
    expect(result.official_tier).toBe('PASS');
  });

  test('appends existing card reason_codes to rejection codes', () => {
    const card = buildCard({
      ev_threshold_passed: false,
      reason_codes: ['SOME_WATCHDOG_REASON'],
    });
    const result = evaluateSingleMarket(card, DEFAULT_CTX);
    expect(result.reason_codes).toContain(REASON_CODES.EDGE_BELOW_THRESHOLD);
    expect(result.reason_codes).toContain('SOME_WATCHDOG_REASON');
  });
});

// ---------------------------------------------------------------------------
// Test 3: status='WATCH', ev_threshold_passed=true → QUALIFIED_LEAN
// ---------------------------------------------------------------------------
describe('evaluateSingleMarket: WATCH status → QUALIFIED_LEAN', () => {
  test('returns QUALIFIED_LEAN when status is WATCH and ev_threshold_passed is true', () => {
    const card = buildCard({ status: 'WATCH', ev_threshold_passed: true });
    const result = evaluateSingleMarket(card, DEFAULT_CTX);
    expect(result.status).toBe('QUALIFIED_LEAN');
    expect(result.official_tier).toBe('LEAN');
    expect(result.game_id).toBe('game-001');
    expect(result.candidate_id).toBe('game-001::full_game_ml');
  });
});

// ---------------------------------------------------------------------------
// Test 4: status='FIRE', ev_threshold_passed=true → QUALIFIED_OFFICIAL
// ---------------------------------------------------------------------------
describe('evaluateSingleMarket: FIRE status → QUALIFIED_OFFICIAL', () => {
  test('returns QUALIFIED_OFFICIAL when status is FIRE and ev_threshold_passed is true', () => {
    const card = buildCard({ status: 'FIRE', ev_threshold_passed: true });
    const result = evaluateSingleMarket(card, DEFAULT_CTX);
    expect(result.status).toBe('QUALIFIED_OFFICIAL');
    expect(result.official_tier).toBe('PLAY');
    expect(result.reason_codes).toEqual([]);
  });

  test('returns QUALIFIED_OFFICIAL when classification is BASE and ev_threshold_passed is true', () => {
    const card = buildCard({ classification: 'BASE', ev_threshold_passed: true });
    const result = evaluateSingleMarket(card, DEFAULT_CTX);
    expect(result.status).toBe('QUALIFIED_OFFICIAL');
    expect(result.official_tier).toBe('PLAY');
  });
});

// ---------------------------------------------------------------------------
// Test 5: finalizeGameMarketEvaluation splits correctly
// ---------------------------------------------------------------------------
describe('finalizeGameMarketEvaluation: correct partition', () => {
  test('splits market_results into official_plays, leans, and rejected', () => {
    const ctx = { game_id: 'game-002', sport: 'NHL' };
    const fireCard = buildCard({ market: 'puckline', status: 'FIRE', ev_threshold_passed: true });
    const watchCard = buildCard({ market: 'total', status: 'WATCH', ev_threshold_passed: true });
    const rejectCard = buildCard({ market: 'spread', ev_threshold_passed: false });

    const results = [
      evaluateSingleMarket(fireCard, ctx),
      evaluateSingleMarket(watchCard, ctx),
      evaluateSingleMarket(rejectCard, ctx),
    ];

    const game = finalizeGameMarketEvaluation({
      game_id: 'game-002',
      sport: 'NHL',
      market_results: results,
    });

    expect(game.official_plays).toHaveLength(1);
    expect(game.leans).toHaveLength(1);
    expect(game.rejected).toHaveLength(1);
    expect(game.status).toBe('HAS_OFFICIAL_PLAYS');
    expect(game.game_id).toBe('game-002');
  });

  test('sets status to LEANS_ONLY when no official plays', () => {
    const ctx = { game_id: 'game-003', sport: 'MLB' };
    const watchCard = buildCard({ market: 'f5_ml', status: 'WATCH', ev_threshold_passed: true });
    const rejectCard = buildCard({ market: 'total', ev_threshold_passed: false });

    const results = [
      evaluateSingleMarket(watchCard, ctx),
      evaluateSingleMarket(rejectCard, ctx),
    ];

    const game = finalizeGameMarketEvaluation({
      game_id: 'game-003',
      sport: 'MLB',
      market_results: results,
    });

    expect(game.official_plays).toHaveLength(0);
    expect(game.leans).toHaveLength(1);
    expect(game.status).toBe('LEANS_ONLY');
  });

  test('sets status to SKIP_MARKET_NO_EDGE when all cards rejected with non-input reasons', () => {
    const ctx = { game_id: 'game-004', sport: 'MLB' };
    const rejectCard = buildCard({ market: 'total', ev_threshold_passed: false });

    const results = [evaluateSingleMarket(rejectCard, ctx)];

    const game = finalizeGameMarketEvaluation({
      game_id: 'game-004',
      sport: 'MLB',
      market_results: results,
    });

    expect(game.status).toBe('SKIP_MARKET_NO_EDGE');
  });
});

// ---------------------------------------------------------------------------
// Test 6: assertNoSilentMarketDrop throws on unbalanced state
// ---------------------------------------------------------------------------
describe('assertNoSilentMarketDrop: invariant enforcement', () => {
  test('throws UNACCOUNTED_MARKET_RESULTS when partition sums do not match market_results count', () => {
    const ctx = { game_id: 'game-005', sport: 'MLB' };
    const card = buildCard({ status: 'FIRE', ev_threshold_passed: true });
    const result = evaluateSingleMarket(card, ctx);

    // Inject invalid state: market_results has 1 item but official_plays/leans/rejected together have 0
    const invalidGameEval = {
      game_id: 'game-005',
      sport: 'MLB',
      market_results: [result],
      official_plays: [],
      leans: [],
      rejected: [],
    };

    expect(() => assertNoSilentMarketDrop(invalidGameEval)).toThrow(
      'UNACCOUNTED_MARKET_RESULTS for game-005',
    );
  });

  test('does not throw when partition is balanced', () => {
    const ctx = { game_id: 'game-006', sport: 'MLB' };
    const card = buildCard({ status: 'FIRE', ev_threshold_passed: true });
    const result = evaluateSingleMarket(card, ctx);

    const validGameEval = {
      game_id: 'game-006',
      sport: 'MLB',
      market_results: [result],
      official_plays: [result],
      leans: [],
      rejected: [],
    };

    expect(() => assertNoSilentMarketDrop(validGameEval)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 7: all REJECTED_INPUTS → SKIP_GAME_INPUT_FAILURE
// ---------------------------------------------------------------------------
describe('finalizeGameMarketEvaluation: all REJECTED_INPUTS → SKIP_GAME_INPUT_FAILURE', () => {
  test('sets status to SKIP_GAME_INPUT_FAILURE when all results are REJECTED_INPUTS', () => {
    const ctx = { game_id: 'game-007', sport: 'MLB' };

    // null card produces REJECTED_INPUTS
    const r1 = evaluateSingleMarket(null, ctx);
    // card with missing_inputs also produces REJECTED_INPUTS
    const r2 = evaluateSingleMarket(
      buildCard({ market: 'full_game_ml', missing_inputs: ['pitcher_stats'] }),
      ctx,
    );

    const game = finalizeGameMarketEvaluation({
      game_id: 'game-007',
      sport: 'MLB',
      market_results: [r1, r2],
    });

    expect(game.status).toBe('SKIP_GAME_INPUT_FAILURE');
    expect(game.official_plays).toHaveLength(0);
    expect(game.leans).toHaveLength(0);
    expect(game.rejected).toHaveLength(2);
  });
});

describe('evaluateSingleMarket: fallback reason code source', () => {
  test('uses REASON_CODES for unclassified market states', () => {
    const result = evaluateSingleMarket(
      buildCard({
        status: 'UNKNOWN_STATE',
        classification: 'UNKNOWN_STATE',
        ev_threshold_passed: true,
      }),
      DEFAULT_CTX,
    );

    expect(result.status).toBe('REJECTED_THRESHOLD');
    expect(result.reason_codes).toEqual([
      REASON_CODES.UNCLASSIFIED_MARKET_STATE,
    ]);
  });
});
