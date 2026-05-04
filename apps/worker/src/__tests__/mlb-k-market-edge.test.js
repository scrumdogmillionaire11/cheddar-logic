'use strict';

/**
 * Unit Tests — MLB K projection-only card emission
 *
 * Validates:
 *   1. Pitcher-K cards emit projection-only output regardless of requested mode.
 *
 *   2. Line presence/absence does not block projection card emission or upgrade
 *      the contract beyond PASS/PROJECTION_ONLY posture output.
 *
 *   3. Projection posture is deterministic, multi-input, and non-executable.
 *
 *   4. deriveMlbExecutionEnvelope keeps projection-only pitcher-K rows
 *      non-actionable.
 *
 *   5. resolvePitcherKsMode defaults to 'PROJECTION_ONLY'.
 *
 * Pure unit tests — no DB, no network, no fixtures.
 */

const {
  computePitcherKDriverCards,
  scorePitcherK,
  selectPitcherKUnderMarket,
} = require('../models/mlb-model');

const {
  deriveMlbExecutionEnvelope,
  resolvePitcherKsMode,
} = require('../jobs/run_mlb_model');

const ALLOWED_POSTURES = new Set([
  'UNDER_CANDIDATE',
  'OVER_CANDIDATE',
  'NO_EDGE_ZONE',
  'TRAP_FLAGGED',
  'DATA_UNTRUSTED',
  'UNDER_LEAN_ONLY',
]);

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

function buildPostureScenario({
  starterKPct = 0.29,
  oppKPctVsHand = 0.255,
  lastThreePitchCounts = [96, 94, 92],
  recentIp = 6.1,
  starts = 10,
} = {}) {
  return {
    pitcherInput: {
      full_name: 'Scenario Pitcher',
      season_k_pct: starterKPct,
      k_pct: starterKPct,
      bb_pct: 0.07,
      handedness: 'R',
      xwoba_allowed: 0.295,
      recent_ip: recentIp,
      avg_ip: recentIp,
      season_starts: starts,
      starts,
      il_return: false,
      days_since_last_start: 5,
      role: 'starter',
      last_three_pitch_counts: lastThreePitchCounts,
      k_pct_last_4_starts: starterKPct + 0.01,
      k_pct_prior_4_starts: starterKPct - 0.01,
      current_season_swstr_pct: 0.13,
      swstr_pct: 0.13,
      season_avg_velo: 94.0,
      last3_avg_velo: 94.2,
      bvp_pa: 0,
      bvp_k: 0,
      is_star_name: false,
      strikeout_history: [
        { season: 2026, strikeouts: 8, batters_faced: 25, walks: 1, number_of_pitches: 96, innings_pitched: 6.0, home_away: 'H' },
        { season: 2026, strikeouts: 7, batters_faced: 24, walks: 1, number_of_pitches: 94, innings_pitched: 5.2, home_away: 'A' },
        { season: 2026, strikeouts: 9, batters_faced: 26, walks: 2, number_of_pitches: 92, innings_pitched: 6.1, home_away: 'H' },
      ],
      game_role: 'home',
    },
    matchupInput: {
      opp_k_pct_vs_handedness_l30: oppKPctVsHand,
      opp_k_pct_vs_handedness_l30_pa: 220,
      opp_k_pct_vs_handedness_season: oppKPctVsHand,
      opp_k_pct_vs_handedness_season_pa: 520,
      opp_obp: 0.314,
      opp_xwoba: 0.319,
      opp_hard_hit_pct: 38.5,
      park_k_factor: 1.0,
      confirmed_lineup: false,
      has_role_signal: false,
      high_k_hitters_absent: 0,
      handedness_shift_material: false,
    },
    weatherInput: {
      temp_at_first_pitch: 72,
      temp_f: 72,
      wind_in_mph: 6,
      wind_direction: 'VAR',
    },
  };
}

const BOOKMAKER_PRIORITY = { draftkings: 1, fanduel: 2, betmgm: 3 };

// ── Test 1: Line present still yields PROJECTION_ONLY card ─────────────────────

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

  test('home card basis is PROJECTION_ONLY', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(homeCard.basis).toBe('PROJECTION_ONLY');
  });

  test('prop_decision.line is null (projection-only, no market line)', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(homeCard.prop_decision.line).toBeNull();
  });

  test('prop_decision.verdict is PASS in projection-only mode', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(homeCard.prop_decision.verdict).toBe('PASS');
    expect(homeCard.card_verdict).toBe('PASS');
    expect(homeCard.action).toBe('PASS');
  });

  test('prop_decision.missing_inputs does NOT include k_market_line', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    const missing = homeCard.prop_decision.missing_inputs ?? [];
    expect(missing).not.toContain('k_market_line');
  });

  test('home card exposes a projection-only posture and forced-mode reason code', () => {
    const homeCard = cards.find((c) => c.market === 'pitcher_k_home');
    expect(ALLOWED_POSTURES.has(homeCard.posture)).toBe(true);
    expect(homeCard.prop_decision.posture).toBe(homeCard.posture);
    expect(homeCard.reason_codes).toContain('PASS_PROJECTION_ONLY_NO_MARKET');
    expect(homeCard.reason_codes).toContain('MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY');
    expect(homeCard.prop_decision.flags).toContain('PASS_PROJECTION_ONLY_NO_MARKET');
  });

  test('away pitcher (no line) remains visible as projection-only', () => {
    const awayCard = cards.find((c) => c.market === 'pitcher_k_away');
    expect(awayCard).toBeDefined();
    expect(awayCard.basis).toBe('PROJECTION_ONLY');
  });
});

// ── Test 2: Line absent still yields PROJECTION_ONLY cards ────────────────────

describe('K engine: line absent (no player_prop_lines data)', () => {
  const snapshot = buildKSnapshot(); // no k_market_lines injected
  let cards;

  beforeAll(() => {
    cards = computePitcherKDriverCards('mlb-test-001', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: BOOKMAKER_PRIORITY,
    });
  });

  test('cards are emitted when no lines exist', () => {
    expect(cards.length).toBeGreaterThan(0);
  });

  test('projection-only cards are produced when no lines exist', () => {
    expect(cards.find((card) => card.basis === 'PROJECTION_ONLY')).toBeDefined();
  });

  test('every emitted card stays non-executable and posture-only', () => {
    for (const card of cards) {
      expect(card.prediction).toBe('PASS');
      expect(card.status).toBe('PASS');
      expect(card.action).toBe('PASS');
      expect(card.classification).toBe('PASS');
      expect(ALLOWED_POSTURES.has(card.posture)).toBe(true);
      expect(card.prop_decision.line).toBeNull();
    }
  });
});

describe('scorePitcherK projection posture contract', () => {
  test('requested ODDS_BACKED mode still resolves to PASS/PROJECTION_ONLY posture output', () => {
    const { pitcherInput, matchupInput, weatherInput } = buildPostureScenario();
    const result = scorePitcherK(
      pitcherInput,
      matchupInput,
      {},
      null,
      weatherInput,
      { mode: 'ODDS_BACKED', side: 'over' },
    );

    expect(result.basis).toBe('PROJECTION_ONLY');
    expect(result.verdict).toBe('PASS');
    expect(ALLOWED_POSTURES.has(result.posture)).toBe(true);
    expect(result.reason_codes).toContain('PASS_PROJECTION_ONLY_NO_MARKET');
    expect(result.reason_codes).toContain('MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY');
  });

  test('synthetic fallback paths surface DATA_UNTRUSTED posture', () => {
    const { pitcherInput, matchupInput, weatherInput } = buildPostureScenario({
      starts: 10,
    });
    pitcherInput.role = 'opener';
    const result = scorePitcherK(
      pitcherInput,
      matchupInput,
      {},
      null,
      weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );

    expect(result.projection_source).toBe('SYNTHETIC_FALLBACK');
    expect(result.posture).toBe('DATA_UNTRUSTED');
  });

  test('baseline K skill changes posture when opponent and leash stay fixed', () => {
    const strong = buildPostureScenario({
      starterKPct: 0.29,
      oppKPctVsHand: 0.255,
      lastThreePitchCounts: [96, 94, 92],
      recentIp: 6.1,
    });
    const weak = buildPostureScenario({
      starterKPct: 0.225,
      oppKPctVsHand: 0.255,
      lastThreePitchCounts: [96, 94, 92],
      recentIp: 6.1,
    });

    const strongResult = scorePitcherK(
      strong.pitcherInput,
      strong.matchupInput,
      {},
      null,
      strong.weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );
    const weakResult = scorePitcherK(
      weak.pitcherInput,
      weak.matchupInput,
      {},
      null,
      weak.weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );

    expect(strongResult.posture).toBe('OVER_CANDIDATE');
    expect(weakResult.posture).toBe('NO_EDGE_ZONE');
  });

  test('opponent K factor changes posture when pitcher baseline and leash stay fixed', () => {
    const highOppK = buildPostureScenario({
      starterKPct: 0.29,
      oppKPctVsHand: 0.255,
      lastThreePitchCounts: [96, 94, 92],
      recentIp: 6.1,
    });
    const lowOppK = buildPostureScenario({
      starterKPct: 0.29,
      oppKPctVsHand: 0.205,
      lastThreePitchCounts: [96, 94, 92],
      recentIp: 6.1,
    });

    const highOppKResult = scorePitcherK(
      highOppK.pitcherInput,
      highOppK.matchupInput,
      {},
      null,
      highOppK.weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );
    const lowOppKResult = scorePitcherK(
      lowOppK.pitcherInput,
      lowOppK.matchupInput,
      {},
      null,
      lowOppK.weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );

    expect(highOppKResult.posture).toBe('OVER_CANDIDATE');
    expect(lowOppKResult.posture).toBe('NO_EDGE_ZONE');
  });

  test('leash bucket changes posture when pitcher baseline and opponent factor stay fixed', () => {
    const fullLeash = buildPostureScenario({
      starterKPct: 0.225,
      oppKPctVsHand: 0.205,
      lastThreePitchCounts: [96, 94, 92],
      recentIp: 6.1,
    });
    const shortLeash = buildPostureScenario({
      starterKPct: 0.225,
      oppKPctVsHand: 0.205,
      lastThreePitchCounts: [72, 70, 68],
      recentIp: 4.2,
    });

    const fullLeashResult = scorePitcherK(
      fullLeash.pitcherInput,
      fullLeash.matchupInput,
      {},
      null,
      fullLeash.weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );
    const shortLeashResult = scorePitcherK(
      shortLeash.pitcherInput,
      shortLeash.matchupInput,
      {},
      null,
      shortLeash.weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );

    expect(fullLeashResult.posture).toBe('UNDER_LEAN_ONLY');
    expect(shortLeashResult.posture).toBe('UNDER_CANDIDATE');
  });
});

// ── Test 4: deriveMlbExecutionEnvelope — projection-only status only ─────────

describe('deriveMlbExecutionEnvelope: projection-only pitcher-K card', () => {
  test('PASS verdict remains PROJECTION_ONLY and non-actionable', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: { basis: 'PROJECTION_ONLY', card_verdict: 'PASS' },
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'LIMITED_LIVE',
    });
    expect(envelope.execution_status).toBe('PROJECTION_ONLY');
    expect(envelope.actionable).toBe(false);
    expect(envelope._publish_state.emit_allowed).toBe(true);
  });

  test('rolloutState=OFF → execution_status remains BLOCKED (disabled)', () => {
    const envelope = deriveMlbExecutionEnvelope({
      driver: { basis: 'PROJECTION_ONLY', card_verdict: 'PASS' },
      pricingStatus: 'NOT_REQUIRED',
      isPitcherK: true,
      rolloutState: 'OFF',
    });
    expect(envelope.execution_status).toBe('BLOCKED');
    expect(envelope._publish_state.emit_allowed).toBe(false);
  });
});

// ── Test 5: resolvePitcherKsMode defaults to PROJECTION_ONLY ─────────────────

describe('resolvePitcherKsMode', () => {
  test('returns PROJECTION_ONLY by default', () => {
    expect(resolvePitcherKsMode()).toBe('PROJECTION_ONLY');
  });
});

// ── Test 6: selectPitcherKUnderMarket reads pitcher.k_market_lines format ─────

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
