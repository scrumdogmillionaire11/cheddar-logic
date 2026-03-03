const { calculateWelcomeHome, generateWelcomeHomeCard } = require('../welcome-home-v2');

describe('welcome-home-v2', () => {
  const awayTeam = { netRating: 6, restDays: 1 };
  const homeTeam = { netRating: 1 };

  test('emits AWAY fade for valid multi-game home return', () => {
    const card = generateWelcomeHomeCard({
      gameId: 'g1',
      awayTeam,
      homeTeam,
      sport: 'NBA',
      isBackToBack: false,
      homeRestDays: 1,
      gameTimeUtc: '2026-02-10T00:00:00.000Z',
      recentRoadGames: [
        { isHome: false, location: 'away', date: '2026-02-03T00:00:00.000Z' },
        { isHome: false, location: 'away', date: '2026-02-05T00:00:00.000Z' },
        { isHome: false, location: 'away', date: '2026-02-08T00:00:00.000Z' }
      ],
      homeTeamRoadTrip: true
    });

    expect(card).toBeTruthy();
    expect(card.prediction).toBe('AWAY');
    expect(card.driverScore).toBeLessThan(0.5);
  });

  test('rejects stale return spots with long home rest after trip', () => {
    const card = generateWelcomeHomeCard({
      gameId: 'g2',
      awayTeam,
      homeTeam,
      sport: 'NHL',
      isBackToBack: false,
      homeRestDays: 5,
      gameTimeUtc: '2026-02-15T00:00:00.000Z',
      recentRoadGames: [
        { isHome: false, location: 'away', date: '2026-02-07T00:00:00.000Z' },
        { isHome: false, location: 'away', date: '2026-02-09T00:00:00.000Z' }
      ],
      homeTeamRoadTrip: true
    });

    expect(card).toBeNull();
  });

  test('rejects non-contiguous road games (spread out schedule noise)', () => {
    const analysis = calculateWelcomeHome(awayTeam, homeTeam, {
      sport: 'NBA',
      isBackToBack: false,
      homeRestDays: 1,
      gameTimeUtc: '2026-02-20T00:00:00.000Z',
      recentRoadGames: [
        { isHome: false, location: 'away', date: '2026-02-01T00:00:00.000Z' },
        { isHome: false, location: 'away', date: '2026-02-12T00:00:00.000Z' }
      ],
      homeTeamRoadTrip: true
    });

    expect(analysis.tier).toBe('NO_PLAY');
    expect(analysis.signal).toBe('Road legs too spread out');
  });
});
