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
    ['Bournemouth', 'BOURNEMOUTH'],
    ['Newcastle United', 'NEWCASTLE UNITED'],
    ['Manchester United', 'MANCHESTER UNITED'],
    ['Tottenham Hotspur', 'TOTTENHAM HOTSPUR'],
    ['Liverpool', 'LIVERPOOL'],
    ['West Ham United', 'WEST HAM UNITED'],
    ['Brighton and Hove Albion', 'BRIGHTON AND HOVE ALBION'],
    ['Atletico Madrid', 'ATLETICO MADRID'],
  ];

  test.each(cases)('%s resolves to %s', (input, canonical) => {
    const result = resolveTeamVariant(input, 'normalize.soccer-team-variants.test');
    expect(result.matched).toBe(true);
    expect(result.canonical).toBe(canonical);
  });
});

describe('MLS team variant mapping', () => {
  const mlsCases = [
    ['Vancouver Whitecaps FC', 'VANCOUVER WHITECAPS FC'],
    ['Whitecaps FC', 'VANCOUVER WHITECAPS FC'],
    ['Vancouver Whitecaps', 'VANCOUVER WHITECAPS FC'],
    ['FC Cincinnati', 'FC CINCINNATI'],
    ['Cincinnati FC', 'FC CINCINNATI'],
    ['CF Montreal', 'CF MONTREAL'],
    ['Montreal FC', 'CF MONTREAL'],
    ['New York City FC', 'NEW YORK CITY FC'],
    ['NYCFC', 'NEW YORK CITY FC'],
    ['Inter Miami CF', 'INTER MIAMI CF'],
    ['Inter Miami', 'INTER MIAMI CF'],
    ['Minnesota United FC', 'MINNESOTA UNITED FC'],
    ['Minnesota United', 'MINNESOTA UNITED FC'],
    ['Seattle Sounders FC', 'SEATTLE SOUNDERS FC'],
    ['Seattle Sounders', 'SEATTLE SOUNDERS FC'],
    ['Portland Timbers', 'PORTLAND TIMBERS'],
    ['LA Galaxy', 'LA GALAXY'],
    ['Los Angeles Galaxy', 'LA GALAXY'],
    ['San Diego FC', 'SAN DIEGO FC'],
    ['Real Salt Lake', 'REAL SALT LAKE'],
    ['RSL', 'REAL SALT LAKE'],
  ];

  test.each(mlsCases)('%s resolves to %s', (input, canonical) => {
    const result = resolveTeamVariant(input, 'normalize.soccer-team-variants.test');
    expect(result.matched).toBe(true);
    expect(result.canonical).toBe(canonical);
  });
});
