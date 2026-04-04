'use strict';

/**
 * Unit Tests — WI-0763: BB% and home/away split adjustments in MLB K engine
 *
 * Validates:
 *   1. calculateProjectionK applies a down-weight when bb_pct_from_logs > 10%
 *   2. calculateProjectionK applies home/away split when ≥ 3 starts in each bucket
 *   3. Neither adjustment fires when data is absent or sample is thin
 *
 * Pure tests — no DB, no network, no fixtures required.
 */

const { calculateProjectionK } = require('../models/mlb-model');

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Minimal pitcher that passes all early gates */
function makePitcher(overrides = {}) {
  return {
    season_starts: 10,
    handedness: 'R',
    season_k_pct: 0.26,
    k_pct: 0.26,
    bb_pct: 0.08,
    xwoba_allowed: 0.315,
    recent_ip: 5.5,
    avg_ip: 5.5,
    last_three_pitch_counts: [95, 98, 92],
    season_swstr_pct: 0.12,
    swstr_pct: 0.12,
    current_season_swstr_pct: 0.12,
    season_avg_velo: null,
    strikeout_history: [],
    game_role: null,
    ...overrides,
  };
}

/** Matchup with full opponent data to avoid thin-sample paths */
function makeMatchup(overrides = {}) {
  return {
    opp_k_pct_vs_handedness_l30: 0.23,
    opp_k_pct_vs_handedness_l30_pa: 280,
    opp_obp: 0.315,
    opp_xwoba: 0.310,
    opp_hard_hit_pct: 38.0,
    park_k_factor: 1.0,
    ...overrides,
  };
}

/** Build a game-log start */
function makeStart({ strikeouts = 6, walks = 2, batters_faced = 24, home_away = 'H', innings_pitched = 6.0 } = {}) {
  return { strikeouts, walks, batters_faced, home_away, innings_pitched,
           season: 2025, game_date: '2025-04-01', number_of_pitches: 95 };
}

const LEASH_TIER = 'Full';
const WEATHER = { temp_at_first_pitch: 68 };

// ── BB% adjustment tests ──────────────────────────────────────────────────────

describe('calculateProjectionK — BB% adjustment from game logs', () => {
  test('no adjustment when strikeout_history is empty', () => {
    const pitcher = makePitcher({ strikeout_history: [] });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.bb_pct_from_logs).toBeNull();
    expect(result.bb_pct_adjustment).toBeNull();
  });

  test('no adjustment when fewer than 3 starts have batters_faced > 0', () => {
    const history = [
      makeStart({ walks: 3, batters_faced: 24 }),
      makeStart({ walks: 3, batters_faced: 24 }),
    ];
    const pitcher = makePitcher({ strikeout_history: history });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.bb_pct_from_logs).toBeNull();
    expect(result.bb_pct_adjustment).toBeNull();
  });

  test('no adjustment when bb_pct_from_logs <= 10%', () => {
    // ~8% BB rate (2 walks per 24 BF)
    const history = Array.from({ length: 5 }, () =>
      makeStart({ walks: 2, batters_faced: 24 }),
    );
    const pitcher = makePitcher({ strikeout_history: history });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.bb_pct_from_logs).toBeCloseTo(2 / 24, 3);
    expect(result.bb_pct_adjustment).toBeNull(); // no adjustment since ≤ 10%
  });

  test('down-weights K projection when bb_pct_from_logs > 10%', () => {
    // Baseline projection without high BB history
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [] }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );

    // ~14% BB rate (3.5 walks per 25 BF) — clearly > 10%
    const highWalkHistory = Array.from({ length: 6 }, () =>
      makeStart({ walks: 4, batters_faced: 27 }),
    );
    const pitcher = makePitcher({ strikeout_history: highWalkHistory });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);

    expect(result.bb_pct_from_logs).toBeGreaterThan(0.10);
    expect(result.bb_pct_adjustment).not.toBeNull();
    expect(result.bb_pct_adjustment).toBeLessThan(1.0);
    // K mean should be strictly lower than the baseline
    expect(result.k_mean).toBeLessThan(baseline.k_mean);
  });

  test('bb_pct_adjustment is clamped to minimum 0.88', () => {
    // Extreme BB rate — ~25% — should be clamped
    const extremeHistory = Array.from({ length: 6 }, () =>
      makeStart({ walks: 7, batters_faced: 27 }),
    );
    const pitcher = makePitcher({ strikeout_history: extremeHistory });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    // formula: clamp(1 - (0.259 - 0.10) * 2.5, 0.88, 1.0) = clamp(0.603, 0.88, 1.0) = 0.88
    expect(result.bb_pct_adjustment).toBeCloseTo(0.88, 2);
  });
});

// ── Home/away split adjustment tests ─────────────────────────────────────────

describe('calculateProjectionK — home/away split from game logs', () => {
  test('no adjustment when game_role is null', () => {
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 8, home_away: 'H' })),
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 4, home_away: 'A' })),
    ];
    const pitcher = makePitcher({ strikeout_history: history, game_role: null });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_adj).toBeNull();
  });

  test('no adjustment when fewer than 3 starts in either split bucket', () => {
    // only 2 away starts
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 7, home_away: 'H' })),
      ...Array.from({ length: 2 }, () => makeStart({ strikeouts: 4, home_away: 'A' })),
    ];
    const pitcher = makePitcher({ strikeout_history: history, game_role: 'away' });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_adj).toBeNull();
  });

  test('home start receives up-weight when pitcher K-rate is higher at home', () => {
    // Home: avg 8 Ks, Away: avg 4 Ks → total avg 6 Ks
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 8, home_away: 'H' })),
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 4, home_away: 'A' })),
    ];
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [], game_role: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const pitcher = makePitcher({ strikeout_history: history, game_role: 'home' });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);

    expect(result.home_away_adj).not.toBeNull();
    expect(result.home_away_adj).toBeGreaterThan(1.0); // blended up-weight
    expect(result.k_mean).toBeGreaterThanOrEqual(baseline.k_mean);
  });

  test('away start receives down-weight when pitcher K-rate is lower away', () => {
    // Home: avg 8 Ks, Away: avg 4 Ks → pitcher is worse away
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 8, home_away: 'H' })),
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 4, home_away: 'A' })),
    ];
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [], game_role: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const pitcher = makePitcher({ strikeout_history: history, game_role: 'away' });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);

    expect(result.home_away_adj).not.toBeNull();
    expect(result.home_away_adj).toBeLessThan(1.0); // blended down-weight
    expect(result.k_mean).toBeLessThanOrEqual(baseline.k_mean);
  });

  test('home/away split adjustment is within ±10% band of unadjusted kMean', () => {
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 9, home_away: 'H' })),
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 3, home_away: 'A' })),
    ];
    // Extreme ratio: 9/3 = 3 → clamped rawRatio = 0.80 for away
    const awayPitcher = makePitcher({ strikeout_history: history, game_role: 'away' });
    const awayResult = calculateProjectionK(awayPitcher, makeMatchup(), LEASH_TIER, WEATHER);
    // homeAwayAdjFactor = 0.70 + 0.80 * 0.30 = 0.94 → max 6% down-weight
    expect(awayResult.home_away_adj).toBeCloseTo(0.94, 2);

    // Extreme ratio: 9/3: home rawRatio = 1.20 (clamped)
    const homePitcher = makePitcher({ strikeout_history: history, game_role: 'home' });
    const homeResult = calculateProjectionK(homePitcher, makeMatchup(), LEASH_TIER, WEATHER);
    // homeAwayAdjFactor = 0.70 + 1.20 * 0.30 = 1.06 → max 6% up-weight
    expect(homeResult.home_away_adj).toBeCloseTo(1.06, 2);
  });

  test('accepts home_away = "home" / "away" string values in addition to H/A codes', () => {
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 7, home_away: 'home' })),
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 4, home_away: 'away' })),
    ];
    const pitcher = makePitcher({ strikeout_history: history, game_role: 'home' });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_adj).not.toBeNull();
  });
});

// ── Both adjustments applied together ────────────────────────────────────────

describe('calculateProjectionK — BB% + home/away both applied', () => {
  test('both adjustments compound: high-walk pitcher pitching away receives double down-weight', () => {
    const history = [
      // high-walk away starts: ~14% BB + worse away
      ...Array.from({ length: 4 }, () =>
        makeStart({ strikeouts: 4, walks: 4, batters_faced: 27, home_away: 'A' }),
      ),
      // home starts: normal walk rate
      ...Array.from({ length: 4 }, () =>
        makeStart({ strikeouts: 7, walks: 2, batters_faced: 26, home_away: 'H' }),
      ),
    ];
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [], game_role: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const pitcher = makePitcher({ strikeout_history: history, game_role: 'away' });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);

    expect(result.bb_pct_adjustment).not.toBeNull();
    expect(result.home_away_adj).not.toBeNull();
    expect(result.k_mean).toBeLessThan(baseline.k_mean);
  });
});
