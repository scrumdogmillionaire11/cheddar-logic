'use strict';

const { evaluateExecution } = require('../execution-gate');
const { applyDecisionVeto } = require('../../utils/decision-publisher');
const { computeMLBDriverCards } = require('../../models/mlb-model');
const { buildNhlModelSnapshot } = require('../run_nhl_model');

const awayPitcher = {
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

function buildPaceResult(overrides = {}) {
  return {
    homeExpected: 2.85,
    awayExpected: 2.6,
    expectedTotal: 5.45,
    rawTotalModel: 5.5,
    regressedTotalModel: 5.47,
    modifierBreakdown: {
      base_5v5_total: 5.01,
      special_teams_delta: 0.12,
      home_ice_delta: 0.08,
      rest_delta: -0.04,
      goalie_delta_raw: -0.3,
      goalie_delta_applied: -0.18,
      raw_modifier_total: -0.14,
      capped_modifier_total: -0.14,
      modifier_cap_applied: false,
    },
    homeGoalieCertainty: 'CONFIRMED',
    awayGoalieCertainty: 'EXPECTED',
    homeAdjustmentTrust: 'FULL',
    awayAdjustmentTrust: 'DEGRADED',
    official_eligible: true,
    first_period_model: {
      classification: 'PASS',
      reason_codes: ['NHL_1P_PASS_DEAD_ZONE'],
    },
    ...overrides,
  };
}

describe('negative-path execution and gate coverage', () => {
  test('stale snapshot blocks execution with explicit worker gate reason', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.08,
      confidence: 0.74,
      snapshotAgeMs: 6 * 60 * 1000,
    });

    expect(result.should_bet).toBe(false);
    expect(result.blocked_by[0]).toMatch(/^STALE_SNAPSHOT:/);
    expect(result.drop_reason).toMatchObject({
      drop_reason_code: 'STALE_SNAPSHOT_GATE',
      drop_reason_layer: 'worker_gate',
    });
  });

  test('selected play downgraded by gate preserves prior reasons and emits PASS', () => {
    const card = {
      action: 'FIRE',
      classification: 'BASE',
      status: 'FIRE',
      reason_codes: ['EDGE_CLEAR'],
      decision_v2: { official_status: 'PLAY' },
    };

    applyDecisionVeto(card, 'PASS_EXECUTION_GATE_BLOCKED');

    expect(card.action).toBe('PASS');
    expect(card.classification).toBe('PASS');
    expect(card.decision_v2.official_status).toBe('PASS');
    expect(card.reason_codes).toContain('EDGE_CLEAR');
    expect(card.reason_codes).toContain('PASS_EXECUTION_GATE_BLOCKED');
  });

  test('missing starter blocks MLB F5 card emission', () => {
    const cards = computeMLBDriverCards('mlb-f5-missing-sp-negative-path', {
      away_team: 'Boston Red Sox',
      home_team: 'New York Yankees',
      raw_data: {
        mlb: {
          f5_line: 4.5,
          home_pitcher: null,
          away_pitcher: awayPitcher,
          ...f5FullContext,
        },
      },
    });

    expect(cards).toHaveLength(0);
  });

  test('unknown-goalie executable total is blocked by invariant guard', () => {
    const payload = {
      game_id: 'nhl-negative-goalie',
      market_type: 'TOTAL',
      execution_status: 'EXECUTABLE',
      consistency: {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
      },
    };

    expect(() =>
      buildNhlModelSnapshot({
        paceResult: buildPaceResult({
          homeGoalieCertainty: 'UNKNOWN',
          homeAdjustmentTrust: 'NEUTRALIZED',
        }),
        payload,
        sigmaTotal: 1.8,
      }),
    ).toThrow(/INVARIANT_BREACH/);
  });
});
