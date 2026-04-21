'use strict';

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  upsertGameIdMap: jest.fn(),
  withDb: jest.fn(async (fn) => fn()),
}));

global.fetch = jest.fn();

// ── Helpers ──────────────────────────────────────────────────────────────────
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertGameIdMap,
} = require('@cheddar-logic/data');

const {
  extractGamesFromSchedule,
  resolveCanonicalGameId,
  pullNhlGameIds,
} = require('../pull_nhl_game_ids');

function makeScheduleResponse({ games = [] } = {}) {
  return {
    gameWeek: [
      {
        date: '2026-04-21',
        games,
      },
    ],
  };
}

function makeGame({ id, gameDate, homeAbbrev, awayAbbrev }) {
  return {
    id,
    gameDate,
    homeTeam: { abbrev: homeAbbrev },
    awayTeam: { abbrev: awayAbbrev },
  };
}

function makeMockDb({ espnRow = null, existingRow = null } = {}) {
  const mockGet = jest.fn();
  // First call: resolveCanonicalGameId ESPN lookup
  // Second call: existing nhl_gamecenter row check
  mockGet
    .mockReturnValueOnce(espnRow)
    .mockReturnValueOnce(existingRow);

  return {
    prepare: jest.fn(() => ({ get: mockGet })),
    _mockGet: mockGet,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('extractGamesFromSchedule', () => {
  test('extracts game id, date, and team abbreviations from gameWeek', () => {
    const raw = makeScheduleResponse({
      games: [
        makeGame({ id: 2025021234, gameDate: '2026-04-21', homeAbbrev: 'BOS', awayAbbrev: 'TOR' }),
        makeGame({ id: 2025021235, gameDate: '2026-04-21', homeAbbrev: 'NYR', awayAbbrev: 'WSH' }),
      ],
    });

    const result = extractGamesFromSchedule(raw);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      nhlGameId: '2025021234',
      gameDate: '2026-04-21',
      homeAbbrev: 'BOS',
      awayAbbrev: 'TOR',
    });
  });

  test('returns empty array for empty gameWeek', () => {
    expect(extractGamesFromSchedule({})).toEqual([]);
    expect(extractGamesFromSchedule({ gameWeek: [] })).toEqual([]);
  });

  test('skips games missing id', () => {
    const raw = makeScheduleResponse({
      games: [makeGame({ id: null, gameDate: '2026-04-21', homeAbbrev: 'BOS', awayAbbrev: 'TOR' })],
    });
    expect(extractGamesFromSchedule(raw)).toHaveLength(0);
  });
});

describe('resolveCanonicalGameId', () => {
  test('returns game_id when ESPN row found via date + team abbrev LIKE match', () => {
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({ game_id: 'canonical-bos-tor' })),
      })),
    };

    const result = resolveCanonicalGameId(db, {
      gameDate: '2026-04-21',
      homeAbbrev: 'BOS',
      awayAbbrev: 'TOR',
    });

    expect(result).toBe('canonical-bos-tor');
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("provider = 'espn'"));
  });

  test('returns null when no ESPN row found', () => {
    const db = {
      prepare: jest.fn(() => ({ get: jest.fn(() => null) })),
    };

    const result = resolveCanonicalGameId(db, {
      gameDate: '2026-04-21',
      homeAbbrev: 'SJS',
      awayAbbrev: 'VAN',
    });

    expect(result).toBeNull();
  });

  test('returns null when any input field is missing', () => {
    const db = { prepare: jest.fn(() => ({ get: jest.fn() })) };

    expect(resolveCanonicalGameId(db, { gameDate: '', homeAbbrev: 'BOS', awayAbbrev: 'TOR' })).toBeNull();
    expect(resolveCanonicalGameId(db, { gameDate: '2026-04-21', homeAbbrev: '', awayAbbrev: 'TOR' })).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

describe('pullNhlGameIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('upserts with provider=nhl_gamecenter when canonical game_id matched', async () => {
    const db = makeMockDb({
      espnRow: { game_id: 'canonical-bos-tor' },
      existingRow: null,
    });
    getDatabase.mockReturnValue(db);

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () =>
        makeScheduleResponse({
          games: [makeGame({ id: 2025021234, gameDate: '2026-04-21', homeAbbrev: 'BOS', awayAbbrev: 'TOR' })],
        }),
    });

    const result = await pullNhlGameIds({ dateRange: 0 });

    expect(result.success).toBe(true);
    expect(result.fetched).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.inserted).toBe(1);
    expect(upsertGameIdMap).toHaveBeenCalledWith(
      expect.objectContaining({
        sport: 'nhl',
        provider: 'nhl_gamecenter',
        externalGameId: '2025021234',
        gameId: 'canonical-bos-tor',
        matchMethod: 'schedule_date_teams',
        matchConfidence: 1.0,
      }),
    );
  });

  test('counts unmatched games — does not call upsertGameIdMap', async () => {
    const db = makeMockDb({ espnRow: null });
    getDatabase.mockReturnValue(db);

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () =>
        makeScheduleResponse({
          games: [makeGame({ id: 9999999, gameDate: '2026-04-21', homeAbbrev: 'SJS', awayAbbrev: 'VAN' })],
        }),
    });

    const result = await pullNhlGameIds({ dateRange: 0 });

    expect(result.unmatched).toBe(1);
    expect(result.matched).toBe(0);
    expect(upsertGameIdMap).not.toHaveBeenCalled();
  });

  test('dryRun=true skips fetch and upsert', async () => {
    const result = await pullNhlGameIds({ dryRun: true, dateRange: 0 });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(upsertGameIdMap).not.toHaveBeenCalled();
    expect(insertJobRun).not.toHaveBeenCalled();
  });

  test('skips job when shouldRunJobKey returns false', async () => {
    shouldRunJobKey.mockReturnValueOnce(false);

    const result = await pullNhlGameIds({ jobKey: 'pull|nhl-game-ids|2026-04-21' });

    expect(result.skipped).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('counts updated when nhl_gamecenter row already exists', async () => {
    const db = {
      prepare: jest.fn(() => {
        let callCount = 0;
        return {
          get: jest.fn(() => {
            callCount += 1;
            // First call: ESPN lookup returns match
            if (callCount === 1) return { game_id: 'canonical-bos-tor' };
            // Second call: existing nhl_gamecenter row
            return { external_game_id: '2024021000' };
          }),
        };
      }),
    };
    getDatabase.mockReturnValue(db);

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () =>
        makeScheduleResponse({
          games: [makeGame({ id: 2025021234, gameDate: '2026-04-21', homeAbbrev: 'BOS', awayAbbrev: 'TOR' })],
        }),
    });

    const result = await pullNhlGameIds({ dateRange: 0 });

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    expect(upsertGameIdMap).toHaveBeenCalledTimes(1);
  });

  test('continues after fetch failure for a date and counts remaining successes', async () => {
    const db = makeMockDb({
      espnRow: { game_id: 'canonical-bos-tor' },
      existingRow: null,
    });
    getDatabase.mockReturnValue(db);

    global.fetch
      // First date (e.g., today-1): fetch error
      .mockRejectedValueOnce(new Error('network timeout'))
      // Second date (today): success
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeScheduleResponse({
            games: [makeGame({ id: 2025021234, gameDate: '2026-04-21', homeAbbrev: 'BOS', awayAbbrev: 'TOR' })],
          }),
      });

    const result = await pullNhlGameIds({ dateRange: 1 });

    // Should not throw; 3 dates total (±1), 1 fetch error tolerated
    expect(result.success).toBe(true);
    expect(result.fetched).toBeGreaterThanOrEqual(1);
  });

  test('records job failure and returns success=false when DB throws', async () => {
    getDatabase.mockReturnValue({
      prepare: jest.fn(() => {
        throw new Error('DB exploded');
      }),
    });

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () =>
        makeScheduleResponse({
          games: [makeGame({ id: 2025021234, gameDate: '2026-04-21', homeAbbrev: 'BOS', awayAbbrev: 'TOR' })],
        }),
    });

    const result = await pullNhlGameIds({ dateRange: 0 });

    expect(result.success).toBe(false);
    expect(markJobRunFailure).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('DB exploded'),
    );
  });
});
