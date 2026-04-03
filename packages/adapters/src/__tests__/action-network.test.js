'use strict';

/**
 * Unit tests for packages/adapters/src/action-network.js  (v2)
 *
 * Covers:
 *   _toFloatPct        — value coercion to [0,100] float or null
 *   _validatePctSum    — pct-sum validation rules
 *   _parseMarketEntry  — per-market normalisation: valid, invalid, skipped
 *   normalizeSplitsResponse — game-level output with markets[]
 *   fetchSplitsForDate      — HTTP/JSON wrappers and sourceStatus values
 *   matchSplitsToGameId     — fuzzy team-name matching
 *
 * No network calls are made; fetch() is globally mocked.
 */

const {
  fetchSplitsForDate,
  normalizeSplitsResponse,
  matchSplitsToGameId,
  _toFloatPct,
  _validatePctSum,
  _parseMarketEntry,
} = require('../action-network');

// ─── Mock fetch globally ─────────────────────────────────────────────────────

function makeFetchMock(status, body) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  });
}

function makeFetchNetworkError(message) {
  return jest.fn().mockRejectedValue(new Error(message));
}

function makeFetchBadJson(status) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  });
}

afterEach(() => {
  global.fetch = undefined;
  jest.restoreAllMocks();
});

// ─── _toFloatPct ─────────────────────────────────────────────────────────────

describe('_toFloatPct', () => {
  it('returns a numeric value unchanged', () => {
    expect(_toFloatPct(60)).toBe(60);
  });

  it('parses a string numeric value', () => {
    expect(_toFloatPct('42.5')).toBe(42.5);
  });

  it('returns null for null input', () => {
    expect(_toFloatPct(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(_toFloatPct(undefined)).toBeNull();
  });

  it('returns null for NaN string', () => {
    expect(_toFloatPct('not-a-number')).toBeNull();
  });

  it('returns null for values above 100', () => {
    expect(_toFloatPct(101)).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(_toFloatPct(-1)).toBeNull();
  });

  it('accepts boundary values 0 and 100', () => {
    expect(_toFloatPct(0)).toBe(0);
    expect(_toFloatPct(100)).toBe(100);
  });
});

// ─── _validatePctSum ─────────────────────────────────────────────────────────

describe('_validatePctSum', () => {
  it('returns valid when both values are null', () => {
    const result = _validatePctSum(null, null, 'test.bets');
    expect(result.valid).toBe(true);
  });

  it('returns invalid when first value is null but second is present', () => {
    const result = _validatePctSum(null, 60, 'test.bets');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/asymmetric/);
  });

  it('returns invalid when second value is null but first is present', () => {
    const result = _validatePctSum(40, null, 'test.bets');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/asymmetric/);
  });

  it('returns valid for a sum of 100', () => {
    const result = _validatePctSum(60, 40, 'test.bets');
    expect(result.valid).toBe(true);
  });

  it('returns valid for a sum within [96, 104] (rounding slack)', () => {
    expect(_validatePctSum(58, 39, 'test.bets').valid).toBe(true); // sum=97
    expect(_validatePctSum(63, 40, 'test.bets').valid).toBe(true); // sum=103
  });

  it('returns invalid when sum is below 96', () => {
    const result = _validatePctSum(45, 45, 'test.bets'); // sum=90
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside/);
  });

  it('returns invalid when sum exceeds 104', () => {
    const result = _validatePctSum(60, 55, 'test.bets'); // sum=115
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside/);
  });
});

// ─── _parseMarketEntry ───────────────────────────────────────────────────────

/** Minimal valid moneyline entry (sums ≈ 100) */
function mlEntry(overrides = {}) {
  return {
    bet_type: 'money_line',
    home_bets: 60, away_bets: 40,
    home_handle: 55, away_handle: 45,
    home_tickets: 62, away_tickets: 38,
    ...overrides,
  };
}

/** Minimal valid spread entry */
function spreadEntry(overrides = {}) {
  return {
    bet_type: 'spread',
    home_bets: 55, away_bets: 45,
    home_handle: 52, away_handle: 48,
    home_tickets: 53, away_tickets: 47,
    spread: -3.5,
    ...overrides,
  };
}

/** Minimal valid total entry */
function totalEntry(overrides = {}) {
  return {
    bet_type: 'total',
    over_bets: 55, under_bets: 45,
    over_handle: 60, under_handle: 40,
    over_tickets: 52, under_tickets: 48,
    total: 220.5,
    ...overrides,
  };
}

describe('_parseMarketEntry', () => {
  it('parses a valid moneyline entry', () => {
    const result = _parseMarketEntry(mlEntry());
    expect(result).not.toBeNull();
    expect(result.valid).toBe(true);
    expect(result.marketType).toBe('ML');
    expect(result.selectionScope).toBe('HOME_AWAY');
    expect(result.home_or_over_bets_pct).toBe(60);
    expect(result.away_or_under_bets_pct).toBe(40);
    expect(result.line).toBeNull();
    expect(result.source).toBe('ACTION_NETWORK');
    expect(result.sourceMarketKey).toBe('money_line');
  });

  it('accepts "moneyline" as an alias for ML', () => {
    const result = _parseMarketEntry(mlEntry({ bet_type: 'moneyline' }));
    expect(result).not.toBeNull();
    expect(result.marketType).toBe('ML');
  });

  it('parses a valid spread entry with line', () => {
    const result = _parseMarketEntry(spreadEntry());
    expect(result).not.toBeNull();
    expect(result.valid).toBe(true);
    expect(result.marketType).toBe('SPREAD');
    expect(result.line).toBe(-3.5);
  });

  it('parses a valid total entry (over/under scope and line)', () => {
    const result = _parseMarketEntry(totalEntry());
    expect(result).not.toBeNull();
    expect(result.valid).toBe(true);
    expect(result.marketType).toBe('TOTAL');
    expect(result.selectionScope).toBe('OVER_UNDER');
    expect(result.home_or_over_bets_pct).toBe(55);
    expect(result.away_or_under_bets_pct).toBe(45);
    expect(result.line).toBe(220.5);
  });

  it('returns null for unrecognised bet_type — no fallback substitution', () => {
    const result = _parseMarketEntry({ bet_type: 'futures', home_bets: 60, away_bets: 40 });
    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    expect(_parseMarketEntry(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(_parseMarketEntry('money_line')).toBeNull();
  });

  it('returns INVALID_INPUT when spread entry is missing line', () => {
    const entry = spreadEntry({ spread: undefined });
    const result = _parseMarketEntry(entry);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/INVALID_INPUT/);
    expect(result.invalidReason).toMatch(/SPREAD|line/i);
  });

  it('returns INVALID_INPUT when total entry is missing line', () => {
    const entry = totalEntry({ total: undefined });
    const result = _parseMarketEntry(entry);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/INVALID_INPUT/);
  });

  it('returns INVALID_INPUT for bad bets pct sum', () => {
    const result = _parseMarketEntry(mlEntry({ home_bets: 45, away_bets: 10 })); // sum=55
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/INVALID_INPUT/);
  });

  it('returns INVALID_INPUT for bad handle pct sum', () => {
    const result = _parseMarketEntry(mlEntry({ home_handle: 80, away_handle: 80 })); // sum=160
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/INVALID_INPUT/);
  });
});

// ─── normalizeSplitsResponse ─────────────────────────────────────────────────

const SAMPLE_GAME = {
  id: 99,
  home_team: { full_name: 'Boston Celtics' },
  away_team: { full_name: 'Golden State Warriors' },
  start_time: '2026-04-03T00:00:00Z',
  bets: [mlEntry(), spreadEntry(), totalEntry()],
};

describe('normalizeSplitsResponse', () => {
  it('returns an empty array for non-array input', () => {
    expect(normalizeSplitsResponse(null)).toEqual([]);
    expect(normalizeSplitsResponse({})).toEqual([]);
    expect(normalizeSplitsResponse('oops')).toEqual([]);
  });

  it('returns an empty array for an empty input array', () => {
    expect(normalizeSplitsResponse([])).toEqual([]);
  });

  it('produces correct game-level fields', () => {
    const [game] = normalizeSplitsResponse([SAMPLE_GAME]);
    expect(game.actionNetworkGameId).toBe('99');
    expect(game.homeTeam).toBe('Boston Celtics');
    expect(game.awayTeam).toBe('Golden State Warriors');
    expect(game.commenceTime).toBe('2026-04-03T00:00:00.000Z');
  });

  it('produces one valid MarketSplit per recognised bet_type', () => {
    const [game] = normalizeSplitsResponse([SAMPLE_GAME]);
    expect(Array.isArray(game.markets)).toBe(true);
    expect(game.markets).toHaveLength(3);
    const types = game.markets.map((m) => m.marketType);
    expect(types).toContain('ML');
    expect(types).toContain('SPREAD');
    expect(types).toContain('TOTAL');
  });

  it('all returned markets are valid', () => {
    const [game] = normalizeSplitsResponse([SAMPLE_GAME]);
    for (const m of game.markets) {
      expect(m.valid).toBe(true);
    }
  });

  it('skips unrecognised bet_type entries; does not substitute', () => {
    const game = {
      ...SAMPLE_GAME,
      bets: [{ bet_type: 'futures', home_bets: 60, away_bets: 40 }],
    };
    const [result] = normalizeSplitsResponse([game]);
    expect(result.markets).toHaveLength(0);
  });

  it('returns markets: [] for a game with no bets array', () => {
    const game = { id: 1, home_team: {}, away_team: {}, bets: [] };
    const [result] = normalizeSplitsResponse([game]);
    expect(result.markets).toHaveLength(0);
  });

  it('skips non-object entries without throwing', () => {
    const result = normalizeSplitsResponse([null, undefined, SAMPLE_GAME]);
    expect(result).toHaveLength(1);
  });
});

// ─── fetchSplitsForDate ───────────────────────────────────────────────────────

describe('fetchSplitsForDate', () => {
  it('returns sourceStatus OK and games on HTTP 200', async () => {
    global.fetch = makeFetchMock(200, { games: [{ id: 1, bets: [] }] });
    const { games, sourceStatus } = await fetchSplitsForDate({ sport: 'NBA', date: '20260403' });
    expect(sourceStatus).toBe('OK');
    expect(Array.isArray(games)).toBe(true);
    expect(games).toHaveLength(1);
  });

  it('calls the correct URL with a User-Agent header', async () => {
    global.fetch = makeFetchMock(200, { games: [] });
    await fetchSplitsForDate({ sport: 'NHL', date: '20260401' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.actionnetwork.com/web/v1/game?league=NHL&date=20260401');
    expect(opts.headers['User-Agent']).toMatch(/Mozilla\/5\.0/);
  });

  it('returns sourceStatus SOURCE_BLOCKED on HTTP 403', async () => {
    global.fetch = makeFetchMock(403, {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { games, sourceStatus } = await fetchSplitsForDate({ sport: 'NBA', date: '20260403' });
    expect(sourceStatus).toBe('SOURCE_BLOCKED');
    expect(games).toEqual([]);
  });

  it('returns sourceStatus SOURCE_BLOCKED on HTTP 404', async () => {
    global.fetch = makeFetchMock(404, {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { games, sourceStatus } = await fetchSplitsForDate({ sport: 'NBA', date: '20260403' });
    expect(sourceStatus).toBe('SOURCE_BLOCKED');
    expect(games).toEqual([]);
  });

  it('returns sourceStatus FETCH_ERROR on network failure', async () => {
    global.fetch = makeFetchNetworkError('ECONNREFUSED');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { games, sourceStatus } = await fetchSplitsForDate({ sport: 'NBA', date: '20260403' });
    expect(sourceStatus).toBe('FETCH_ERROR');
    expect(games).toEqual([]);
  });

  it('returns sourceStatus PARSE_ERROR when response is not valid JSON', async () => {
    global.fetch = makeFetchBadJson(200);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { games, sourceStatus } = await fetchSplitsForDate({ sport: 'NBA', date: '20260403' });
    expect(sourceStatus).toBe('PARSE_ERROR');
    expect(games).toEqual([]);
  });
});

// ─── matchSplitsToGameId ──────────────────────────────────────────────────────

const NORMALIZED_GAME = {
  actionNetworkGameId: '99',
  homeTeam: 'Boston Celtics',
  awayTeam: 'Golden State Warriors',
  commenceTime: '2026-04-03T00:00:00.000Z',
  markets: [],
};

const KNOWN_GAMES = [
  { gameId: 'game-abc', homeTeam: 'Boston Celtics', awayTeam: 'Golden State Warriors' },
];

describe('matchSplitsToGameId', () => {
  it('returns an array of { gameId, game } for matched entries', () => {
    const result = matchSplitsToGameId([NORMALIZED_GAME], KNOWN_GAMES);
    expect(result).toHaveLength(1);
    expect(result[0].gameId).toBe('game-abc');
    expect(result[0].game).toBe(NORMALIZED_GAME);
  });

  it('returns empty array when no games match', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = matchSplitsToGameId([NORMALIZED_GAME], [
      { gameId: 'x', homeTeam: 'Los Angeles Lakers', awayTeam: 'Denver Nuggets' },
    ]);
    expect(result).toHaveLength(0);
  });

  it('returns [] when given non-array arguments', () => {
    expect(matchSplitsToGameId(null, [])).toEqual([]);
    expect(matchSplitsToGameId([], null)).toEqual([]);
    expect(matchSplitsToGameId(null, null)).toEqual([]);
  });

  it('emits a console.warn for unmatched games', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    matchSplitsToGameId([NORMALIZED_GAME], []);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unmatched'));
  });
});
