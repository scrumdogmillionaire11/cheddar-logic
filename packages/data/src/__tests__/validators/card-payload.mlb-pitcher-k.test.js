'use strict';
/**
 * Tests for MLB pitcher K card payload validation
 *
 * WI-0598 acceptance: mlb-pitcher-k card type validates with explicit schema
 * coverage for required fields, reason codes, and mode/basis metadata.
 * Projection-only and odds-backed semantics are intentionally distinct.
 */
const { validateCardPayload } = require('../../validators/card-payload');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildProjectionOnlyPayload(overrides = {}) {
  return {
    game_id: 'mlb-2026-03-26-bos-nyy',
    sport: 'MLB',
    model_version: 'mlb-model-v1',
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    matchup: 'BOS @ NYY',
    start_time_utc: '2026-03-26T23:05:00.000Z',
    market_type: 'PROP',
    prediction: 'OVER',
    selection: { side: 'OVER' },
    line: null,
    confidence: 0.6,
    tier: 'WATCH',
    ev_passed: true,
    reasoning: 'Projection: 8.1 Ks | Leash: Veteran | Score: 6/10 (Tier-B) | Verdict: Play',
    disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: new Date().toISOString(),
    player_name: 'NYY SP',
    canonical_market_key: 'pitcher_strikeouts',
    basis: 'PROJECTION_ONLY',
    tags: ['no_odds_mode'],
    pitcher_k_result: { status: 'COMPLETE', projection: 8.1, net_score: 6 },
    ...overrides,
  };
}

function buildOddsBackedPayload(overrides = {}) {
  return {
    game_id: 'mlb-2026-03-26-bos-nyy',
    sport: 'MLB',
    model_version: 'mlb-model-v1',
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    matchup: 'BOS @ NYY',
    start_time_utc: '2026-03-26T23:05:00.000Z',
    market_type: 'PROP',
    prediction: 'OVER',
    selection: { side: 'OVER' },
    line: 7.5,
    confidence: 0.65,
    tier: 'WATCH',
    ev_passed: true,
    reasoning: 'Projection: 8.1 Ks | Margin: +0.6K | Score: 7/10 (Tier-B) | Verdict: Play',
    disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: new Date().toISOString(),
    player_name: 'NYY SP',
    canonical_market_key: 'pitcher_strikeouts',
    basis: 'ODDS_BACKED',
    tags: [],
    pitcher_k_result: { status: 'COMPLETE', projection: 8.1, net_score: 7 },
    line_source: 'draftkings',
    over_price: -115,
    under_price: -105,
    best_line_bookmaker: 'draftkings',
    margin: 0.6,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECTION_ONLY payloads
// ─────────────────────────────────────────────────────────────────────────────

describe('mlb-pitcher-k validator — PROJECTION_ONLY mode', () => {
  test('accepts valid PROJECTION_ONLY payload', () => {
    const result = validateCardPayload('mlb-pitcher-k', buildProjectionOnlyPayload());
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rejects PROJECTION_ONLY payload missing required no_odds_mode tag', () => {
    const payload = buildProjectionOnlyPayload({ tags: [] });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('no_odds_mode');
  });

  test('rejects PROJECTION_ONLY payload with wrong canonical_market_key', () => {
    const payload = buildProjectionOnlyPayload({ canonical_market_key: 'player_shots' });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/canonical_market_key/);
  });

  test('rejects payload with wrong sport', () => {
    const payload = buildProjectionOnlyPayload({ sport: 'NHL' });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sport/);
  });

  test('rejects payload with wrong market_type', () => {
    const payload = buildProjectionOnlyPayload({ market_type: 'TOTAL' });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/market_type/);
  });

  test('rejects payload missing player_name', () => {
    const payload = buildProjectionOnlyPayload({ player_name: undefined });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/player_name/);
  });

  test('rejects payload with invalid basis value', () => {
    const payload = buildProjectionOnlyPayload({ basis: 'MOCK_MODE' });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/basis/);
  });

  test('rejects payload missing game_id', () => {
    const payload = buildProjectionOnlyPayload({ game_id: undefined });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/game_id/);
  });

  test('allows null line in PROJECTION_ONLY (no market line required)', () => {
    const payload = buildProjectionOnlyPayload({ line: null });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(true);
  });

  test('allows null pitcher_k_result', () => {
    const payload = buildProjectionOnlyPayload({ pitcher_k_result: null });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ODDS_BACKED payloads
// ─────────────────────────────────────────────────────────────────────────────

describe('mlb-pitcher-k validator — ODDS_BACKED mode', () => {
  test('accepts valid ODDS_BACKED payload', () => {
    const result = validateCardPayload('mlb-pitcher-k', buildOddsBackedPayload());
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rejects ODDS_BACKED payload with null line', () => {
    const payload = buildOddsBackedPayload({ line: null });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('line');
  });

  test('rejects ODDS_BACKED payload missing line_source', () => {
    const payload = buildOddsBackedPayload({ line_source: null });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('line_source');
  });

  test('accepts ODDS_BACKED payload without no_odds_mode tag', () => {
    const payload = buildOddsBackedPayload({ tags: [] });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(true);
  });

  test('accepts ODDS_BACKED with null over_price/under_price when not yet priced', () => {
    const payload = buildOddsBackedPayload({ over_price: null, under_price: null });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mlb-pitcher-k bypasses deriveLockedMarketContext (PROP market)
// ─────────────────────────────────────────────────────────────────────────────

describe('mlb-pitcher-k validator — market contract bypass', () => {
  test('PROP cards skip deriveLockedMarketContext — SPREAD/TOTAL/ML contract does not apply', () => {
    // A PROP card with no SPREAD/TOTAL/MONEYLINE market_type must pass without
    // triggering the MISSING_MARKET_LINE or MISSING_LOCKED_PRICE guards.
    const payload = buildProjectionOnlyPayload({
      market_type: 'PROP',
      line: null,
      // Deliberately omit recommendation field (not needed for PROP cards)
    });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(true);
  });
});
