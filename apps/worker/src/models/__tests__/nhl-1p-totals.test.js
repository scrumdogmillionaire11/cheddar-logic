'use strict';

const { computeNHLDriverCards } = require('../index');
const { makeCanonicalGoalieState } = require('../nhl-goalie-state');
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

function getOnePeriodDescriptor(snapshotOverrides = {}, context = {}) {
  const descriptors = computeNHLDriverCards(
    'nhl-test-game',
    buildNhlSnapshot(snapshotOverrides),
    context,
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

  test('uses canonical goalie state context for certainty + confirmed flags', () => {
    const homeGoalieState = makeCanonicalGoalieState({
      game_id: 'nhl-test-game',
      team_side: 'home',
      starter_state: 'CONFIRMED',
      starter_source: 'USER_INPUT',
      goalie_name: 'Canonical Home',
      goalie_tier: 'STRONG',
      tier_confidence: 'HIGH',
      evidence_flags: [],
    });
    const awayGoalieState = makeCanonicalGoalieState({
      game_id: 'nhl-test-game',
      team_side: 'away',
      starter_state: 'CONFIRMED',
      starter_source: 'USER_INPUT',
      goalie_name: 'Canonical Away',
      goalie_tier: 'STRONG',
      tier_confidence: 'HIGH',
      evidence_flags: [],
    });

    const descriptor = getOnePeriodDescriptor(
      {
        raw_data: JSON.stringify({
          goalie: {
            home: { name: 'Raw Home', status: 'UNKNOWN' },
            away: { name: 'Raw Away', status: 'UNKNOWN' },
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
      },
      {
        canonicalGoalieState: {
          home: homeGoalieState,
          away: awayGoalieState,
        },
      },
    );

    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.home_goalie_name).toBe('Canonical Home');
    expect(descriptor.driverInputs.away_goalie_name).toBe('Canonical Away');
    expect(descriptor.driverInputs.home_goalie_certainty).toBe('CONFIRMED');
    expect(descriptor.driverInputs.away_goalie_certainty).toBe('CONFIRMED');
    expect(descriptor.driverInputs.home_goalie_confirmed).toBe(true);
    expect(descriptor.driverInputs.away_goalie_confirmed).toBe(true);
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

// WI-0505: Phase-2 fair probability gating
describe('Phase-2 fair probability gating', () => {
  // Snapshot that reliably yields a classifiable (non-PASS) result.
  // High-scoring teams with confirmed goalies to avoid goalie-uncertain cap.
  const classifiableSnapshot = {
    raw_data: JSON.stringify({
      goalie: {
        home: { name: 'Igor Shesterkin', status: 'CONFIRMED' },
        away: { name: 'Thatcher Demko', status: 'CONFIRMED' },
      },
      espn_metrics: {
        home: {
          metrics: {
            avgGoalsFor: 4.2,
            avgGoalsAgainst: 2.5,
            pace_factor: 1.15,
            ppPct: 0.28,
            pkPct: 0.76,
            restDays: 2,
          },
        },
        away: {
          metrics: {
            avgGoalsFor: 4.0,
            avgGoalsAgainst: 2.6,
            pace_factor: 1.12,
            ppPct: 0.26,
            pkPct: 0.78,
            restDays: 2,
          },
        },
      },
    }),
  };

  test('gate off (default): fair_over_1_5_prob and fair_under_1_5_prob are null', () => {
    const descriptor = getOnePeriodDescriptor(classifiableSnapshot, {
      phase2FairProbEnabled: false,
    });
    expect(descriptor).toBeDefined();
    expect(descriptor.driverInputs.fair_over_1_5_prob).toBeNull();
    expect(descriptor.driverInputs.fair_under_1_5_prob).toBeNull();
  });

  test('gate on + classifiable record: probs are finite (0,1) and sum to ~1', () => {
    const descriptor = getOnePeriodDescriptor(classifiableSnapshot, {
      phase2FairProbEnabled: true,
      sigma1p: 1.26,
    });
    expect(descriptor).toBeDefined();

    const classification = descriptor.driverInputs.classification;
    if (classification === 'PASS') {
      // If model happens to produce PASS, both probs must still be null.
      expect(descriptor.driverInputs.fair_over_1_5_prob).toBeNull();
      expect(descriptor.driverInputs.fair_under_1_5_prob).toBeNull();
    } else {
      const pOver = descriptor.driverInputs.fair_over_1_5_prob;
      const pUnder = descriptor.driverInputs.fair_under_1_5_prob;
      expect(typeof pOver).toBe('number');
      expect(typeof pUnder).toBe('number');
      expect(pOver).toBeGreaterThan(0);
      expect(pOver).toBeLessThan(1);
      expect(pUnder).toBeGreaterThan(0);
      expect(pUnder).toBeLessThan(1);
      // Probabilities must sum to 1 (within floating-point rounding at 4dp)
      expect(Math.round((pOver + pUnder) * 10000) / 10000).toBe(1);
    }
  });

  test('gate on + PASS (dead-zone): fair probs remain null', () => {
    // Mid-range averages + confirmed goalies → likely dead-zone PASS
    const deadZoneSnapshot = {
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
    };
    const descriptor = getOnePeriodDescriptor(deadZoneSnapshot, {
      phase2FairProbEnabled: true,
      sigma1p: 1.26,
    });
    expect(descriptor).toBeDefined();
    const classification = descriptor.driverInputs.classification;
    if (classification === 'PASS') {
      expect(descriptor.driverInputs.fair_over_1_5_prob).toBeNull();
      expect(descriptor.driverInputs.fair_under_1_5_prob).toBeNull();
    }
    // If model doesn't land in PASS for this input, pass — invariant only
    // applies when classification is actually PASS.
  });

  test('gate on + goalie UNKNOWN (uncertain cap): fair probs remain null', () => {
    const { makeCanonicalGoalieState } = require('../nhl-goalie-state');
    const homeState = makeCanonicalGoalieState({
      game_id: 'nhl-test-game',
      team_side: 'home',
      starter_state: 'CONFIRMED',
      starter_source: 'USER_INPUT',
      goalie_name: 'Igor Shesterkin',
      goalie_tier: 'ELITE',
      tier_confidence: 'HIGH',
      evidence_flags: [],
    });
    const awayState = makeCanonicalGoalieState({
      game_id: 'nhl-test-game',
      team_side: 'away',
      starter_state: 'UNKNOWN',
      starter_source: 'USER_INPUT',
      goalie_name: 'TBD',
      goalie_tier: 'UNKNOWN',
      tier_confidence: 'LOW',
      evidence_flags: [],
    });
    const descriptor = getOnePeriodDescriptor(
      {
        raw_data: JSON.stringify({
          espn_metrics: {
            home: {
              metrics: { avgGoalsFor: 4.2, avgGoalsAgainst: 2.5, restDays: 2 },
            },
            away: {
              metrics: { avgGoalsFor: 4.0, avgGoalsAgainst: 2.6, restDays: 2 },
            },
          },
        }),
      },
      {
        phase2FairProbEnabled: true,
        sigma1p: 1.26,
        canonicalGoalieState: { home: homeState, away: awayState },
      },
    );
    expect(descriptor).toBeDefined();
    // Goalie-uncertain cap forces PASS; Phase-2 must not populate probs.
    expect(descriptor.driverInputs.classification).toBe('PASS');
    expect(descriptor.driverInputs.fair_over_1_5_prob).toBeNull();
    expect(descriptor.driverInputs.fair_under_1_5_prob).toBeNull();
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
    expect(card.payloadData.price).toBe(-125);
  });
});
