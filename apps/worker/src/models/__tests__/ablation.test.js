'use strict';

const { projectF5Total, projectF5TotalCard } = require('../mlb-model');
const { predictNHLGame } = require('../nhl-pace-model');
const { makeCanonicalGoalieState } = require('../nhl-goalie-state');
const { projectNBACanonical } = require('../projections');

const mlbHomePitcher = {
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
  times_through_order_profile: { '1st': 0.296, '2nd': 0.312, '3rd': 0.337 },
};

const mlbAwayPitcher = {
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
  times_through_order_profile: { '1st': 0.302, '2nd': 0.319, '3rd': 0.346 },
};

const mlbContext = {
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

function confirmedGoalieState(teamSide) {
  return makeCanonicalGoalieState({
    game_id: 'game-1',
    team_side: teamSide,
    starter_state: 'CONFIRMED',
    starter_source: 'USER_INPUT',
    goalie_name: `${teamSide}-goalie`,
    goalie_tier: 'STRONG',
    tier_confidence: 'HIGH',
    evidence_flags: [],
  });
}

function buildNhlFixture(overrides = {}) {
  return {
    homeGoalsFor: 3.2,
    homeGoalsAgainst: 3.0,
    awayGoalsFor: 3.1,
    awayGoalsAgainst: 2.9,
    homePaceFactor: 1.03,
    awayPaceFactor: 1.01,
    homePpPct: 0.24,
    awayPpPct: 0.21,
    homePkPct: 0.81,
    awayPkPct: 0.79,
    homeGoalieSavePct: 0.913,
    awayGoalieSavePct: 0.908,
    homeGoalieGsax: 0.35,
    awayGoalieGsax: -0.1,
    homeGoalieConfirmed: true,
    awayGoalieConfirmed: true,
    homeGoalieCertainty: 'CONFIRMED',
    awayGoalieCertainty: 'CONFIRMED',
    homeGoalieState: confirmedGoalieState('home'),
    awayGoalieState: confirmedGoalieState('away'),
    homeB2B: false,
    awayB2B: false,
    restDaysHome: 1,
    restDaysAway: 1,
    homeGoalsForL5: 3.5,
    awayGoalsForL5: 2.8,
    homeGoalsAgainstL5: 2.7,
    awayGoalsAgainstL5: 3.2,
    ...overrides,
  };
}

describe('MLB F5 Total ablation coverage', () => {
  test('missing starter skill path remains load-bearing upstream', () => {
    const ablated = projectF5Total(
      mlbHomePitcher,
      {
        ...mlbAwayPitcher,
        siera: null,
        x_fip: null,
        x_era: null,
      },
      mlbContext,
    );

    expect(ablated.status).toBe('NO_BET');
    expect(ablated.missingCritical).toContain('starter_skill_ra9_home');
  });

  test('missing offense split remains load-bearing upstream', () => {
    const ablated = projectF5Total(mlbHomePitcher, mlbAwayPitcher, {
      ...mlbContext,
      home_offense_profile: {
        ...mlbContext.home_offense_profile,
        wrc_plus_vs_lhp: null,
        wrc_plus: null,
      },
    });

    expect(ablated.status).toBe('NO_BET');
    expect(ablated.missingCritical).toContain('wrc_plus_vs_hand_home');
  });

  test('weather ablation degrades card metadata without changing card-tier status semantics', () => {
    const baseline = projectF5Total(
      mlbHomePitcher,
      mlbAwayPitcher,
      mlbContext,
    );
    const degraded = projectF5TotalCard(
      mlbHomePitcher,
      mlbAwayPitcher,
      baseline.base - 0.8,
      {
        ...mlbContext,
        temp_f: null,
        wind_mph: null,
        wind_dir: null,
      },
    );

    expect(degraded).not.toBeNull();
    expect(degraded.market).toBe('MLB_F5_TOTAL');
    expect(degraded.model_status).toBe('DEGRADED');
    expect(degraded.status).toMatch(/^(FIRE|WATCH|PASS)$/);
    expect(degraded.missingOptional).toEqual(
      expect.arrayContaining(['home_weather', 'away_weather']),
    );
  });
});

describe('NHL Total ablation coverage', () => {
  test('special teams inputs are load-bearing for confidence and observability', () => {
    const full = predictNHLGame(buildNhlFixture());
    const ablated = predictNHLGame(
      buildNhlFixture({
        homePpPct: null,
        awayPpPct: null,
        homePkPct: null,
        awayPkPct: null,
      }),
    );

    expect(ablated.confidence).toBeLessThan(full.confidence);
    expect(ablated.missingOptional).toEqual(
      expect.arrayContaining(['homePpPct', 'awayPpPct', 'homePkPct', 'awayPkPct']),
    );
    expect(ablated.market).toBe('NHL_TOTAL');
  });

  test('recency blend inputs affect confidence and are surfaced in missingOptional', () => {
    const full = predictNHLGame(buildNhlFixture());
    const ablated = predictNHLGame(
      buildNhlFixture({
        homeGoalsForL5: null,
        awayGoalsForL5: null,
        homeGoalsAgainstL5: null,
        awayGoalsAgainstL5: null,
      }),
    );

    expect(ablated.confidence).toBeLessThan(full.confidence);
    expect(ablated.missingOptional).toEqual(
      expect.arrayContaining([
        'homeGoalsForL5',
        'awayGoalsForL5',
        'homeGoalsAgainstL5',
        'awayGoalsAgainstL5',
      ]),
    );
  });

  test('unknown goalies degrade model status and cap confidence', () => {
    const ablated = predictNHLGame(
      buildNhlFixture({
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: false,
        homeGoalieCertainty: 'UNKNOWN',
        awayGoalieCertainty: 'UNKNOWN',
        homeGoalieState: null,
        awayGoalieState: null,
      }),
    );

    expect(ablated.model_status).toBe('DEGRADED');
    expect(ablated.goalieConfidenceCapped).toBe(true);
    expect(ablated.confidence).toBeLessThanOrEqual(0.35);
  });
});

describe('NBA Canonical ablation coverage', () => {
  test('missing pace remains a hard NO_BET gate', () => {
    const result = projectNBACanonical(115, 110, null, 112, 108, 100, 0);

    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('homePace');
  });

  test('missing offense remains a hard NO_BET gate', () => {
    const result = projectNBACanonical(115, 110, 101, null, 108, 100, 0);

    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('awayOffRtg');
  });

  test('pace synergy adjustment changes canonical total while preserving additive metadata', () => {
    const baseline = projectNBACanonical(118, 110, 104, 116, 109, 102, 0);
    const boosted = projectNBACanonical(118, 110, 104, 116, 109, 102, 1.2);

    expect(boosted.projectedTotal).toBeGreaterThan(baseline.projectedTotal);
    expect(boosted.market).toBe('NBA_TOTAL');
    expect(boosted.model_status).toBe('MODEL_OK');
    expect(boosted.featuresUsed.paceAdjustment).toBe(1.2);
  });
});
