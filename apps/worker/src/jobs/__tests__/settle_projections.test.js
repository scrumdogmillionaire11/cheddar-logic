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
  batchInsertProjectionProxyEvals: jest.fn(),
}));

// Mock nhl-settlement-source
jest.mock('../nhl-settlement-source', () => ({
  fetchNhlSettlementSnapshot: jest.fn(),
  resolveNhlFullGamePlayerShots: jest.requireActual('../nhl-settlement-source').resolveNhlFullGamePlayerShots,
}));

// Mock settle_mlb_f5 (imported for fetchF5Total, not used in player-prop handlers)
jest.mock('../settle_mlb_f5', () => ({
  fetchF5Total: jest.fn(),
  fetchF5GameState: jest.fn(),
  resolveF5Snapshot: jest.fn(),
  resolveMlbGamePk: jest.fn(),
}));

const {
  getDatabase,
  getUnsettledProjectionCards,
  hasSuccessfulJobRun,
  setProjectionActualResult,
  batchInsertProjectionProxyEvals,
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
    batchInsertProjectionProxyEvals.mockImplementation(() => undefined);
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
  let metadataUpdates;
  let resolveMlbGamePkMock;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    metadataUpdates = [];
    resolveMlbGamePkMock = require('../settle_mlb_f5').resolveMlbGamePk;
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
    resolveMlbGamePkMock.mockReturnValue(745398);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(null), run: jest.fn() }),
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

  test('writes terminal projection_settlement metadata when gamePk not found in mlb_game_pk_map', async () => {
    const playerId = '543135';
    getUnsettledProjectionCards.mockReturnValue([makeCard('mlb-pitcher-k', playerId)]);
      resolveMlbGamePkMock.mockReturnValue(null);
    getDatabase.mockReturnValue({
      prepare: jest.fn((sql) => {
        if (sql.includes('FROM card_results')) {
          return {
            get: jest.fn().mockReturnValue({ id: 'result-1', metadata: '{}' }),
          };
        }
        if (sql.includes('UPDATE card_results')) {
          return {
            run: jest.fn((metadataJson, id) => {
              metadataUpdates.push({ id, metadata: JSON.parse(metadataJson) });
              return { changes: 1 };
            }),
          };
        }
        return { get: jest.fn().mockReturnValue(null), run: jest.fn() };
      }),
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(metadataUpdates).toHaveLength(1);
    expect(metadataUpdates[0]).toMatchObject({
      id: 'result-1',
      metadata: {
        projection_settlement: expect.objectContaining({
          code: 'PROJECTION_SETTLEMENT_NO_GAME_PK',
        }),
      },
    });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test('skips silently when game is not yet final', async () => {
    const playerId = '543135';
    getUnsettledProjectionCards.mockReturnValue([makeCard('mlb-pitcher-k', playerId)]);
    resolveMlbGamePkMock.mockReturnValue(745398);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(null), run: jest.fn() }),
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

  test('writes terminal projection_settlement metadata when pitcher_id not found in boxscore', async () => {
    const playerId = '999999';
      resolveMlbGamePkMock.mockReturnValue(745398);
    getUnsettledProjectionCards.mockReturnValue([makeCard('mlb-pitcher-k', playerId)]);
    getDatabase.mockReturnValue({
      prepare: jest.fn((sql) => {
        if (sql.includes('FROM card_results')) {
          return {
            get: jest.fn().mockReturnValue({ id: 'result-2', metadata: '{}' }),
          };
        }
        if (sql.includes('UPDATE card_results')) {
          return {
            run: jest.fn((metadataJson, id) => {
              metadataUpdates.push({ id, metadata: JSON.parse(metadataJson) });
              return { changes: 1 };
            }),
          };
        }
        return { get: jest.fn().mockReturnValue(null), run: jest.fn() };
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
    expect(metadataUpdates).toHaveLength(1);
    expect(metadataUpdates[0]).toMatchObject({
      id: 'result-2',
      metadata: {
        projection_settlement: expect.objectContaining({
          code: 'PROJECTION_SETTLEMENT_NO_PLAYER_MATCH',
        }),
      },
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// proxy eval integration (WI-0866)
// ─────────────────────────────────────────────────────────────────────────────

function makeProjectionCard(cardType, projection) {
  const isNhl = cardType.startsWith('nhl');
  return {
    card_id: `card-${cardType}-proj`,
    game_id: isNhl ? '2024020001' : 'mlb-proj-game',
    sport: isNhl ? 'nhl' : 'baseball_mlb',
    card_type: cardType,
    payload_data: JSON.stringify({ projected_total: projection }),
    game_time_utc: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    home_team: 'BOS',
    away_team: 'NYY',
  };
}

describe('settleProjections — proxy eval integration', () => {
  const {
    fetchF5Total,
    fetchF5GameState,
    resolveF5Snapshot,
    resolveMlbGamePk: resolveMlbGamePkFn,
  } = require('../settle_mlb_f5');
  const { fetchNhlSettlementSnapshot: fetchNhlSnapshot } = require('../nhl-settlement-source');

  beforeEach(() => {
    jest.clearAllMocks();
    batchInsertProjectionProxyEvals.mockImplementation(() => undefined);
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ game_pk: '745340' }),
      }),
    });
    resolveMlbGamePkFn.mockReturnValue('745340');
  });

  test('Case 1: mlb-f5 card triggers batchInsertProjectionProxyEvals with 2 rows', async () => {
    getUnsettledProjectionCards.mockReturnValue([makeProjectionCard('mlb-f5', 4.82)]);
    fetchF5Total.mockResolvedValue(5);

    const result = await settleProjections({ dryRun: false });

    expect(result.settled).toBe(1);
    expect(batchInsertProjectionProxyEvals).toHaveBeenCalledTimes(1);
    const [, rows] = batchInsertProjectionProxyEvals.mock.calls[0];
    expect(rows).toHaveLength(2);  // lines 3.5 and 4.5
    expect(rows.every((r) => r.card_family === 'MLB_F5_TOTAL')).toBe(true);
    expect(rows.every((r) => r.actual_value === 5)).toBe(true);
    expect(rows.every((r) => r.game_id === 'mlb-proj-game')).toBe(true);
  });

  test('Case 2: nhl-pace-1p card triggers batchInsertProjectionProxyEvals with 1 row', async () => {
    getUnsettledProjectionCards.mockReturnValue([makeProjectionCard('nhl-pace-1p', 1.70)]);
    fetchNhlSnapshot.mockResolvedValue({
      available: true,
      isFirstPeriodComplete: true,
      homeFirstPeriodScore: 1,
      awayFirstPeriodScore: 1,
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.settled).toBe(1);
    expect(batchInsertProjectionProxyEvals).toHaveBeenCalledTimes(1);
    const [, rows] = batchInsertProjectionProxyEvals.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0].proxy_line).toBe(1.5);
    expect(rows[0].card_family).toBe('NHL_1P_TOTAL');
  });

  test('Case 3: nhl-player-shots card does NOT call batchInsertProjectionProxyEvals', async () => {
    getUnsettledProjectionCards.mockReturnValue([makeProjectionCard('nhl-player-shots', 3.0)]);
    fetchNhlSnapshot.mockResolvedValue({
      available: true,
      isFinal: true,
      playerShots: { fullGameByPlayerId: {} },
    });

    // Player not found → settled=0, skipped=1, no proxy eval
    await settleProjections({ dryRun: false });

    expect(batchInsertProjectionProxyEvals).not.toHaveBeenCalled();
  });

  test('Case 4: proxy eval insert failure does NOT abort settlement', async () => {
    getUnsettledProjectionCards.mockReturnValue([makeProjectionCard('mlb-f5', 4.82)]);
    fetchF5Total.mockResolvedValue(5);
    batchInsertProjectionProxyEvals.mockImplementation(() => { throw new Error('DB locked'); });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(result.settled).toBe(1);
    expect(setProjectionActualResult).toHaveBeenCalledWith('card-mlb-f5-proj', { runs_f5: 5 });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[settle_projections] proxy eval insert failed',
      'card-mlb-f5-proj',
      'DB locked',
    );

    consoleSpy.mockRestore();
  });

  test('mlb-f5-ml writes selected-side actual and one moneyline proxy eval row', async () => {
    getUnsettledProjectionCards.mockReturnValue([{
      ...makeProjectionCard('mlb-f5-ml', null),
      payload_data: JSON.stringify({
        prediction: 'AWAY',
        selection: { side: 'AWAY' },
        p_fair: 0.61,
        confidence_score: 74,
        confidence_band: 'HIGH',
        projection: { projected_win_prob_home: 0.39 },
      }),
    }]);
    fetchF5GameState.mockResolvedValue({ gamePk: '745340' });
    resolveF5Snapshot.mockReturnValue({
      status: 'READY',
      home_runs: 1,
      away_runs: 3,
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.settled).toBe(1);
    expect(setProjectionActualResult).toHaveBeenCalledWith(
      'card-mlb-f5-ml-proj',
      {
        f5_home_runs: 1,
        f5_away_runs: 3,
        f5_winner: 'AWAY',
        f5_ml_actual: 1,
        selected_side: 'AWAY',
      },
    );
    expect(batchInsertProjectionProxyEvals).toHaveBeenCalledTimes(1);
    const [, rows] = batchInsertProjectionProxyEvals.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_family: 'MLB_F5_ML',
      proj_value: 0.61,
      actual_value: 1,
      proxy_line: 0.5,
      edge_vs_line: 0.11,
      recommended_side: 'UNDER',
      confidence_bucket: 'HIGH',
      graded_result: 'WIN',
      hit_flag: 1,
      agreement_group: 'DIRECT_SELECTION',
    });
  });

  test('backfill mode materializes missing NHL 1P proxy rows from stored actual_result without refetching', async () => {
    getUnsettledProjectionCards.mockReturnValue([{
      ...makeProjectionCard('nhl-pace-1p', 1.7),
      actual_result: JSON.stringify({ goals_1p: 2 }),
    }]);

    const result = await settleProjections({ dryRun: false, backfillMissingProxyEvals: true });

    expect(result.success).toBe(true);
    expect(result.backfilled).toBe(1);
    expect(fetchNhlSnapshot).not.toHaveBeenCalled();
    expect(setProjectionActualResult).not.toHaveBeenCalled();
    expect(batchInsertProjectionProxyEvals).toHaveBeenCalledTimes(1);
    const [, rows] = batchInsertProjectionProxyEvals.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_id: 'card-nhl-pace-1p-proj',
      card_family: 'NHL_1P_TOTAL',
      proj_value: 1.7,
      actual_value: 2,
      proxy_line: 1.5,
      graded_result: 'NO_BET',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveNhlFullGamePlayerShots — unit tests (WI-0909)
// ─────────────────────────────────────────────────────────────────────────────

const { resolveNhlFullGamePlayerShots } = require('../nhl-settlement-source');

// ─────────────────────────────────────────────────────────────────────────────
// settle_projections — nhl-player-shots mismatch detection (WI-0909)
// ─────────────────────────────────────────────────────────────────────────────

function makeCardWithPlayerName(cardType, playerId, playerName, gameId = null) {
  const defaultGameId = cardType.startsWith('mlb') ? 'mlb-test-game' : '2024020001';
  return {
    card_id: `card-${cardType}-${playerId}`,
    game_id: gameId ?? defaultGameId,
    sport: 'nhl',
    card_type: cardType,
    payload_data: JSON.stringify({ player_id: playerId, player_name: playerName }),
    game_time_utc: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    home_team: 'EDM',
    away_team: 'CGY',
  };
}

function makeSnapshotWithNameLookup({
  available = true,
  isFinal = true,
  fullGameByPlayerId = {},
  playerIdByNormalizedName = {},
} = {}) {
  return {
    available,
    isFinal,
    isFirstPeriodComplete: true,
    playerShots: {
      fullGameByPlayerId,
      firstPeriodByPlayerId: {},
      playerNamesById: {},
      playerIdByNormalizedName,
      sources: { boxscore: true, playByPlay: true },
    },
    playerBlocks: { fullGameByPlayerId: {}, playerNamesById: {}, playerIdByNormalizedName: {} },
  };
}

describe('settleProjections — nhl-player-shots mismatch detection (WI-0909)', () => {
  let warnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('mismatch fixture: emits [NHL_SHOTS_MISMATCH] when stored shots=4 but live API shots=6', async () => {
    const playerId = '8478402';
    const card = makeCardWithPlayerName('nhl-player-shots', playerId, 'Connor McDavid');
    getUnsettledProjectionCards.mockReturnValue([card]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeSnapshotWithNameLookup({ fullGameByPlayerId: { [playerId]: 6 } }),
    );
    // DB returns stored game_results metadata with shots=4 (different from live 6)
    const storedMeta = JSON.stringify({
      playerShots: { fullGameByPlayerId: { [playerId]: 4 } },
    });
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ metadata: storedMeta }),
      }),
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.success).toBe(true);
    expect(result.settled).toBe(1);
    // API value (6) used for settlement, not stored (4)
    expect(setProjectionActualResult).toHaveBeenCalledWith(card.card_id, { shots: 6 });
    // Mismatch warn emitted
    const warnCalls = warnSpy.mock.calls.map((args) => args[0]);
    expect(warnCalls.some((msg) => String(msg).includes('[NHL_SHOTS_MISMATCH]'))).toBe(true);
  });

  test('no mismatch: no warn when stored shots=6 matches live API shots=6', async () => {
    const playerId = '8478402';
    const card = makeCardWithPlayerName('nhl-player-shots', playerId, 'Connor McDavid');
    getUnsettledProjectionCards.mockReturnValue([card]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeSnapshotWithNameLookup({ fullGameByPlayerId: { [playerId]: 6 } }),
    );
    const storedMeta = JSON.stringify({
      playerShots: { fullGameByPlayerId: { [playerId]: 6 } },
    });
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ metadata: storedMeta }),
      }),
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.settled).toBe(1);
    expect(setProjectionActualResult).toHaveBeenCalledWith(card.card_id, { shots: 6 });
    const warnCalls = warnSpy.mock.calls.map((args) => args[0]);
    expect(warnCalls.some((msg) => String(msg).includes('[NHL_SHOTS_MISMATCH]'))).toBe(false);
  });

  test('no stored row: proceeds normally with API value, no warn', async () => {
    const playerId = '8478402';
    const card = makeCardWithPlayerName('nhl-player-shots', playerId, 'Connor McDavid');
    getUnsettledProjectionCards.mockReturnValue([card]);
    fetchNhlSettlementSnapshot.mockResolvedValue(
      makeSnapshotWithNameLookup({ fullGameByPlayerId: { [playerId]: 3 } }),
    );
    // No game_results row found
    getDatabase.mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null),
      }),
    });

    const result = await settleProjections({ dryRun: false });

    expect(result.settled).toBe(1);
    expect(setProjectionActualResult).toHaveBeenCalledWith(card.card_id, { shots: 3 });
    const warnCalls = warnSpy.mock.calls.map((args) => args[0]);
    expect(warnCalls.some((msg) => String(msg).includes('[NHL_SHOTS_MISMATCH]'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveMoneylineConfidenceBucket — canonical resolution chain (WI-1145)
// ─────────────────────────────────────────────────────────────────────────────

const { resolveMoneylineConfidenceBucket } = require('../../audit/projection_evaluator');

describe('resolveMoneylineConfidenceBucket — canonical resolution chain', () => {
  test('Case 1: top-level confidence_band present returns its bucket', () => {
    const result = resolveMoneylineConfidenceBucket({ payload: { confidence_band: 'HIGH', confidence_score: 60 } });
    expect(result).toBe('HIGH');
  });

  test('Case 2: top-level absent, drivers[0].confidence_band present returns correct bucket', () => {
    const result = resolveMoneylineConfidenceBucket({ payload: { drivers: [{ confidence_band: 'MED' }] } });
    expect(result).toBe('MED');
  });

  test('Case 3: all band fields absent with confidence_score present derives bucket from score', () => {
    const result = resolveMoneylineConfidenceBucket({ payload: { confidence_score: 72 } });
    expect(result).toBe('HIGH');
  });

  test('Case 4: all fields absent returns LOW default', () => {
    const result = resolveMoneylineConfidenceBucket({ payload: {} });
    expect(result).toBe('LOW');
  });
});

function makeFullGameSnapshot({ fullGameByPlayerId = {}, playerIdByNormalizedName = {} } = {}) {
  return {
    available: true,
    isFinal: true,
    playerShots: {
      fullGameByPlayerId,
      firstPeriodByPlayerId: {},
      playerNamesById: {},
      playerIdByNormalizedName,
      sources: { boxscore: true, playByPlay: true },
    },
  };
}

describe('resolveNhlFullGamePlayerShots', () => {
  test('resolves by id when player id present in fullGameByPlayerId', () => {
    const snapshot = makeFullGameSnapshot({ fullGameByPlayerId: { '8478402': 5 } });
    const result = resolveNhlFullGamePlayerShots(snapshot, '8478402', 'Connor McDavid');
    expect(result).toEqual({ value: 5, resolvedBy: 'id' });
  });

  test('resolves by name when id not in map but name-lookup succeeds', () => {
    const snapshot = makeFullGameSnapshot({
      fullGameByPlayerId: { '8478402': 3 },
      playerIdByNormalizedName: { 'connor mcdavid': '8478402' },
    });
    // Use a player_id that is NOT in fullGameByPlayerId
    const result = resolveNhlFullGamePlayerShots(snapshot, '9999999', 'Connor McDavid');
    expect(result).toEqual({ value: 3, resolvedBy: 'name' });
  });

  test('returns null when player absent from both lookup paths', () => {
    const snapshot = makeFullGameSnapshot({ fullGameByPlayerId: { '8478402': 5 } });
    const result = resolveNhlFullGamePlayerShots(snapshot, '9999999', 'Unknown Player');
    expect(result).toBeNull();
  });

  test('returns null when snapshot has no playerShots', () => {
    const snapshot = { available: true, isFinal: true };
    const result = resolveNhlFullGamePlayerShots(snapshot, '8478402', 'Connor McDavid');
    expect(result).toBeNull();
  });
});
