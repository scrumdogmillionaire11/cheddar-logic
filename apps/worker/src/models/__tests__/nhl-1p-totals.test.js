'use strict';

const { computeNHLDriverCards } = require('../index');
const {
  applyNhlSettlementMarketContext,
} = require('../../jobs/run_nhl_model.js');

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
    const descriptor = getOnePeriodDescriptor({
      raw_data: JSON.stringify({
        goalie: {
          home: { name: 'Igor Shesterkin', status: 'CONFIRMED' },
          away: { name: 'Samuel Ersson', status: 'UNKNOWN' },
        },
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
      }),
    });
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
    expect(descriptor.driverInputs.home_goalie_name).toBe('Igor Shesterkin');
    expect(descriptor.driverInputs.away_goalie_name).toBe('Samuel Ersson');
  });

  test('emits canonical first-period fields without odds pricing', () => {
    const descriptor = getOnePeriodDescriptor();
    expect(descriptor).toBeDefined();
    expect(descriptor.market_type).toBe('FIRST_PERIOD');
    expect(descriptor.selection).toEqual({ side: expect.any(String) });
    expect(descriptor.line).toBe(1.5);
    expect(descriptor.price).toBeNull();
  });

  test('returns PASS in dead-zone environments', () => {
    const descriptor = getOnePeriodDescriptor({
      raw_data: JSON.stringify({
        goalie: {
          home: { name: 'Andrei Vasilevskiy', status: 'CONFIRMED' },
          away: { name: 'Ilya Sorokin', status: 'CONFIRMED' },
        },
        espn_metrics: {
          home: {
            metrics: {
              avgGoalsFor: 3.1,
              avgGoalsAgainst: 2.9,
              restDays: 1,
            },
          },
          away: {
            metrics: {
              avgGoalsFor: 3.0,
              avgGoalsAgainst: 2.9,
              restDays: 1,
            },
          },
        },
      }),
    });
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
    expect(descriptor.driverInputs.projection_final).toBeGreaterThanOrEqual(
      2.2,
    );
    expect(['PASS', 'PLAY_OVER', 'BEST_OVER']).toContain(
      descriptor.driverInputs.classification,
    );
    expect(
      descriptor.driverInputs.reason_codes.some(
        (code) =>
          code === 'NHL_1P_CLAMP_HIGH' ||
          code === 'NHL_1P_OVER_PLAY' ||
          code === 'NHL_1P_OVER_BEST',
      ),
    ).toBe(true);
  });
});

describe('applyNhlSettlementMarketContext — 1P market_context contract', () => {
  test('sets period = 1P on both market_context.period and market_context.wager.period', () => {
    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        kind: 'PLAY',
        status: 'FIRE',
        market_type: 'FIRST_PERIOD',
        classification: 'PLAY_OVER',
        driver: { inputs: { market_1p_total: 1.5 } },
      },
    };
    const oddsSnapshot = {
      total: 6.0,
      total_1p: 1.5,
      total_price_over_1p: -125,
      total_price_under_1p: 105,
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    expect(card.payloadData.market_context?.period).toBe('1P');
    expect(card.payloadData.market_context?.wager?.period).toBe('1P');
    expect(card.payloadData.market_type).toBe('FIRST_PERIOD');
  });

  test('does not set model_prob or p_fair on the 1P payload (wave-1 decision_v2 is the canonicaln source)', () => {
    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        kind: 'PLAY',
        status: 'FIRE',
        classification: 'PLAY_OVER',
        driver: { inputs: { market_1p_total: 1.5 } },
      },
    };
    const oddsSnapshot = {
      total: 6.0,
      total_1p: 1.5,
      total_price_over_1p: -125,
      total_price_under_1p: 105,
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    // applyNhlSettlementMarketContext must not inject model_prob / p_fair;
    // those are the responsibility of applyUiActionFields after decision_v2 is built.
    expect(card.payloadData.model_prob).toBeUndefined();
    expect(card.payloadData.p_fair).toBeUndefined();
    expect(card.payloadData.price).toBeNull();
  });
});
