const { resolveTeamVariant } = require('../normalize');

describe('soccer team variant mapping', () => {
  const cases = [
    ['Sporting Lisbon', 'SPORTING CP'],
    ['Sporting CP', 'SPORTING CP'],
    ['Bodø/Glimt', 'BODO/GLIMT'],
    ['Bodo Glimt', 'BODO/GLIMT'],
    ['Bodo/Glimt', 'BODO/GLIMT'],
    ['Arsenal', 'ARSENAL'],
    ['Bayer Leverkusen', 'BAYER LEVERKUSEN'],
    ['Chelsea', 'CHELSEA'],
    ['Manchester City', 'MANCHESTER CITY'],
    ['Real Madrid', 'REAL MADRID'],
    ['Paris Saint Germain', 'PARIS SAINT-GERMAIN'],
    ['Paris Saint-Germain', 'PARIS SAINT-GERMAIN'],
    ['PSG', 'PARIS SAINT-GERMAIN'],
  ];

  test.each(cases)('%s resolves to %s', (input, canonical) => {
    const result = resolveTeamVariant(input, 'normalize.soccer-team-variants.test');
    expect(result.matched).toBe(true);
    expect(result.canonical).toBe(canonical);
  });
});
