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
