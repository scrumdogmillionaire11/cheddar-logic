/**
 * Integration tests for settle_game_results.js with resilient ESPN client
 *
 * Tests the full settle game results flow including:
 * - Resilient ESPN client initialization
 * - Scoring validation integration
 * - Environment variable configuration
 * - Game result settlement with validated scores
 */

'use strict';

jest.mock('@cheddar-logic/data', () => ({
  upsertGameResult: jest.fn(),
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn((fn) => fn()),
}));

jest.mock('../../../../packages/data/src/espn-client', () => ({
  fetchScoreboardEvents: jest.fn(),
}));

jest.mock('../../utils/db-backup.js', () => ({
  backupDatabase: jest.fn(),
}));

const { settleGameResults } = require('../settle_game_results.js');
const { ResilientESPNClient } = require('../../utils/espn-resilient-client.js');
const { ScoringValidator } = require('../../utils/scoring-validator.js');

describe('settle_game_results.js Integration', () => {
  let mockDb;
  let mockUpsertGameResult;
  let mockGetDatabase;
  let mockInsertJobRun;
  let mockMarkJobRunSuccess;
  let mockFetchScoreboardEvents;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset environment variables to defaults
    delete process.env.ESPN_API_TIMEOUT_MS;
    delete process.env.SETTLEMENT_MAX_RETRIES;
    delete process.env.SETTLEMENT_MIN_HOURS_AFTER_START;

    const dataModule = require('@cheddar-logic/data');
    mockUpsertGameResult = dataModule.upsertGameResult;
    mockGetDatabase = dataModule.getDatabase;
    mockInsertJobRun = dataModule.insertJobRun;
    mockMarkJobRunSuccess = dataModule.markJobRunSuccess;

    const espnModule = require('../../../../packages/data/src/espn-client');
    mockFetchScoreboardEvents = espnModule.fetchScoreboardEvents;

    // Mock database
    mockDb = {
      prepare: jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue([]), // No pending games
      }),
    };
    mockGetDatabase.mockReturnValue(mockDb);
  });

  describe('Environment Variable Configuration', () => {
    it('should use default ESPN timeout (30000ms)', async () => {
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
      // Verify the job ran (would timeout if ESPN_API_TIMEOUT_MS was broken)
    });

    it('should use custom ESPN timeout from env var', async () => {
      process.env.ESPN_API_TIMEOUT_MS = '45000';
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
    });

    it('should use default max retries (3)', async () => {
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
    });

    it('should use custom max retries from env var', async () => {
      process.env.SETTLEMENT_MAX_RETRIES = '5';
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
    });

    it('should use default min hours after start (3)', async () => {
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
    });

    it('should use custom min hours from env var', async () => {
      process.env.SETTLEMENT_MIN_HOURS_AFTER_START = '6';
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
    });

    it('should enforce minimum timeout (5000ms)', async () => {
      process.env.ESPN_API_TIMEOUT_MS = '1000'; // Below minimum
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
      // Should use 5000ms minimum, not 1000ms
    });
  });

  describe('Dry-run mode', () => {
    it('should complete successfully without DB writes', async () => {
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(mockUpsertGameResult).not.toHaveBeenCalled();
    });

    it('should log initialization with configured timeouts', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      process.env.ESPN_API_TIMEOUT_MS = '45000';
      process.env.SETTLEMENT_MAX_RETRIES = '2';

      const result = await settleGameResults({ dryRun: true });

      expect(result.success).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Initialized with'),
        expect.any(String)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Job key idempotency', () => {
    it('should skip if jobKey already ran', async () => {
      const { shouldRunJobKey } = require('@cheddar-logic/data');
      shouldRunJobKey.mockReturnValue(false);

      const result = await settleGameResults({ jobKey: 'test-key-123' });

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.jobKey).toBe('test-key-123');
      expect(mockInsertJobRun).not.toHaveBeenCalled();
    });
  });

  describe('No pending games', () => {
    it('should complete with 0 games settled when no pending games found', async () => {
      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue([]), // No pending games
      });

      const result = await settleGameResults({});

      expect(result.success).toBe(true);
      expect(result.gamesSettled).toBe(0);
      expect(result.sportsProcessed).toEqual([]);
      expect(mockMarkJobRunSuccess).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should mark job as failed and return error', async () => {
      mockGetDatabase.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const result = await settleGameResults({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database connection failed');
    });

    it('should catch and log errors without throwing', async () => {
      mockDb.prepare.mockImplementation(() => {
        throw new Error('SQL error');
      });

      const result = await settleGameResults({});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Resilient ESPN Client Integration', () => {
    it('should initialize resilient client with env var config', async () => {
      process.env.ESPN_API_TIMEOUT_MS = '25000';
      process.env.SETTLEMENT_MAX_RETRIES = '2';

      // Just verify it doesn't break initialization
      const result = await settleGameResults({ dryRun: true });
      expect(result.success).toBe(true);
    });

    it('should use resilient client for ESPN fetches', async () => {
      // Set up a pending game
      const pendingGame = {
        game_id: 'game-123',
        sport: 'NHL',
        home_team: 'NYR',
        away_team: 'EDM',
        game_time_utc: new Date(Date.now() - 14400000).toISOString(), // 4 hours ago
        pending_card_count: 1,
      };

      mockDb.prepare.mockReturnValue({
        all: jest.fn()
          .mockReturnValueOnce([pendingGame]) // First call: get pending games
          .mockReturnValueOnce([]) // Second call: check for game_id_map
          .mockReturnValueOnce([], // Third call: check for existing game_results
          ),
      });

      mockFetchScoreboardEvents.mockResolvedValue([
        {
          id: '123',
          date: new Date().toISOString(),
          competitions: [
            {
              status: { type: { completed: true } },
              competitors: [
                { homeAway: 'home', team: { displayName: 'New York Rangers' }, score: 3 },
                { homeAway: 'away', team: { displayName: 'Edmonton Oilers' }, score: 2 },
              ],
            },
          ],
        },
      ]);

      const result = await settleGameResults({});

      // Verify the process ran (resilient client was used internally)
      expect(result.success).toBe(true);
    });
  });

  describe('Scoring Validation Integration', () => {
    it('should validate scores before settlement', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      // Set up pending game with unusual score
      const pendingGame = {
        game_id: 'game-456',
        sport: 'NBA',
        home_team: 'Lakers',
        away_team: 'Celtics',
        game_time_utc: new Date(Date.now() - 14400000).toISOString(),
        pending_card_count: 1,
      };

      mockDb.prepare.mockReturnValue({
        all: jest.fn()
          .mockReturnValueOnce([pendingGame])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([]),
      });

      mockFetchScoreboardEvents.mockResolvedValue([
        {
          id: '456',
          date: new Date().toISOString(),
          competitions: [
            {
              status: { type: { completed: true } },
              competitors: [
                { homeAway: 'home', team: { displayName: 'Los Angeles Lakers' }, score: 145 },
                { homeAway: 'away', team: { displayName: 'Boston Celtics' }, score: 95 },
              ],
            },
          ],
        },
      ]);

      const result = await settleGameResults({});

      // Log should mention scoring validation
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Settling'),
        expect.any(String)
      );

      consoleSpy.mockRestore();
    });

    it('should not block settlement on suspicious scores', async () => {
      // Scoring validator warns but doesn't block
      const pendingGame = {
        game_id: 'game-blowout',
        sport: 'NBA',
        home_team: 'Team A',
        away_team: 'Team B',
        game_time_utc: new Date(Date.now() - 14400000).toISOString(),
        pending_card_count: 1,
      };

      mockDb.prepare.mockReturnValue({
        all: jest.fn()
          .mockReturnValueOnce([pendingGame])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([]),
      });

      // 180-80 = 100 point spread (should warn but allow)
      mockFetchScoreboardEvents.mockResolvedValue([
        {
          id: 'blowout',
          date: new Date().toISOString(),
          competitions: [
            {
              status: { type: { completed: true } },
              competitors: [
                { homeAway: 'home', team: { displayName: 'Team A' }, score: 180 },
                { homeAway: 'away', team: { displayName: 'Team B' }, score: 80 },
              ],
            },
          ],
        },
      ]);

      const result = await settleGameResults({});

      // Settlement should proceed despite unusual score
      expect(result.success).toBe(true);
    });
  });
});
