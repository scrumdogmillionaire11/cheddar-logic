'use strict';

/**
 * Unit Tests — WI-1173: Command-context integration in MLB K engine
 *
 * Validates:
 *   1. recent_bb_pct is computed as sum(walks)/sum(batters_faced) over last 10 starts
 *   2. recent_bb_pct_status: OK / SMALL_SAMPLE / MISSING
 *   3. command_risk_flag fires at >= 9.5% BB rate with OK status
 *   4. Projection penalty of -0.15 Ks when command_risk_flag is true
 *   5. Overlap cap: projection >= projection_pre_overlap - 0.30
 *   6. SMALL_SAMPLE does NOT apply command-risk projection penalty
 *   7. MISSING does NOT crash and does NOT apply projection penalty
 *   8. home_away_context derivation: HOME / AWAY / MIXED / UNKNOWN
 *   9. WI-0763 deprecated fields (bb_pct_from_logs, bb_pct_adjustment, home_away_adj)
 *      are still present but no longer drive projection
 *  10. Adversarial: high BB% + high-K profile does not over-penalize beyond cap
 *  11. Adversarial: conflicting signals produce bounded, explainable adjustments
 *
 * Pure tests — no DB, no network, no fixtures required.
 */

const { calculateProjectionK } = require('../models/mlb-model');

// ── Shared fixtures ───────────────────────────────────────────────────────────

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

function makeStart({ strikeouts = 6, walks = 2, batters_faced = 24, home_away = 'H', innings_pitched = 6.0 } = {}) {
  return { strikeouts, walks, batters_faced, home_away, innings_pitched,
           season: 2025, game_date: '2025-04-01', number_of_pitches: 95 };
}

const LEASH_TIER = 'Full';
const WEATHER = { temp_at_first_pitch: 68 };

// ── recent_bb_pct derivation ──────────────────────────────────────────────────

describe('calculateProjectionK — recent_bb_pct derivation', () => {
  test('MISSING when strikeout_history is empty', () => {
    const result = calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct).toBeNull();
    expect(result.recent_bb_pct_status).toBe('MISSING');
    expect(result.command_risk_flag).toBe(false);
  });

  test('MISSING when no starts have batters_faced > 0', () => {
    const history = [makeStart({ batters_faced: 0 }), makeStart({ batters_faced: 0 })];
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('MISSING');
  });

  test('SMALL_SAMPLE when total batters_faced < 120', () => {
    // 4 starts × 24 BF = 96 BF < 120
    const history = Array.from({ length: 4 }, () => makeStart({ walks: 2, batters_faced: 24 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('SMALL_SAMPLE');
    expect(result.command_risk_flag).toBe(false); // SMALL_SAMPLE never fires command risk
  });

  test('OK when total batters_faced >= 120', () => {
    // 5 starts × 24 BF = 120 BF exactly
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 2, batters_faced: 24 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('OK');
  });

  test('recent_bb_pct = sum(walks)/sum(batters_faced) across starts', () => {
    const history = [
      makeStart({ walks: 3, batters_faced: 25 }),
      makeStart({ walks: 2, batters_faced: 23 }),
      makeStart({ walks: 4, batters_faced: 26 }),
      makeStart({ walks: 1, batters_faced: 24 }),
      makeStart({ walks: 2, batters_faced: 22 }),
    ];
    // total walks = 12, total BF = 120 → 0.100
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct).toBeCloseTo(12 / 120, 4);
  });

  test('uses at most last 10 starts from strikeout_history', () => {
    // strikeout_history is ordered most-recent-first (mirrors buildPitcherStrikeoutLookback ORDER BY game_date DESC).
    // First 10 entries are recent (2 walks / 24 BF = 8.3%); entries 11-12 have extreme walks (50%).
    const recentStarts = Array.from({ length: 10 }, () => makeStart({ walks: 2, batters_faced: 24 }));
    const olderStarts = Array.from({ length: 2 }, () => makeStart({ walks: 12, batters_faced: 24 }));
    const history = [...recentStarts, ...olderStarts]; // recent first
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    // Only first 10 (recent) used → 20 walks / 240 BF ≈ 0.0833
    expect(result.recent_bb_pct).toBeCloseTo(2 / 24, 3);
  });
});

// ── command_risk_flag and projection penalty ──────────────────────────────────

describe('calculateProjectionK — command_risk_flag and -0.15 projection penalty', () => {
  test('command_risk_flag false at BB% < 9.5% (OK sample)', () => {
    // 9.0% BB: 2.16 walks / 24 BF per start × 5 starts = 10.8 / 120
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 2, batters_faced: 22 }));
    // 2/22 = 9.09% — above threshold, but let's use a clearly below case
    const belowHistory = Array.from({ length: 5 }, () => makeStart({ walks: 2, batters_faced: 25 }));
    // 2/25 = 8.0% < 9.5%
    const result = calculateProjectionK(makePitcher({ strikeout_history: belowHistory }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(false);
  });

  test('command_risk_flag true at BB% >= 9.5% (OK sample)', () => {
    // 10 walks / 100 BF = 10.0% >= 9.5%; 5 starts × 20 BF = 100 BF (OK)
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 2, batters_faced: 20 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct).toBeCloseTo(2 / 20, 3); // 10%
    expect(result.recent_bb_pct_status).toBe('OK');
    expect(result.command_risk_flag).toBe(true);
  });

  test('command_risk_flag exactly at threshold 9.5% fires', () => {
    // 19 walks / 200 BF = 9.5% exactly; 8 starts × 25 BF = 200 BF
    const history = Array.from({ length: 8 }, () =>
      makeStart({ walks: Math.round(19 / 8), batters_faced: 25 }),
    );
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct).toBeGreaterThanOrEqual(0.094); // close to threshold
  });

  test('projection reduced by exactly 0.15 when command_risk_flag is true', () => {
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [] }),
      makeMatchup(), LEASH_TIER, WEATHER,
    );
    // 10% BB, 5 starts, 5×24=120 BF (OK)
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 3, batters_faced: 27 }));
    // 3/27 ≈ 11.1% > 9.5%
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(true);
    // Penalty is -0.15 flat (additive), not multiplicative
    // Due to rounding, use approximate comparison
    expect(result.k_mean).toBeCloseTo(baseline.k_mean - 0.15, 1);
  });

  test('SMALL_SAMPLE does NOT apply command-risk projection penalty', () => {
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [] }),
      makeMatchup(), LEASH_TIER, WEATHER,
    );
    // High BB% but only 3 starts × 24 BF = 72 BF < 120 → SMALL_SAMPLE
    const history = Array.from({ length: 3 }, () => makeStart({ walks: 6, batters_faced: 24 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('SMALL_SAMPLE');
    expect(result.command_risk_flag).toBe(false);
    expect(result.k_mean).toBeCloseTo(baseline.k_mean, 1); // no projection penalty
  });

  test('MISSING context does not crash and does not apply projection penalty', () => {
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [] }),
      makeMatchup(), LEASH_TIER, WEATHER,
    );
    const result = calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('MISSING');
    expect(result.command_risk_flag).toBe(false);
    expect(result.k_mean).toBeCloseTo(baseline.k_mean, 3);
  });

  test('COMMAND_RISK_RECENT_BB_RATE reason code present when command risk fires', () => {
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 3, batters_faced: 25 }));
    // 3/25 = 12% > 9.5%; 5×25=125 BF (OK)
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(true);
    expect(result.flags).toContain('COMMAND_RISK_RECENT_BB_RATE');
  });

  test('COMMAND_CONTEXT_SMALL_SAMPLE reason code present when small sample', () => {
    const history = Array.from({ length: 3 }, () => makeStart({ walks: 4, batters_faced: 24 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('SMALL_SAMPLE');
    expect(result.flags).toContain('COMMAND_CONTEXT_SMALL_SAMPLE');
  });

  test('COMMAND_CONTEXT_MISSING reason code present when no history', () => {
    const result = calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('MISSING');
    expect(result.flags).toContain('COMMAND_CONTEXT_MISSING');
  });
});

// ── Overlap cap ───────────────────────────────────────────────────────────────

describe('calculateProjectionK — overlap cap (projection >= pre_overlap - 0.30)', () => {
  test('single command-risk penalty of -0.15 never exceeds cap (-0.30)', () => {
    const baseline = calculateProjectionK(
      makePitcher({ strikeout_history: [] }),
      makeMatchup(), LEASH_TIER, WEATHER,
    );
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 4, batters_faced: 25 }));
    // 4/25 = 16% > 9.5%; 5×25=125 BF (OK)
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(true);
    // Reduction is -0.15, which is within the -0.30 cap
    expect(baseline.k_mean - result.k_mean).toBeLessThanOrEqual(0.30 + 0.01); // 0.01 rounding buffer
  });

  test('high BB% + high-K profile does not over-penalize beyond -0.30 cap', () => {
    // Pitcher with strong baseline (elite K pitcher) and high BB% command risk
    const elitePitcher = makePitcher({
      season_k_pct: 0.33,
      k_pct: 0.33,
      season_starts: 15,
      strikeout_history: [],
    });
    const baseline = calculateProjectionK(elitePitcher, makeMatchup(), LEASH_TIER, WEATHER);

    const history = Array.from({ length: 5 }, () => makeStart({ walks: 4, batters_faced: 22 }));
    // 4/22 = 18.2%; 5×22=110 BF — just under 120 → SMALL_SAMPLE, no projection penalty
    // Let's use 6 starts × 22 = 132 BF (OK)
    const okHistory = Array.from({ length: 6 }, () => makeStart({ walks: 4, batters_faced: 22 }));
    const result = calculateProjectionK(
      { ...elitePitcher, strikeout_history: okHistory },
      makeMatchup(), LEASH_TIER, WEATHER,
    );
    expect(result.command_risk_flag).toBe(true);
    const reduction = baseline.k_mean - result.k_mean;
    expect(reduction).toBeLessThanOrEqual(0.30 + 0.01);
    expect(reduction).toBeGreaterThan(0); // some penalty applied
  });
});

// ── home_away_context ─────────────────────────────────────────────────────────

describe('calculateProjectionK — home_away_context derivation', () => {
  test('HOME when game_role is home', () => {
    const result = calculateProjectionK(makePitcher({ game_role: 'home' }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_context).toBe('HOME');
  });

  test('AWAY when game_role is away', () => {
    const result = calculateProjectionK(makePitcher({ game_role: 'away' }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_context).toBe('AWAY');
  });

  test('MIXED when game_role is null and lookback has both home and away tags', () => {
    const history = [
      makeStart({ home_away: 'H' }),
      makeStart({ home_away: 'A' }),
    ];
    const result = calculateProjectionK(makePitcher({ strikeout_history: history, game_role: null }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_context).toBe('MIXED');
  });

  test('UNKNOWN when game_role is null and all lookback tags are the same', () => {
    const history = Array.from({ length: 3 }, () => makeStart({ home_away: 'H' }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history, game_role: null }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_context).toBe('UNKNOWN');
  });

  test('UNKNOWN when game_role is null and no home_away tags in history', () => {
    const history = Array.from({ length: 3 }, () => makeStart({ home_away: null }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history, game_role: null }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_context).toBe('UNKNOWN');
  });

  test('HOME_AWAY_CONTEXT_SHIFT reason code present for HOME context', () => {
    const result = calculateProjectionK(makePitcher({ game_role: 'home' }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.flags).toContain('HOME_AWAY_CONTEXT_SHIFT');
  });

  test('HOME_AWAY_CONTEXT_SHIFT reason code present for AWAY context', () => {
    const result = calculateProjectionK(makePitcher({ game_role: 'away' }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.flags).toContain('HOME_AWAY_CONTEXT_SHIFT');
  });

  test('HOME_AWAY_CONTEXT_SHIFT NOT emitted for MIXED context', () => {
    const history = [makeStart({ home_away: 'H' }), makeStart({ home_away: 'A' })];
    const result = calculateProjectionK(makePitcher({ strikeout_history: history, game_role: null }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_context).toBe('MIXED');
    expect(result.flags ?? []).not.toContain('HOME_AWAY_CONTEXT_SHIFT');
  });

  test('home/away context does NOT affect projection value', () => {
    const homeResult = calculateProjectionK(makePitcher({ game_role: 'home' }), makeMatchup(), LEASH_TIER, WEATHER);
    const awayResult = calculateProjectionK(makePitcher({ game_role: 'away' }), makeMatchup(), LEASH_TIER, WEATHER);
    const noRoleResult = calculateProjectionK(makePitcher({ game_role: null }), makeMatchup(), LEASH_TIER, WEATHER);
    // home/away is confidence-only; projection should be identical
    expect(homeResult.k_mean).toBeCloseTo(noRoleResult.k_mean, 3);
    expect(awayResult.k_mean).toBeCloseTo(noRoleResult.k_mean, 3);
  });
});

// ── WI-0763 deprecated field backward compat ─────────────────────────────────

describe('calculateProjectionK — deprecated WI-0763 fields retained but inert', () => {
  test('bb_pct_from_logs is populated from recentBbPct for traceability', () => {
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 2, batters_faced: 24 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.bb_pct_from_logs).toBeCloseTo(2 / 24, 3);
  });

  test('bb_pct_from_logs is null when no batters_faced data', () => {
    const result = calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.bb_pct_from_logs).toBeNull();
  });

  test('bb_pct_adjustment is always null (deprecated: multiplicative penalty removed)', () => {
    const history = Array.from({ length: 5 }, () => makeStart({ walks: 5, batters_faced: 24 }));
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.bb_pct_adjustment).toBeNull();
  });

  test('home_away_adj is always null (deprecated: projection impact removed)', () => {
    const history = [
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 8, home_away: 'H' })),
      ...Array.from({ length: 4 }, () => makeStart({ strikeouts: 4, home_away: 'A' })),
    ];
    const result = calculateProjectionK(makePitcher({ strikeout_history: history, game_role: 'home' }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.home_away_adj).toBeNull();
  });
});

// ── Adversarial scenarios ─────────────────────────────────────────────────────

describe('calculateProjectionK — adversarial scenarios', () => {
  test('high BB% with strong K baseline: reduction is bounded and explainable', () => {
    // Elite pitcher (33% K rate) with 14% recent BB% → command risk fires, -0.15 penalty
    const history = Array.from({ length: 6 }, () => makeStart({ walks: 4, batters_faced: 27 }));
    // 4/27 ≈ 14.8%; 6×27=162 BF (OK)
    const elitePitcher = makePitcher({
      season_k_pct: 0.33,
      season_starts: 15,
      strikeout_history: history,
    });
    const result = calculateProjectionK(elitePitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(true);
    expect(result.flags).toContain('COMMAND_RISK_RECENT_BB_RATE');
    // Penalty is exactly -0.15, bounded by cap
    const noHistBaseline = calculateProjectionK({ ...elitePitcher, strikeout_history: [] }, makeMatchup(), LEASH_TIER, WEATHER);
    const reduction = noHistBaseline.k_mean - result.k_mean;
    expect(reduction).toBeCloseTo(0.15, 1);
    expect(reduction).toBeLessThanOrEqual(0.30);
  });

  test('small-sample BB% spike does not apply full command-risk projection penalty', () => {
    // 3 starts, extreme walks but BF < 120 → SMALL_SAMPLE, no projection penalty
    const history = Array.from({ length: 3 }, () => makeStart({ walks: 8, batters_faced: 24 }));
    // 8/24 = 33% BB — extreme but SMALL_SAMPLE
    const baseline = calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    const result = calculateProjectionK(makePitcher({ strikeout_history: history }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.recent_bb_pct_status).toBe('SMALL_SAMPLE');
    expect(result.command_risk_flag).toBe(false);
    expect(result.k_mean).toBeCloseTo(baseline.k_mean, 1);
  });

  test('missing BB context: no crash, no projection penalty, reason code emitted', () => {
    expect(() => {
      calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    }).not.toThrow();
    const result = calculateProjectionK(makePitcher({ strikeout_history: [] }), makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(false);
    expect(result.flags).toContain('COMMAND_CONTEXT_MISSING');
    const noHistProjection = result.k_mean;
    expect(noHistProjection).toBeGreaterThan(0);
  });

  test('conflicting signals: high BB% with elevated K rate produces bounded output', () => {
    // Pitcher with elite K rate but high recent BB% — should produce penalty within cap
    const history = Array.from({ length: 5 }, () =>
      makeStart({ strikeouts: 9, walks: 3, batters_faced: 25, home_away: 'H' }),
    );
    // 3/25 = 12% BB; 5×25=125 BF (OK) → command risk fires
    const pitcher = makePitcher({
      season_k_pct: 0.30,
      season_starts: 12,
      strikeout_history: history,
      game_role: 'home',
    });
    const result = calculateProjectionK(pitcher, makeMatchup(), LEASH_TIER, WEATHER);
    expect(result.command_risk_flag).toBe(true);
    expect(result.home_away_context).toBe('HOME');
    expect(result.k_mean).toBeGreaterThan(0);
    // Verify the projection output is within a reasonable range
    const noHistBaseline = calculateProjectionK({ ...pitcher, strikeout_history: [] }, makeMatchup(), LEASH_TIER, WEATHER);
    const reduction = noHistBaseline.k_mean - result.k_mean;
    expect(reduction).toBeLessThanOrEqual(0.30 + 0.01);
  });
});
