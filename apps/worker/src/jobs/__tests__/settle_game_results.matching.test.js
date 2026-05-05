const { __private } = require('../settle_game_results');

function buildCompletedEvent({
  id,
  homeTeam,
  awayTeam,
  homeScore = '80',
  awayScore = '70',
  date = '2026-03-03T02:00:00Z',
}) {
  return {
    id,
    date,
    competitions: [
      {
        date,
        status: { type: { completed: true } },
        competitors: [
          {
            homeAway: 'home',
            score: homeScore,
            team: { displayName: homeTeam },
          },
          {
            homeAway: 'away',
            score: awayScore,
            team: { displayName: awayTeam },
          },
        ],
      },
    ],
  };
}

describe('settle_game_results matching hardening', () => {
  test('NHL snapshot eligibility requires final state', () => {
    expect(
      __private.isFinalNhlSnapshot({
        available: true,
        isFinal: true,
        homeScore: 3,
        awayScore: 2,
      }),
    ).toBe(true);

    expect(
      __private.isFinalNhlSnapshot({
        available: true,
        isFinal: false,
        homeScore: 3,
        awayScore: 2,
      }),
    ).toBe(false);

    expect(
      __private.isFinalNhlSnapshot({
        available: true,
        isFinal: true,
        homeScore: null,
        awayScore: 2,
      }),
    ).toBe(false);
  });

  test('uses mapped ESPN event id when it is completed and exact team match', () => {
    const dbGame = {
      game_id: 'canonical-abc',
      home_team: 'Arizona Wildcats',
      away_team: 'Iowa State Cyclones',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const event = __private.eventToComparable(
      buildCompletedEvent({
        id: '401820821',
        homeTeam: 'Arizona Wildcats',
        awayTeam: 'Iowa State Cyclones',
        homeScore: '88',
        awayScore: '82',
      }),
    );

    const completedEvents = [event];
    const completedById = new Map([[event.id, event]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      completedEvents,
      completedById,
      '401820821',
    );

    expect(outcome.reason).toBeNull();
    expect(outcome.match).toBeTruthy();
    expect(outcome.match.method).toBe('mapped_event_id');
    expect(outcome.match.event.id).toBe('401820821');
    expect(outcome.match.event.homeScore).toBe(88);
    expect(outcome.match.event.awayScore).toBe(82);
  });

  test('rejects mapped event id when teams do not exactly match', () => {
    const dbGame = {
      game_id: 'canonical-abc',
      home_team: 'Arizona Wildcats',
      away_team: 'Iowa State Cyclones',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const wrongEvent = __private.eventToComparable(
      buildCompletedEvent({
        id: '401827604',
        homeTeam: 'Arizona Wildcats',
        awayTeam: 'Kansas State Wildcats',
        homeScore: '101',
        awayScore: '76',
      }),
    );

    const completedEvents = [wrongEvent];
    const completedById = new Map([[wrongEvent.id, wrongEvent]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      completedEvents,
      completedById,
      '401827604',
    );

    expect(outcome.match).toBeNull();
    expect(outcome.reason).toBe('mapped_event_team_mismatch');
  });

  test('strict fallback does not allow loose overlap matches', () => {
    const dbGame = {
      game_id: 'canonical-abc',
      home_team: 'Arizona Wildcats',
      away_team: 'Iowa State Cyclones',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const nearButWrong = __private.eventToComparable(
      buildCompletedEvent({
        id: '401827604',
        homeTeam: 'Arizona Wildcats',
        awayTeam: 'Kansas State Wildcats',
        homeScore: '101',
        awayScore: '76',
        date: '2026-03-03T02:01:00Z',
      }),
    );

    const completedEvents = [nearButWrong];
    const completedById = new Map([[nearButWrong.id, nearButWrong]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      completedEvents,
      completedById,
      null,
    );

    expect(outcome.match).toBeNull();
    expect(outcome.reason).toContain('no_strict_candidate');
  });

  test('strict fallback rejects ambiguous tie on exact team/time', () => {
    const dbGame = {
      game_id: 'canonical-abc',
      home_team: 'Arizona Wildcats',
      away_team: 'Iowa State Cyclones',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const eventA = __private.eventToComparable(
      buildCompletedEvent({
        id: 'A',
        homeTeam: 'Arizona Wildcats',
        awayTeam: 'Iowa State Cyclones',
        date: '2026-03-03T02:30:00Z',
      }),
    );
    const eventB = __private.eventToComparable(
      buildCompletedEvent({
        id: 'B',
        homeTeam: 'Arizona Wildcats',
        awayTeam: 'Iowa State Cyclones',
        date: '2026-03-03T01:30:00Z',
      }),
    );

    const strict = __private.findStrictNameTimeMatch(dbGame, [eventA, eventB]);
    expect(strict.match).toBeNull();
    expect(strict.reason).toBe('ambiguous_tie');
  });

  test('strict matching supports swapped home/away orientation with score remap', () => {
    const dbGame = {
      game_id: 'canonical-swap-1',
      sport: 'NBA',
      home_team: 'Detroit Pistons',
      away_team: 'Cleveland Cavaliers',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const swappedEvent = __private.eventToComparable(
      buildCompletedEvent({
        id: '401900001',
        homeTeam: 'Cleveland Cavaliers',
        awayTeam: 'Detroit Pistons',
        homeScore: '99',
        awayScore: '101',
        date: '2026-03-03T02:04:00Z',
      }),
    );

    const outcome = __private.findStrictNameTimeMatch(dbGame, [swappedEvent]);

    expect(outcome.reason).toBeNull();
    expect(outcome.match).toBeTruthy();
    expect(outcome.match.method).toBe('strict_name_time_swapped');
    expect(outcome.match.dbHomeScore).toBe(101);
    expect(outcome.match.dbAwayScore).toBe(99);
  });

  test('mapped ESPN id supports swapped orientation with score remap', () => {
    const dbGame = {
      game_id: 'canonical-swap-2',
      sport: 'NBA',
      home_team: 'Detroit Pistons',
      away_team: 'Cleveland Cavaliers',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const swappedEvent = __private.eventToComparable(
      buildCompletedEvent({
        id: '401900002',
        homeTeam: 'Cleveland Cavaliers',
        awayTeam: 'Detroit Pistons',
        homeScore: '109',
        awayScore: '111',
        date: '2026-03-03T02:02:00Z',
      }),
    );

    const completedById = new Map([[swappedEvent.id, swappedEvent]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      [swappedEvent],
      completedById,
      '401900002',
    );

    expect(outcome.reason).toBeNull();
    expect(outcome.match).toBeTruthy();
    expect(outcome.match.method).toBe('mapped_event_id_swapped');
    expect(outcome.match.dbHomeScore).toBe(111);
    expect(outcome.match.dbAwayScore).toBe(109);
  });

  test('NCAAM fuzzy fallback matches abbreviation variants safely', () => {
    const dbGame = {
      game_id: 'canonical-ncaam-1',
      sport: 'NCAAM',
      home_team: 'Florida St Seminoles',
      away_team: "Saint Joseph's Hawks",
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const event = __private.eventToComparable(
      buildCompletedEvent({
        id: '401999001',
        homeTeam: 'Florida State Seminoles',
        awayTeam: 'St Josephs Hawks',
        homeScore: '77',
        awayScore: '71',
        date: '2026-03-03T02:07:00Z',
      }),
    );

    const completedEvents = [event];
    const completedById = new Map([[event.id, event]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      completedEvents,
      completedById,
      null,
    );

    expect(outcome.reason).toBeNull();
    expect(outcome.match).toBeTruthy();
    expect(outcome.match.method).toBe('ncaam_fuzzy_name_time');
    expect(outcome.match.event.id).toBe('401999001');
  });

  test('NCAAM fuzzy fallback matches Loyola (CHI) vs Loyola Chicago variants', () => {
    const dbGame = {
      game_id: 'canonical-ncaam-loyola',
      sport: 'NCAAM',
      home_team: 'Davidson Wildcats',
      away_team: 'Loyola (CHI) Ramblers',
      game_time_utc: '2026-03-13T00:00:00Z',
    };

    const event = __private.eventToComparable(
      buildCompletedEvent({
        id: '401999077',
        homeTeam: 'Davidson Wildcats',
        awayTeam: 'Loyola Chicago Ramblers',
        homeScore: '69',
        awayScore: '74',
        date: '2026-03-13T00:02:00Z',
      }),
    );

    const completedEvents = [event];
    const completedById = new Map([[event.id, event]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      completedEvents,
      completedById,
      null,
    );

    expect(outcome.reason).toBeNull();
    expect(outcome.match).toBeTruthy();
    expect(outcome.match.method).toBe('ncaam_fuzzy_name_time');
    expect(outcome.match.event.id).toBe('401999077');
  });

  test('NCAAM fuzzy fallback still rejects low-similarity wrong teams', () => {
    const dbGame = {
      game_id: 'canonical-ncaam-2',
      sport: 'NCAAM',
      home_team: 'Florida St Seminoles',
      away_team: "Saint Joseph's Hawks",
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const wrongEvent = __private.eventToComparable(
      buildCompletedEvent({
        id: '401999099',
        homeTeam: 'Florida State Seminoles',
        awayTeam: 'Kansas State Wildcats',
        homeScore: '66',
        awayScore: '64',
        date: '2026-03-03T02:05:00Z',
      }),
    );

    const completedEvents = [wrongEvent];
    const completedById = new Map([[wrongEvent.id, wrongEvent]]);
    const outcome = __private.findMatchForGame(
      dbGame,
      completedEvents,
      completedById,
      null,
    );

    expect(outcome.match).toBeNull();
    expect(outcome.reason).toContain('no_ncaam_fuzzy_candidate');
  });

  test('Odds API score parser emits comparable event for completed game', () => {
    const comparable = __private.oddsApiScoreEventToComparable({
      id: 'odds-1',
      completed: true,
      commence_time: '2026-03-03T02:00:00Z',
      home_team: 'Detroit Pistons',
      away_team: 'Cleveland Cavaliers',
      scores: [
        { name: 'Cleveland Cavaliers', score: '99' },
        { name: 'Detroit Pistons', score: '101' },
      ],
    });

    expect(comparable).toBeTruthy();
    expect(comparable.id).toBe('oddsapi:odds-1');
    expect(comparable.homeName).toBe('Detroit Pistons');
    expect(comparable.awayName).toBe('Cleveland Cavaliers');
    expect(comparable.homeScore).toBe(101);
    expect(comparable.awayScore).toBe(99);
  });

  // ── Collision dedup: same-signature duplicate rows ────────────────────────

  test('getGameSignature returns identical value for two db rows with same matchup and game_time_utc', () => {
    // This is the pre-condition for same-signature dedup: two db rows for the same
    // actual game (e.g. double-ingested) will have matching signatures.
    const game1 = {
      game_id: 'game-dup-001',
      home_team: 'Boston Bruins',
      away_team: 'New York Rangers',
      game_time_utc: '2026-03-22T20:00:00Z',
    };
    const game2 = {
      game_id: 'game-dup-002',
      home_team: 'Boston Bruins',
      away_team: 'New York Rangers',
      game_time_utc: '2026-03-22T20:00:00Z',
    };
    expect(__private.getGameSignature(game1)).toBe(__private.getGameSignature(game2));
  });

  test('getGameSignature returns different values for games with different matchups', () => {
    const game1 = {
      game_id: 'game-col-001',
      home_team: 'Boston Bruins',
      away_team: 'New York Rangers',
      game_time_utc: '2026-03-22T20:00:00Z',
    };
    const game2 = {
      game_id: 'game-col-002',
      home_team: 'Tampa Bay Lightning',
      away_team: 'Florida Panthers',
      game_time_utc: '2026-03-22T20:00:00Z',
    };
    expect(__private.getGameSignature(game1)).not.toBe(__private.getGameSignature(game2));
  });

  test('applyEventUseDedupRule: same-signature duplicate emits debug log, no warn, no error push', () => {
    // Tests the dedup behavior exported via __private.applyEventUseDedupRule
    const eventId = 'espn-dup-001';
    const gameSignature = 'BOSTON BRUINS|NEW YORK RANGERS|2026-03-22T20:00:00Z';
    const eventUseById = new Map([[eventId, gameSignature]]);
    const errors = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = __private.applyEventUseDedupRule(eventId, gameSignature, eventUseById, errors);

    expect(result).toBe('skip'); // should skip settlement of duplicate
    expect(errors).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[SettleGames] Duplicate row skipped'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('applyEventUseDedupRule: true collision (different signatures) warns and pushes error', () => {
    const eventId = 'espn-col-001';
    const existingSignature = 'BOSTON BRUINS|NEW YORK RANGERS|2026-03-22T20:00:00Z';
    const newSignature = 'TAMPA BAY LIGHTNING|FLORIDA PANTHERS|2026-03-22T20:00:00Z';
    const eventUseById = new Map([[eventId, existingSignature]]);
    const errors = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = __private.applyEventUseDedupRule(eventId, newSignature, eventUseById, errors);

    expect(result).toBe('skip'); // also skips but for collision reason
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Collision');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  test('applyEventUseDedupRule: no existing entry registers signature and returns proceed', () => {
    const eventId = 'espn-new-001';
    const gameSignature = 'BOSTON BRUINS|NEW YORK RANGERS|2026-03-22T20:00:00Z';
    const eventUseById = new Map();
    const errors = [];

    const result = __private.applyEventUseDedupRule(eventId, gameSignature, eventUseById, errors);

    expect(result).toBe('proceed');
    expect(eventUseById.get(eventId)).toBe(gameSignature);
    expect(errors).toHaveLength(0);
  });

  test('Odds API comparable event matches strict name/time when ESPN is absent', () => {
    const dbGame = {
      game_id: 'canonical-odds-fallback',
      sport: 'NBA',
      home_team: 'Detroit Pistons',
      away_team: 'Cleveland Cavaliers',
      game_time_utc: '2026-03-03T02:00:00Z',
    };

    const comparable = __private.oddsApiScoreEventToComparable({
      id: 'odds-2',
      completed: true,
      commence_time: '2026-03-03T02:03:00Z',
      home_team: 'Detroit Pistons',
      away_team: 'Cleveland Cavaliers',
      scores: [
        { name: 'Detroit Pistons', score: '112' },
        { name: 'Cleveland Cavaliers', score: '109' },
      ],
    });

    const outcome = __private.findMatchForGame(
      dbGame,
      [comparable],
      new Map([[comparable.id, comparable]]),
      null,
    );

    expect(outcome.reason).toBeNull();
    expect(outcome.match).toBeTruthy();
    expect(outcome.match.method).toBe('strict_name_time');
    expect(outcome.match.dbHomeScore).toBe(112);
    expect(outcome.match.dbAwayScore).toBe(109);
  });
});
