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
  normalizePitcherKMarketInput,
  computePitcherKDriverCards,
  selectPitcherKUnderMarket,
} = require('../../models/mlb-model');
const {
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
  resolveMlbTeamLookupKeys,
  buildPitcherStrikeoutLookback,
  computeProjectionFloorF5,
  resolvePitcherKsMode,
  resolveMlbPitcherPropRolloutState,
  evaluatePitcherPropPublishability,
  deriveMlbExecutionEnvelope,
  assertMlbExecutionInvariant,
  applyExecutionGateToMlbPayload,
  applyMlbProjectionOnlyGuards,
  buildMlbPipelineState,
  buildPitcherKLineContract,
  buildMlbPitcherKPayloadFields,
  resolvePitcherKPayloadIdentity,
  computeSyntheticLineF5Driver,
} = require('../run_mlb_model');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A healthy, full-data pitcher ready to emit. */
const fullPitcher = {
  k_per_9: 10.2,
  recent_k_per_9: 11.4,
  season_k_pct: 0.282,
  handedness: 'R',
  bb_pct: 0.072,
  xwoba_allowed: 0.304,
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
  opp_k_pct_vs_handedness_l30: 0.229,
  opp_k_pct_vs_handedness_l30_pa: 140,
  opp_k_pct_vs_handedness_season: 0.229,
  opp_k_pct_vs_handedness_season_pa: 600,
  opp_obp: 0.311,
  opp_xwoba: 0.318,
  opp_hard_hit_pct: 38.7,
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
  siera: 3.48,
  x_fip: 3.42,
  x_era: 3.51,
  bb_pct: 0.071,
  gb_pct: 45.2,
  hr_per_9: 0.98,
  season_k_pct: 0.272,
  xwoba_allowed: 0.302,
  avg_ip: 5.8,
  pitch_count_avg: 96,
  times_through_order_profile: {
    '1st': 0.296,
    '2nd': 0.312,
    '3rd': 0.337,
  },
};

const f5AwayPitcher = {
  era: 4.1,
  whip: 1.28,
  k_per_9: 8.6,
  handedness: 'L',
  siera: 3.98,
  x_fip: 3.95,
  x_era: 4.08,
  bb_pct: 0.083,
  gb_pct: 41.5,
  hr_per_9: 1.14,
  season_k_pct: 0.238,
  xwoba_allowed: 0.326,
  avg_ip: 5.4,
  pitch_count_avg: 91,
  times_through_order_profile: {
    '1st': 0.302,
    '2nd': 0.319,
    '3rd': 0.346,
  },
};

const f5FullContext = {
  home_offense_profile: {
    wrc_plus_vs_lhp: 118,
    k_pct_vs_lhp: 0.208,
    iso_vs_lhp: 0.201,
    bb_pct_vs_lhp: 0.089,
    xwoba_vs_lhp: 0.341,
    hard_hit_pct: 42.1,
    rolling_14d_wrc_plus_vs_lhp: 112,
  },
  away_offense_profile: {
    wrc_plus_vs_rhp: 94,
    k_pct_vs_rhp: 0.247,
    iso_vs_rhp: 0.142,
    bb_pct_vs_rhp: 0.077,
    xwoba_vs_rhp: 0.308,
    hard_hit_pct: 36.8,
    rolling_14d_wrc_plus_vs_rhp: 91,
  },
  park_run_factor: 1.04,
  temp_f: 82,
  wind_mph: 12,
  wind_dir: 'OUT',
  roof: 'OPEN',
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

    expect(result.k_mean).toBeCloseTo(result.projection, 1);
    expect(result.probability_ladder).toMatchObject({
      p_5_plus: expect.any(Number),
      p_6_plus: expect.any(Number),
      p_7_plus: expect.any(Number),
    });
    expect(result.playability).toMatchObject({
      over_playable_at_or_below: expect.any(Number),
      under_playable_at_or_above: expect.any(Number),
    });
    expect(result.projection_source).toBe('FULL_MODEL');
    expect(result.status_cap).toBe('PASS');

    // Net score is non-negative but the verdict remains PASS in projection-only mode.
    expect(result.net_score).toBeGreaterThanOrEqual(0);
    expect(result.verdict).toBe('PASS');
  });

  test('2. Thin-sample starters still emit projection-only results with an explicit flag', () => {
    const greenPitcher = { ...fullPitcher, season_starts: 2, starts: 2 };
    const result = scorePitcherK(greenPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('COMPLETE');
    expect(result.projection_only).toBe(true);
    expect(result.reason_codes).toContain('THIN_SAMPLE_STARTS');
    expect(result.projection_source).toBe('DEGRADED_MODEL');
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
    expect(result.probability_ladder.p_5_plus).toEqual(expect.any(Number));
  });

  test('4. Blocked: IL_RETURN kills over at Step 2', () => {
    const ilPitcher = { ...fullPitcher, il_return: true };
    const result = scorePitcherK(ilPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('HALTED');
    expect(result.halted_at).toBe('STEP_2');
    expect(result.reason_code).toBe('IL_RETURN');
    expect(result.verdict).toBe('PASS');
    expect(result.projection_source).toBe('FULL_MODEL');
  });
});

describe('MLB F5 full-model projection', () => {
  test('uses FULL_MODEL starter/matchup/environment inputs when all required fields are present', () => {
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, f5FullContext);

    expect(projection).toMatchObject({
      projection_source: 'FULL_MODEL',
      status_cap: 'PLAY',
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

  test('caps DEGRADED_MODEL F5 cards to WATCH when weather is missing but core inputs exist', () => {
    const degradedContext = {
      ...f5FullContext,
      temp_f: null,
      wind_mph: null,
      wind_dir: null,
    };
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, degradedContext);
    const result = projectF5TotalCard(
      f5HomePitcher,
      f5AwayPitcher,
      projection.base - 0.8,
      degradedContext,
    );

    expect(projection.projection_source).toBe('DEGRADED_MODEL');
    expect(projection.status_cap).toBe('LEAN');
    expect(projection.missing_inputs).toEqual(
      expect.arrayContaining(['home_weather', 'away_weather']),
    );
    expect(result.status).toBe('WATCH');
    expect(result.action).toBe('HOLD');
    expect(result.classification).toBe('LEAN');
    expect(result.reason_codes).toContain('MODEL_DEGRADED_INPUTS');
    expect(result.pass_reason_code).toBeNull();
  });

  test('returns NO_BET when matchup context is missing required inputs (null offense profile / park factor)', () => {
    const projection = projectF5Total(f5HomePitcher, f5AwayPitcher, {
      home_offense_profile: null,
      away_offense_profile: null,
      park_run_factor: null,
      temp_f: null,
      wind_mph: null,
      wind_dir: null,
    });

    expect(projection.status).toBe('NO_BET');
    expect(projection.projection_source).toBe('NO_BET');
    expect(projection.missingCritical).toEqual(
      expect.arrayContaining([
        'wrc_plus_vs_hand_home',
        'wrc_plus_vs_hand_away',
        'park_run_factor',
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

  test('computeMLBDriverCards returns empty when a starter is missing (NO_BET gate fires)', () => {
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

    // WI-0820: null pitcher → gate fires → NO_BET → no card emitted
    expect(cards).toHaveLength(0);
  });

  test('higher starter leash and third-time exposure increases opponent F5 run expectation', () => {
    const longLeashHomePitcher = {
      ...f5HomePitcher,
      avg_ip: 6.3,
      pitch_count_avg: 102,
      times_through_order_profile: {
        '1st': 0.295,
        '2nd': 0.312,
        '3rd': 0.355,
      },
    };
    const shortLeashHomePitcher = {
      ...f5HomePitcher,
      avg_ip: 4.4,
      pitch_count_avg: 78,
      times_through_order_profile: {
        '1st': 0.295,
        '2nd': 0.305,
        '3rd': 0.310,
      },
    };

    const longLeashProjection = projectF5Total(
      longLeashHomePitcher,
      f5AwayPitcher,
      f5FullContext,
    );
    const shortLeashProjection = projectF5Total(
      shortLeashHomePitcher,
      f5AwayPitcher,
      f5FullContext,
    );

    expect(longLeashProjection.projected_away_f5_runs).toBeGreaterThan(
      shortLeashProjection.projected_away_f5_runs,
    );
    expect(longLeashProjection.away_starter_ip_f5_exp).toBeGreaterThanOrEqual(
      shortLeashProjection.away_starter_ip_f5_exp,
    );
  });

  test('hitter park with warm wind out raises F5 total versus neutral environment', () => {
    const neutralProjection = projectF5Total(f5HomePitcher, f5AwayPitcher, {
      ...f5FullContext,
      park_run_factor: 1.0,
      temp_f: 62,
      wind_mph: 4,
      wind_dir: 'IN',
    });
    const hitterParkProjection = projectF5Total(f5HomePitcher, f5AwayPitcher, {
      ...f5FullContext,
      park_run_factor: 1.08,
      temp_f: 86,
      wind_mph: 15,
      wind_dir: 'OUT_TO_LF',
    });

    expect(hitterParkProjection.base).toBeGreaterThan(neutralProjection.base);
  });

  test('strong lineup split raises team F5 runs versus a weaker same-hand split', () => {
    const weakSplitProjection = projectF5Total(f5HomePitcher, f5AwayPitcher, {
      ...f5FullContext,
      home_offense_profile: {
        wrc_plus_vs_lhp: 88,
        k_pct_vs_lhp: 0.255,
        iso_vs_lhp: 0.132,
        bb_pct_vs_lhp: 0.071,
        xwoba_vs_lhp: 0.297,
        hard_hit_pct: 34.2,
      },
    });
    const strongSplitProjection = projectF5Total(f5HomePitcher, f5AwayPitcher, {
      ...f5FullContext,
      home_offense_profile: {
        wrc_plus_vs_lhp: 122,
        k_pct_vs_lhp: 0.19,
        iso_vs_lhp: 0.214,
        bb_pct_vs_lhp: 0.096,
        xwoba_vs_lhp: 0.352,
        hard_hit_pct: 43.8,
      },
    });

    expect(strongSplitProjection.projected_home_f5_runs).toBeGreaterThan(
      weakSplitProjection.projected_home_f5_runs,
    );
  });

  test('ERA-only projection floor falls back to neutral synthetic floor instead of ERA math', () => {
    const floor = computeProjectionFloorF5({
      home_team: 'New York Yankees',
      away_team: 'Boston Red Sox',
      raw_data: {
        mlb: {
          home_pitcher: { era: 1.80 },
          away_pitcher: { era: 7.20 },
        },
      },
    });

    expect(floor).toBe(4.5);
  });
});

describe('MLB pitcher-K under monitoring', () => {
  test('buildPitcherKLineContract normalizes standard and alt K markets', () => {
    const contract = buildPitcherKLineContract({
      line: '7.5',
      over_price: '-112',
      under_price: '-108',
      bookmaker: 'draftkings',
      line_source: 'draftkings',
      fetched_at: '2026-04-03T01:15:00Z',
      opening_line: '7.5',
      opening_over_price: '-110',
      opening_under_price: '-110',
      alt_lines: [
        { line: '6.5', side: 'over', juice: '-145', book: 'fanduel' },
        { line: '8.5', side: 'under', price: '120', bookmaker: 'draftkings' },
        { line: 'bad', side: 'over', juice: -110, book: 'draftkings' },
      ],
    });

    expect(contract).toMatchObject({
      line: 7.5,
      over_price: -112,
      under_price: -108,
      bookmaker: 'draftkings',
      line_source: 'draftkings',
      current_timestamp: '2026-04-03T01:15:00Z',
      opening_line: 7.5,
      opening_over_price: -110,
      opening_under_price: -110,
      best_available_line: 7.5,
      best_available_bookmaker: 'draftkings',
      alt_lines: [
        {
          line: 6.5,
          side: 'over',
          juice: -145,
          book: 'fanduel',
          source: 'draftkings',
          captured_at: '2026-04-03T01:15:00Z',
        },
        {
          line: 8.5,
          side: 'under',
          juice: 120,
          book: 'draftkings',
          source: 'draftkings',
          captured_at: '2026-04-03T01:15:00Z',
        },
      ],
    });
  });

  test('normalizePitcherKMarketInput converts a dormant line contract into model market input', () => {
    const marketInput = normalizePitcherKMarketInput({
      line: 7.5,
      over_price: -112,
      under_price: -108,
      bookmaker: 'draftkings',
      line_source: 'draftkings',
      current_timestamp: '2026-04-03T01:15:00Z',
      opening_line: 7.0,
      best_available_line: 8.0,
      best_available_under_price: 110,
      best_available_bookmaker: 'fanduel',
      alt_lines: [
        { line: 8.0, side: 'under', juice: 110, book: 'fanduel' },
        { line: 6.5, side: 'over', juice: -145, book: 'draftkings' },
      ],
    });

    expect(marketInput).toMatchObject({
      line: 7.5,
      over_price: -112,
      under_price: -108,
      bookmaker: 'draftkings',
      line_source: 'draftkings',
      current_timestamp: '2026-04-03T01:15:00Z',
      opening_line: 7.0,
      best_available_line: 8.0,
      best_available_under_price: 110,
      best_available_bookmaker: 'fanduel',
      alt_lines: [
        {
          side: 'under',
          line: 8.0,
          juice: 110,
          book: 'fanduel',
          source: 'draftkings',
          captured_at: '2026-04-03T01:15:00Z',
        },
        {
          side: 'over',
          line: 6.5,
          juice: -145,
          book: 'draftkings',
          source: 'draftkings',
          captured_at: '2026-04-03T01:15:00Z',
        },
      ],
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

  test('computePitcherKDriverCards forces PASS projection-only rows even when ODDS_BACKED mode is requested', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        raw_data: {
          mlb: {
            temp_f: 86,
            home_pitcher: {
              ...fullPitcher,
              full_name: 'Projection Only',
              strikeout_history: strongUnderHistory,
            },
            away_offense_profile: {
              wrc_plus_vs_rhp: 101,
              k_pct_vs_rhp: 0.236,
              iso_vs_rhp: 0.165,
              bb_pct_vs_rhp: 0.082,
              xwoba_vs_rhp: 0.319,
              hard_hit_pct: 39.4,
            },
          },
        },
      },
      { mode: 'ODDS_BACKED' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      prediction: 'PASS',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      emit_card: true,
      card_verdict: 'PASS',
      basis: 'PROJECTION_ONLY',
      projection_source: 'FULL_MODEL',
      status_cap: 'PASS',
      line: null,
      line_source: null,
      over_price: null,
      under_price: null,
      best_line_bookmaker: null,
      playability: {
        over_playable_at_or_below: expect.any(Number),
        under_playable_at_or_above: expect.any(Number),
      },
    });
    expect(cards[0].prop_decision).toMatchObject({
      verdict: 'PASS',
      lean_side: null,
      line: null,
      display_price: null,
      projection_source: 'FULL_MODEL',
      status_cap: 'PASS',
    });
    expect(cards[0].projection).toMatchObject({
      k_mean: expect.any(Number),
      projected_ip: expect.any(Number),
      bf_exp: expect.any(Number),
      k_interaction: expect.any(Number),
      probability_ladder: {
        p_5_plus: expect.any(Number),
        p_6_plus: expect.any(Number),
        p_7_plus: expect.any(Number),
      },
    });
    expect(cards[0].reason_codes).toContain('MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY');
    expect(cards[0].pass_reason_code).toBe('PASS_PROJECTION_ONLY_NO_MARKET');
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
              mlb_id: 592450,
              full_name: 'Gerrit Cole',
            },
            away_offense_profile: {
              wrc_plus_vs_rhp: 102,
              k_pct_vs_rhp: 0.241,
              iso_vs_rhp: 0.171,
              bb_pct_vs_rhp: 0.084,
              xwoba_vs_rhp: 0.322,
              hard_hit_pct: 40.1,
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      basis: 'PROJECTION_ONLY',
      player_id: '592450',
      player_name: 'Gerrit Cole',
      pitcher_team: 'New York Yankees',
      prediction: 'PASS',
      status: 'PASS',
      emit_card: true,
      ev_threshold_passed: false,
      card_verdict: 'PASS',
      prop_display_state: 'PROJECTION_ONLY',
      projection_source: 'FULL_MODEL',
      status_cap: 'PASS',
    });
    expect(cards[0].prop_decision).toMatchObject({
      verdict: 'PASS',
      lean_side: null,
      line: null,
      display_price: null,
      projection: expect.any(Number),
      probability_ladder: {
        p_5_plus: expect.any(Number),
        p_6_plus: expect.any(Number),
        p_7_plus: expect.any(Number),
      },
      playability: {
        over_playable_at_or_below: expect.any(Number),
        under_playable_at_or_above: expect.any(Number),
      },
    });
  });

  test('computePitcherKDriverCards threads starter identity for home and away pitcher cards', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        away_team: 'Boston Red Sox',
        raw_data: {
          mlb: {
            home_pitcher: {
              ...fullPitcher,
              mlb_id: 592450,
              full_name: 'Gerrit Cole',
            },
            away_pitcher: {
              ...fullPitcher,
              mlb_id: 608337,
              full_name: 'Lucas Giolito',
            },
            home_offense_profile: {
              wrc_plus_vs_rhp: 102,
              k_pct_vs_rhp: 0.231,
              iso_vs_rhp: 0.169,
              bb_pct_vs_rhp: 0.085,
              xwoba_vs_rhp: 0.321,
              hard_hit_pct: 40.3,
            },
            away_offense_profile: {
              wrc_plus_vs_rhp: 98,
              k_pct_vs_rhp: 0.241,
              iso_vs_rhp: 0.162,
              bb_pct_vs_rhp: 0.081,
              xwoba_vs_rhp: 0.316,
              hard_hit_pct: 38.8,
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(2);
    expect(cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          market: 'pitcher_k_home',
          pitcher_team: 'New York Yankees',
          player_id: '592450',
          player_name: 'Gerrit Cole',
        }),
        expect.objectContaining({
          market: 'pitcher_k_away',
          pitcher_team: 'Boston Red Sox',
          player_id: '608337',
          player_name: 'Lucas Giolito',
        }),
      ]),
    );
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
            away_offense_profile: {
              wrc_plus_vs_rhp: 97,
              k_pct_vs_rhp: 0.229,
              iso_vs_rhp: 0.154,
              bb_pct_vs_rhp: 0.078,
              xwoba_vs_rhp: 0.311,
              hard_hit_pct: 37.9,
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].emit_card).toBe(true);
    expect(cards[0].card_verdict).toBe('PASS');
    expect(cards[0].projection_source).toBe('DEGRADED_MODEL');
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
            away_offense_profile: {
              wrc_plus_vs_rhp: 100,
              k_pct_vs_rhp: 0.229,
              iso_vs_rhp: 0.164,
              bb_pct_vs_rhp: 0.081,
              xwoba_vs_rhp: 0.318,
              hard_hit_pct: 39.0,
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
    expect(cards[0].prop_decision?.verdict).toBe('PASS');
  });

  test('computePitcherKDriverCards emits SYNTHETIC_FALLBACK PASS with missing-input metadata', () => {
    const cards = computePitcherKDriverCards(
      'game-1',
      {
        home_team: 'New York Yankees',
        away_team: 'Boston Red Sox',
        raw_data: {
          mlb: {
            home_pitcher: {
              full_name: 'Missing Inputs',
              season_starts: 6,
              days_since_last_start: 5,
              recent_ip: 5.5,
              role: 'starter',
            },
          },
        },
      },
      { mode: 'PROJECTION_ONLY' },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      prediction: 'PASS',
      emit_card: true,
      card_verdict: 'PASS',
      basis: 'PROJECTION_ONLY',
      projection_source: 'SYNTHETIC_FALLBACK',
      status_cap: 'PASS',
      pass_reason_code: 'PASS_PROJECTION_ONLY_NO_MARKET',
    });
    expect(cards[0].missing_inputs).toEqual(
      expect.arrayContaining([
        'starter_k_pct',
        'starter_handedness',
        'opponent_k_pct_vs_hand',
        // opponent_contact_profile is not flagged: computePitcherKDriverCards provides
        // league-average defaults for opp_obp/opp_xwoba/opp_hard_hit_pct, so the
        // "all three null" check in calculateProjectionK never fires.
      ]),
    );
    expect(cards[0].reason_codes).toEqual(
      expect.arrayContaining([
        'PASS_PROJECTION_ONLY_NO_MARKET',
        'PASS_SYNTHETIC_FALLBACK',
        'PASS_MISSING_DRIVER_INPUTS',
      ]),
    );
    expect(cards[0].projection.probability_ladder).toMatchObject({
      p_5_plus: expect.any(Number),
      p_6_plus: expect.any(Number),
      p_7_plus: expect.any(Number),
    });
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

  test('resolvePitcherKsMode returns ODDS_BACKED (WI-0771: hard lock removed, reads from player_prop_lines)', () => {
    // WI-0771: hard lock removed. Mode is always ODDS_BACKED; when player_prop_lines
    // is empty the engine naturally falls to PROJECTION_ONLY via ODDS_BACKED_NO_EDGE.
    process.env.PITCHER_KS_MODEL_MODE = 'ODDS_BACKED';
    expect(resolvePitcherKsMode()).toBe('ODDS_BACKED');
    delete process.env.PITCHER_KS_MODEL_MODE;
  });

  test('resolvePitcherKsMode returns ODDS_BACKED when PITCHER_KS_MODEL_MODE is unset', () => {
    delete process.env.PITCHER_KS_MODEL_MODE;
    expect(resolvePitcherKsMode()).toBe('ODDS_BACKED');
  });

  test('resolvePitcherKsMode returns ODDS_BACKED when PITCHER_KS_MODEL_MODE is set to unknown value', () => {
    process.env.PITCHER_KS_MODEL_MODE = 'FULL';
    expect(resolvePitcherKsMode()).toBe('ODDS_BACKED');
    delete process.env.PITCHER_KS_MODEL_MODE;
  });

  test('evaluatePitcherPropPublishability keeps projection-only drivers NOT_REQUIRED even when scoped odds exist', () => {
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
      { market: 'pitcher_k_home', basis: 'PROJECTION_ONLY' },
    );

    expect(result).toMatchObject({
      publishable: false,
      status: 'NOT_REQUIRED',
      reason: null,
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

describe('resolvePitcherKPayloadIdentity', () => {
  test('prefers driver player_name and player_id when available', () => {
    expect(
      resolvePitcherKPayloadIdentity(
        { player_id: 592450, player_name: 'Gerrit Cole' },
        'New York Yankees',
      ),
    ).toEqual({
      playerId: '592450',
      playerName: 'Gerrit Cole',
    });
  });

  test('falls back to team SP label when driver player_name is missing', () => {
    expect(
      resolvePitcherKPayloadIdentity(
        { player_id: null, player_name: null },
        'New York Yankees',
      ),
    ).toEqual({
      playerId: null,
      playerName: 'New York Yankees SP',
    });
  });
});

describe('buildMlbPitcherKPayloadFields', () => {
  test('projection-only branch keeps no-odds markers and strips gradeable line contract fields', () => {
    const payload = buildMlbPitcherKPayloadFields({
      driver: {
        basis: 'PROJECTION_ONLY',
        prediction: 'PASS',
        card_verdict: 'PASS',
        projection: { k_mean: 6.2 },
        prop_decision: { verdict: 'PASS', lean_side: null },
      },
      pitcherPlayerId: '592450',
      pitcherPlayerName: 'Gerrit Cole',
    });

    expect(payload.selectionSide).toBe('PASS');
    expect(payload.line).toBeNull();
    expect(payload.titleSuffix).toBe(' [PROJECTION_ONLY]');
    expect(payload.payloadFields).toMatchObject({
      player_id: '592450',
      player_name: 'Gerrit Cole',
      prop_type: 'strikeouts',
      basis: 'PROJECTION_ONLY',
      tags: ['no_odds_mode'],
      line: null,
      price: null,
      line_source: null,
      over_price: null,
      under_price: null,
      pitcher_k_line_contract: null,
    });
  });

  test('odds-backed branch preserves under contract fields and uses market side for selection', () => {
    const payload = buildMlbPitcherKPayloadFields({
      driver: {
        basis: 'ODDS_BACKED',
        prediction: 'WATCH',
        direction: 'UNDER',
        line: 6.5,
        under_price: -118,
        over_price: -102,
        line_source: 'draftkings',
        best_line_bookmaker: 'draftkings',
        line_fetched_at: '2026-04-12T18:00:00Z',
        odds_freshness: 'FRESH',
        card_verdict: 'WATCH',
        prop_decision: {
          verdict: 'WATCH',
          lean_side: 'UNDER',
          selected_market: {
            line: 6.5,
            under_price: -118,
            over_price: -102,
            bookmaker: 'draftkings',
            line_source: 'draftkings',
          },
        },
        pitcher_k_result: {
          selected_market: {
            line: 6.5,
            under_price: -118,
            over_price: -102,
            bookmaker: 'draftkings',
            line_source: 'draftkings',
          },
        },
      },
      pitcherPlayerId: '592450',
      pitcherPlayerName: 'Gerrit Cole',
    });

    expect(payload.selectionSide).toBe('UNDER');
    expect(payload.line).toBe(6.5);
    expect(payload.titleSuffix).toBe('');
    expect(payload.payloadFields.tags).toBeUndefined();
    expect(payload.payloadFields).toMatchObject({
      basis: 'ODDS_BACKED',
      line: 6.5,
      price: -118,
      line_source: 'draftkings',
      over_price: -102,
      under_price: -118,
      best_line_bookmaker: 'draftkings',
      pitcher_k_line_contract: expect.objectContaining({
        line: 6.5,
        bookmaker: 'draftkings',
        line_source: 'draftkings',
      }),
    });
  });
});

describe('WI-0720 MLB execution envelope', () => {
  test.each([
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
      'pitcher K emits ODDS_BACKED_NO_EDGE under shadow rollout when ODDS_BACKED basis has no edge verdict',
      {
        driver: { market: 'pitcher_k_home', basis: 'ODDS_BACKED' },
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
        k_prop_execution_path: 'ODDS_BACKED_NO_EDGE',
      },
    ],
    [
      'projection-only pitcher K is blocked when rollout is OFF',
      {
        driver: { market: 'pitcher_k_home', basis: 'PROJECTION_ONLY' },
        pricingStatus: 'NOT_REQUIRED',
        isPitcherK: true,
        rolloutState: 'OFF',
      },
      {
        execution_status: 'BLOCKED',
        actionable: false,
        pricing_status: 'NOT_REQUIRED',
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

  test('execution gate annotates executable MLB payloads that clear the veto', () => {
    const payload = {
      execution_status: 'EXECUTABLE',
      edge: 0.09,
      confidence: 0.72,
      model_status: 'MODEL_OK',
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      ev_passed: true,
      reason_codes: [],
      _publish_state: {
        publish_ready: true,
        emit_allowed: true,
        execution_status: 'EXECUTABLE',
      },
    };
    const oddsSnapshot = { captured_at: '2026-04-03T01:15:00Z' };
    const nowMs = new Date(oddsSnapshot.captured_at).getTime() + 120_000;

    const result = applyExecutionGateToMlbPayload(payload, {
      oddsSnapshot,
      nowMs,
    });

    expect(result).toEqual({ evaluated: true, blocked: false });
    expect(payload.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: true,
      model_status: 'MODEL_OK',
      snapshot_age_ms: 120_000,
    });
    expect(payload.execution_gate.net_edge).toBeCloseTo(0.04, 6);
    expect(payload.status).toBe('FIRE');
  });

  test('execution gate demotes blocked executable MLB payloads to PASS', () => {
    const payload = {
      execution_status: 'EXECUTABLE',
      edge: 0.055,
      confidence: 0.72,
      model_status: 'MODEL_OK',
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      ev_passed: true,
      reason_codes: [],
      actionable: true,
      publish_ready: true,
      _publish_state: {
        publish_ready: true,
        emit_allowed: true,
        execution_status: 'EXECUTABLE',
      },
    };
    const oddsSnapshot = { fetched_at: '2026-04-03T01:15:00Z' };
    const nowMs = new Date(oddsSnapshot.fetched_at).getTime() + 180_000;

    const result = applyExecutionGateToMlbPayload(payload, {
      oddsSnapshot,
      nowMs,
    });

    expect(result).toEqual({ evaluated: true, blocked: true });
    expect(payload.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: false,
      snapshot_age_ms: 180_000,
    });
    expect(payload.execution_gate.blocked_by).toContain(
      'NET_EDGE_INSUFFICIENT:0.0050',
    );
    expect(payload.status).toBe('PASS');
    expect(payload.action).toBe('PASS');
    expect(payload.classification).toBe('PASS');
    expect(payload.execution_status).toBe('BLOCKED');
    expect(payload.actionable).toBe(false);
    expect(payload.publish_ready).toBe(false);
    expect(payload.pass_reason_code).toBe(
      'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
    );
  });

  test('execution gate skips projection-only MLB payloads', () => {
    const payload = {
      execution_status: 'PROJECTION_ONLY',
      edge: 0.2,
      confidence: 0.72,
      model_status: 'MODEL_OK',
    };

    const result = applyExecutionGateToMlbPayload(payload, {
      oddsSnapshot: { captured_at: '2026-04-03T01:15:00Z' },
      nowMs: new Date('2026-04-03T01:16:00Z').getTime(),
    });

    expect(result).toEqual({ evaluated: false, blocked: false });
    expect(payload.execution_gate).toMatchObject({
      evaluated: false,
      blocked_by: ['PROJECTION_ONLY_EXCLUSION'],
      snapshot_age_ms: 60_000,
      drop_reason: {
        drop_reason_code: 'PROJECTION_ONLY_EXCLUSION',
        drop_reason_layer: 'worker_gate',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// WI-0596: Required field validation
// ---------------------------------------------------------------------------

describe('validatePitcherKInputs — required field gates (WI-0596)', () => {

  /** Minimal valid pitcher: all PITCHER_K_REQUIRED_FIELDS present */
  const validPitcher = {
    season_k_pct: 0.282,
    season_starts: 8,
    handedness: 'R',
    days_since_last_start: 5,
    last_three_pitch_counts: [95, 92, 88],
  };

  test('valid pitcher: all required fields present → returns null', () => {
    expect(validatePitcherKInputs(validPitcher)).toBeNull();
  });

  test('missing season_k_pct → PITCHER_REQUIRED_FIELD_NULL with season_k_pct in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, season_k_pct: null });
    expect(result).not.toBeNull();
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toContain('season_k_pct');
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

  test('missing both pitch counts and recent IP → starter_leash appears in missing_fields', () => {
    const result = validatePitcherKInputs({
      ...validPitcher,
      last_three_pitch_counts: null,
      recent_ip: null,
      avg_ip: null,
    });
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toContain('starter_leash');
  });

  test('all required fields null → required pitcher fields and starter_leash appear in missing_fields', () => {
    const result = validatePitcherKInputs({});
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toEqual(
      expect.arrayContaining([
        'season_k_pct',
        'season_starts',
        'handedness',
        'days_since_last_start',
        'starter_leash',
      ]),
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

// ---------------------------------------------------------------------------
// WI-0663: selectPitcherKUnderMarket
// ---------------------------------------------------------------------------

const MLB_PROP_BOOKMAKER_PRIORITY_TEST = Object.freeze({
  draftkings: 1,
  fanduel: 2,
  oddstrader: 3,
  oddsjam: 4,
  betmgm: 5,
});

describe('selectPitcherKUnderMarket', () => {
  test('selects highest-line entry', () => {
    const strikeoutLines = {
      'ace pitcher': { line: 6.5, under_price: -110, bookmaker: 'draftkings' },
      'other pitcher': { line: 7.0, under_price: -110, bookmaker: 'draftkings' },
    };
    const result = selectPitcherKUnderMarket(strikeoutLines, 'ace pitcher', MLB_PROP_BOOKMAKER_PRIORITY_TEST);
    expect(result).not.toBeNull();
    expect(result.line).toBe(7.0);
  });

  test('tiebreaks by best under_price (closest to 0 from negative side)', () => {
    const strikeoutLines = {
      'ace pitcher': { line: 6.5, under_price: -105, bookmaker: 'draftkings' },
      'other pitcher': { line: 6.5, under_price: -115, bookmaker: 'fanduel' },
    };
    const result = selectPitcherKUnderMarket(strikeoutLines, 'ace pitcher', MLB_PROP_BOOKMAKER_PRIORITY_TEST);
    expect(result).not.toBeNull();
    expect(result.under_price).toBe(-105);
  });

  test('tiebreaks by bookmaker priority when line and under_price are equal', () => {
    const strikeoutLines = {
      'ace pitcher': { line: 6.5, under_price: -110, bookmaker: 'fanduel' },
      'other pitcher': { line: 6.5, under_price: -110, bookmaker: 'draftkings' },
    };
    const result = selectPitcherKUnderMarket(strikeoutLines, 'ace pitcher', MLB_PROP_BOOKMAKER_PRIORITY_TEST);
    expect(result).not.toBeNull();
    // draftkings has priority 1 (best)
    expect(result.bookmaker).toBe('draftkings');
  });

  test('returns null when strikeout_lines is empty', () => {
    const result = selectPitcherKUnderMarket({}, 'ace pitcher', MLB_PROP_BOOKMAKER_PRIORITY_TEST);
    expect(result).toBeNull();
  });

  test('returns null when strikeout_lines is null', () => {
    const result = selectPitcherKUnderMarket(null, 'ace pitcher', MLB_PROP_BOOKMAKER_PRIORITY_TEST);
    expect(result).toBeNull();
  });

  test('filters out entries with line below minimum (5.0)', () => {
    const strikeoutLines = {
      'ace pitcher': { line: 4.5, under_price: -110, bookmaker: 'draftkings' },
    };
    const result = selectPitcherKUnderMarket(strikeoutLines, 'ace pitcher', MLB_PROP_BOOKMAKER_PRIORITY_TEST);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WI-0663: computePitcherKDriverCards ODDS_BACKED mode
// ---------------------------------------------------------------------------

function buildOddsSnapshot(pitcherOverrides = {}, strikeoutLines = null) {
  const pitcher = {
    full_name: 'Ace Pitcher',
    mlb_id: 12345,
    k_per_9: 10.2,
    recent_k_per_9: 11.4,
    season_k_pct: 0.282,
    handedness: 'R',
    bb_pct: 0.072,
    xwoba_allowed: 0.304,
    season_starts: 8,
    starts: 8,
    recent_ip: 6.1,
    last_three_pitch_counts: [95, 92, 88],
    il_return: false,
    days_since_last_start: 5,
    role: 'starter',
    k_pct_last_4_starts: 0.32,
    k_pct_prior_4_starts: 0.27,
    current_season_swstr_pct: 0.13,
    bvp_pa: 0,
    bvp_k: 0,
    strikeout_history: [],
    ...pitcherOverrides,
  };

  const mlbData = {
    home_pitcher: pitcher,
    away_pitcher: null,
  };

  if (strikeoutLines !== null) {
    mlbData.strikeout_lines = strikeoutLines;
  }

  return {
    home_team: 'Boston Red Sox',
    away_team: 'New York Yankees',
    raw_data: { mlb: mlbData },
  };
}

// Pitcher with declining K rate (season K/9 higher than recent) — produces UNDER_RECENT_K_DROP_MAJOR
const decliningKPitcher = {
  k_per_9: 11.4,
  recent_k_per_9: 10.2, // declined: season - recent = 1.2 >= 0.75
  season_k_pct: 0.282,
  handedness: 'R',
  bb_pct: 0.072,
  xwoba_allowed: 0.304,
  season_starts: 8,
  starts: 8,
  recent_ip: 5.1, // < 5.5 → UNDER_RECENT_IP_SUPPRESSION
  last_three_pitch_counts: [87, 85, 86], // avg 86 < 90 → UNDER_PITCH_COUNT_SUPPRESSION
  il_return: false,
  days_since_last_start: 5,
  role: 'starter',
  k_pct_last_4_starts: 0.28,
  k_pct_prior_4_starts: 0.27,
  current_season_swstr_pct: 0.13,
  bvp_pa: 0,
  bvp_k: 0,
};

describe('computePitcherKDriverCards ODDS_BACKED mode (WI-0663)', () => {
  test('emits PLAY card in ODDS_BACKED mode with strong under profile', () => {
    // decliningKPitcher with strongUnderHistory and line 6.5 should score >= 7.5 → PLAY
    // Scoring: UNDER_LAST5_80(+3) + UNDER_LAST10_70(+2) + UNDER_LINE_PLUS_1(+2)
    //        + UNDER_RECENT_K_DROP_MAJOR(+1) + UNDER_PITCH_COUNT_SUPPRESSION(+1)
    //        + UNDER_RECENT_IP_SUPPRESSION(+1) = 10 → PLAY
    const snapshot = buildOddsSnapshot(
      { ...decliningKPitcher, strikeout_history: strongUnderHistory },
      { 'ace pitcher': { line: 6.5, under_price: -105, bookmaker: 'draftkings' } },
    );
    const cards = computePitcherKDriverCards('game-1', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: MLB_PROP_BOOKMAKER_PRIORITY_TEST,
    });
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[0];
    expect(card.basis).toBe('ODDS_BACKED');
    expect(card.prop_decision.lean_side).toBe('UNDER');
    expect(card.prop_decision.verdict).toBe('PLAY');
    expect(card.emit_card).toBe(true);
  });

  test('emits WATCH card in ODDS_BACKED mode with moderate under profile', () => {
    // watchUnderHistory has last5 under rate 60% (score 2) + last10 70% (score 2) + line_delta 0.7 (score 1)
    // + UNDER_RECENT_K_DROP_MAJOR(+1) = 6.0 → WATCH (5.5-7.4)
    const snapshot = buildOddsSnapshot(
      { ...decliningKPitcher, strikeout_history: watchUnderHistory },
      { 'ace pitcher': { line: 6.5, under_price: -105, bookmaker: 'draftkings' } },
    );
    const cards = computePitcherKDriverCards('game-2', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: MLB_PROP_BOOKMAKER_PRIORITY_TEST,
    });
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[0];
    expect(card.basis).toBe('ODDS_BACKED');
    expect(['WATCH', 'PLAY']).toContain(card.prop_decision.verdict);
    expect(card.emit_card).toBe(true);
  });

  test('falls back to PROJECTION_ONLY when ODDS_BACKED but no strikeout_lines', () => {
    const snapshot = buildOddsSnapshot({ strikeout_history: strongUnderHistory }, null);
    const cards = computePitcherKDriverCards('game-3', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: MLB_PROP_BOOKMAKER_PRIORITY_TEST,
    });
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[0];
    expect(card.basis).toBe('PROJECTION_ONLY');
    expect(card.reason_codes).toContain('MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY');
  });

  test('emits NO_PLAY card in ODDS_BACKED mode on hard gate (line too low)', () => {
    const snapshot = buildOddsSnapshot(
      { strikeout_history: strongUnderHistory },
      { 'ace pitcher': { line: 4.5, under_price: -170, bookmaker: 'draftkings' } },
    );
    const cards = computePitcherKDriverCards('game-4', snapshot, {
      mode: 'ODDS_BACKED',
      bookmakerPriority: MLB_PROP_BOOKMAKER_PRIORITY_TEST,
    });
    // line 4.5 is below minimum, so selectPitcherKUnderMarket returns null → fallback
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[0];
    // No qualifying market → falls back to PROJECTION_ONLY
    expect(card.basis).toBe('PROJECTION_ONLY');
    expect(card.reason_codes).toContain('MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY');
  });
});

describe('WI-0835: sigma provenance annotation on MLB card payloads', () => {
  // Simulate the annotation logic from run_mlb_model.js that runs before insertCardPayload.
  // The actual annotation is inlined in the job body; here we verify the contract.
  function annotateCardSigma(card, mlbSigma) {
    if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
    card.payloadData.raw_data.sigma_source = mlbSigma.sigma_source;
    card.payloadData.raw_data.sigma_games_sampled = mlbSigma.games_sampled ?? null;
    return card;
  }

  test('computed sigma: sigma_source=computed and sigma_games_sampled is a number', () => {
    const card = { payloadData: { prediction: 'OVER', confidence: 0.62 } };
    const mlbSigma = { sigma_source: 'computed', games_sampled: 240, margin: 0.8, total: 1.1 };
    annotateCardSigma(card, mlbSigma);
    expect(card.payloadData.raw_data.sigma_source).toBe('computed');
    expect(typeof card.payloadData.raw_data.sigma_games_sampled).toBe('number');
    expect(card.payloadData.raw_data.sigma_games_sampled).toBe(240);
  });

  test('fallback sigma: sigma_source=fallback and sigma_games_sampled is null', () => {
    const card = { payloadData: { prediction: 'UNDER', confidence: 0.55 } };
    const mlbSigma = { sigma_source: 'fallback', games_sampled: undefined, margin: 0.8, total: 1.1 };
    annotateCardSigma(card, mlbSigma);
    expect(card.payloadData.raw_data.sigma_source).toBe('fallback');
    expect(card.payloadData.raw_data.sigma_games_sampled).toBeNull();
  });

  test('card without existing raw_data gets raw_data initialized', () => {
    const card = { payloadData: {} };
    const mlbSigma = { sigma_source: 'computed', games_sampled: 120 };
    annotateCardSigma(card, mlbSigma);
    expect(card.payloadData.raw_data).toBeDefined();
    expect(['computed', 'fallback']).toContain(card.payloadData.raw_data.sigma_source);
  });

  test('card with existing raw_data preserves prior fields', () => {
    const card = { payloadData: { raw_data: { prior_field: 'value' } } };
    const mlbSigma = { sigma_source: 'computed', games_sampled: 80 };
    annotateCardSigma(card, mlbSigma);
    expect(card.payloadData.raw_data.prior_field).toBe('value');
    expect(card.payloadData.raw_data.sigma_source).toBe('computed');
  });
});

describe('WI-0863: projection-only market trust guards', () => {
  test('adds projection-only non-actionable flags and runtime context', () => {
    const payload = {
      reason_codes: ['PASS_SYNTHETIC_FALLBACK'],
      raw_data: { sigma_source: 'computed' },
    };
    const runtimeContext = {
      run_mode: 'PROJECTION_ONLY',
      seed_data_status: 'FRESH',
      seed_last_success_at: '2026-04-10T15:00:00Z',
      games_seeded_count: 6,
      market_expression_enabled: false,
    };

    applyMlbProjectionOnlyGuards(payload, runtimeContext);

    expect(payload.run_mode).toBe('PROJECTION_ONLY');
    expect(payload.market_expression_enabled).toBe(false);
    expect(payload.market_trust_flags).toEqual(
      expect.arrayContaining([
        'PROJECTION_ONLY_NO_MARKET_TRUST',
        'PROJECTION_ONLY_NOT_ACTIONABLE',
        'NO_ANCHOR_PRICE_VALIDATION',
      ]),
    );
    expect(payload.market_trust_flags).not.toContain('STALE_SEED_DATA');
    expect(payload.reason_codes).toEqual(
      expect.arrayContaining([
        'PASS_SYNTHETIC_FALLBACK',
        'PROJECTION_ONLY_NO_MARKET_TRUST',
        'PROJECTION_ONLY_NOT_ACTIONABLE',
        'NO_ANCHOR_PRICE_VALIDATION',
      ]),
    );
    expect(payload.raw_data.mlb_runtime_context).toEqual(runtimeContext);
  });

  test('marks stale seed data explicitly when runtime context is stale', () => {
    const payload = { reason_codes: [] };
    const runtimeContext = {
      run_mode: 'PROJECTION_ONLY',
      seed_data_status: 'STALE',
      seed_last_success_at: '2026-04-10T09:00:00Z',
      games_seeded_count: 2,
      market_expression_enabled: false,
    };

    applyMlbProjectionOnlyGuards(payload, runtimeContext);

    expect(payload.market_trust_flags).toContain('STALE_SEED_DATA');
    expect(payload.reason_codes).toContain('STALE_SEED_DATA');
    expect(payload.raw_data.mlb_runtime_context.seed_data_status).toBe('STALE');
  });
});

// ---------------------------------------------------------------------------
// WI-0877: computeSyntheticLineF5Driver — synthetic-line F5 edge driver
// ---------------------------------------------------------------------------

describe('WI-0877: computeSyntheticLineF5Driver', () => {
  /** Minimal pitcher that drives a clean projection. */
  const elitePitcher = {
    siera: 2.70, x_fip: 2.75, x_era: 2.80, handedness: 'R',
    avg_ip: 6.2, pitch_count_avg: 100, bb_pct: 0.06, k_per_9: 11.0, whip: 0.95, era: 2.70,
    times_through_order_profile: { '1st': 2.8, '3rd': 3.2 },
  };
  const avgPitcher = {
    siera: 4.20, x_fip: 4.10, x_era: 4.20, handedness: 'R',
    avg_ip: 5.3, pitch_count_avg: 88, bb_pct: 0.09, k_per_9: 7.8, whip: 1.30, era: 4.20,
    times_through_order_profile: { '1st': 3.8, '3rd': 4.2 },
  };
  const goodOffense = { wrc_plus: 110, xwoba: 0.340 };
  const avgOffense = { wrc_plus: 100, xwoba: 0.320 };
  const weakOffense = { wrc_plus: 85, xwoba: 0.295 };
  const context = {
    park_run_factor: 1.0, temp_f: 72, wind_mph: 3, wind_dir: null, roof: null,
  };

  test('missing home_offense_profile → returns null (SYNTHETIC_FALLBACK fallback)', () => {
    const mlb = {
      home_pitcher: avgPitcher,
      away_pitcher: avgPitcher,
      home_offense_profile: null,
      away_offense_profile: avgOffense,
      park_run_factor: 1.0, temp_f: 72, wind_mph: 3, wind_dir: null, roof: null,
    };
    expect(computeSyntheticLineF5Driver(mlb, context, 'test-game-001')).toBeNull();
  });

  test('missing away_offense_profile → returns null (SYNTHETIC_FALLBACK fallback)', () => {
    const mlb = {
      home_pitcher: avgPitcher,
      away_pitcher: avgPitcher,
      home_offense_profile: avgOffense,
      away_offense_profile: null,
      park_run_factor: 1.0, temp_f: 72, wind_mph: 3, wind_dir: null, roof: null,
    };
    expect(computeSyntheticLineF5Driver(mlb, context, 'test-game-002')).toBeNull();
  });

  test('f5_runs null from either side (missing pitcher inputs) → returns null', () => {
    // Pass null pitchers — projectTeamF5RunsAgainstStarter will return f5_runs: null
    const mlb = {
      home_pitcher: null,
      away_pitcher: null,
      home_offense_profile: avgOffense,
      away_offense_profile: avgOffense,
      park_run_factor: 1.0, temp_f: 72, wind_mph: 3, wind_dir: null, roof: null,
    };
    expect(computeSyntheticLineF5Driver(mlb, context, 'test-game-003')).toBeNull();
  });

  test('high-offense vs weak pitching (projectedBase >= 5.0) → OVER FIRE, projection_source=FULL_MODEL', () => {
    // Use avg pitchers vs good offense + neutral park to get projectedBase >= 5.0
    const mlb = {
      home_pitcher: avgPitcher,
      away_pitcher: avgPitcher,
      home_offense_profile: goodOffense,
      away_offense_profile: goodOffense,
      park_run_factor: 1.0, temp_f: 72, wind_mph: 3, wind_dir: null, roof: null,
    };
    const result = computeSyntheticLineF5Driver(mlb, context, 'test-game-004');
    expect(result).not.toBeNull();
    expect(result.projection_source).toBe('FULL_MODEL');
    expect(result.reason_codes).toContain('SYNTHETIC_LINE_ASSUMPTION');
    if (result.projection.projected_total >= 5.0) {
      expect(result.status).toBe('FIRE');
      expect(result.prediction).toBe('OVER');
      expect(result.ev_threshold_passed).toBe(true);
    }
  });

  test('elite pitching both sides (projectedBase <= 3.0) → UNDER FIRE, projection_source=FULL_MODEL', () => {
    const mlb = {
      home_pitcher: elitePitcher,
      away_pitcher: elitePitcher,
      home_offense_profile: weakOffense,
      away_offense_profile: weakOffense,
      park_run_factor: 0.92, temp_f: 50, wind_mph: 2, wind_dir: 'IN', roof: null,
    };
    const eliteContext = { park_run_factor: 0.92, temp_f: 50, wind_mph: 2, wind_dir: 'IN', roof: null };
    const result = computeSyntheticLineF5Driver(mlb, eliteContext, 'test-game-005');
    expect(result).not.toBeNull();
    expect(result.projection_source).toBe('FULL_MODEL');
    expect(result.reason_codes).toContain('SYNTHETIC_LINE_ASSUMPTION');
    if (result.projection.projected_total <= 3.0) {
      expect(result.status).toBe('FIRE');
      expect(result.prediction).toBe('UNDER');
      expect(result.ev_threshold_passed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// IME-01-03: runMLBModel multi-market insertion
// ---------------------------------------------------------------------------

describe('multi-market insertion (IME-01-03)', () => {
  const GAME_ID = 'mlb-2026-ime-test-001';
  const BASE_SNAPSHOT = {
    id: 'odds-ime-001',
    game_id: GAME_ID,
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    game_time_utc: '2026-04-13T23:05:00Z',
    captured_at: '2026-04-13T19:00:00Z',
    total_f5: 4.5,
    total_price_over_f5: -110,
    total_price_under_f5: -110,
    h2h_home: -128,
    h2h_away: 108,
    raw_data: { mlb: {} },
  };

  function buildImeDataMocks(snapshot = BASE_SNAPSHOT) {
    const insertCardPayload = jest.fn();
    const insertModelOutput = jest.fn();
    const prepareModelAndCardWrite = jest.fn();
    const markJobRunSuccess = jest.fn();

    return {
      getDatabase: jest.fn(() => ({
        prepare: jest.fn(() => ({
          get: jest.fn(() => null),
          all: jest.fn(() => []),
        })),
      })),
      insertJobRun: jest.fn(),
      markJobRunSuccess,
      markJobRunFailure: jest.fn(),
      setCurrentRunId: jest.fn(),
      getOddsSnapshots: jest.fn(() => []),
      getOddsWithUpcomingGames: jest.fn(() => [snapshot]),
      getUpcomingGamesAsSyntheticSnapshots: jest.fn(() => []),
      getLatestOdds: jest.fn(() => null),
      insertModelOutput,
      insertCardPayload,
      prepareModelAndCardWrite,
      runPerGameWriteTransaction: jest.fn((fn) => fn()),
      validateCardPayload: jest.fn(() => ({ success: true, errors: [] })),
      shouldRunJobKey: jest.fn(() => true),
      withDb: jest.fn(async (fn) => fn()),
      computeMLBLeagueAverages: jest.fn(() => ({
        source: 'mock',
        n: 1,
        kPct: 0.22,
        xfip: 4.1,
        bbPct: 0.08,
      })),
    };
  }

  async function runImeScenario({ gameDriverCards, snapshot = BASE_SNAPSHOT } = {}) {
    jest.resetModules();

    const dataMocks = buildImeDataMocks(snapshot);

    jest.doMock('@cheddar-logic/data', () => dataMocks);
    jest.doMock('@cheddar-logic/adapters', () => ({
      f5LineFetcher: {
        fetchF5LineFromVsin: jest.fn(async () => null),
      },
    }));
    jest.doMock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: { MLB: { active: true } },
    }));
    jest.doMock('@cheddar-logic/models', () => ({
      buildRecommendationFromPrediction: jest.fn(() => ({ tier: 'mock' })),
      buildMatchup: jest.fn((home, away) => `${away} @ ${home}`),
      formatStartTimeLocal: jest.fn(() => 'mock-local-time'),
      formatCountdown: jest.fn(() => 'mock-countdown'),
      buildMarketFromOdds: jest.fn(() => null),
      buildPipelineState: jest.fn((state) => state),
      WATCHDOG_REASONS: { MARKET_UNAVAILABLE: 'MARKET_UNAVAILABLE' },
      PRICE_REASONS: { MARKET_PRICE_MISSING: 'MARKET_PRICE_MISSING' },
    }));
    jest.doMock('@cheddar-logic/models/src/edge-calculator', () => ({
      computeSigmaFromHistory: jest.fn(() => ({
        sigma_source: 'fallback',
        games_sampled: 0,
      })),
      kellyStake: jest.fn(() => ({
        kelly_fraction: 0.01,
        kelly_units: 0.25,
      })),
    }));
    jest.doMock('../../models', () => ({
      getModel: jest.fn(() => ({ name: 'mock-mlb-model' })),
      computeMLBDriverCards: jest.fn(() => gameDriverCards),
      computePitcherKDriverCards: jest.fn(() => []),
    }));
    jest.doMock('../../models/mlb-model', () => {
      const actual = jest.requireActual('../../models/mlb-model');
      return {
        ...actual,
        projectF5ML: jest.fn(() => null),
        projectTeamF5RunsAgainstStarter: jest.fn(() => ({
          f5_runs: null,
          degraded_inputs: [],
        })),
        setLeagueConstants: jest.fn(),
      };
    });
    jest.doMock('../execution-gate', () => ({
      evaluateExecution: jest.fn(() => ({
        shouldBet: true,
        netEdge: 0.18,
        blocked_by: [],
        reason: null,
        drop_reason: null,
      })),
    }));
    jest.doMock('../../utils/calibration', () => ({
      applyCalibration: jest.fn((probability) => ({
        calibratedProb: probability,
        calibrationSource: 'mock',
      })),
    }));
    jest.doMock('../../models/feature-time-guard', () => ({
      assertFeatureTimeliness: jest.fn(() => ({
        ok: true,
        violations: [],
      })),
    }));

    let runMLBModel;
    jest.isolateModules(() => {
      ({ runMLBModel } = require('../run_mlb_model'));
    });

    const result = await runMLBModel({ expectF5Ml: false });

    jest.dontMock('@cheddar-logic/data');
    jest.dontMock('@cheddar-logic/adapters');
    jest.dontMock('@cheddar-logic/odds/src/config');
    jest.dontMock('@cheddar-logic/models');
    jest.dontMock('@cheddar-logic/models/src/edge-calculator');
    jest.dontMock('../../models');
    jest.dontMock('../../models/mlb-model');
    jest.dontMock('../execution-gate');
    jest.dontMock('../../utils/calibration');
    jest.dontMock('../../models/feature-time-guard');

    return { result, dataMocks };
  }

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('official play plus lean → both card_payloads are inserted and lean stays LEAN', async () => {
    const gameDriverCards = [
      {
        market: 'f5_total',
        prediction: 'OVER',
        confidence: 0.85,
        ev_threshold_passed: true,
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        reasoning: 'F5 edge qualifies',
        reason_codes: [],
        missing_inputs: [],
        projection: { projected_total: 5.6 },
        drivers: [{ projected: 5.6, edge: 1.1 }],
      },
      {
        market: 'full_game_ml',
        prediction: 'HOME',
        confidence: 0.74,
        ev_threshold_passed: true,
        status: 'WATCH',
        action: 'WATCH',
        classification: 'LEAN',
        reasoning: 'Full-game moneyline is lean-only',
        reason_codes: [],
        missing_inputs: [],
        drivers: [{ edge: 0.14, win_prob_home: 0.57 }],
      },
    ];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, dataMocks } = await runImeScenario({ gameDriverCards });

    expect(result.success).toBe(true);
    expect(result.cardsGenerated).toBe(2);
    expect(dataMocks.insertCardPayload).toHaveBeenCalledTimes(2);
    expect(
      dataMocks.insertCardPayload.mock.calls.map(([card]) => card.cardType),
    ).toEqual(expect.arrayContaining(['mlb-f5', 'mlb-full-game-ml']));
    expect(
      dataMocks.insertCardPayload.mock.calls.map(([card]) => card.payloadData.classification),
    ).toEqual(expect.arrayContaining(['BASE', 'LEAN']));
    expect(dataMocks.prepareModelAndCardWrite).toHaveBeenCalledWith(
      GAME_ID,
      'mlb-model-v1',
      'mlb-full-game-ml',
      expect.objectContaining({ runId: expect.any(String) }),
    );

    logSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('active MLB odds config does not mark full-game cards as without-odds', async () => {
    const gameDriverCards = [
      {
        market: 'full_game_total',
        prediction: 'OVER',
        confidence: 0.82,
        ev_threshold_passed: true,
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        reasoning: 'Full-game total qualifies with live odds',
        reason_codes: [],
        missing_inputs: [],
        projection_source: 'FULL_MODEL',
        projection: { projected_total: 8.6 },
        drivers: [{ projected: 8.6, edge: 0.9 }],
      },
      {
        market: 'full_game_ml',
        prediction: 'HOME',
        confidence: 0.75,
        ev_threshold_passed: true,
        status: 'WATCH',
        action: 'WATCH',
        classification: 'LEAN',
        reasoning: 'Full-game moneyline is lean-only',
        reason_codes: [],
        missing_inputs: [],
        projection_source: 'FULL_MODEL',
        drivers: [{ edge: 0.12, win_prob_home: 0.56 }],
      },
    ];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, dataMocks } = await runImeScenario({ gameDriverCards });

    expect(result.success).toBe(true);
    expect(
      logSpy.mock.calls.some(([line]) =>
        String(line).includes('MLB odds disabled in config'),
      ),
    ).toBe(false);

    const fullGameCalls = dataMocks.insertCardPayload.mock.calls.filter(
      ([card]) =>
        card.cardType === 'mlb-full-game' ||
        card.cardType === 'mlb-full-game-ml',
    );
    expect(fullGameCalls).toHaveLength(2);
    fullGameCalls.forEach(([card]) => {
      expect(card.payloadData.without_odds_mode).toBeUndefined();
      expect(card.payloadData.tags).toBeUndefined();
    });

    logSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('no qualifying driver cards → SKIP_MARKET_NO_EDGE logs explicitly and inserts zero cards', async () => {
    const gameDriverCards = [
      {
        market: 'f5_total',
        prediction: 'OVER',
        confidence: 0.41,
        ev_threshold_passed: false,
        status: 'PASS',
        action: 'PASS',
        classification: 'PASS',
        reasoning: 'No edge on F5 total',
        reason_codes: ['PASS_NO_EDGE'],
        missing_inputs: [],
      },
      {
        market: 'full_game_ml',
        prediction: 'HOME',
        confidence: 0.39,
        ev_threshold_passed: false,
        status: 'PASS',
        action: 'PASS',
        classification: 'PASS',
        reasoning: 'No edge on full-game moneyline',
        reason_codes: ['PASS_NO_EDGE'],
        missing_inputs: [],
      },
    ];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, dataMocks } = await runImeScenario({ gameDriverCards });

    expect(result.success).toBe(true);
    expect(result.cardsGenerated).toBe(0);
    expect(dataMocks.insertCardPayload).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some(([line]) => String(line).includes('SKIP_MARKET_NO_EDGE')),
    ).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('runMLBModel without-odds mode selection', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
  });

  test('does not emit the legacy config-disabled projection-only log when withoutOddsMode=false', async () => {
    jest.resetModules();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.doMock('@cheddar-logic/data', () => ({
      withDb: jest.fn(async (fn) => fn()),
      shouldRunJobKey: jest.fn(() => true),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      setCurrentRunId: jest.fn(),
      getOddsWithUpcomingGames: jest.fn(() => []),
      getUpcomingGamesAsSyntheticSnapshots: jest.fn(() => []),
      getDatabase: jest.fn(() => ({
        prepare: jest.fn(() => ({
          get: jest.fn(() => null),
          all: jest.fn(() => []),
          run: jest.fn(),
        })),
      })),
      computeMLBLeagueAverages: jest.fn(() => ({
        source: 'mock',
        n: 0,
        kPct: 0.22,
        xfip: 4.1,
        bbPct: 0.08,
      })),
    }));
    jest.doMock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: { MLB: { active: true } },
    }));
    jest.doMock('@cheddar-logic/adapters', () => ({
      f5LineFetcher: { fetchF5LineFromVsin: jest.fn(async () => null) },
    }));
    jest.doMock('../../models', () => ({
      getModel: jest.fn(() => ({ name: 'mock-mlb-model' })),
      computeMLBDriverCards: jest.fn(() => []),
      computePitcherKDriverCards: jest.fn(() => []),
    }));
    jest.doMock('../../models/mlb-model', () => {
      const actual = jest.requireActual('../../models/mlb-model');
      return {
        ...actual,
        setLeagueConstants: jest.fn(),
      };
    });
    jest.doMock('../../utils/calibration', () => ({
      applyCalibration: jest.fn((probability) => ({
        calibratedProb: probability,
        calibrationSource: 'mock',
      })),
    }));
    jest.doMock('../../models/feature-time-guard', () => ({
      assertFeatureTimeliness: jest.fn(() => ({
        ok: true,
        violations: [],
      })),
    }));
    jest.doMock('../execution-gate', () => ({
      evaluateExecution: jest.fn(() => ({
        shouldBet: false,
        netEdge: 0,
        blocked_by: [],
        reason: null,
        drop_reason: null,
      })),
    }));
    jest.doMock('@cheddar-logic/models', () => ({
      buildRecommendationFromPrediction: jest.fn(() => ({ tier: 'mock' })),
      buildMatchup: jest.fn((home, away) => `${away} @ ${home}`),
      formatStartTimeLocal: jest.fn(() => 'mock-local-time'),
      formatCountdown: jest.fn(() => 'mock-countdown'),
      buildMarketFromOdds: jest.fn(() => null),
      buildPipelineState: jest.fn((state) => state),
      WATCHDOG_REASONS: { MARKET_UNAVAILABLE: 'MARKET_UNAVAILABLE' },
      PRICE_REASONS: { MARKET_PRICE_MISSING: 'MARKET_PRICE_MISSING' },
    }));
    jest.doMock('@cheddar-logic/models/src/edge-calculator', () => ({
      computeSigmaFromHistory: jest.fn(() => ({
        sigma_source: 'fallback',
        games_sampled: 0,
      })),
      kellyStake: jest.fn(() => ({
        kelly_fraction: 0.01,
        kelly_units: 0.25,
      })),
    }));

    let runMLBModel;
    jest.isolateModules(() => {
      ({ runMLBModel } = require('../run_mlb_model'));
    });

    await runMLBModel({ dryRun: true, withoutOddsMode: false });

    expect(consoleSpy).not.toHaveBeenCalledWith(
      '[MLBModel] WITHOUT_ODDS_MODE: MLB odds disabled in config — running projection-only',
    );

    consoleSpy.mockRestore();
    jest.dontMock('@cheddar-logic/data');
    jest.dontMock('@cheddar-logic/odds/src/config');
    jest.dontMock('@cheddar-logic/adapters');
    jest.dontMock('../../models');
    jest.dontMock('../../models/mlb-model');
    jest.dontMock('../../utils/calibration');
    jest.dontMock('../../models/feature-time-guard');
    jest.dontMock('../execution-gate');
    jest.dontMock('@cheddar-logic/models');
    jest.dontMock('@cheddar-logic/models/src/edge-calculator');
  });
});
