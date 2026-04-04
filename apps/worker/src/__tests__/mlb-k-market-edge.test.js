'use strict';

/**
 * Unit Tests — WI-0771: MLB K engine market-edge step reads player_prop_lines
 *
 * Validates:
 *   1. Line present: computePitcherKDriverCards with ODDS_BACKED mode produces
 *      a card with non-null prop_decision.market_line (via line field) and
 *      edge_pct / score computed; card can reach PLAY classification.
 *
 *   2. Line absent: card falls back to PROJECTION_ONLY with
 *      missing_inputs containing 'k_market_line'.
 *
 *   3. deriveMlbExecutionEnvelope:
 *      - ODDS_BACKED + PLAY verdict → execution_status=EXECUTABLE
 *      - ODDS_BACKED + PASS verdict → execution_status=PROJECTION_ONLY
 *      - No basis (pure PROJECTION_ONLY) → execution_status=PROJECTION_ONLY
 *
 *   4. resolvePitcherKsMode returns 'ODDS_BACKED' (guard removed).
 *
 * Pure unit tests — no DB, no network, no fixtures.
 */

const {
  computePitcherKDriverCards,
  selectPitcherKUnderMarket,
} = require('../models/mlb-model');

const {
  deriveMlbExecutionEnvelope,
  resolvePitcherKsMode,
} = require('../jobs/run_mlb_model');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal oddsSnapshot with enough pitcher data to pass K engine gates.
 * Optionally injects k_market_lines onto the home pitcher.
 */
function buildKSnapshot({ homeKLines = null, awayKLines = null } = {}) {
  const homePitcher = {
    full_name: 'Sandy Koufax',
    mlb_id: 112345,
    k_per_9: 10.5,
    recent_k_per_9: 11.0,
    season_k_pct: 0.30,
    bb_pct: 0.07,
    handedness: 'L',
    xwoba_allowed: 0.285,
    recent_ip: 6.5,
    avg_ip: 6.5,
    starts: 10,
    season_starts: 10,
    il_return: false,
    days_since_last_start: 5,
    role: 'starter',
    last_three_pitch_counts: [98, 102, 95],
    k_pct_last_4_starts: 0.31,
    k_pct_prior_4_starts: 0.28,
    current_season_swstr_pct: 0.145,
    swstr_pct: 0.145,
    season_avg_velo: 94.5,
    last3_avg_velo: 95.0,
    bvp_pa: 40,
    bvp_k: 14,
    is_star_name: true,
    has_role_signal: true,
    strikeout_history: [
      { season: 2026, game_date: '2026-03-20', strikeouts: 8, number_of_pitches: 100, innings_pitched: 6.0 },
      { season: 2026, game_date: '2026-03-14', strikeouts: 7, number_of_pitches: 98, innings_pitched: 6.0 },
      { season: 2026, game_date: '2026-03-08', strikeouts: 9, number_of_pitches: 105, innings_pitched: 6.1 },
    ],
    // WI-0771: per-pitcher market lines keyed by bookmaker
    ...(homeKLines ? { k_market_lines: homeKLines } : {}),
  };

  const awayPitcher = {
    full_name: 'Bob Gibson',
    mlb_id: 112346,
    k_per_9: 9.1,
    recent_k_per_9: 9.5,
    season_k_pct: 0.26,
    bb_pct: 0.08,
    handedness: 'R',
    xwoba_allowed: 0.310,
    recent_ip: 6.0,
    avg_ip: 6.0,
    starts: 9,
    season_starts: 9,
    il_return: false,
    days_since_last_start: 5,
    role: 'starter',
    last_three_pitch_counts: [95, 97, 92],
    k_pct_last_4_starts: 0.27,
    k_pct_prior_4_starts: 0.25,
    current_season_swstr_pct: 0.12,
    swstr_pct: 0.12,
    season_avg_velo: 93.0,
    last3_avg_velo: 93.5,
    bvp_pa: 30,
    bvp_k: 9,
    is_star_name: false,
    has_role_signal: true,
    strikeout_history: [],
    ...(awayKLines ? { k_market_lines: awayKLines } : {}),
  };

  return {
    game_id: 'mlb-test-001',
    id: 'odds-row-test-001',
    home_team: 'Los Angeles Dodgers',
    away_team: 'St. Louis Cardinals',
    game_time_utc: '2026-04-03T23:10:00.000Z',
    captured_at: new Date().toISOString(),
    total: 8.5,
    total_price_over: -110,
    total_price_under: -110,
    raw_data: {
      mlb: {
        home_pitcher: homePitcher,
        away_pitcher: awayPitcher,
        home_offense_profile: {
          wrc_plus_vs_lhp: 95,
          k_pct_vs_lhp: 0.24,
          iso_vs_lhp: 0.17,
        },
        away_offense_profile: {
          wrc_plus_vs_rhp: 102,
          k_pct_vs_rhp: 0.22,
          iso_vs_rhp: 0.18,
        },
        park_run_factor: 1.0,
        park_k_factor: 1.0,
        temp_f: 70,
        wind_mph: 5,
        wind_dir: 'VAR',
      },
    },
  };
}

const BOOKMAKER_PRIORITY = { draftkings: 1, fanduel: 2, betmgm: 3 };

// ── Test 1: Line present → ODDS_BACKED card with market_line populated ────────

describe('K engine: line present in player_prop_lines', () => {
  // Inject a line onto the home pitcher (simulates what enrichMlbPitcherData
  // attaches after querying player_prop_lines)
  const homeKLines = {
    draftkings: {
      line: 6.5,
      over_price: -115,
      under_price: -105,
      bookmaker: 'draftkings',
      line_source: 'draftkings',
      fetched_at: new Date().toISOString(),
    },
  };
  const snapshot = buildKSnapshot({ homeKLines });
  let cards;

  beforeAll(() => {
    cards = computePitcherKDriverCards('mlb-test-001', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: BOOKMAKER_PRIORITY,
    });
  });

  test('produces at least one pitcher-k card for home pitcher', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(homeCard).toBeDefined();
  });

  test('home card basis is ODDS_BACKED', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(homeCard.basis).toBe('ODDS_BACKED');
  });

  test('prop_decision.line is non-null (market line populated)', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(homeCard.prop_decision.line).not.toBeNull();
    expect(typeof homeCard.prop_decision.line).toBe('number');
  });

  test('prop_decision.verdict is a valid scoring verdict (not PASS)', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    // When a line is present the ODDS_BACKED path runs scorePitcherKUnder.
    // The verdict may be PLAY, WATCH, or NO_PLAY — never the PROJECTION_ONLY
    // default PASS that was used before WI-0771.
    expect(['PLAY', 'WATCH', 'NO_PLAY']).toContain(homeCard.prop_decision.verdict);
  });

  test('prop_decision.missing_inputs does NOT include k_market_line', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    const missing = homeCard.prop_decision.missing_inputs ?? [];
    expect(missing).not.toContain('k_market_line');
  });

  test('away pitcher (no line) falls back to PROJECTION_ONLY', () => {
    const awayCard = cards.find((c) => c.market === 'pitcher_k_away');
    expect(awayCard).toBeDefined();
    expect(awayCard.basis).toBe('PROJECTION_ONLY');
    expect(awayCard.prop_decision.missing_inputs).toContain('k_market_line');
  });
});

// ── Test 2: Line absent → PROJECTION_ONLY with k_market_line in missing_inputs ─

describe('K engine: line absent (no player_prop_lines data)', () => {
  const snapshot = buildKSnapshot(); // no k_market_lines injected
  let cards;

  beforeAll(() => {
    cards = computePitcherKDriverCards('mlb-test-001', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: BOOKMAKER_PRIORITY,
    });
  });

  test('cards are still emitted (no hard failure)', () => {
    expect(cards.length).toBeGreaterThan(0);
  });

  test('all cards are PROJECTION_ONLY when no lines exist', () => {
    for (const card of cards) {
      expect(card.basis).toBe('PROJECTION_ONLY');
    }
  });

  test('all cards have k_market_line in missing_inputs', () => {
    for (const card of cards) {
      const missing = card.missing_inputs ?? [];
      expect(missing).toContain('k_market_line');
    }
  });

  test('prop_decision.line is null when no line exists', () => {
    for (const card of cards) {
      expect(card.prop_decision.line).toBeNull();
    }
  });
});

// ── Test 3: deriveMlbExecutionEnvelope — ODDS_BACKED execution status ─────────

describe('deriveMlbExecutionEnvelope: ODDS_BACKED K card', () => {
  const baseDriver = {
    basis: 'ODDS_BACKED',
    card_verdict: 'PLAY',
    verdict: 'PLAY',
    projection_floor: false,
    without_odds_mode: false,
  };

  test('PLAY verdict → execution_status=EXECUTABLE', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: { ...baseDriver, card_verdict: 'PLAY' },
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'LIMITED_LIVE',
    });
    expect(envelope.execution_status).toBe('EXECUTABLE');
    expect(envelope.actionable).toBe(true);
    expect(envelope._publish_state.emit_allowed).toBe(true);
  });

  test('WATCH verdict → execution_status=EXECUTABLE', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: { ...baseDriver, card_verdict: 'WATCH' },
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'LIMITED_LIVE',
    });
    expect(envelope.execution_status).toBe('EXECUTABLE');
  });

  test('NO_PLAY verdict → execution_status=PROJECTION_ONLY (no edge)', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: { ...baseDriver, card_verdict: 'NO_PLAY' },
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'LIMITED_LIVE',
    });
    expect(envelope.execution_status).toBe('PROJECTION_ONLY');
    expect(envelope.actionable).toBe(false);
  });

  test('PASS verdict (absent line fallback) → PROJECTION_ONLY', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: { basis: 'PROJECTION_ONLY', card_verdict: 'PASS' },
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'LIMITED_LIVE',
    });
    expect(envelope.execution_status).toBe('PROJECTION_ONLY');
  });

  test('rolloutState=OFF → execution_status remains BLOCKED (disabled)', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: baseDriver,
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'OFF',
    });
    expect(envelope.execution_status).toBe('BLOCKED');
    expect(envelope._publish_state.emit_allowed).toBe(false);
  });
});

// ── Test 4: resolvePitcherKsMode returns ODDS_BACKED (guard removed) ──────────

describe('resolvePitcherKsMode', () => {
  test('returns ODDS_BACKED after WI-0771 guard removal', () => {
    expect(resolvePitcherKsMode()).toBe('ODDS_BACKED');
  });
});

// ── Test 5: selectPitcherKUnderMarket reads pitcher.k_market_lines format ─────

describe('selectPitcherKUnderMarket with k_market_lines format', () => {
  test('selects best under market from bookmaker-keyed map', () => {
    const kLines = {
      draftkings: {
        line: 6.5,
        over_price: -115,
        under_price: -105,
        bookmaker: 'draftkings',
        line_source: 'draftkings',
        fetched_at: new Date().toISOString(),
      },
      fanduel: {
        line: 6.0,
        over_price: -110,
        under_price: -110,
        bookmaker: 'fanduel',
        line_source: 'fanduel',
        fetched_at: new Date().toISOString(),
      },
    };
    // selectPitcherKUnderMarket selects highest line ≥ 5.0
    const selected = selectPitcherKUnderMarket(kLines, 'Sandy Koufax', { draftkings: 1, fanduel: 2 });
    expect(selected).not.toBeNull();
    expect(selected.line).toBe(6.5);
    expect(selected.bookmaker).toBe('draftkings');
  });

  test('returns null when map is empty', () => {
    const result = selectPitcherKUnderMarket({}, 'Sandy Koufax', {});
    expect(result).toBeNull();
  });

  test('returns null when all lines are below minimum (5.0)', () => {
    const kLines = {
      draftkings: {
        line: 4.5,
        over_price: -115,
        under_price: -105,
        bookmaker: 'draftkings',
        line_source: 'draftkings',
        fetched_at: new Date().toISOString(),
      },
    };
    const result = selectPitcherKUnderMarket(kLines, 'Sandy Koufax', { draftkings: 1 });
    expect(result).toBeNull();
  });
});
