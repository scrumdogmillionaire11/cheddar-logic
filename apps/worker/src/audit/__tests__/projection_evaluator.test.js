'use strict';

const {
  collectProjectionAlerts,
  evaluateProjectionRows,
  resolveActualValue,
  resolveDirection,
  resolvePredictionValue,
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
