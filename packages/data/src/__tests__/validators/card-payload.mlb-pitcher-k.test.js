'use strict';
/**
 * Tests for MLB pitcher K card payload validation
 *
 * WI-0598 acceptance: mlb-pitcher-k card type validates with explicit schema
 * coverage for required fields, reason codes, and basis metadata.
 * WI-0733: current runtime writes are projection-only and PASS-only.
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
    prediction: 'PASS',
    selection: { side: 'PASS' },
    line: null,
    confidence: 0.6,
    status: 'PASS',
    action: 'PASS',
    classification: 'PASS',
    tier: null,
    ev_passed: false,
    projection_source: 'FULL_MODEL',
    status_cap: 'PASS',
    playability: {
      over_playable_at_or_below: 6.5,
      under_playable_at_or_above: 7.5,
    },
    missing_inputs: [],
    reason_codes: ['PASS_PROJECTION_ONLY_NO_MARKET'],
    pass_reason_code: 'PASS_PROJECTION_ONLY_NO_MARKET',
    projection: {
      k_mean: 7.1,
      projected_ip: 6.0,
      bf_exp: 25.5,
      batters_per_inning: 4.25,
      k_interaction: 0.278,
      k_leash_mult: 1.0,
      starter_k_pct: 0.282,
      starter_swstr_pct: 0.131,
      whiff_proxy_pct: 0.131,
      opp_k_pct_vs_hand: 0.241,
      probability_ladder: {
        p_5_plus: 0.821,
        p_6_plus: 0.704,
        p_7_plus: 0.558,
      },
      fair_prices: {
        k_5_plus: { over: -459, under: 459 },
        k_6_plus: { over: -238, under: 238 },
        k_7_plus: { over: -126, under: 126 },
      },
    },
    reasoning: 'K mean: 7.1 Ks | BF=25.5 x Kint=0.278 x leash=1 | fair O<=6.5 U>=7.5 | Source: FULL_MODEL | Verdict: PASS',
    disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: new Date().toISOString(),
    player_name: 'NYY SP',
    canonical_market_key: 'pitcher_strikeouts',
    basis: 'PROJECTION_ONLY',
    tags: ['no_odds_mode'],
    line_source: null,
    over_price: null,
    under_price: null,
    best_line_bookmaker: null,
    margin: null,
    pitcher_k_result: {
      status: 'COMPLETE',
      projection: 7.1,
      k_mean: 7.1,
      probability_ladder: {
        p_5_plus: 0.821,
        p_6_plus: 0.704,
        p_7_plus: 0.558,
      },
      verdict: 'PASS',
      projection_source: 'FULL_MODEL',
      status_cap: 'PASS',
      net_score: 2,
    },
    ...overrides,
  };
}

function buildOddsBackedPayload(overrides = {}) {
  return {
    ...buildProjectionOnlyPayload({
      prediction: 'UNDER',
      selection: { side: 'UNDER' },
      line: 7.5,
      status: 'WATCH',
      action: 'HOLD',
      classification: 'LEAN',
      tier: 'WATCH',
      ev_passed: true,
      reason_codes: ['UNDER_LAST5_60'],
      pass_reason_code: null,
      basis: 'ODDS_BACKED',
      tags: ['draftkings_primary'],
      line_source: 'draftkings',
      over_price: -112,
      under_price: -108,
      best_line_bookmaker: 'draftkings',
      margin: 0.8,
      pitcher_k_line_contract: {
        line: 7.5,
        over_price: -112,
        under_price: -108,
        bookmaker: 'draftkings',
        line_source: 'draftkings',
        opening_line: 7.5,
        opening_over_price: -110,
        opening_under_price: -110,
        best_available_line: 8.0,
        best_available_under_price: 120,
        best_available_bookmaker: 'fanduel',
        current_timestamp: '2026-04-03T01:15:00Z',
        alt_lines: [
          {
            line: 8.0,
            side: 'under',
            juice: 120,
            book: 'fanduel',
            source: 'fanduel',
            captured_at: '2026-04-03T01:15:00Z',
          },
          {
            line: 6.5,
            side: 'over',
            juice: -145,
            book: 'draftkings',
            source: 'draftkings',
            captured_at: '2026-04-03T01:15:00Z',
          },
        ],
      },
    }),
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

  test('rejects PROJECTION_ONLY payload with a live line', () => {
    const payload = buildProjectionOnlyPayload({ line: 6.5 });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('line');
  });

  test('rejects PROJECTION_ONLY payload promoted to FIRE', () => {
    const payload = buildProjectionOnlyPayload({
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      tier: 'BEST',
      ev_passed: true,
    });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/status=PASS|ev_passed=false|must not set tier/);
  });

  test('rejects PROJECTION_ONLY payload carrying dormant line contract metadata', () => {
    const payload = buildProjectionOnlyPayload({
      pitcher_k_line_contract: {
        line: 7.5,
        over_price: -112,
        under_price: -108,
        bookmaker: 'draftkings',
        line_source: 'draftkings',
        current_timestamp: '2026-04-03T01:15:00Z',
        alt_lines: [{ line: 8.5, side: 'under', juice: 120, book: 'draftkings' }],
      },
    });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('pitcher_k_line_contract');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ODDS_BACKED payloads (dormant contract only)
// ─────────────────────────────────────────────────────────────────────────────

describe('mlb-pitcher-k validator — dormant ODDS_BACKED mode', () => {
  test('accepts valid ODDS_BACKED payload with standard and alt K lines', () => {
    const result = validateCardPayload('mlb-pitcher-k', buildOddsBackedPayload());
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rejects ODDS_BACKED payload missing line_source', () => {
    const payload = buildOddsBackedPayload({ line_source: null });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('line_source');
  });

  test('rejects ODDS_BACKED payload with null line contract line', () => {
    const payload = buildOddsBackedPayload({
      pitcher_k_line_contract: {
        ...buildOddsBackedPayload().pitcher_k_line_contract,
        line: null,
      },
    });
    const result = validateCardPayload('mlb-pitcher-k', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('line contract must have line set');
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
