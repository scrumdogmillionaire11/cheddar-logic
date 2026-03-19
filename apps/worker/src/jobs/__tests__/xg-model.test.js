const {
  poissonPmf,
  computeXgWinProbs,
  computeXgTotalProb,
  applyLeagueHomeAdj,
  getLeagueSigma,
} = require('@cheddar-logic/models/src/xg-model');

describe('xg-model', () => {
  test('poissonPmf is accurate to 4 decimals for known values', () => {
    expect(poissonPmf(0, 1.5)).toBeCloseTo(0.2231, 4);
    expect(poissonPmf(1, 1.5)).toBeCloseTo(0.3347, 4);
    expect(poissonPmf(2, 1.5)).toBeCloseTo(0.2510, 4);
  });

  test('computeXgWinProbs returns probabilities that sum to 1 within tolerance', () => {
    const probabilities = computeXgWinProbs({
      homeXg: 1.6,
      awayXg: 1.2,
      league: 'EPL',
    });

    expect(probabilities.homeWin).toBeGreaterThan(0);
    expect(probabilities.draw).toBeGreaterThan(0);
    expect(probabilities.awayWin).toBeGreaterThan(0);

    const total = probabilities.homeWin + probabilities.draw + probabilities.awayWin;
    expect(total).toBeCloseTo(1, 3);
  });

  test('computeXgTotalProb returns over and under probabilities', () => {
    const over = computeXgTotalProb({
      homeXg: 1.4,
      awayXg: 1.1,
      totalLine: 2.5,
      direction: 'over',
      league: 'MLS',
    });
    const under = computeXgTotalProb({
      homeXg: 1.4,
      awayXg: 1.1,
      totalLine: 2.5,
      direction: 'under',
      league: 'MLS',
    });

    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThan(1);
    expect(under).toBeGreaterThan(0);
    expect(under).toBeLessThan(1);
    expect(over + under).toBeCloseTo(1, 3);
  });

  test('applyLeagueHomeAdj uses per-league constants', () => {
    expect(applyLeagueHomeAdj(1.5, 'EPL')).toBeCloseTo(1.62, 6);
    expect(applyLeagueHomeAdj(1.5, 'MLS')).toBeCloseTo(1.59, 6);
    expect(applyLeagueHomeAdj(1.5, 'UCL')).toBeCloseTo(1.6, 6);
  });

  test('getLeagueSigma returns configured values', () => {
    expect(getLeagueSigma('EPL')).toBeCloseTo(1.18, 6);
    expect(getLeagueSigma('MLS')).toBeCloseTo(1.24, 6);
    expect(getLeagueSigma('UCL')).toBeCloseTo(1.15, 6);
  });

  test('poissonPmf never yields NaN/Infinity for lambda range [0.5, 3.5]', () => {
    const lambdas = [0.5, 1, 1.5, 2, 2.5, 3, 3.5];
    for (const lambda of lambdas) {
      for (let k = 0; k <= 10; k += 1) {
        const probability = poissonPmf(k, lambda);
        expect(Number.isFinite(probability)).toBe(true);
      }
    }
  });
});
