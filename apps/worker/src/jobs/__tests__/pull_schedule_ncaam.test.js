const {
  __private,
} = require('../pull_schedule_ncaam');

describe('pull_schedule_ncaam candidate selection', () => {
  const target = {
    homeTeam: 'Southern Jaguars',
    awayTeam: 'Arkansas-Pine Bluff Golden Lions',
    gameTimeUtc: '2026-03-13T00:30:00Z',
  };

  test('prefers existing fuzzy match when start times are within 90 minutes', () => {
    const result = __private.selectBestCandidate(
      [
        {
          game_id: 'canonical-ncaam-1',
          game_time_utc: '2026-03-13T00:00:00Z',
          home_team: 'Southern Jaguars',
          away_team: 'Arkansas-Pine Bluff Golden Lions',
        },
      ],
      target,
    );

    expect(result.status).toBe('matched');
    expect(result.matchMethod).toBe('teams_time_fuzzy');
    expect(result.match.candidate.game_id).toBe('canonical-ncaam-1');
    expect(result.match.confidence).toBe(0.9);
    expect(result.shouldSyncCanonicalTime).toBe(true);
  });

  test('repairs a unique exact-team candidate when the time delta is larger than 90 minutes', () => {
    const result = __private.selectBestCandidate(
      [
        {
          game_id: 'canonical-ncaam-2',
          game_time_utc: '2026-03-12T18:00:00Z',
          home_team: 'Southern Jaguars',
          away_team: 'Arkansas-Pine Bluff Golden Lions',
        },
      ],
      target,
    );

    expect(result.status).toBe('matched');
    expect(result.matchMethod).toBe('teams_exact_time_repair');
    expect(result.match.candidate.game_id).toBe('canonical-ncaam-2');
    expect(result.match.deltaMinutes).toBe(390);
    expect(result.match.confidence).toBe(0.6);
    expect(result.shouldSyncCanonicalTime).toBe(true);
  });

  test('returns ambiguous when two exact-team repair candidates are equally close', () => {
    const result = __private.selectBestCandidate(
      [
        {
          game_id: 'canonical-a',
          game_time_utc: '2026-03-12T18:00:00Z',
          home_team: 'Southern Jaguars',
          away_team: 'Arkansas-Pine Bluff Golden Lions',
        },
        {
          game_id: 'canonical-b',
          game_time_utc: '2026-03-13T07:00:00Z',
          home_team: 'Southern Jaguars',
          away_team: 'Arkansas-Pine Bluff Golden Lions',
        },
      ],
      target,
    );

    expect(result.status).toBe('ambiguous');
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].deltaMinutes).toBe(390);
    expect(result.matches[1].deltaMinutes).toBe(390);
  });

  test('returns no_candidate when no exact team candidate exists', () => {
    const result = __private.selectBestCandidate(
      [
        {
          game_id: 'canonical-other',
          game_time_utc: '2026-03-13T00:30:00Z',
          home_team: 'Another Home Team',
          away_team: 'Another Away Team',
        },
      ],
      target,
    );

    expect(result).toEqual({ status: 'no_candidate' });
  });
});
