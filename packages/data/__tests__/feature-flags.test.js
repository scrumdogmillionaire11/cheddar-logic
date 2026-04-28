/**
 * Feature Flags Service Tests
 */

const { isFeatureEnabled } = require('../src/feature-flags');

describe('isFeatureEnabled', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear environment before each test
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('model execution flags', () => {
    test('returns true for sport models when ENABLE_<SPORT>_MODEL is not set (default enabled)', () => {
      delete process.env.ENABLE_NHL_MODEL;
      delete process.env.ENABLE_NBA_MODEL;
      delete process.env.ENABLE_MLB_MODEL;

      expect(isFeatureEnabled('nhl', 'model')).toBe(true);
      expect(isFeatureEnabled('nba', 'model')).toBe(true);
      expect(isFeatureEnabled('mlb', 'model')).toBe(true);
    });

    test('returns false when ENABLE_<SPORT>_MODEL is explicitly false', () => {
      process.env.ENABLE_NHL_MODEL = 'false';
      process.env.ENABLE_NBA_MODEL = 'false';

      expect(isFeatureEnabled('nhl', 'model')).toBe(false);
      expect(isFeatureEnabled('nba', 'model')).toBe(false);
    });

    test('returns true when ENABLE_<SPORT>_MODEL is true', () => {
      process.env.ENABLE_NHL_MODEL = 'true';
      expect(isFeatureEnabled('nhl', 'model')).toBe(true);
    });

    test('handles case-insensitive sport names', () => {
      process.env.ENABLE_NHL_MODEL = 'false';
      expect(isFeatureEnabled('NHL', 'model')).toBe(false);
      expect(isFeatureEnabled('Nhl', 'model')).toBe(false);
    });
  });

  describe('player availability sync', () => {
    test('returns true for player-availability-sync when not explicitly disabled', () => {
      delete process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC;
      delete process.env.ENABLE_NBA_PLAYER_AVAILABILITY_SYNC;

      expect(isFeatureEnabled('nhl', 'player-availability-sync')).toBe(true);
      expect(isFeatureEnabled('nba', 'player-availability-sync')).toBe(true);
    });

    test('returns false when explicitly disabled', () => {
      process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC = 'false';
      expect(isFeatureEnabled('nhl', 'player-availability-sync')).toBe(false);
    });
  });

  describe('NHL-specific features', () => {
    test('goalie-starters is enabled by default', () => {
      delete process.env.ENABLE_NHL_GOALIE_STARTERS;
      expect(isFeatureEnabled('nhl', 'goalie-starters')).toBe(true);
    });

    test('sog-sync is disabled by default (explicit opt-in required)', () => {
      delete process.env.ENABLE_NHL_SOG_PLAYER_SYNC;
      expect(isFeatureEnabled('nhl', 'sog-sync')).toBe(false);
    });

    test('sog-sync requires explicit true to enable', () => {
      process.env.ENABLE_NHL_SOG_PLAYER_SYNC = 'true';
      expect(isFeatureEnabled('nhl', 'sog-sync')).toBe(true);
    });

    test('sog-sync disabled when not explicitly true', () => {
      process.env.ENABLE_NHL_SOG_PLAYER_SYNC = 'false';
      expect(isFeatureEnabled('nhl', 'sog-sync')).toBe(false);
    });

    test('blk-ingest is enabled by default', () => {
      delete process.env.ENABLE_NHL_BLK_INGEST;
      expect(isFeatureEnabled('nhl', 'blk-ingest')).toBe(true);
    });

  });

  describe('player props scheduler', () => {
    test('player-props-scheduler is enabled by default', () => {
      delete process.env.ENABLE_PLAYER_PROPS_SCHEDULER;
      expect(isFeatureEnabled('internal', 'player-props-scheduler')).toBe(true);
    });

    test('player-props-scheduler can be disabled', () => {
      process.env.ENABLE_PLAYER_PROPS_SCHEDULER = 'false';
      expect(isFeatureEnabled('internal', 'player-props-scheduler')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('returns false for invalid sport', () => {
      expect(isFeatureEnabled('invalid-sport', 'model')).toBe(false);
    });

    test('returns false for invalid feature', () => {
      expect(isFeatureEnabled('nhl', 'invalid-feature')).toBe(false);
    });

    test('returns false when sport is null', () => {
      expect(isFeatureEnabled(null, 'model')).toBe(false);
    });

    test('returns false when feature is null', () => {
      expect(isFeatureEnabled('nhl', null)).toBe(false);
    });

    test('returns false when both are null', () => {
      expect(isFeatureEnabled(null, null)).toBe(false);
    });

    test('handles whitespace in sport and feature names', () => {
      process.env.ENABLE_NHL_MODEL = 'false';
      expect(isFeatureEnabled('  nhl  ', '  model  ')).toBe(false);
    });
  });
});
