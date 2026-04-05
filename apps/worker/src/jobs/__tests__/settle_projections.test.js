'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// settle_projections.test.js
// Unit tests for the 4 new player-prop settlement handlers and fetchMlbPitcherKs
// ─────────────────────────────────────────────────────────────────────────────

// Mock @cheddar-logic/data before requiring the module under test
jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  hasSuccessfulJobRun: jest.fn().mockReturnValue(false),
  shouldRunJobKey: jest.fn().mockReturnValue(true),
  withDb: jest.fn(async (fn) => fn()),
  getUnsettledProjectionCards: jest.fn(),
  setProjectionActualResult: jest.fn(),
}));

// Mock nhl-settlement-source
jest.mock('../nhl-settlement-source', () => ({
  fetchNhlSettlementSnapshot: jest.fn(),
}));

// Mock settle_mlb_f5 (imported for fetchF5Total, not used in player-prop handlers)
jest.mock('../settle_mlb_f5', () => ({
  fetchF5Total: jest.fn(),
}));

const {
  getDatabase,
  getUnsettledProjectionCards,
  hasSuccessfulJobRun,
  setProjectionActualResult,
} = require('@cheddar-logic/data');

const { fetchNhlSettlementSnapshot } = require('../nhl-settlement-source');

const { settleProjections, fetchMlbPitcherKs } = require('../settle_projections');

// ─────────────────────────────────────────────────────────────────────────────
// fetchMlbPitcherKs — mocked global.fetch
// ─────────────────────────────────────────────────────────────────────────────

function buildMlbBoxscorePayload({ gameState = 'Final', pitchers = {} } = {}) {
  // pitchers: { home: {playerId: ks}, away: {playerId: ks} }
  function buildPlayers(playerMap) {
    const players = {};
    for (const [id, ks] of Object.entries(playerMap)) {
      players[`ID${id}`] = { stats: { pitching: { strikeOuts: ks } } };
    }
    return players;
  }
  return {
    gameData: { status: { abstractGameState: gameState } },
    liveData: {
      boxscore: {
        teams: {
          home: { players: buildPlayers(pitchers.home || {}) },
          away: { players: buildPlayers(pitchers.away || {}) },
        },
      },
    },
  };
}

describe('fetchMlbPitcherKs', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
  });

  test('returns {available: false} when game is not final', async () => {
    const payload = buildMlbBoxscorePayload({ gameState: 'Live' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await fetchMlbPitcherKs(745398);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('game_not_final');
  });

  test('returns ksByPlayerId when game is final and pitcher found', async () => {
    const payload = buildMlbBoxscorePayload({
      gameState: 'Final',
      pitchers: {
        home: { '543135': 7 },
        away: { '592789': 4 },
      },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await fetchMlbPitcherKs(745398);
    expect(result.available).toBe(true);
    expect(result.ksByPlayerId['543135']).toBe(7);
    expect(result.ksByPlayerId['592789']).toBe(4);
  });

  test('returns undefined for a pitcherId not found in boxscore', async () => {
    const payload = buildMlbBoxscorePayload({
      gameState: 'Final',
      pitchers: { home: { '543135': 5 } },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await fetchMlbPitcherKs(745398);
    expect(result.available).toBe(true);
    expect(result.ksByPlayerId['999999']).toBeUndefined();
  });

  test('returns {available: false, reason: fetch_failed} when both URLs fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await fetchMlbPitcherKs(745398);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('fetch_failed');
  });

  test('falls back to second URL when first returns !ok', async () => {
    const payload = buildMlbBoxscorePayload({
      gameState: 'Final',
      pitchers: { home: { '543135': 6 } },
    });
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchMlbPitcherKs(745398);
    expect(result.available).toBe(true);
    expect(result.ksByPlayerId['543135']).toBe(6);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// settleProjections — actual_result shape tests for the 4 new card types
// ─────────────────────────────────────────────────────────────────────────────

function makeNhlSnapshot({
  available = true,
  isFinal = true,
  isFirstPeriodComplete = true,
  fullGameByPlayerId = {},
  firstPeriodByPlayerId = {},
  fullGameBlocksByPlayerId = {},
} = {}) {
  return {
    available,
    isFinal,
    isFirstPeriodComplete,
    playerShots: {
      fullGameByPlayerId,
      firstPeriodByPlayerId,
      playerNamesById: {},
    },
    playerBlocks: {
      fullGameByPlayerId: fullGameBlocksByPlayerId,
      playerNamesById: {},
    },
  };
}

function makeCard(cardType, playerId, gameId = null) {
  // NHL cards need a numeric game_id so resolveNhlGamecenterId fallback works
  const defaultGameId = cardType.startsWith('mlb') ? 'mlb-test-game' : '2024020001';
  return {
    card_id: `card-${cardType}-${playerId}`,
    game_id: gameId ?? defaultGameId,
    sport: cardType.startsWith('mlb') ? 'mlb' : 'nhl',
    card_type: cardType,
    payload_data: JSON.stringify({ player_id: playerId }),
    game_time_utc: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    home_team: 'BOS',
    away_team: 'NYY',
  };
}

describe('settleProjections — nhl-player-shots actual_result shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(null) }),
    });
  });

  test('writes {shots: N} when game is final and player found in fullGameByPlayerId', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-shots', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ fullGameByPlayerId: { [playerId]: 5 } }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).toHaveBeenCalledWith(
      `card-nhl-player-shots-${playerId}`,
      { shots: 5 },
    );
    expect(result.settled).toBe(1);
  });

  test('skips when player_id not found in fullGameByPlayerId', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-shots', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ fullGameByPlayerId: {} }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test('skips when game is not yet final', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-shots', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFinal: false, fullGameByPlayerId: { [playerId]: 3 } }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('settleProjections — nhl-player-shots-1p actual_result shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(null) }),
    });
  });

  test('writes {shots_1p: N} when 1P complete and player found in firstPeriodByPlayerId', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-shots-1p', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFirstPeriodComplete: true, firstPeriodByPlayerId: { [playerId]: 3 } }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).toHaveBeenCalledWith(
      `card-nhl-player-shots-1p-${playerId}`,
      { shots_1p: 3 },
    );
    expect(result.settled).toBe(1);
  });

  test('skips when first period is not yet complete', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-shots-1p', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFirstPeriodComplete: false, firstPeriodByPlayerId: { [playerId]: 2 } }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test('skips when player_id not found in firstPeriodByPlayerId', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-shots-1p', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFirstPeriodComplete: true, firstPeriodByPlayerId: {} }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('settleProjections — nhl-player-blk actual_result shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(null) }),
    });
  });

  test('writes {blocks: N} when game is final and player found in fullGameBlocksByPlayerId', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-blk', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFinal: true, fullGameBlocksByPlayerId: { [playerId]: 4 } }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).toHaveBeenCalledWith(
      `card-nhl-player-blk-${playerId}`,
      { blocks: 4 },
    );
    expect(result.settled).toBe(1);
  });

  test('skips when game is not final', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-blk', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFinal: false, fullGameBlocksByPlayerId: { [playerId]: 2 } }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test('skips when player_id not found in fullGameBlocksByPlayerId', async () => {
    const playerId = '8478402';
    getUnsettledProjectionCards.mockReturnValue([makeCard('nhl-player-blk', playerId)]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeNhlSnapshot({ isFinal: true, fullGameBlocksByPlayerId: {} }),
    );

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('settleProjections — mlb-pitcher-k actual_result shape', () => {
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
  });

  test('writes {pitcher_ks: N} when game is final and pitcher found', async () => {
    const playerId = '543135';
    const mockCard = makeCard('mlb-pitcher-k', playerId, 'mlb-test-game');
    getUnsettledProjectionCards.mockReturnValue([mockCard]);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ game_pk: 745398 }),
      }),
    });

    const payload = buildMlbBoxscorePayload({
      gameState: 'Final',
      pitchers: { home: { [playerId]: 8 } },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).toHaveBeenCalledWith(
      `card-mlb-pitcher-k-${playerId}`,
      { pitcher_ks: 8 },
    );
    expect(result.settled).toBe(1);
  });

  test('skips when gamePk not found in mlb_game_pk_map', async () => {
    const playerId = '543135';
    getUnsettledProjectionCards.mockReturnValue([makeCard('mlb-pitcher-k', playerId)]);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null), // no gamePk row
      }),
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test('skips silently when game is not yet final', async () => {
    const playerId = '543135';
    getUnsettledProjectionCards.mockReturnValue([makeCard('mlb-pitcher-k', playerId)]);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ game_pk: 745398 }),
      }),
    });

    const payload = buildMlbBoxscorePayload({ gameState: 'Live' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test('skips when pitcher_id not found in boxscore', async () => {
    const playerId = '999999';
    getUnsettledProjectionCards.mockReturnValue([makeCard('mlb-pitcher-k', playerId)]);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ game_pk: 745398 }),
      }),
    });

    const payload = buildMlbBoxscorePayload({
      gameState: 'Final',
      pitchers: { home: { '543135': 7 } }, // different pitcher
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await settleProjections({ dryRun: false });

    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// Sequential ordering guard — settle_projections must not run before game results
// ─────────────────────────────────────────────────────────────────────────────

describe('settleProjections — sequential ordering guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips with guardedBy=game-results when game-results not yet SUCCESS (hourly key)', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);

    const jobKey = 'settle|hourly|2026-04-04|14|projections';
    const result = await settleProjections({ jobKey, dryRun: false });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.guardedBy).toBe('game-results');
    expect(hasSuccessfulJobRun).toHaveBeenCalledWith(
      'settle|hourly|2026-04-04|14|game-results',
    );
    expect(setProjectionActualResult).not.toHaveBeenCalled();
  });

  test('skips with guardedBy=game-results when game-results not yet SUCCESS (nightly key)', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);

    const jobKey = 'settle|nightly|2026-04-04|projections';
    const result = await settleProjections({ jobKey, dryRun: false });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.guardedBy).toBe('game-results');
    expect(hasSuccessfulJobRun).toHaveBeenCalledWith(
      'settle|nightly|2026-04-04|game-results',
    );
  });

  test('proceeds normally when game-results is SUCCESS', async () => {
    hasSuccessfulJobRun.mockReturnValue(true);
    getUnsettledProjectionCards.mockReturnValue([]);

    const jobKey = 'settle|hourly|2026-04-04|14|projections';
    const result = await settleProjections({ jobKey, dryRun: false });

    expect(result.success).toBe(true);
    expect(result.guardedBy).toBeUndefined();
    expect(result.settled).toBe(0);
  });

  test('no guard check when jobKey is null', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);
    getUnsettledProjectionCards.mockReturnValue([]);

    const result = await settleProjections({ jobKey: null, dryRun: false });

    expect(hasSuccessfulJobRun).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});