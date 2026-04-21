const {
  computeNBADriverCards,
} = require('../index');
const { projectNBACanonical } = require('../projections');
const { analyzePaceSynergy } = require('../nba-pace-synergy');

describe('NBA projection parity', () => {
  test('nba-base-projection stays within three points of the canonical market path', () => {
    const oddsSnapshot = {
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              pace: 101.2,
              avgPoints: 116.4,
              avgPointsAllowed: 109.8,
              restDays: 2,
            },
          },
          away: {
            metrics: {
              pace: 99.3,
              avgPoints: 113.1,
              avgPointsAllowed: 111.6,
              restDays: 1,
            },
          },
        },
      },
    };

    const descriptors = computeNBADriverCards('nba-test-game', oddsSnapshot, {});
    const baseProjection = descriptors.find(
      (descriptor) => descriptor.cardType === 'nba-base-projection',
    );
    expect(baseProjection).toBeDefined();

    const paceData = analyzePaceSynergy(101.2, 99.3, 116.4, 113.1);
    const canonical = projectNBACanonical(
      116.4,
      109.8,
      101.2,
      113.1,
      111.6,
      99.3,
      paceData?.paceAdjustment || 0,
    );

    const driverProjectedTotal = baseProjection.projectionDetails.projectedTotal;
    expect(typeof driverProjectedTotal).toBe('number');
    expect(typeof canonical.projectedTotal).toBe('number');
    expect(Math.abs(driverProjectedTotal - canonical.projectedTotal)).toBeLessThanOrEqual(3);
  });

  test('projectNBA has been deleted and is no longer exported', () => {
    const projections = require('../projections');

    expect(projections.projectNBA).toBeUndefined();
  });
});

// WI-1024: computeNbaResidualCorrection unit tests
describe('computeNbaResidualCorrection', () => {
  const { computeNbaResidualCorrection } = require('../residual-projection');

  function makeDb(rows) {
    return {
      prepare: jest.fn(() => ({
        get: jest.fn(() => rows),
        all: jest.fn(() => (rows ? [rows] : [])),
      })),
    };
  }

  function makeDbSequence(sequence) {
    let callIndex = 0;
    return {
      prepare: jest.fn(() => ({
        get: jest.fn(() => {
          const row = sequence[callIndex] !== undefined ? sequence[callIndex] : null;
          callIndex++;
          return row;
        }),
        all: jest.fn(() => {
          const row = sequence[callIndex] !== undefined ? sequence[callIndex] : null;
          callIndex++;
          return row ? [row] : [];
        }),
      })),
    };
  }

  const BASE_PARAMS = {
    homeTeam: 'Boston Celtics',
    awayTeam: 'Miami Heat',
    paceTier: 'HIGH_PACE',
    totalBand: '220-230',
    month: '04',
  };

  // Scenario 1: Full segment (n >= 30) — shrinkage = 1.0, correction = mean_residual
  test('full segment: n >= 30 uses shrinkage=1.0 and correction equals mean_residual', async () => {
    // Levels: full(n=35), then remaining queries should not be called
    const db = makeDbSequence([
      { mean_residual: 2.5, n: 35 }, // level 1: team × paceTier × totalBand × month
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: 0,
    });

    expect(result.correction).toBeCloseTo(2.5, 5);
    expect(result.shrinkage_factor).toBe(1.0);
    expect(result.source).toBe('full');
    expect(result.samples).toBe(35);
    expect(result.segment).toContain('team');
  });

  // Scenario 2a: Partial shrinkage n=10 (~0.33)
  test('partial shrinkage: n=10 blends toward globalBias with shrinkage≈0.33', async () => {
    const globalBias = 1.0;
    const meanResidual = 3.0;
    const n = 10;
    const expectedShrinkage = Math.min(1, n / 30); // ~0.333
    const expectedCorrection = meanResidual * expectedShrinkage + globalBias * (1 - expectedShrinkage);

    // Only level 4 (team) responds, but level 1/2/3 return insufficient samples
    const db = makeDbSequence([
      { mean_residual: null, n: 0 }, // level 1
      { mean_residual: null, n: 0 }, // level 2
      { mean_residual: null, n: 0 }, // level 3
      { mean_residual: meanResidual, n },  // level 4: team (min 10)
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias,
    });

    expect(result.shrinkage_factor).toBeCloseTo(expectedShrinkage, 5);
    expect(result.correction).toBeCloseTo(expectedCorrection, 5);
    expect(result.source).toBe('team');
    expect(result.samples).toBe(n);
  });

  // Scenario 2b: Partial shrinkage n=20 (~0.67)
  test('partial shrinkage: n=20 blends toward globalBias with shrinkage≈0.67', async () => {
    const globalBias = 0.5;
    const meanResidual = 4.0;
    const n = 20;
    const expectedShrinkage = Math.min(1, n / 30); // ~0.667
    const expectedCorrection = meanResidual * expectedShrinkage + globalBias * (1 - expectedShrinkage);

    const db = makeDbSequence([
      { mean_residual: null, n: 0 }, // level 1
      { mean_residual: null, n: 0 }, // level 2
      { mean_residual: meanResidual, n }, // level 3: team × totalBand (min 15)
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias,
    });

    expect(result.shrinkage_factor).toBeCloseTo(expectedShrinkage, 5);
    expect(result.correction).toBeCloseTo(expectedCorrection, 5);
    expect(result.source).toBe('team_band');
    expect(result.samples).toBe(n);
  });

  // Scenario 3: Hierarchy selection — highest specificity first, falls back when insufficient
  test('hierarchy: level 1 is chosen when it has sufficient samples', async () => {
    const db = makeDbSequence([
      { mean_residual: 1.8, n: 20 }, // level 1 has enough (min 15)
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: 0,
    });

    expect(result.source).toBe('full');
    expect(result.samples).toBe(20);
  });

  test('hierarchy: falls back to level 2 when level 1 has insufficient samples', async () => {
    const db = makeDbSequence([
      { mean_residual: 5.0, n: 5 }, // level 1: insufficient (< 15)
      { mean_residual: 2.0, n: 18 }, // level 2: sufficient (>= 15)
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: 0,
    });

    expect(result.source).toBe('team_pace_band');
    expect(result.samples).toBe(18);
  });

  // Scenario 4: Global fallback — no qualifying segment returns globalBias as correction with source='global'
  test('global fallback: returns globalBias when no segment meets thresholds', async () => {
    const globalBias = 1.5;
    const db = makeDbSequence([
      { mean_residual: null, n: 0 }, // level 1
      { mean_residual: null, n: 0 }, // level 2
      { mean_residual: null, n: 0 }, // level 3
      { mean_residual: null, n: 0 }, // level 4 (team only, min 10)
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias,
    });

    expect(result.source).toBe('global');
    expect(result.correction).toBe(globalBias);
    expect(result.samples).toBe(0);
  });

  // Scenario 5: Segment cap — raw correction > 5 is clamped to ±5
  test('segment cap: correction > 5 is clamped to +5.0', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const db = makeDbSequence([
      { mean_residual: 8.0, n: 30 }, // uncapped: correction would be 8.0
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: 0,
    });

    expect(result.correction).toBe(5.0);
    // Should emit clamp log
    const logCalls = consoleSpy.mock.calls.map((args) => args.join(' '));
    expect(logCalls.some((msg) => msg.includes('[RESIDUAL]') && msg.includes('clamped'))).toBe(true);

    consoleSpy.mockRestore();
  });

  test('segment cap: correction < -5 is clamped to -5.0', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const db = makeDbSequence([
      { mean_residual: -7.5, n: 30 },
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: 0,
    });

    expect(result.correction).toBe(-5.0);

    consoleSpy.mockRestore();
  });

  // Scenario 6 (no-data): returns { correction: 0, source: 'none', samples: 0 } when globalBias is null/undefined
  test('no-data: returns correction=0, source=none when globalBias is undefined and no segments match', async () => {
    const db = makeDbSequence([
      { mean_residual: null, n: 0 }, // level 1
      { mean_residual: null, n: 0 }, // level 2
      { mean_residual: null, n: 0 }, // level 3
      { mean_residual: null, n: 0 }, // level 4
    ]);

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: undefined,
    });

    expect(result.correction).toBe(0);
    expect(result.source).toBe('none');
    expect(result.samples).toBe(0);
  });

  test('no-data: db query error returns safe fallback { correction: 0, source: none }', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      prepare: jest.fn(() => {
        throw new Error('DB connection failed');
      }),
    };

    const result = await computeNbaResidualCorrection({
      db,
      ...BASE_PARAMS,
      globalBias: 1.0,
    });

    expect(result.correction).toBe(0);
    expect(result.source).toBe('none');
    expect(result.samples).toBe(0);

    consoleSpy.mockRestore();
  });
});
