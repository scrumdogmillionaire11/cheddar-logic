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

describe('NHL 1P totals fixed reference contract', () => {
  test('emits nhl-pace-1p when edge vs fixed 1.5 is meaningful', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.market_1p_total).toBe(1.5);
    expect(descriptor.driverInputs.edge).toBe(
      Number((descriptor.driverInputs.expected_1p_total - 1.5).toFixed(2)),
    );
  });

  test('still emits nhl-pace-1p when full-game market total is missing', () => {
    const descriptor = getOnePeriodDescriptor({ total: null });
    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.market_1p_total).toBe(1.5);
  });

  test('ignores raw 1P market fields and always uses fixed 1.5 reference', () => {
    const descriptor = getOnePeriodDescriptor({
      raw_data: JSON.stringify({
        espn_metrics: {
          home: { metrics: { avgGoalsFor: 3.4, avgGoalsAgainst: 2.8, restDays: 1 } },
          away: { metrics: { avgGoalsFor: 3.2, avgGoalsAgainst: 2.9, restDays: 1 } },
        },
        total_1p: 2.9,
        first_period_total: 2.6,
      }),
      total: null,
    });

    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.market_1p_total).toBe(1.5);
    expect(descriptor.cardTitle).toContain('vs Line 1.5');
    expect(descriptor.reasoning).toContain('fixed reference 1.5');
  });

  test('remains projection-only (no playable market fields)', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    expect(descriptor.market_type).toBeUndefined();
    expect(descriptor.selection).toBeUndefined();
    expect(descriptor.line).toBeUndefined();
    expect(descriptor.price).toBeUndefined();
  });

  test('exposes expected_1p_total as numeric projection input', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    expect(typeof descriptor.driverInputs.expected_1p_total).toBe('number');
    expect(Number.isFinite(descriptor.driverInputs.expected_1p_total)).toBe(
      true,
    );
  });
});
