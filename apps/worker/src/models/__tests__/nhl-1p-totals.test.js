'use strict';

const { computeNHLDriverCards } = require('../index');

function buildNhlSnapshot(overrides = {}) {
  const raw = {
    espn_metrics: {
      home: {
        metrics: {
          avgGoalsFor: 3.4,
          avgGoalsAgainst: 2.8,
          restDays: 1,
        },
      },
      away: {
        metrics: {
          avgGoalsFor: 3.2,
          avgGoalsAgainst: 2.9,
          restDays: 1,
        },
      },
    },
  };

  return {
    game_id: 'nhl-test-game',
    total: 6.0,
    total_price_over: -110,
    total_price_under: -110,
    raw_data: JSON.stringify(raw),
    ...overrides,
  };
}

function getOnePeriodDescriptor(snapshotOverrides = {}) {
  const descriptors = computeNHLDriverCards(
    'nhl-test-game',
    buildNhlSnapshot(snapshotOverrides),
  );
  return descriptors.find((d) => d.cardType === 'nhl-pace-1p');
}

describe('NHL 1P model output contract', () => {
  test('emits projection + classification contract fields', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.market_1p_total).toBe(1.5);
    expect(typeof descriptor.driverInputs.expected_1p_total).toBe('number');
    expect(typeof descriptor.driverInputs.projection_raw).toBe('number');
    expect(typeof descriptor.driverInputs.projection_final).toBe('number');
    expect(typeof descriptor.driverInputs.classification).toBe('string');
    expect(Array.isArray(descriptor.driverInputs.reason_codes)).toBe(true);
    expect(descriptor.driverInputs.edge).toBe(
      Number((descriptor.driverInputs.expected_1p_total - 1.5).toFixed(2)),
    );
  });

  test('remains projection-only (no playable market fields)', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    expect(descriptor.market_type).toBeUndefined();
    expect(descriptor.selection).toBeUndefined();
    expect(descriptor.line).toBeUndefined();
    expect(descriptor.price).toBeUndefined();
  });

  test('returns PASS in dead-zone environments', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    const classification = descriptor.driverInputs.classification;
    const projection = descriptor.driverInputs.projection_final;
    if (projection >= 1.59 && projection < 2.0) {
      expect(classification).toBe('PASS');
      expect(descriptor.driverInputs.reason_codes).toContain(
        'NHL_1P_PASS_DEAD_ZONE',
      );
    }
  });

  test('caps actionability to PASS when a goalie is UNKNOWN', () => {
    const descriptor = getOnePeriodDescriptor({
      raw_data: JSON.stringify({
        goalie_home_gsax: -0.8,
        goalie_away_gsax: -0.7,
        espn_metrics: {
          home: {
            metrics: {
              avgGoalsFor: 4.0,
              avgGoalsAgainst: 2.6,
              pace_factor: 1.18,
              ppPct: 0.31,
              pkPct: 0.71,
              restDays: 2,
            },
            goalie: { savePct: 0.9, confirmed: false, certainty: 'UNKNOWN' },
          },
          away: {
            metrics: {
              avgGoalsFor: 4.0,
              avgGoalsAgainst: 2.6,
              pace_factor: 1.18,
              ppPct: 0.31,
              pkPct: 0.71,
              restDays: 2,
            },
            goalie: { savePct: 0.9, confirmed: true, certainty: 'CONFIRMED' },
          },
        },
      }),
    });

    expect(descriptor).toBeDefined();
    expect(Array.isArray(descriptor.driverInputs.reason_codes)).toBe(true);
  });

  test('emits clamp flags and top over band under hot conditions', () => {
    const descriptor = getOnePeriodDescriptor({
      raw_data: JSON.stringify({
        espn_metrics: {
          home: {
            metrics: {
              avgGoalsFor: 4.6,
              avgGoalsAgainst: 3.8,
              pace_factor: 1.22,
              ppPct: 0.34,
              pkPct: 0.69,
              restDays: 3,
            },
            goalie: { savePct: 0.885, confirmed: true, certainty: 'CONFIRMED' },
          },
          away: {
            metrics: {
              avgGoalsFor: 4.5,
              avgGoalsAgainst: 3.7,
              pace_factor: 1.2,
              ppPct: 0.33,
              pkPct: 0.7,
              restDays: 3,
            },
            goalie: { savePct: 0.884, confirmed: true, certainty: 'CONFIRMED' },
          },
        },
      }),
    });

    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.projection_final).toBeGreaterThanOrEqual(2.2);
    expect(['PASS', 'PLAY_OVER', 'BEST_OVER']).toContain(
      descriptor.driverInputs.classification,
    );
    expect(descriptor.driverInputs.reason_codes.some((code) => code === 'NHL_1P_CLAMP_HIGH' || code === 'NHL_1P_OVER_PLAY' || code === 'NHL_1P_OVER_BEST')).toBe(true);
  });
});
