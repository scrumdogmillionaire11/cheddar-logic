'use strict';

/**
 * Tests for pull_public_splits.js
 */

let mockGetActiveGamesForSplits = jest.fn(() => []);
let mockUpdateOddsSnapshotSplits = jest.fn(() => 1);
let mockGetLatestOdds = jest.fn(() => null);

jest.mock('@cheddar-logic/data', () => ({
  getActiveGamesForSplits: (...args) => mockGetActiveGamesForSplits(...args),
  updateOddsSnapshotSplits: (...args) => mockUpdateOddsSnapshotSplits(...args),
  getLatestOdds: (...args) => mockGetLatestOdds(...args),
}));

let mockFetchSplitsForDate = jest.fn();
let mockNormalizeSplitsResponse = jest.fn(() => []);
let mockMatchSplitsToGameId = jest.fn(() => []);

jest.mock('@cheddar-logic/adapters/src/action-network', () => ({
  fetchSplitsForDate: (...args) => mockFetchSplitsForDate(...args),
  normalizeSplitsResponse: (...args) => mockNormalizeSplitsResponse(...args),
  matchSplitsToGameId: (...args) => mockMatchSplitsToGameId(...args),
}));

function loadModule() {
  jest.resetModules();
  // Re-register mocks after resetModules
  jest.mock('@cheddar-logic/data', () => ({
    getActiveGamesForSplits: (...args) => mockGetActiveGamesForSplits(...args),
    updateOddsSnapshotSplits: (...args) => mockUpdateOddsSnapshotSplits(...args),
    getLatestOdds: (...args) => mockGetLatestOdds(...args),
  }));
  jest.mock('@cheddar-logic/adapters/src/action-network', () => ({
    fetchSplitsForDate: (...args) => mockFetchSplitsForDate(...args),
    normalizeSplitsResponse: (...args) => mockNormalizeSplitsResponse(...args),
    matchSplitsToGameId: (...args) => mockMatchSplitsToGameId(...args),
  }));
  return require('../pull_public_splits');
}

function makeGame(overrides = {}) {
  return {
    game_id: 'game-1',
    home_team: 'Miami Heat',
    away_team: 'Boston Celtics',
    sport: 'NBA',
    game_time_utc: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeNormalizedGame(overrides = {}) {
  return {
    actionNetworkGameId: 'an-123',
    homeTeam: 'Miami Heat',
    awayTeam: 'Boston Celtics',
    commenceTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    markets: [
      {
        marketType: 'SPREAD',
        selectionScope: 'HOME_AWAY',
        valid: true,
        home_or_over_bets_pct: 0.62,
        away_or_under_bets_pct: 0.38,
        home_or_over_handle_pct: 0.55,
        away_or_under_handle_pct: 0.45,
        home_or_over_tickets_pct: 0.60,
        away_or_under_tickets_pct: 0.40,
        line: -3.5,
        source: 'ACTION_NETWORK',
        sourceMarketKey: 'spread',
      },
    ],
    ...overrides,
  };
}

describe('pull_public_splits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveGamesForSplits.mockReset();
    mockUpdateOddsSnapshotSplits.mockReset();
    mockGetLatestOdds.mockReset();
    mockFetchSplitsForDate.mockReset();
    mockNormalizeSplitsResponse.mockReset();
    mockMatchSplitsToGameId.mockReset();

    // Sensible defaults
    mockUpdateOddsSnapshotSplits.mockReturnValue(1);
    mockGetLatestOdds.mockReturnValue(null);
  });

  // ─── No games ───────────────────────────────────────────────────────────────

  test('returns success with empty stats when no active games', async () => {
    mockGetActiveGamesForSplits.mockReturnValueOnce([]);

    const { runPullPublicSplits } = loadModule();
    const result = await runPullPublicSplits();

    expect(result.success).toBe(true);
    expect(result.totalWritten).toBe(0);
    expect(result.sportsProcessed).toBe(0);
    expect(mockFetchSplitsForDate).not.toHaveBeenCalled();
  });

  // ─── Happy path: single matched game ────────────────────────────────────────

  test('fetches, matches, and writes splits for a matched game', async () => {
    const game = makeGame();
    mockGetActiveGamesForSplits.mockReturnValue([game]);
    mockFetchSplitsForDate.mockResolvedValue({ games: [{}], sourceStatus: 'OK' });
    mockNormalizeSplitsResponse.mockReturnValue([makeNormalizedGame()]);
    mockMatchSplitsToGameId.mockReturnValue([
      { gameId: 'game-1', game: makeNormalizedGame() },
    ]);

    const { runPullPublicSplits } = loadModule();
    const result = await runPullPublicSplits();

    expect(result.success).toBe(true);
    expect(result.totalMatched).toBe(1);
    expect(result.totalWritten).toBe(1);
    expect(result.totalProxyFlagged).toBe(0);

    // Verify the write call includes action_network source
    const writeCall = mockUpdateOddsSnapshotSplits.mock.calls[0][0];
    expect(writeCall.gameId).toBe('game-1');
    expect(writeCall.splitsData.splits_source).toBe('action_network');
    expect(writeCall.splitsData.public_bets_pct_home).toBe(0.62);
    expect(writeCall.splitsData.public_bets_pct_away).toBe(0.38);
  });

  // ─── Soft-fail on non-200 per sport ─────────────────────────────────────────

  test('soft-fails on FETCH_ERROR and continues other sports', async () => {
    const nbaGame = makeGame({ sport: 'NBA', game_id: 'nba-1' });
    const mlbGame = makeGame({ sport: 'MLB', game_id: 'mlb-1' });
    mockGetActiveGamesForSplits.mockReturnValue([nbaGame, mlbGame]);

    // NBA fetch fails
    mockFetchSplitsForDate.mockImplementation(({ sport }) => {
      if (sport === 'NBA') return Promise.resolve({ games: [], sourceStatus: 'FETCH_ERROR' });
      return Promise.resolve({ games: [{}], sourceStatus: 'OK' });
    });
    mockNormalizeSplitsResponse.mockReturnValue([makeNormalizedGame({ homeTeam: 'Miami Heat', awayTeam: 'Boston Celtics' })]);
    mockMatchSplitsToGameId.mockReturnValue([
      { gameId: 'mlb-1', game: makeNormalizedGame() },
    ]);

    const { runPullPublicSplits } = loadModule();
    const result = await runPullPublicSplits();

    expect(result.success).toBe(true);
    expect(result.sportStats.NBA.sourceStatus).toBe('FETCH_ERROR');
    expect(result.sportStats.NBA.matched).toBe(0);
    // MLB branch still processed
    expect(result.sportsProcessed).toBe(2);
  });

  // ─── Pinnacle proxy for unmatched HIGH-confidence games ─────────────────────

  test('flags unmatched HIGH-confidence game as pinnacle_proxy', async () => {
    const game = makeGame({ game_id: 'unmatched-1' });
    mockGetActiveGamesForSplits.mockReturnValue([game]);
    mockFetchSplitsForDate.mockResolvedValue({ games: [{}], sourceStatus: 'OK' });
    mockNormalizeSplitsResponse.mockReturnValue([makeNormalizedGame()]);

    // No match (empty matches array)
    mockMatchSplitsToGameId.mockReturnValue([]);

    // The snapshot has HIGH consensus
    mockGetLatestOdds.mockReturnValue({ spread_consensus_confidence: 'HIGH' });

    const { runPullPublicSplits } = loadModule();
    const result = await runPullPublicSplits();

    expect(result.totalProxyFlagged).toBe(1);
    expect(result.totalWritten).toBe(0);

    const proxyCall = mockUpdateOddsSnapshotSplits.mock.calls[0][0];
    expect(proxyCall.splitsData.splits_source).toBe('pinnacle_proxy');
    expect(proxyCall.splitsData.public_bets_pct_home).toBeNull();
  });

  // ─── Unmatched non-HIGH-confidence: no pinnacle_proxy write ─────────────────

  test('does not flag unmatched MEDIUM-confidence game as proxy', async () => {
    const game = makeGame({ game_id: 'unmatched-2' });
    mockGetActiveGamesForSplits.mockReturnValue([game]);
    mockFetchSplitsForDate.mockResolvedValue({ games: [{}], sourceStatus: 'OK' });
    mockNormalizeSplitsResponse.mockReturnValue([makeNormalizedGame()]);
    mockMatchSplitsToGameId.mockReturnValue([]);
    mockGetLatestOdds.mockReturnValue({ spread_consensus_confidence: 'MEDIUM' });

    const { runPullPublicSplits } = loadModule();
    const result = await runPullPublicSplits();

    expect(result.totalProxyFlagged).toBe(0);
    expect(mockUpdateOddsSnapshotSplits).not.toHaveBeenCalled();
  });

  // ─── Match rate logging boundary ────────────────────────────────────────────

  test('match rate ≥70% is success, <70% still succeeds (checked via stats)', async () => {
    // 1 of 2 games matched → 50% → WARN path but still success
    const g1 = makeGame({ game_id: 'g1' });
    const g2 = makeGame({ game_id: 'g2' });
    mockGetActiveGamesForSplits.mockReturnValue([g1, g2]);
    mockFetchSplitsForDate.mockResolvedValue({ games: [{}], sourceStatus: 'OK' });
    mockNormalizeSplitsResponse.mockReturnValue([makeNormalizedGame()]);
    mockMatchSplitsToGameId.mockReturnValue([{ gameId: 'g1', game: makeNormalizedGame() }]);
    mockGetLatestOdds.mockReturnValue(null); // g2 has no snapshot

    const { runPullPublicSplits } = loadModule();
    const result = await runPullPublicSplits();

    expect(result.success).toBe(true);
    expect(result.sportStats.NBA.matchRate).toBeCloseTo(0.5);
  });
});
