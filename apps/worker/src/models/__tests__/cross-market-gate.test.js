'use strict';
// WI-0820: Input gate regression tests for cross-market.js
// Verifies NO_BET and DEGRADED enforcement for NBA and NHL market decisions.

const {
  computeNBAMarketDecisions,
  computeNHLMarketDecisions,
} = require('../cross-market');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal NHL odds snapshot with raw_data as a plain object. */
function buildNHLSnapshot(rawOverrides = {}, snapshotOverrides = {}) {
  return {
    total: 6.5,
    spread_home: -1.5,
    h2h_home: -120,
    h2h_away: 110,
    raw_data: {
      espn_metrics: {
        home: { metrics: { avgGoalsFor: 3.2, avgGoalsAgainst: 2.7, restDays: 2 } },
        away: { metrics: { avgGoalsFor: 2.9, avgGoalsAgainst: 3.1, restDays: 1 } },
      },
      goalie_home_gsax: 1.2,
      goalie_away_gsax: -0.5,
      pp_home_pct: 22,
      pk_home_pct: 80,
      pp_away_pct: 21,
      pk_away_pct: 79,
      pdo_home: 1.01,
      pdo_away: 0.99,
      xgf_home_pct: 52,
      xgf_away_pct: 48,
      pace: 102,
      ...rawOverrides,
    },
    ...snapshotOverrides,
  };
}

/** Build a minimal NBA odds snapshot. */
function buildNBASnapshot(rawOverrides = {}, snapshotOverrides = {}) {
  return {
    total: 224.5,
    spread_home: -5.5,
    raw_data: {
      espn_metrics: {
        home: {
          metrics: {
            avgPtsHome: 115,
            avgPointsAllowed: 108,
            restDays: 1,
            paceHome: 100,
          },
        },
        away: {
          metrics: {
            avgPtsAway: 112,
            avgPointsAllowed: 110,
            restDays: 1,
            paceAway: 98,
          },
        },
      },
      ...rawOverrides,
    },
    ...snapshotOverrides,
  };
}

// ---------------------------------------------------------------------------
// NBA gate tests
// ---------------------------------------------------------------------------
describe('computeNBAMarketDecisions — WI-0820 input gate', () => {
  test('missing all ESPN metrics → NO_BET result with status key', () => {
    const result = computeNBAMarketDecisions({
      total: 224.5,
      spread_home: -5.5,
      raw_data: {},
    });
    expect(result.status).toBe('NO_BET');
    expect(result.drivers).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.decision).toBeNull();
  });

  test('missing pace only → NO_BET (pace is required)', () => {
    const snapshot = buildNBASnapshot({
      espn_metrics: {
        home: { metrics: { avgPtsHome: 115, avgPointsAllowed: 108, restDays: 1 } },
        away: { metrics: { avgPtsAway: 112, avgPointsAllowed: 110, restDays: 1 } },
      },
    });
    const result = computeNBAMarketDecisions(snapshot);
    expect(result.status).toBe('NO_BET');
  });

  test('full valid data → produces TOTAL and SPREAD decisions (not NO_BET)', () => {
    const result = computeNBAMarketDecisions(buildNBASnapshot());
    expect(result.status).toBeUndefined();
    expect(result.TOTAL).toBeDefined();
    expect(result.SPREAD).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// NHL gate tests
// ---------------------------------------------------------------------------
describe('computeNHLMarketDecisions — WI-0820 input gate', () => {
  test('double-UNKNOWN goalie via raw.goalie.home|away.certainty → NO_BET', () => {
    const snapshot = buildNHLSnapshot({
      goalie: {
        home: { certainty: 'UNKNOWN' },
        away: { certainty: 'UNKNOWN' },
      },
    });
    const result = computeNHLMarketDecisions(snapshot);
    expect(result.status).toBe('NO_BET');
    expect(result.reason_detail).toBe('DOUBLE_UNKNOWN_GOALIE');
    expect(result.missingCritical).toContain('homeGoalieCertainty');
    expect(result.missingCritical).toContain('awayGoalieCertainty');
  });

  test('double-UNKNOWN via legacy goalie_home_certainty fields → NO_BET', () => {
    const snapshot = buildNHLSnapshot({
      goalie_home_certainty: 'UNKNOWN',
      goalie_away_certainty: 'UNKNOWN',
    });
    const result = computeNHLMarketDecisions(snapshot);
    expect(result.status).toBe('NO_BET');
    expect(result.reason_detail).toBe('DOUBLE_UNKNOWN_GOALIE');
  });

  test('single-UNKNOWN (only home) → NOT NO_BET (falls through to model)', () => {
    const snapshot = buildNHLSnapshot({
      goalie: {
        home: { certainty: 'UNKNOWN' },
        away: { certainty: 'CONFIRMED' },
      },
    });
    const result = computeNHLMarketDecisions(snapshot);
    // Should have market decisions, not a NO_BET gate return
    expect(result.status).toBeUndefined();
    expect(result.TOTAL).toBeDefined();
  });

  test('both CONFIRMED goalies → normal result with TOTAL/SPREAD/ML', () => {
    const snapshot = buildNHLSnapshot({
      goalie: {
        home: { certainty: 'CONFIRMED' },
        away: { certainty: 'CONFIRMED' },
      },
    });
    const result = computeNHLMarketDecisions(snapshot);
    expect(result.status).toBeUndefined();
    expect(result.TOTAL).toBeDefined();
    expect(result.SPREAD).toBeDefined();
    expect(result.ML).toBeDefined();
  });

  test('no goalie certainty data → does NOT produce NO_BET (empty string != UNKNOWN)', () => {
    // Missing certainty fields default to '' which is not 'UNKNOWN'
    const snapshot = buildNHLSnapshot();
    const result = computeNHLMarketDecisions(snapshot);
    expect(result.status).toBeUndefined();
    expect(result.TOTAL).toBeDefined();
  });
});
