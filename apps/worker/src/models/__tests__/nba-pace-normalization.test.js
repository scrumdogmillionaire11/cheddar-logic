/**
 * WI-0822: NBA pace normalization unit tests.
 *
 * Verifies that projectNBACanonical correctly normalizes avgPoints to
 * per-100-possession ORtg/DRtg before applying the PPP × pace formula.
 */
const { projectNBACanonical } = require('../projections');

describe('WI-0822: NBA pace normalization — projectNBACanonical', () => {
  // Baseline: average-pace team (pace ≈ 100) — normalization is nearly identity
  const AVG_DEF_RTG = 110;
  const AVG_PACE = 100;

  test('fast-paced team (118 pts, 108 poss): homeOffRtgNorm ≈ 109.3, homeProjected lower than raw', () => {
    // Fast team: avgPoints=118 at pace=108 → per-100 ORtg = 118/108*100 ≈ 109.3
    const fast = projectNBACanonical(
      118, AVG_DEF_RTG, 108, // home: fast pace
      110, AVG_DEF_RTG, AVG_PACE, // away: average pace
      0,
    );
    expect(fast).not.toBeNull();
    expect(fast.status).toBeUndefined(); // no NO_BET

    // Raw (pre-fix) baseHomePPP would be (118 + 110) / 200 = 1.14 → 114 × pace
    // Normalised: homeOffRtgNorm = 109.26; baseHomePPP = (109.26 + 110) / 200 = 0.9613
    // homeProjected ≈ 104 — meaningfully lower
    const rawHomePPP = (118 + AVG_DEF_RTG) / 200;
    const rawHomeProjected = rawHomePPP * ((108 + AVG_PACE) / 2);
    expect(fast.homeProjected).toBeLessThan(rawHomeProjected);
  });

  test('slow-paced team (108 pts, 98 poss): homeOffRtgNorm ≈ 110.2, homeProjected higher than raw', () => {
    // Slow team: avgPoints=108 at pace=98 → per-100 ORtg = 108/98*100 ≈ 110.2
    const slow = projectNBACanonical(
      108, AVG_DEF_RTG, 98, // home: slow pace
      110, AVG_DEF_RTG, AVG_PACE, // away: average pace
      0,
    );
    expect(slow).not.toBeNull();
    expect(slow.status).toBeUndefined();

    // Raw: baseHomePPP = (108 + 110) / 200 = 1.09 → 109 pts
    // Normalised: homeOffRtgNorm = 110.2; baseHomePPP higher → homeProjected > raw
    const rawHomePPP = (108 + AVG_DEF_RTG) / 200;
    const rawHomeProjected = rawHomePPP * ((98 + AVG_PACE) / 2);
    expect(slow.homeProjected).toBeGreaterThan(rawHomeProjected);
  });

  test('same avgPoints but different pace → different homeProjected', () => {
    const fastResult = projectNBACanonical(
      118, AVG_DEF_RTG, 108,
      110, AVG_DEF_RTG, AVG_PACE,
      0,
    );
    const slowResult = projectNBACanonical(
      118, AVG_DEF_RTG, 98, // same avgPoints, different pace
      110, AVG_DEF_RTG, AVG_PACE,
      0,
    );
    expect(fastResult.homeProjected).not.toEqual(slowResult.homeProjected);
    // Fast team's adjusted efficiency (per-100) is lower → fast has lower homeProjected
    expect(fastResult.homeProjected).toBeLessThan(slowResult.homeProjected);
  });

  test('acceptance: projected total never exceeds 240 pts at max realistic synergy boost', () => {
    // Extreme high-offense dual-fast scenario.
    // Max realistic paceAdjustment from nba-pace-synergy is VERY_FAST_BOOST_FULL = 1.2 poss.
    // Before WI-0822, double-counting pace on fast teams could push totals to 260+.
    const result = projectNBACanonical(
      121, 112, 110, // home: very high-volume, very fast
      119, 111, 110, // away: same
      1.2, // VERY_FAST_BOOST_FULL (max synergy boost from nba-pace-synergy.js)
    );
    expect(result).not.toBeNull();
    expect(result.status).toBeUndefined();
    expect(result.projectedTotal).toBeLessThanOrEqual(240);
  });

  test('pace=100 teams: normalization is near-identity (≤0.5 pt change from raw total)', () => {
    // At pace=100, offRtgNorm = (pts/100)*100 = pts — formula should be unchanged
    const result = projectNBACanonical(115, 110, 100, 112, 108, 100, 0);
    const rawTotal = (115 + 108) / 200 * 100 + (112 + 110) / 200 * 100;
    expect(Math.abs(result.projectedTotal - rawTotal)).toBeLessThan(0.5);
  });

  test('NO_BET still returned when pace is null', () => {
    const result = projectNBACanonical(115, 110, null, 112, 108, 100, 0);
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('homePace');
  });
});
