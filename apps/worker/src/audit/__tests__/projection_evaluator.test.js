'use strict';

const {
  collectProjectionAlerts,
  evaluateProjectionRows,
  resolveActualValue,
  resolveDirection,
  resolvePredictionValue,
  classifyProxyEdge,
  gradeProxyMarket,
  buildProjectionProxyMarketRows,
} = require('../projection_evaluator');

function buildRow(overrides = {}) {
  return {
    card_family: 'NHL_PLAYER_SHOTS',
    execution_status: 'PROJECTION_ONLY',
    card_mode: 'PROJECTION_ONLY',
    model_version: 'test-v1',
    sport: 'NHL',
    payload: {
      decision: {
        model_projection: 3.8,
      },
      play: {
        player_id: '97',
        player_name: 'Connor McDavid',
        period: 'full_game',
        selection: {
          side: 'over',
        },
      },
    },
    game_result_metadata: {
      playerShots: {
        fullGameByPlayerId: {
          97: 5,
        },
        firstPeriodByPlayerId: {
          97: 1,
        },
        playerIdByNormalizedName: {
          'connor mcdavid': '97',
        },
      },
    },
    ...overrides,
  };
}

describe('projection_evaluator', () => {
  test('extracts projection, direction, and full-game NHL player shots actuals', () => {
    const row = buildRow();

    expect(resolvePredictionValue(row)).toBe(3.8);
    expect(resolveDirection(row)).toBe('OVER');
    expect(resolveActualValue(row)).toBe(5);
  });

  test('extracts NHL 1P totals from first-period result metadata', () => {
    const row = buildRow({
      card_family: 'NHL_1P_TOTAL',
      payload: {
        projection: {
          total: 1.7,
        },
        selection: {
          side: 'OVER',
        },
      },
      game_result_metadata: {
        firstPeriodScores: {
          home: 1,
          away: 1,
        },
      },
    });

    expect(resolvePredictionValue(row)).toBe(1.7);
    expect(resolveActualValue(row)).toBe(2);
  });

  test('extracts MLB F5 totals from game-result metadata', () => {
    const row = buildRow({
      card_family: 'MLB_F5_TOTAL',
      sport: 'MLB',
      payload: {
        projection: {
          projected_total: 4.2,
        },
        prediction: 'UNDER',
      },
      game_result_metadata: {
        f5_total: 3,
      },
    });

    expect(resolvePredictionValue(row)).toBe(4.2);
    expect(resolveDirection(row)).toBe('UNDER');
    expect(resolveActualValue(row)).toBe(3);
  });

  test('computes MAE, bias, directional accuracy, and calibration buckets', () => {
    const metrics = evaluateProjectionRows(
      [
        buildRow({
          payload: {
            decision: { model_projection: 3.8 },
            play: {
              player_id: '97',
              player_name: 'Connor McDavid',
              period: 'full_game',
              selection: { side: 'over' },
            },
          },
          game_result_metadata: {
            playerShots: {
              fullGameByPlayerId: { 97: 5 },
              firstPeriodByPlayerId: {},
              playerIdByNormalizedName: {},
            },
          },
        }),
        buildRow({
          payload: {
            decision: { model_projection: 2.2 },
            play: {
              player_id: '',
              player_name: 'Leon Draisaitl',
              period: 'full_game',
              selection: { side: 'under' },
            },
          },
          game_result_metadata: {
            playerShots: {
              fullGameByPlayerId: { 29: 1 },
              firstPeriodByPlayerId: {},
              playerIdByNormalizedName: {
                'leon draisaitl': '29',
              },
            },
          },
        }),
      ],
      'NHL_PLAYER_SHOTS',
    );

    expect(metrics).toMatchObject({
      actuals_available: true,
      bias: 0,
      directional_accuracy: 1,
      directional_sample_count: 2,
      mae: 1.2,
      sample_count: 2,
      rows_seen: 2,
    });
    expect(metrics.calibration_buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '2-4',
          count: 2,
          avg_projection: 3,
          avg_actual: 3,
        }),
      ]),
    );
  });

  test('marks MLB pitcher-K actuals unavailable when no durable settled actual exists', () => {
    const metrics = evaluateProjectionRows(
      [
        buildRow({
          card_family: 'MLB_PITCHER_K',
          sport: 'MLB',
          payload: {
            projection: {
              k_mean: 6.4,
            },
            selection: {
              side: 'OVER',
            },
          },
          game_result_metadata: {},
        }),
      ],
      'MLB_PITCHER_K',
    );

    expect(metrics).toMatchObject({
      actuals_available: false,
      bias: null,
      directional_accuracy: null,
      mae: null,
      missing_actual_count: 1,
      sample_count: 0,
      rows_seen: 1,
    });
  });

  test('emits projection alerts only for PROJECTION_ONLY windows with sufficient sample', () => {
    const rows = Array.from({ length: 30 }, () =>
      buildRow({
        card_family: 'NHL_1P_TOTAL',
        payload: {
          projection: { total: 1.0 },
          selection: { side: 'UNDER' },
        },
        game_result_metadata: {
          firstPeriodScores: { home: 2, away: 1 },
        },
      }),
    );

    const projectionSegment = {
      card_family: 'NHL_1P_TOTAL',
      card_mode: 'PROJECTION_ONLY',
      execution_status: 'PROJECTION_ONLY',
      model_version: 'nhl-v1',
      previous_model_version: null,
      projection_metrics: evaluateProjectionRows(rows, 'NHL_1P_TOTAL'),
      sport: 'NHL',
    };
    const alerts = collectProjectionAlerts(projectionSegment, 'season_to_date');

    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alert_type: 'PROJECTION_MAE_BREACH',
          severity: 'CRITICAL',
          threshold: 0.85,
          value: 2,
        }),
        expect.objectContaining({
          alert_type: 'PROJECTION_BIAS_BREACH',
          severity: 'CRITICAL',
          threshold: 0.4,
          value: -2,
        }),
        expect.objectContaining({
          alert_type: 'PROJECTION_DIRECTIONAL_ACCURACY_BREACH',
          severity: 'CRITICAL',
          threshold: 0.53,
          value: 0,
        }),
      ]),
    );
    expect(collectProjectionAlerts({
      ...projectionSegment,
      card_mode: 'ODDS_BACKED',
    }, 'season_to_date')).toHaveLength(0);
    expect(collectProjectionAlerts(projectionSegment, 'last_50')).toHaveLength(0);
  });
});

// ── Proxy-line grading — WI-0865 ─────────────────────────────────────────────

describe('classifyProxyEdge', () => {
  it('edge +1.32 → OVER STRONG LARGE', () => {
    expect(classifyProxyEdge(1.32)).toEqual({
      recommended_side: 'OVER', tier: 'STRONG', confidence_bucket: 'LARGE',
    });
  });
  it('edge -0.32 → UNDER LEAN SMALL', () => {
    expect(classifyProxyEdge(-0.32)).toEqual({
      recommended_side: 'UNDER', tier: 'LEAN', confidence_bucket: 'SMALL',
    });
  });
  it('edge +0.18 → PASS MICRO', () => {
    expect(classifyProxyEdge(0.18)).toEqual({
      recommended_side: 'PASS', tier: 'PASS', confidence_bucket: 'MICRO',
    });
  });
  it('edge 0.0 → PASS', () => {
    expect(classifyProxyEdge(0.0).tier).toBe('PASS');
  });
  it('edge -0.60 → UNDER PLAY MEDIUM', () => {
    expect(classifyProxyEdge(-0.60)).toEqual({
      recommended_side: 'UNDER', tier: 'PLAY', confidence_bucket: 'MEDIUM',
    });
  });
});

describe('gradeProxyMarket', () => {
  it('OVER, actual=5, line=3.5 → WIN hit=1', () => {
    expect(gradeProxyMarket('OVER', 5, 3.5)).toEqual({ graded_result: 'WIN', hit_flag: 1 });
  });
  it('OVER, actual=3, line=3.5 → LOSS hit=0', () => {
    expect(gradeProxyMarket('OVER', 3, 3.5)).toEqual({ graded_result: 'LOSS', hit_flag: 0 });
  });
  it('UNDER, actual=1, line=1.5 → WIN hit=1', () => {
    expect(gradeProxyMarket('UNDER', 1, 1.5)).toEqual({ graded_result: 'WIN', hit_flag: 1 });
  });
  it('UNDER, actual=2, line=1.5 → LOSS hit=0', () => {
    expect(gradeProxyMarket('UNDER', 2, 1.5)).toEqual({ graded_result: 'LOSS', hit_flag: 0 });
  });
  it('PASS, actual=5, line=3.5 → NO_BET hit=0', () => {
    expect(gradeProxyMarket('PASS', 5, 3.5)).toEqual({ graded_result: 'NO_BET', hit_flag: 0 });
  });
});

describe('buildProjectionProxyMarketRows', () => {
  function mlbRow(proj, actual, overrides = {}) {
    return {
      card_id: 'test-card',
      game_id: 'test-game',
      game_date: '2026-04-10',
      sport: 'baseball_mlb',
      card_family: 'MLB_F5_TOTAL',
      model_projection: proj,
      actual_result: JSON.stringify({ runs_f5: actual }),
      ...overrides,
    };
  }
  function nhlRow(proj, actual, overrides = {}) {
    return {
      card_id: 'test-card-nhl',
      game_id: 'test-game-nhl',
      game_date: '2026-04-10',
      sport: 'icehockey_nhl',
      card_family: 'NHL_1P_TOTAL',
      model_projection: proj,
      actual_result: JSON.stringify({ goals_1p: actual }),
      ...overrides,
    };
  }

  it('MLB F5: proj=4.82, actual=6 → 2 rows, both WIN, CONSENSUS_OVER', () => {
    const rows = buildProjectionProxyMarketRows(mlbRow(4.82, 6));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.graded_result === 'WIN')).toBe(true);
    expect(rows[0].agreement_group).toBe('CONSENSUS_OVER');
    expect(rows[1].agreement_group).toBe('CONSENSUS_OVER');
  });

  it('MLB F5: proj=2.90, actual=2 → 2 rows, CONSENSUS_UNDER, both WIN', () => {
    const rows = buildProjectionProxyMarketRows(mlbRow(2.90, 2));
    expect(rows).toHaveLength(2);
    expect(rows[0].agreement_group).toBe('CONSENSUS_UNDER');
    expect(rows.every((r) => r.graded_result === 'WIN')).toBe(true);
  });

  it('MLB F5: proj=4.10, actual=4 → SPLIT agreement', () => {
    const rows = buildProjectionProxyMarketRows(mlbRow(4.10, 4));
    expect(rows).toHaveLength(2);
    expect(rows[0].agreement_group).toBe('SPLIT');
  });

  it('MLB F5: proj=3.48, actual=6 → line 3.5 is PASS, line 4.5 is UNDER', () => {
    const rows = buildProjectionProxyMarketRows(mlbRow(3.48, 6));
    expect(rows).toHaveLength(2);
    const row35 = rows.find((r) => r.proxy_line === 3.5);
    const row45 = rows.find((r) => r.proxy_line === 4.5);
    expect(row35.tier).toBe('PASS');
    expect(row45.recommended_side).toBe('UNDER');
  });

  it('NHL 1P: proj=1.85, actual=3 → 1 row, OVER LEAN WIN', () => {
    const rows = buildProjectionProxyMarketRows(nhlRow(1.85, 3));
    expect(rows).toHaveLength(1);
    expect(rows[0].proxy_line).toBe(1.5);
    expect(rows[0].recommended_side).toBe('OVER');
    expect(rows[0].tier).toBe('LEAN');   // edge=0.35 → LEAN (0.25–0.50)
    expect(rows[0].graded_result).toBe('WIN');
  });

  it('NHL 1P: proj=1.20, actual=1 → 1 row, UNDER LEAN WIN', () => {
    const rows = buildProjectionProxyMarketRows(nhlRow(1.20, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].recommended_side).toBe('UNDER');
    expect(rows[0].tier).toBe('LEAN');
    expect(rows[0].graded_result).toBe('WIN');
  });

  it('NHL 1P: proj=1.38, actual=2 → 1 row, PASS (edge=-0.12)', () => {
    const rows = buildProjectionProxyMarketRows(nhlRow(1.38, 2));
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe('PASS');
  });

  it('unknown family → []', () => {
    expect(buildProjectionProxyMarketRows({
      card_family: 'NHL_PLAYER_SHOTS',
      model_projection: 3.0,
      actual_result: '{"shots": 5}',
    })).toEqual([]);
  });

  it('consensus_bonus non-zero only on first row (CONSENSUS_OVER, both WIN)', () => {
    const rows = buildProjectionProxyMarketRows(mlbRow(4.82, 6));
    expect(rows[0].consensus_bonus).not.toBe(0);
    expect(rows[1].consensus_bonus).toBe(0);
  });
});

describe('MLB_PITCHER_K stub fix', () => {
  it('resolveActualValue returns pitcher_ks from actual_result JSON', () => {
    const row = {
      card_family: 'MLB_PITCHER_K',
      actual_result: '{"pitcher_ks":7}',
    };
    expect(resolveActualValue(row)).toBe(7);
  });
  it('resolveActualValue returns null when actual_result is null', () => {
    expect(resolveActualValue({ card_family: 'MLB_PITCHER_K', actual_result: null })).toBeNull();
  });
});
