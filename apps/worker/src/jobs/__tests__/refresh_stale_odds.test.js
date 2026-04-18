const { __private } = require('../refresh_stale_odds');

describe('refresh_stale_odds stale game id matching', () => {
  const { buildStaleGameIdCandidates, buildStaleGameIdSet } = __private;

  test('preserves exact Odds API ids that contain hyphens', () => {
    const candidates = buildStaleGameIdCandidates('abc-def-123', 'MLB');

    expect(candidates).toContain('abc-def-123');
    expect(candidates).not.toContain('123');
  });

  test('adds unprefixed candidate for legacy game-sport ids', () => {
    const candidates = buildStaleGameIdCandidates('game-mlb-abc-def-123', 'MLB');

    expect(candidates).toContain('game-mlb-abc-def-123');
    expect(candidates).toContain('abc-def-123');
  });

  test('stale id set matches exact and legacy-prefixed ids but not unrelated ids', () => {
    const staleGameIds = buildStaleGameIdSet([
      { game_id: 'abc-def-123', sport: 'MLB' },
      { game_id: 'game-nba-legacy-456', sport: 'NBA' },
    ]);

    expect(staleGameIds.has('abc-def-123')).toBe(true);
    expect(staleGameIds.has('legacy-456')).toBe(true);
    expect(staleGameIds.has('123')).toBe(false);
    expect(staleGameIds.has('unrelated-456')).toBe(false);
  });
});
