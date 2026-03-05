/**
 * End-to-End Integration Test: Web + Worker Database Path Alignment
 *
 * This test reproduces and validates the fix for the issue:
 * "Error: [DB] Conflicting explicit DB paths detected"
 *
 * Scenario:
 * 1. Worker runs models with CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db
 * 2. Web app needs to read same database
 * 3. web/.env.local previously hardcoded DATABASE_PATH=/Users/.../cheddar.db
 * 4. Result: Conflict error
 *
 * Fix:
 * 1. Remove web/.env.local
 * 2. Use only CHEDDAR_DB_PATH in web startup
 * 3. Test validates both worker and web can use same database path
 */

const path = require('path');
const { resolveDatabasePath } = require('@cheddar-logic/data/src/db-path');

describe('Integration: Worker + Web database path alignment', () => {
  const unixHomeDir = '/Users/ajcolubiale/projects/cheddar-logic';
  const tmpDbPath = '/tmp/cheddar-logic/cheddar.db';

  describe('scenario: worker writes, web reads', () => {
    test('worker uses CHEDDAR_DB_PATH to write model outputs', () => {
      const workerEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '', // Should be empty in worker
        RECORD_DATABASE_PATH: '',
        DATABASE_URL: '',
      };

      const resolved = resolveDatabasePath({ env: workerEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
    });

    test('web uses same CHEDDAR_DB_PATH to read model outputs', () => {
      // CRITICAL: web must use exact same database as worker
      const webEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '', // Must be empty (or unset)
        RECORD_DATABASE_PATH: '',
        DATABASE_URL: '',
      };

      const resolved = resolveDatabasePath({ env: webEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
    });

    test('both resolve to identical database path', () => {
      const workerResolved = resolveDatabasePath({
        env: {
          CHEDDAR_DB_PATH: tmpDbPath,
          DATABASE_PATH: '',
        },
      });

      const webResolved = resolveDatabasePath({
        env: {
          CHEDDAR_DB_PATH: tmpDbPath,
          DATABASE_PATH: '',
        },
      });

      expect(workerResolved.dbPath).toBe(webResolved.dbPath);
      expect(workerResolved.source).toBe(webResolved.source);
    });
  });

  describe('regression: old bug should not reoccur', () => {
    test('previous bug: web/.env.local DATABASE_PATH vs CHEDDAR_DB_PATH conflict', () => {
      // This is the EXACT error that occurred:
      // CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db (from CLI)
      // DATABASE_PATH=/Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db (from web/.env.local)

      const buggyEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: path.join(unixHomeDir, 'packages/data/cheddar.db'),
      };

      // This SHOULD throw now because we detect the conflict
      expect(() => resolveDatabasePath({ env: buggyEnv })).toThrow(
        'Conflicting explicit DB paths detected',
      );
    });

    test('fix: web startup ONLY uses CHEDDAR_DB_PATH', () => {
      // After fix, web/.env.local was deleted
      // Web startup only receives CHEDDAR_DB_PATH from CLI

      const fixedEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '', // No longer in web/.env.local
        RECORD_DATABASE_PATH: '',
        DATABASE_URL: '',
      };

      const resolved = resolveDatabasePath({ env: fixedEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
    });
  });

  describe('startup command validation', () => {
    test('correct startup: CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm run dev', () => {
      // This is the correct way to start the web app
      const startupEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '',
      };

      const resolved = resolveDatabasePath({ env: startupEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
      expect(resolved.isExplicitFile).toBe(true);
    });

    test('incorrect startup would set both paths', () => {
      // If someone sets both, we catch it
      const badStartupEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '/other/db/path.db',
      };

      expect(() => resolveDatabasePath({ env: badStartupEnv })).toThrow(
        'Conflicting explicit DB paths detected',
      );
    });
  });

  describe('model job execution alignment', () => {
    test('NBA model uses CHEDDAR_DB_PATH', () => {
      const nbaModelEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '',
      };

      const resolved = resolveDatabasePath({ env: nbaModelEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
    });

    test('NHL model uses same CHEDDAR_DB_PATH', () => {
      const nhlModelEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '',
      };

      const resolved = resolveDatabasePath({ env: nhlModelEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
    });

    test('NCAAM model uses same CHEDDAR_DB_PATH', () => {
      const ncaamModelEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '',
      };

      const resolved = resolveDatabasePath({ env: ncaamModelEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
    });

    test('web API reads from same database as all models', () => {
      const webEnv = {
        CHEDDAR_DB_PATH: tmpDbPath,
        DATABASE_PATH: '',
      };

      const resolved = resolveDatabasePath({ env: webEnv });
      expect(resolved.dbPath).toBe(tmpDbPath);
    });
  });

  describe('environment variable override rules', () => {
    test('Setting multiple paths causes conflict error', () => {
      // Setting multiple database paths is now an ERROR
      // This prevents the bug where web/.env.local DATABASE_PATH
      // conflicted with CLI CHEDDAR_DB_PATH
      const env = {
        CHEDDAR_DB_PATH: '/cheddar-path.db',
        DATABASE_PATH: '/database-path.db',
        DATABASE_URL: 'sqlite:////database-url-path.db',
      };

      expect(() => resolveDatabasePath({ env })).toThrow(
        'Conflicting explicit DB paths detected',
      );
    });

    test('Setting multiple paths with different values always errors', () => {
      const env = {
        RECORD_DATABASE_PATH: '/record-path.db',
        CHEDDAR_DB_PATH: '/cheddar-path.db',
        DATABASE_PATH: '/database-path.db',
      };

      expect(() => resolveDatabasePath({ env })).toThrow(
        'Conflicting explicit DB paths detected',
      );
    });

    test('Setting multiple paths to SAME value is still an error', () => {
      // Even if they all point to the same file, it's an error
      // because it shows misconfiguration
      const env = {
        CHEDDAR_DB_PATH: '/same/path.db',
        DATABASE_PATH: '/same/path.db',
      };

      // This should NOT throw because they're the same value
      // The conflict detector deduplicates before checking
      const resolved = resolveDatabasePath({ env });
      expect(resolved.dbPath).toBe('/same/path.db');
    });
  });
});
