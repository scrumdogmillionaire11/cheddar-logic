'use strict';

/**
 * Unit tests for packages/adapters/src/action-network.js
 *
 * These tests are purely unit-level — no network calls are made.
 * fetch() is globally mocked before each test.
 */

const {
  fetchSplitsForDate,
  normalizeSplitsResponse,
  matchSplitsToGameId,
  _toFloatPct,
} = require('../action-network');

// ─── Mock fetch globally ─────────────────────────────────────────────────────

function makeFetchMock(status, body) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  });
}

afterEach(() => {
  global.fetch = undefined;
  jest.restoreAllMocks();
});

// ─── _toFloatPct ─────────────────────────────────────────────────────────────

describe('_toFloatPct', () => {
  test('returns number as-is when in range', () => {
    expect(_toFloatPct(45.5)).toBe(45.5);
    expect(_toFloatPct(0)).toBe(0);
    expect(_toFloatPct(100)).toBe(100);
  });

  test('returns null for null / undefined', () => {
    expect(_toFloatPct(null)).toBeNull();
    expect(_toFloatPct(undefined)).toBeNull();
  });

  test('returns null for out-of-range values', () => {
    expect(_toFloatPct(-1)).toBeNull();
    expect(_toFloatPct(101)).toBeNull();
  });

  test('returns null for NaN / Infinity', () => {
    expect(_toFloatPct(NaN)).toBeNull();
    expect(_toFloatPct(Infinity)).toBeNull();
  });

  test('parses numeric strings', () => {
    expect(_toFloatPct('55.0')).toBe(55);
  });
});

// ─── normalizeSplitsResponse ──────────────────────────────────────────────────

describe('normalizeSplitsResponse', () => {
  const fullRawGame = {
    id: 99001,
    home_team: { full_name: 'Boston Celtics', abbr: 'BOS' },
    away_team: { full_name: 'Golden State Warriors', abbr: 'GSW' },
    start_time: '2026-03-29T17:30:00Z',
    bets: [
      {
        bet_type: 'money_line',
        home_bets: 55,
        away_bets: 45,
        home_handle: 62,
        away_handle: 38,
        home_tickets: 57,
        away_tickets: 43,
      },
    ],
  };

  test('normalises a complete game object — all pct fields present', () => {
    const result = normalizeSplitsResponse([fullRawGame], 'NBA');
    expect(result).toHaveLength(1);
    const g = result[0];
    expect(g.actionNetworkGameId).toBe('99001');
    expect(g.homeTeam).toBe('Boston Celtics');
    expect(g.awayTeam).toBe('Golden State Warriors');
    expect(g.commenceTime).toBe('2026-03-29T17:30:00.000Z');
    expect(g.publicBetsPctHome).toBe(55);
    expect(g.publicBetsPctAway).toBe(45);
    expect(g.publicHandlePctHome).toBe(62);
    expect(g.publicHandlePctAway).toBe(38);
    expect(g.publicTicketsPctHome).toBe(57);
    expect(g.publicTicketsPctAway).toBe(43);
  });

  test('missing pct fields → null (not undefined or 0)', () => {
    const sparseGame = {
      id: 99002,
      home_team: { full_name: 'Celtics' },
      away_team: { full_name: 'Warriors' },
      start_time: '2026-03-29T17:30:00Z',
      bets: [{ bet_type: 'money_line', home_bets: 45 }], // away_bets missing
    };
    const [g] = normalizeSplitsResponse([sparseGame], 'NBA');
    expect(g.publicBetsPctHome).toBe(45);
    expect(g.publicBetsPctAway).toBeNull();
    expect(g.publicHandlePctHome).toBeNull();
    expect(g.publicHandlePctAway).toBeNull();
    expect(g.publicTicketsPctHome).toBeNull();
    expect(g.publicTicketsPctAway).toBeNull();
    // Ensure no undefined leaks
    for (const key of Object.keys(g)) {
      expect(g[key]).not.toBeUndefined();
    }
  });

  test('pct fields that are absent are null, not 0', () => {
    const noSplitsGame = {
      id: 99003,
      home_team: { full_name: 'Heat' },
      away_team: { full_name: 'Nets' },
      start_time: '2026-03-29T00:00:00Z',
    };
    const [g] = normalizeSplitsResponse([noSplitsGame], 'NBA');
    expect(g.publicBetsPctHome).toBeNull();
    expect(g.publicBetsPctAway).toBeNull();
    expect(g.publicHandlePctHome).toBeNull();
    expect(g.publicHandlePctAway).toBeNull();
    expect(g.publicTicketsPctHome).toBeNull();
    expect(g.publicTicketsPctAway).toBeNull();
  });

  test('empty raw array → empty result, no throw', () => {
    expect(() => normalizeSplitsResponse([], 'NBA')).not.toThrow();
    expect(normalizeSplitsResponse([], 'NBA')).toEqual([]);
  });

  test('non-array input → empty result, no throw', () => {
    expect(normalizeSplitsResponse(null, 'NBA')).toEqual([]);
    expect(normalizeSplitsResponse(undefined, 'NBA')).toEqual([]);
    expect(normalizeSplitsResponse('bad', 'NBA')).toEqual([]);
  });

  test('handles flat response without bets array (alternative schema)', () => {
    const flatGame = {
      id: 99004,
      home_team: { full_name: 'Lakers' },
      away_team: { full_name: 'Clippers' },
      start_time: '2026-03-29T00:00:00Z',
      home_bets_pct: 60,
      away_bets_pct: 40,
      home_handle_pct: 55,
      away_handle_pct: 45,
    };
    const [g] = normalizeSplitsResponse([flatGame], 'NBA');
    expect(g.publicBetsPctHome).toBe(60);
    expect(g.publicBetsPctAway).toBe(40);
    expect(g.publicHandlePctHome).toBe(55);
    expect(g.publicHandlePctAway).toBe(45);
  });

  test('null commenceTime when start_time is absent/invalid', () => {
    const g1 = { id: 1, home_team: { full_name: 'A' }, away_team: { full_name: 'B' } };
    const g2 = { id: 2, home_team: { full_name: 'A' }, away_team: { full_name: 'B' }, start_time: 'not-a-date' };
    expect(normalizeSplitsResponse([g1], 'NBA')[0].commenceTime).toBeNull();
    expect(normalizeSplitsResponse([g2], 'NBA')[0].commenceTime).toBeNull();
  });
});

// ─── fetchSplitsForDate ───────────────────────────────────────────────────────

describe('fetchSplitsForDate', () => {
  test('returns raw games array on success', async () => {
    global.fetch = makeFetchMock(200, {
      games: [{ id: 1 }, { id: 2 }],
    });
    const result = await fetchSplitsForDate({ sport: 'NBA', date: '20260329' });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('calls correct URL with User-Agent header', async () => {
    global.fetch = makeFetchMock(200, { games: [] });
    await fetchSplitsForDate({ sport: 'NHL', date: '20260401' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe(
      'https://api.actionnetwork.com/web/v1/game?league=NHL&date=20260401',
    );
    expect(opts.headers['User-Agent']).toMatch(/Mozilla\/5\.0/);
  });

  test('non-200 response → returns [] and does not throw', async () => {
    global.fetch = makeFetchMock(403, {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fetchSplitsForDate({ sport: 'NBA', date: '20260329' });
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-200'),
    );
  });

  test('network error → returns [] and does not throw', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fetchSplitsForDate({ sport: 'NBA', date: '20260329' });
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('handles bare array response (no games wrapper)', async () => {
    global.fetch = makeFetchMock(200, [{ id: 10 }, { id: 11 }]);
    const result = await fetchSplitsForDate({ sport: 'MLB', date: '20260329' });
    expect(result).toEqual([{ id: 10 }, { id: 11 }]);
  });
});

// ─── matchSplitsToGameId ──────────────────────────────────────────────────────

describe('matchSplitsToGameId', () => {
  const knownGames = [
    { gameId: 'game-001', homeTeam: 'Boston Celtics', awayTeam: 'Golden State Warriors' },
    { gameId: 'game-002', homeTeam: 'Los Angeles Lakers', awayTeam: 'Miami Heat' },
  ];

  test('matches exact team names correctly', () => {
    const splits = [
      {
        actionNetworkGameId: '99001',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Golden State Warriors',
        commenceTime: null,
        publicBetsPctHome: 55,
        publicBetsPctAway: 45,
        publicHandlePctHome: null,
        publicHandlePctAway: null,
        publicTicketsPctHome: null,
        publicTicketsPctAway: null,
      },
    ];
    const result = matchSplitsToGameId(splits, knownGames);
    expect(result).toHaveLength(1);
    expect(result[0].gameId).toBe('game-001');
    expect(result[0].splits.publicBetsPctHome).toBe(55);
  });

  test('unmatched split → logs warning, not included in result, no throw', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const unmatched = [
      {
        actionNetworkGameId: '99099',
        homeTeam: 'Unknown Team X',
        awayTeam: 'Unknown Team Y',
        commenceTime: null,
        publicBetsPctHome: null,
        publicBetsPctAway: null,
        publicHandlePctHome: null,
        publicHandlePctAway: null,
        publicTicketsPctHome: null,
        publicTicketsPctAway: null,
      },
    ];
    const result = matchSplitsToGameId(unmatched, knownGames);
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unmatched'),
    );
  });

  test('empty normalizedSplits → empty result', () => {
    expect(matchSplitsToGameId([], knownGames)).toEqual([]);
  });

  test('empty knownGames → all unmatched, empty result', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const splits = [
      {
        actionNetworkGameId: '1',
        homeTeam: 'Celtics',
        awayTeam: 'Warriors',
        commenceTime: null,
        publicBetsPctHome: null,
        publicBetsPctAway: null,
        publicHandlePctHome: null,
        publicHandlePctAway: null,
        publicTicketsPctHome: null,
        publicTicketsPctAway: null,
      },
    ];
    const result = matchSplitsToGameId(splits, []);
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('invalid args → returns empty array, no throw', () => {
    expect(matchSplitsToGameId(null, null)).toEqual([]);
    expect(matchSplitsToGameId(undefined, undefined)).toEqual([]);
  });
});
