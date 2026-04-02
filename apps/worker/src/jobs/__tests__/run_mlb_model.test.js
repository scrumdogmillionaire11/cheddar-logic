'use strict';

/**
 * Tests — Sharp Cheddar K pitcher strikeout decision engine (WI-0595)
 *            + data freshness / fail-closed gates (WI-0596)
 *
 * Covers:
 * 1. Positive emit: full-data pitcher emits PROJECTION_ONLY card with expected fields
 * 2. Blocked: INSUFFICIENT_STARTS halts projection at Step 1
 * 3. Blocked: SHORT_LEASH (via IP proxy) halts over at Step 2
 * 4. Blocked: IL_RETURN flag halts over at Step 2
 * 5. (WI-0596) checkPitcherFreshness: MISSING / STALE / FRESH
 * 6. (WI-0596) validatePitcherKInputs: required field gates
 * 7. (WI-0596) buildPitcherKObject: full field mapping from DB row
 *
 * Tests run without DB, network, or job runner.
 */

const {
  computeMLBDriverCards,
  projectF5Total,
  projectF5TotalCard,
  scorePitcherK,
  scorePitcherKUnder,
  projectF5ML,
  computePitcherKDriverCards,
} = require('../../models/mlb-model');
const {
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
  resolveMlbTeamLookupKeys,
  selectBestPitcherUnderMarket,
  buildPitcherStrikeoutLookback,
  computeProjectionFloorF5,
  resolveMlbPitcherPropRolloutState,
  evaluatePitcherPropPublishability,
  deriveMlbExecutionEnvelope,
  assertMlbExecutionInvariant,
  buildMlbPipelineState,
} = require('../run_mlb_model');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A healthy, full-data pitcher ready to emit. */
const fullPitcher = {
  k_per_9: 10.2,
  recent_k_per_9: 11.4,
  season_starts: 8,
  starts: 8,
  recent_ip: 6.1,
  last_three_pitch_counts: [95, 92, 88], // Full leash: 2 of 3 >= 90
  il_return: false,
  days_since_last_start: 5,
  role: 'starter',
  // Trend: 4 starts available each window
  k_pct_last_4_starts: 0.32,
  k_pct_prior_4_starts: 0.27,  // delta +5pp → trend qualifies
  current_season_swstr_pct: 0.13,
  bvp_pa: 0,
  bvp_k: 0,
};

/** Neutral matchup — no opp K% data available (thin sample → neutral multiplier). */
const neutralMatchup = {
  opp_k_pct_vs_handedness_l30_pa: 0,
  opp_k_pct_vs_handedness_season_pa: 0,
  park_k_factor: 1.0,
  confirmed_lineup: null,
  has_role_signal: false,
};

const PROJECTION_ONLY_OPTS = { mode: 'PROJECTION_ONLY', side: 'over' };

const f5HomePitcher = {
  era: 3.5,
  whip: 1.12,
  k_per_9: 9.4,
  handedness: 'R',
  x_fip: 3.42,
  bb_pct: 0.071,
  hr_per_9: 0.98,
  season_k_pct: 0.272,
};

const f5AwayPitcher = {
  era: 4.1,
  whip: 1.28,
  k_per_9: 8.6,
  handedness: 'L',
  x_fip: 3.95,
  bb_pct: 0.083,
  hr_per_9: 1.14,
  season_k_pct: 0.238,
};

const f5FullContext = {
  home_offense_profile: {
    wrc_plus_vs_lhp: 118,
    k_pct_vs_lhp: 0.208,
    iso_vs_lhp: 0.201,
  },
  away_offense_profile: {
    wrc_plus_vs_rhp: 94,
    k_pct_vs_rhp: 0.247,
    iso_vs_rhp: 0.142,
  },
  park_run_factor: 1.04,
  temp_f: 82,
  wind_mph: 12,
  wind_dir: 'OUT',
};

const strongUnderHistory = [
  { strikeouts: 5, number_of_pitches: 87, innings_pitched: 5.1, game_date: '2026-03-25' },
  { strikeouts: 4, number_of_pitches: 88, innings_pitched: 5.0, game_date: '2026-03-20' },
  { strikeouts: 6, number_of_pitches: 89, innings_pitched: 5.2, game_date: '2026-03-15' },
  { strikeouts: 5, number_of_pitches: 86, innings_pitched: 5.0, game_date: '2026-03-10' },
  { strikeouts: 3, number_of_pitches: 85, innings_pitched: 4.2, game_date: '2026-03-05' },
  { strikeouts: 7, number_of_pitches: 90, innings_pitched: 5.2, game_date: '2026-02-28' },
  { strikeouts: 5, number_of_pitches: 84, innings_pitched: 4.2, game_date: '2026-02-23' },
  { strikeouts: 4, number_of_pitches: 83, innings_pitched: 4.1, game_date: '2026-02-18' },
  { strikeouts: 6, number_of_pitches: 88, innings_pitched: 5.0, game_date: '2026-02-13' },
  { strikeouts: 4, number_of_pitches: 82, innings_pitched: 4.0, game_date: '2026-02-08' },
];

const watchUnderHistory = [
  { strikeouts: 5, number_of_pitches: 92, innings_pitched: 5.8, game_date: '2026-03-25' },
  { strikeouts: 7, number_of_pitches: 93, innings_pitched: 6.0, game_date: '2026-03-20' },
  { strikeouts: 6, number_of_pitches: 91, innings_pitched: 5.9, game_date: '2026-03-15' },
  { strikeouts: 5, number_of_pitches: 90, innings_pitched: 5.6, game_date: '2026-03-10' },
  { strikeouts: 7, number_of_pitches: 92, innings_pitched: 6.0, game_date: '2026-03-05' },
  { strikeouts: 6, number_of_pitches: 91, innings_pitched: 5.8, game_date: '2026-02-28' },
  { strikeouts: 5, number_of_pitches: 90, innings_pitched: 5.5, game_date: '2026-02-23' },
  { strikeouts: 4, number_of_pitches: 89, innings_pitched: 5.1, game_date: '2026-02-18' },
  { strikeouts: 7, number_of_pitches: 94, innings_pitched: 6.2, game_date: '2026-02-13' },
  { strikeouts: 6, number_of_pitches: 92, innings_pitched: 5.7, game_date: '2026-02-08' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scorePitcherK — projection-only mode', () => {

  test('1. Positive emit: full pitcher emits COMPLETE result with projection and reason_codes', () => {
    const result = scorePitcherK(fullPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('COMPLETE');
    expect(result.basis).toBe('PROJECTION_ONLY');
    expect(result.projection_only).toBe(true);
    expect(typeof result.projection).toBe('number');
    expect(result.projection).toBeGreaterThan(0);

    // Leash
    expect(result.leash_tier).toBe('Full');

    // Overlays present
    expect(result.overlays).toMatchObject({
      trend: expect.objectContaining({ score: expect.any(Number) }),
      ump:   expect.objectContaining({ score: expect.any(Number) }),
      bvp:   expect.objectContaining({ score: expect.any(Number) }),
    });

    // Blocks present
    expect(result.blocks).toMatchObject({
      b1: 0, // skipped in PROJECTION_ONLY
      b2: expect.any(Number),
      b3: expect.any(Number),
      b4: 0, // skipped in PROJECTION_ONLY
      b5: expect.any(Number),
    });

    // Reason codes document the bypassed steps
    expect(result.reason_codes).toContain('BLOCK_1_SKIPPED:PROJECTION_ONLY');
    expect(result.reason_codes).toContain('BLOCK_4_SKIPPED:PROJECTION_ONLY');

    // Net score is non-negative
    expect(result.net_score).toBeGreaterThanOrEqual(0);

    // Verdict is a known value
    expect(['Play', 'Conditional', 'Pass']).toContain(result.verdict);
  });

  test('2. Thin-sample starters still emit projection-only results with an explicit flag', () => {
    const greenPitcher = { ...fullPitcher, season_starts: 2, starts: 2 };
    const result = scorePitcherK(greenPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('COMPLETE');
    expect(result.projection_only).toBe(true);
    expect(result.reason_codes).toContain('THIN_SAMPLE_STARTS');
    expect(result.projection).toBeGreaterThan(0);
  });

  test('3. Blocked: SHORT_LEASH kills over at Step 2', () => {
    // IP proxy < 4.5 → Short leash
    const shortLeasher = {
      ...fullPitcher,
      recent_ip: 3.8,
      last_three_pitch_counts: null, // force IP proxy path
    };
    const result = scorePitcherK(shortLeasher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('HALTED');
    expect(result.halted_at).toBe('STEP_2');
    // reason_code should be a leash-kill reason (IP_PROXY maps to Short tier, not over-eligible)
    expect(result.verdict).toBe('PASS');
    expect(result.projection).toBeGreaterThan(0); // projection ran before leash gate
  });

  test('4. Blocked: IL_RETURN kills over at Step 2', () => {
    const ilPitcher = { ...fullPitcher, il_return: true };
    const result = scorePitcherK(ilPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('HALTED');
    expect(result.halted_at).toBe('STEP_2');
    expect(result.reason_code).toBe('IL_RETURN');
    expect(result.verdict).toBe('PASS');
  });
});

describe('MLB F5 full-model projection', () => {
  test('uses FULL_MODEL starter/matchup/environment inputs when all required fields are present', () => {
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, f5FullContext);

    expect(projection).toMatchObject({
      projection_source: 'FULL_MODEL',
      missing_inputs: [],
      playability: {
        over_playable_at_or_below: expect.any(Number),
        under_playable_at_or_above: expect.any(Number),
      },
    });
    expect(projection.base).toBeGreaterThan(0);
    expect(projection.projected_home_f5_runs).toBeGreaterThan(0);
    expect(projection.projected_away_f5_runs).toBeGreaterThan(0);
    expect(projection.projected_total_high).toBeGreaterThan(projection.projected_total_low);
  });

  test('falls back to SYNTHETIC_FALLBACK and records missing inputs when matchup context is incomplete', () => {
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, {
      home_offense_profile: null,
      away_offense_profile: null,
      park_run_factor: null,
      temp_f: null,
      wind_mph: null,
      wind_dir: null,
    });

    expect(projection.projection_source).toBe('SYNTHETIC_FALLBACK');
    expect(projection.reason_codes).toEqual(
      expect.arrayContaining(['PASS_SYNTHETIC_FALLBACK', 'PASS_MISSING_DRIVER_INPUTS']),
    );
    expect(projection.missing_inputs).toEqual(
      expect.arrayContaining([
        'home_opponent_split_profile',
        'away_opponent_split_profile',
        'home_park_run_factor',
        'away_park_run_factor',
      ]),
    );
  });

  test('projectF5TotalCard forces PASS when abs(edge) is below 0.5 runs', () => {
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, f5FullContext);
    const result = projectF5TotalCard(
      f5HomePitcher,
      f5AwayPitcher,
      projection.base + 0.2,
      f5FullContext,
    );

    expect(result.status).toBe('PASS');
    expect(result.action).toBe('PASS');
    expect(result.classification).toBe('PASS');
    expect(result.ev_threshold_passed).toBe(false);
    expect(result.reason_codes).toContain('PASS_NO_EDGE');
    expect(result.pass_reason_code).toBe('PASS_NO_EDGE');
    expect(result.projection_source).toBe('FULL_MODEL');
  });

  test('computeMLBDriverCards keeps no-edge PASS cards visible with playability metadata', () => {
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, f5FullContext);
    const cards = computeMLBDriverCards('mlb-f5-pass', {
      away_team: 'Boston Red Sox',
      home_team: 'New York Yankees',
      raw_data: {
        mlb: {
          f5_line: projection.base + 0.2,
          home_pitcher: f5HomePitcher,
          away_pitcher: f5AwayPitcher,
          ...f5FullContext,
        },
      },
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      market: 'f5_total',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      ev_threshold_passed: false,
      projection_source: 'FULL_MODEL',
      pass_reason_code: 'PASS_NO_EDGE',
      playability: {
        over_playable_at_or_below: expect.any(Number),
        under_playable_at_or_above: expect.any(Number),
      },
    });
    expect(cards[0].reason_codes).toContain('PASS_NO_EDGE');
    expect(cards[0].projection).toMatchObject({
      projected_total: expect.any(Number),
      projected_total_low: expect.any(Number),
      projected_total_high: expect.any(Number),
    });
  });

  test('computeMLBDriverCards emits synthetic-fallback PASS when a starter is missing', () => {
    const cards = computeMLBDriverCards('mlb-f5-missing-sp', {
      away_team: 'Boston Red Sox',
      home_team: 'New York Yankees',
      raw_data: {
        mlb: {
          f5_line: 4.5,
          home_pitcher: null,
          away_pitcher: f5AwayPitcher,
          ...f5FullContext,
        },
      },
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      projection_source: 'SYNTHETIC_FALLBACK',
      pass_reason_code: 'PASS_SYNTHETIC_FALLBACK',
      ev_threshold_passed: false,
    });
    expect(cards[0].missing_inputs).toContain('home_starting_pitcher');
    expect(cards[0].reason_codes).toEqual(
      expect.arrayContaining(['PASS_SYNTHETIC_FALLBACK', 'PASS_MISSING_DRIVER_INPUTS']),
    );
  });
});

describe('MLB pitcher-K under monitoring', () => {
  test('selectBestPitcherUnderMarket prefers highest line, then best under price, then bookmaker priority', () => {
    const best = selectBestPitcherUnderMarket([
      { line: 6.5, under_price: -105, over_price: -115, bookmaker: 'draftkings' },
      { line: 7.5, under_price: -125, over_price: 105, bookmaker: 'fanduel' },
      { line: 7.5, under_price: -115, over_price: 100, bookmaker: 'betmgm' },
      { line: 7.5, under_price: -115, over_price: 100, bookmaker: 'draftkings' },
    ]);

    expect(best).toMatchObject({
      line: 7.5,
      under_price: -115,
      bookmaker: 'draftkings',
    });
  });

  test('buildPitcherStrikeoutLookback fills current season first, then prior season', () => {
    const currentRows = [
      { season: 2026, game_date: '2026-03-20', strikeouts: 5, number_of_pitches: 88, innings_pitched: 5.0 },
      { season: 2026, game_date: '2026-03-14', strikeouts: 6, number_of_pitches: 90, innings_pitched: 5.2 },
      { season: 2026, game_date: '2026-03-08', strikeouts: 4, number_of_pitches: 84, innings_pitched: 4.1 },
      { season: 2026, game_date: '2026-03-02', strikeouts: 5, number_of_pitches: 86, innings_pitched: 4.2 },
    ];
    const priorRows = [
      { season: 2025, game_date: '2025-09-28', strikeouts: 7, number_of_pitches: 95, innings_pitched: 6.0 },
      { season: 2025, game_date: '2025-09-22', strikeouts: 8, number_of_pitches: 97, innings_pitched: 6.1 },
      { season: 2025, game_date: '2025-09-15', strikeouts: 6, number_of_pitches: 93, innings_pitched: 5.2 },
    ];
    const db = {
      prepare: jest.fn((sql) => ({
        all: jest.fn((_pitcherId, season) =>
          sql.includes('season = ?') ? currentRows : priorRows
        ),
      })),
    };

    const lookback = buildPitcherStrikeoutLookback(db, 1234, 2026, 7);
    expect(lookback).toHaveLength(7);
    expect(lookback.slice(0, 4).map((row) => row.season)).toEqual([2026, 2026, 2026, 2026]);
    expect(lookback.slice(4).map((row) => row.season)).toEqual([2025, 2025, 2025]);
  });

  test('scorePitcherKUnder returns PLAY for a strong under profile', () => {
    const result = scorePitcherKUnder(
      {
        ...fullPitcher,
        recent_k_per_9: 9.0,
        recent_ip: 5.2,
        last_three_pitch_counts: [89, 88, 87],
        strikeout_history: strongUnderHistory,
      },
      neutralMatchup,
      { line: 6.5, under_price: -105, over_price: -115, bookmaker: 'draftkings' },
      { temp_f: 86 },
    );

    expect(result.verdict).toBe('PLAY');
    expect(result.direction).toBe('UNDER');
    expect(result.under_score).toBeGreaterThanOrEqual(7.5);
    expect(result.flags).toContain('UNDER_LAST5_80');
    expect(result.history_metrics.under_rate_last10).toBeGreaterThanOrEqual(0.7);
  });

  test('scorePitcherKUnder returns WATCH for a middling under profile', () => {
    const result = scorePitcherKUnder(
      {
        ...fullPitcher,
        recent_k_per_9: 9.8,
        recent_ip: 5.8,
        last_three_pitch_counts: [92, 91, 90],
        strikeout_history: watchUnderHistory,
      },
      neutralMatchup,
      { line: 6.5, under_price: -110, over_price: -110, bookmaker: 'fanduel' },
      { temp_f: 72 },
    );

    expect(result.verdict).toBe('WATCH');
    expect(result.under_score).toBe(5.5);
    expect(result.flags).toContain('UNDER_LAST5_60');
  });

  test('scorePitcherKUnder returns NO_PLAY on hard gates', () => {
    const result = scorePitcherKUnder(
      {
        ...fullPitcher,
        recent_k_per_9: 9.8,
        recent_ip: 5.3,
        last_three_pitch_counts: [88, 87, 86],
        strikeout_history: strongUnderHistory.slice(0, 4),
      },
      neutralMatchup,
      { line: 4.5, under_price: -170, over_price: 140, bookmaker: 'draftkings' },
      { temp_f: 88 },
    );

    expect(result.verdict).toBe('NO_PLAY');
    expect(result.flags).toEqual(
      expect.arrayContaining(['UNDER_LINE_TOO_LOW', 'UNDER_PRICE_TOO_JUICED', 'UNDER_HISTORY_THIN']),
    );
  });

  test('computePitcherKDriverCards emits odds-backed UNDER play with prop_decision', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        raw_data: {
          mlb: {
            temp_f: 86,
            home_pitcher: {
              ...fullPitcher,
              full_name: 'Ace Under',
              recent_k_per_9: 9.0,
              recent_ip: 5.2,
              last_three_pitch_counts: [89, 88, 87],
              strikeout_history: strongUnderHistory,
            },
            strikeout_lines: {
              'ace under': {
                line: 6.5,
                under_price: -105,
                over_price: -115,
                bookmaker: 'draftkings',
              },
            },
          },
        },
      },
      { mode: 'ODDS_BACKED' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      prediction: 'UNDER',
      emit_card: true,
      card_verdict: 'PLAY',
      basis: 'ODDS_BACKED',
    });
    expect(cards[0].prop_decision).toMatchObject({
      verdict: 'PLAY',
      lean_side: 'UNDER',
      line: 6.5,
      display_price: -105,
    });
    expect(cards[0]).toMatchObject({
      line: 6.5,
      line_source: 'draftkings',
      over_price: -115,
      under_price: -105,
      best_line_bookmaker: 'draftkings',
    });
  });

  test('computePitcherKDriverCards emits projection-only prop metadata for completed pitcher K rows', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        raw_data: {
          mlb: {
            home_pitcher: {
              ...fullPitcher,
              full_name: 'Projection Only',
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      basis: 'PROJECTION_ONLY',
      prediction: 'OVER',
      emit_card: true,
      ev_threshold_passed: false,
      card_verdict: 'PROJECTION',
      prop_display_state: 'PROJECTION_ONLY',
    });
    expect(cards[0].prop_decision).toMatchObject({
      verdict: 'PROJECTION',
      lean_side: 'OVER',
      line: null,
      display_price: null,
      projection: expect.any(Number),
    });
  });

  test('computePitcherKDriverCards emits projection-only rows for thin-sample starters with flags', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        raw_data: {
          mlb: {
            home_pitcher: {
              ...fullPitcher,
              full_name: 'Thin Sample Starter',
              season_starts: 1,
              starts: 1,
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].emit_card).toBe(true);
    expect(cards[0].card_verdict).toBe('PROJECTION');
    expect(cards[0].prop_decision?.flags).toContain('THIN_SAMPLE_STARTS');
    expect(cards[0].pitcher_k_result?.reason_codes).toContain('THIN_SAMPLE_STARTS');
  });

  test('projection-only pitcher K rows remain non-actionable even when emitted', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        raw_data: {
          mlb: {
            home_pitcher: {
              ...fullPitcher,
              full_name: 'Projection Only',
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].emit_card).toBe(true);
    expect(cards[0].ev_threshold_passed).toBe(false);
    expect(cards[0].tier).toBeNull();
    expect(cards[0].prop_decision?.verdict).toBe('PROJECTION');
  });
});

describe('scorePitcherK — leash classification edge cases', () => {

  test('Full leash: 2 of last 3 starts >= 90 pitches', () => {
    const p = { ...fullPitcher, last_three_pitch_counts: [92, 95, 78] };
    const result = scorePitcherK(p, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);
    expect(result.leash_tier).toBe('Full');
    expect(result.blocks.b2).toBe(2.0);
  });

  test('Mod leash: avg pitch count 75-84', () => {
    const p = { ...fullPitcher, last_three_pitch_counts: [80, 78, 76] }; // avg 78
    const result = scorePitcherK(p, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);
    expect(result.leash_tier).toBe('Mod');
    expect(result.blocks.b2).toBe(1.0);
  });

  test('EXTENDED_REST kills over at Step 2', () => {
    const p = { ...fullPitcher, days_since_last_start: 12, il_return: false };
    const result = scorePitcherK(p, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);
    expect(result.status).toBe('HALTED');
    expect(result.reason_code).toBe('EXTENDED_REST');
    expect(result.verdict).toBe('PASS');
  });
});

describe('scorePitcherK — trap scan', () => {

  test('ENVIRONMENT_COMPROMISED: 2+ trap flags suspend verdict', () => {
    // Trigger: has_role_signal + hidden weather condition
    const suspectMatchup = {
      ...neutralMatchup,
      has_role_signal: true, // HIDDEN_ROLE_RISK
    };
    const suspectWeather = {
      wind_in_mph: 18,
      wind_direction: 'IN',  // WIND_SUPPRESSION
    };
    const result = scorePitcherK(fullPitcher, suspectMatchup, {}, null, suspectWeather, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('SUSPENDED');
    expect(result.reason_code).toBe('ENVIRONMENT_COMPROMISED');
    expect(result.trap_flags.length).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// WI-0596: Data freshness gates
// ---------------------------------------------------------------------------

describe('checkPitcherFreshness — freshness gate (WI-0596)', () => {
  const TODAY = '2026-03-26';

  test('MISSING: null row returns MISSING', () => {
    expect(checkPitcherFreshness(null, TODAY)).toBe('MISSING');
  });

  test('MISSING: undefined row returns MISSING', () => {
    expect(checkPitcherFreshness(undefined, TODAY)).toBe('MISSING');
  });

  test('FRESH: row updated today returns FRESH', () => {
    const row = { updated_at: '2026-03-26T14:30:00Z' };
    expect(checkPitcherFreshness(row, TODAY)).toBe('FRESH');
  });

  test('STALE: row updated yesterday returns STALE', () => {
    const row = { updated_at: '2026-03-25T22:00:00Z' };
    expect(checkPitcherFreshness(row, TODAY)).toBe('STALE');
  });

  test('STALE: row with empty updated_at returns STALE', () => {
    const row = { updated_at: '' };
    expect(checkPitcherFreshness(row, TODAY)).toBe('STALE');
  });
});

describe('MLB prop rollout + freshness gating', () => {
  afterEach(() => {
    delete process.env.MLB_K_PROPS;
    jest.restoreAllMocks();
  });

  test('resolveMlbPitcherPropRolloutState defaults to SHADOW', () => {
    delete process.env.MLB_K_PROPS;
    expect(resolveMlbPitcherPropRolloutState()).toBe('SHADOW');
  });

  test('evaluatePitcherPropPublishability marks fresh scoped odds as publishable', () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-26T18:00:00Z').getTime());
    const result = evaluatePitcherPropPublishability(
      {
        raw_data: {
          mlb: {
            home_pitcher: { full_name: 'Ace Under' },
            strikeout_lines: {
              'ace under': {
                line: 6.5,
                fetched_at: '2026-03-26T17:15:00Z',
              },
            },
          },
        },
      },
      { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
    );

    expect(result).toMatchObject({
      publishable: true,
      status: 'FRESH',
    });
  });

  test('evaluatePitcherPropPublishability returns MISSING when no scoped line exists', () => {
    const result = evaluatePitcherPropPublishability(
      {
        raw_data: {
          mlb: {
            home_pitcher: { full_name: 'Ace Under' },
            strikeout_lines: {},
          },
        },
      },
      { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
    );

    expect(result).toMatchObject({
      publishable: false,
      status: 'MISSING',
      reason: 'MARKET_MISSING',
    });
  });

  test('evaluatePitcherPropPublishability blocks stale scoped odds with STALE status', () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-26T18:45:00Z').getTime());
    const result = evaluatePitcherPropPublishability(
      {
        raw_data: {
          mlb: {
            away_pitcher: { full_name: 'Stale Arm' },
            strikeout_lines: {
              'stale arm': {
                line: 5.5,
                fetched_at: '2026-03-26T16:00:00Z',
              },
            },
          },
        },
      },
      { market: 'pitcher_k_away', basis: 'ODDS_BACKED' },
    );

    expect(result).toMatchObject({
      publishable: false,
      status: 'STALE',
      reason: 'STALE_ODDS',
    });
  });

  test('evaluatePitcherPropPublishability marks projection-only drivers as NOT_REQUIRED', () => {
    const result = evaluatePitcherPropPublishability(
      { raw_data: { mlb: {} } },
      { market: 'pitcher_k_home', basis: 'PROJECTION_ONLY' },
    );

    expect(result).toMatchObject({
      publishable: false,
      status: 'NOT_REQUIRED',
      reason: null,
    });
  });
});

describe('WI-0720 MLB execution envelope', () => {
  test.each([
    [
      'fresh odds-backed card',
      {
        driver: { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
        pricingStatus: 'FRESH',
        pricingCapturedAt: '2026-03-26T17:15:00Z',
        isPitcherK: true,
        rolloutState: 'FULL',
      },
      {
        execution_status: 'EXECUTABLE',
        actionable: true,
        pricing_status: 'FRESH',
        publish_ready: true,
        emit_allowed: true,
        k_prop_execution_path: 'ODDS_BACKED',
      },
    ],
    [
      'projection-floor game card',
      {
        driver: { market: 'f5_total', projection_floor: true, without_odds_mode: true },
        pricingStatus: 'NOT_REQUIRED',
      },
      {
        execution_status: 'PROJECTION_ONLY',
        actionable: false,
        pricing_status: 'NOT_REQUIRED',
        publish_ready: false,
        emit_allowed: true,
      },
    ],
    [
      'qualified pitcher K with no market',
      {
        driver: { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
        pricingStatus: 'MISSING',
        pricingReason: 'MARKET_MISSING',
        isPitcherK: true,
        rolloutState: 'FULL',
      },
      {
        execution_status: 'PROJECTION_ONLY',
        actionable: false,
        pricing_status: 'MISSING',
        publish_ready: false,
        emit_allowed: true,
        k_prop_execution_path: 'QUALIFIED_BUT_NO_MARKET',
      },
    ],
    [
      'stale odds-backed pitcher K is blocked',
      {
        driver: { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
        pricingStatus: 'STALE',
        pricingReason: 'STALE_ODDS',
        isPitcherK: true,
        rolloutState: 'FULL',
      },
      {
        execution_status: 'BLOCKED',
        actionable: false,
        pricing_status: 'STALE',
        publish_ready: false,
        emit_allowed: false,
        k_prop_execution_path: 'STALE_ODDS_BLOCKED',
      },
    ],
    [
      'projection-only pitcher K emits under shadow rollout',
      {
        driver: { market: 'pitcher_k_home', basis: 'PROJECTION_ONLY' },
        pricingStatus: 'NOT_REQUIRED',
        isPitcherK: true,
        rolloutState: 'SHADOW',
      },
      {
        execution_status: 'PROJECTION_ONLY',
        actionable: false,
        pricing_status: 'NOT_REQUIRED',
        publish_ready: false,
        emit_allowed: true,
        k_prop_execution_path: 'PROJECTION_ONLY',
      },
    ],
    [
      'shadow rollout suppresses pitcher K output',
      {
        driver: { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
        pricingStatus: 'FRESH',
        isPitcherK: true,
        rolloutState: 'SHADOW',
      },
      {
        execution_status: 'BLOCKED',
        actionable: false,
        pricing_status: 'FRESH',
        publish_ready: false,
        emit_allowed: false,
        k_prop_execution_path: 'SHADOW_ROLLOUT',
      },
    ],
    [
      'disabled rollout suppresses pitcher K output',
      {
        driver: { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
        pricingStatus: 'FRESH',
        isPitcherK: true,
        rolloutState: 'OFF',
      },
      {
        execution_status: 'BLOCKED',
        actionable: false,
        pricing_status: 'FRESH',
        publish_ready: false,
        emit_allowed: false,
        k_prop_execution_path: 'DISABLED',
      },
    ],
  ])('%s', (_label, input, expected) => {
    const envelope = deriveMlbExecutionEnvelope(input);

    expect(envelope.execution_status).toBe(expected.execution_status);
    expect(envelope.actionable).toBe(expected.actionable);
    expect(envelope._pricing_state.status).toBe(expected.pricing_status);
    expect(envelope._publish_state.publish_ready).toBe(expected.publish_ready);
    expect(envelope._publish_state.emit_allowed).toBe(expected.emit_allowed);
    if (expected.k_prop_execution_path) {
      expect(envelope.k_prop_execution_path).toBe(expected.k_prop_execution_path);
    } else {
      expect(envelope.k_prop_execution_path).toBeUndefined();
    }
  });

  test('assertMlbExecutionInvariant rejects executable payload without fresh pricing', () => {
    expect(() =>
      assertMlbExecutionInvariant({
        execution_status: 'EXECUTABLE',
        actionable: true,
        _pricing_state: { status: 'MISSING' },
        _publish_state: { publish_ready: false },
      }),
    ).toThrow(/INVARIANT_BREACH/);
  });

  test('assertMlbExecutionInvariant rejects projection floor marked executable', () => {
    expect(() =>
      assertMlbExecutionInvariant({
        execution_status: 'EXECUTABLE',
        actionable: true,
        projection_floor: true,
        _pricing_state: { status: 'FRESH' },
        _publish_state: { publish_ready: true },
      }),
    ).toThrow(/projection_floor=true requires execution_status=PROJECTION_ONLY/);
  });

  test('buildMlbPipelineState derives legacy booleans from execution envelopes', () => {
    const pipelineState = buildMlbPipelineState({
      oddsSnapshot: {
        home_team: 'Boston Red Sox',
        away_team: 'New York Yankees',
        captured_at: '2026-03-26T17:15:00Z',
      },
      marketAvailability: {
        f5_line_ok: true,
        f5_ml_ok: true,
        full_game_total_ok: true,
        expect_f5_total: true,
        expect_f5_ml: true,
        blocking_reason_codes: [],
      },
      projectionReady: true,
      driversReady: true,
      pricingReady: false,
      cardReady: false,
      executionEnvelopes: [
        deriveMlbExecutionEnvelope({
          driver: { market: 'f5_total', projection_floor: true, without_odds_mode: true },
          pricingStatus: 'NOT_REQUIRED',
        }),
      ],
    });

    expect(pipelineState.card_ready).toBe(true);
    expect(pipelineState.pricing_ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WI-0596: Required field validation
// ---------------------------------------------------------------------------

describe('validatePitcherKInputs — required field gates (WI-0596)', () => {

  /** Minimal valid pitcher: all PITCHER_K_REQUIRED_FIELDS present */
  const validPitcher = {
    k_per_9: 10.2,
    season_starts: 8,
    handedness: 'R',
    days_since_last_start: 5,
  };

  test('valid pitcher: all required fields present → returns null', () => {
    expect(validatePitcherKInputs(validPitcher)).toBeNull();
  });

  test('missing k_per_9 → PITCHER_REQUIRED_FIELD_NULL with k_per_9 in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, k_per_9: null });
    expect(result).not.toBeNull();
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toContain('k_per_9');
  });

  test('missing handedness → PITCHER_REQUIRED_FIELD_NULL with handedness in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, handedness: null });
    expect(result).not.toBeNull();
    expect(result.missing_fields).toContain('handedness');
  });

  test('missing days_since_last_start → included in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, days_since_last_start: null });
    expect(result.missing_fields).toContain('days_since_last_start');
  });

  test('all required fields null → all four appear in missing_fields', () => {
    const result = validatePitcherKInputs({});
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toEqual(
      expect.arrayContaining(['k_per_9', 'season_starts', 'handedness', 'days_since_last_start']),
    );
  });
});

// ---------------------------------------------------------------------------
// WI-0596: buildPitcherKObject field mapping
// ---------------------------------------------------------------------------

describe('buildPitcherKObject — DB row → K engine shape (WI-0596)', () => {

  const baseRow = {
    era: 3.45,
    whip: 1.12,
    k_per_9: 10.2,
    recent_k_per_9: 11.4,
    recent_ip: 6.1,
    season_starts: 8,
    handedness: 'R',
    season_k_pct: 0.28,
    k_pct_last_4_starts: 0.31,
    k_pct_prior_4_starts: 0.27,
    last_three_pitch_counts: JSON.stringify([95, 92, 88]),
    last_three_ip: JSON.stringify([6.2, 6.0, 6.1]),
    days_since_last_start: 5,
    il_status: 0,
    il_return: 0,
    role: 'starter',
    season_swstr_pct: 0.13,
    season_avg_velo: 95.1,
  };

  test('pass path: maps all K engine fields correctly from DB row', () => {
    const obj = buildPitcherKObject(baseRow);
    expect(obj.k_per_9).toBe(10.2);
    expect(obj.season_starts).toBe(8);
    expect(obj.handedness).toBe('R');
    expect(obj.days_since_last_start).toBe(5);
    expect(obj.il_status).toBe(false);   // 0 → boolean false
    expect(obj.il_return).toBe(false);
    expect(obj.role).toBe('starter');
    expect(obj.swstr_pct).toBe(0.13);
    expect(obj.season_avg_velo).toBe(95.1);
  });

  test('parses last_three_pitch_counts JSON string to array', () => {
    const obj = buildPitcherKObject(baseRow);
    expect(Array.isArray(obj.last_three_pitch_counts)).toBe(true);
    expect(obj.last_three_pitch_counts).toEqual([95, 92, 88]);
  });

  test('parses last_three_ip JSON string to array', () => {
    const obj = buildPitcherKObject(baseRow);
    expect(Array.isArray(obj.last_three_ip)).toBe(true);
    expect(obj.last_three_ip).toEqual([6.2, 6.0, 6.1]);
  });

  test('null last_three_pitch_counts stays null (< 3 entries)', () => {
    const row = { ...baseRow, last_three_pitch_counts: JSON.stringify([95, 92]) };
    const obj = buildPitcherKObject(row);
    expect(obj.last_three_pitch_counts).toBeNull();
  });

  test('invalid JSON last_three_pitch_counts → null (does not throw)', () => {
    const row = { ...baseRow, last_three_pitch_counts: 'not-json' };
    expect(() => buildPitcherKObject(row)).not.toThrow();
    expect(buildPitcherKObject(row).last_three_pitch_counts).toBeNull();
  });

  test('null DB fields remain null (Statcast not yet populated)', () => {
    const row = { ...baseRow, season_swstr_pct: null, season_avg_velo: null };
    const obj = buildPitcherKObject(row);
    expect(obj.swstr_pct).toBeNull();
    expect(obj.season_avg_velo).toBeNull();
  });
});

describe('resolveMlbTeamLookupKeys — MLB team join fallback', () => {
  test('returns full team name plus abbreviation for known MLB teams', () => {
    expect(resolveMlbTeamLookupKeys('San Francisco Giants')).toEqual([
      'San Francisco Giants',
      'SF',
    ]);
    expect(resolveMlbTeamLookupKeys('New York Yankees')).toEqual([
      'New York Yankees',
      'NYY',
    ]);
  });

  test('normalizes uppercase full-name variants to canonical full name plus abbreviation', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveMlbTeamLookupKeys('KANSAS CITY ROYALS')).toEqual([
      'KANSAS CITY ROYALS',
      'Kansas City Royals',
      'KC',
    ]);
    expect(resolveMlbTeamLookupKeys('MINNESOTA TWINS')).toEqual([
      'MINNESOTA TWINS',
      'Minnesota Twins',
      'MIN',
    ]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('keeps known abbreviations available as lookup keys', () => {
    expect(resolveMlbTeamLookupKeys('KC')).toEqual([
      'KC',
      'Kansas City Royals',
    ]);
    expect(resolveMlbTeamLookupKeys('SF')).toEqual([
      'SF',
      'San Francisco Giants',
    ]);
  });

  test('returns cleaned input only for unknown labels', () => {
    expect(resolveMlbTeamLookupKeys('  Unknown Team  ')).toEqual([
      'Unknown Team',
    ]);
  });

  test('logs unknown variants once so new source labels are visible in worker output', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnSpy.mockClear();

    expect(resolveMlbTeamLookupKeys('  Unknown Franchise  ')).toEqual([
      'Unknown Franchise',
    ]);
    expect(resolveMlbTeamLookupKeys('Unknown Franchise')).toEqual([
      'Unknown Franchise',
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('MLB_TEAM_VARIANT_UNKNOWN');
  });

  test('returns empty array for empty input', () => {
    expect(resolveMlbTeamLookupKeys('')).toEqual([]);
    expect(resolveMlbTeamLookupKeys(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WI-0603: projectF5ML — F5 Moneyline side-projection
// ---------------------------------------------------------------------------

describe('projectF5ML — F5 ML side projection (WI-0603)', () => {
  const avgPitcher  = { era: 4.00, whip: 1.25, k_per_9: 8.5 };
  const weakPitcher = { era: 5.40, whip: 1.55, k_per_9: 6.5 };

  test('returns null when homePitcher is missing', () => {
    expect(projectF5ML(null, avgPitcher, -120, 105)).toBeNull();
  });

  test('returns null when awayPitcher is missing', () => {
    expect(projectF5ML(avgPitcher, null, -120, 105)).toBeNull();
  });

  test('returns null when ml_f5_home is null', () => {
    expect(projectF5ML(avgPitcher, avgPitcher, null, 105)).toBeNull();
  });

  test('returns null when ml_f5_away is null', () => {
    expect(projectF5ML(avgPitcher, avgPitcher, -120, null)).toBeNull();
  });

  test('returns null when home pitcher ERA is missing', () => {
    expect(projectF5ML({ whip: 1.20 }, avgPitcher, -120, 105)).toBeNull();
  });

  test('result shape: has required fields on valid input', () => {
    const result = projectF5ML(avgPitcher, avgPitcher, -115, 105);
    expect(result).not.toBeNull();
    expect(typeof result.side).toBe('string');
    expect(typeof result.prediction).toBe('string');
    expect(typeof result.edge).toBe('number');
    expect(typeof result.projected_win_prob_home).toBe('number');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.ev_threshold_passed).toBe('boolean');
    expect(typeof result.reasoning).toBe('string');
  });

  test('PASS when pitchers are evenly matched (no edge)', () => {
    // Even ERA matchup → run diff ≈ 0 → win prob ≈ 50%; vig prevents edge clearing threshold
    const result = projectF5ML(avgPitcher, avgPitcher, -115, -105);
    expect(result.side).toBe('PASS');
    expect(result.ev_threshold_passed).toBe(false);
  });

  test('projected_win_prob_home > 0.5 when home faces weak away starter', () => {
    // weakPitcher pitching for away → home team scores more → home expected to win F5
    const result = projectF5ML(avgPitcher, weakPitcher, -130, 115);
    expect(result).not.toBeNull();
    expect(result.projected_win_prob_home).toBeGreaterThan(0.5);
  });

  test('projected_win_prob_home < 0.5 when away faces weak home starter', () => {
    // weakPitcher pitching for home → away team scores more → away expected to win F5
    const result = projectF5ML(weakPitcher, avgPitcher, 115, -130);
    expect(result).not.toBeNull();
    expect(result.projected_win_prob_home).toBeLessThan(0.5);
  });

  test('emits HOME when home edge is large enough and confidence clears minimum', () => {
    // Both pitchers quality (ERA < 3.50, WHIP < 1.20) → confidence = 8, clears CONFIDENCE_MIN=6.
    // Home faces slightly weaker away pitcher → pWin(H) > 0.5.
    // Home priced at +180 (impliedH ≈ 36%) while model says ~53% → homeEdge ≈ +17pp > LEAN_EDGE_MIN.
    const homePitcher = { era: 2.80, whip: 1.15, k_per_9: 9.0 };
    const awayPitcher = { era: 3.40, whip: 1.18, k_per_9: 8.5 };
    const result = projectF5ML(homePitcher, awayPitcher, 180, -220);
    expect(result).not.toBeNull();
    expect(result.side).toBe('HOME');
    expect(result.edge).toBeGreaterThan(0.04);
    expect(result.ev_threshold_passed).toBe(true);
  });

  test('reasoning string contains expected diagnostic tokens', () => {
    const result = projectF5ML(avgPitcher, avgPitcher, -110, -110);
    expect(result.reasoning).toMatch(/F5 ML/);
    expect(result.reasoning).toMatch(/pWin\(H\)/);
    expect(result.reasoning).toMatch(/conf=/);
  });
});
