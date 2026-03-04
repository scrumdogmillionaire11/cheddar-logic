/**
 * Production Environment DB Path Tests
 * 
 * Ensures the database path resolution works correctly across:
 * - Development (local SQLite)
 * - Staging (different SQLite path)
 * - Production (PostgreSQL or production SQLite)
 * 
 * This prevents the "Conflicting explicit DB paths" error that
 * occurred when web/.env.local hardcoded DATABASE_PATH while
 * the environment set CHEDDAR_DB_PATH.
 */

const path = require('path');
const { resolveDatabasePath } = require('../src/db-path');

describe('db-path resolver - Production scenarios', () => {
  const cwd = '/repo';

  describe('Local development', () => {
    test('dev with CHEDDAR_DB_PATH only (preferred)', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'development',
          CHEDDAR_DB_PATH: '/tmp/cheddar-logic/cheddar.db',
          // DATABASE_PATH is NOT set
          RECORD_DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/tmp/cheddar-logic/cheddar.db');
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
      expect(resolved.isExplicitFile).toBe(true);
    });

    test('dev correctly rejects conflicting CHEDDAR_DB_PATH + DATABASE_PATH', () => {
      // This is the bug we're preventing
      expect(() =>
        resolveDatabasePath({
          cwd,
          env: {
            NODE_ENV: 'development',
            CHEDDAR_DB_PATH: '/tmp/cheddar-logic/cheddar.db',
            DATABASE_PATH: '/Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db',
          },
        })
      ).toThrow('Conflicting explicit DB paths detected');
    });

    test('dev fallback to DEFAULT when no explicit path is set', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'development',
          CHEDDAR_DB_PATH: '',
          DATABASE_PATH: '',
          RECORD_DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.source).toBe('DEFAULT');
      expect(resolved.dbPath).toContain('cheddar.db');
    });
  });

  describe('Staging environment', () => {
    test('staging with isolated SQLite database', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'staging',
          CHEDDAR_DB_PATH: '/var/lib/cheddar/staging/cheddar.db',
          RECORD_DATABASE_PATH: '',
          DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/var/lib/cheddar/staging/cheddar.db');
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
    });

    test('staging rejects DATABASE_PATH when CHEDDAR_DB_PATH is set', () => {
      expect(() =>
        resolveDatabasePath({
          cwd,
          env: {
            NODE_ENV: 'staging',
            CHEDDAR_DB_PATH: '/var/lib/cheddar/staging/cheddar.db',
            DATABASE_PATH: '/var/lib/legacy/cheddar.db',
          },
        })
      ).toThrow('Conflicting explicit DB paths detected');
    });
  });

  describe('Production environment', () => {
    test('production with SQLite DATABASE_URL format', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'sqlite:////opt/cheddar-logic/cheddar.db',
          CHEDDAR_DB_PATH: '',
          RECORD_DATABASE_PATH: '',
        },
      });

      expect(resolved.dbPath).toBe('/opt/cheddar-logic/cheddar.db');
      expect(resolved.source).toBe('DATABASE_URL');
    });

    test('production with Postgres DATABASE_URL is not supported (SQLite only)', () => {
      // This system only supports SQLite, not PostgreSQL
      // PostgreSQL URLs are not parsed by parseSqliteUrl
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://user:pass@prod.example.com:5432/cheddar',
          CHEDDAR_DB_PATH: '',
          RECORD_DATABASE_PATH: '',
          DATABASE_PATH: '',
        },
      });

      // Non-sqlite DATABASE_URL is ignored, defaults to DEFAULT path
      expect(resolved.source).toBe('DEFAULT');
    });

    test('production rejects conflicting DATABASE_URL + other paths', () => {
      expect(() =>
        resolveDatabasePath({
          cwd,
          env: {
            NODE_ENV: 'production',
            DATABASE_URL: 'sqlite:////opt/cheddar.db',
            CHEDDAR_DB_PATH: '/tmp/cheddar.db',
          },
        })
      ).toThrow('Conflicting explicit DB paths detected');
    });

    test('production with RECORD_DATABASE_PATH (settlement DB)', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'production',
          RECORD_DATABASE_PATH: '/var/lib/cheddar/records.db',
          CHEDDAR_DB_PATH: '',
          DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/var/lib/cheddar/records.db');
      expect(resolved.source).toBe('RECORD_DATABASE_PATH');
    });
  });

  describe('Railway deployment (production platform)', () => {
    test('railway with PostgreSQL DATABASE_URL is not supported (SQLite only)', () => {
      // This system only supports SQLite databases
      // PostgreSQL URLs are ignored and will fall back to DEFAULT
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://railway:abc123@localhost:5432/cheddar',
          CHEDDAR_DB_PATH: '',
          RECORD_DATABASE_PATH: '',
          DATABASE_PATH: '',
        },
      });

      // Non-sqlite DATABASE_URL is ignored, defaults to DEFAULT path
      expect(resolved.source).toBe('DEFAULT');
    });
  });

  describe('Vercel deployment (web app hosting)', () => {
    test('vercel with CHEDDAR_DATA_DIR fallback', () => {
      const vercelCwd = '/var/task';
      const resolved = resolveDatabasePath({
        cwd: vercelCwd,
        env: {
          NODE_ENV: 'production',
          CHEDDAR_DATA_DIR: '/tmp/cheddar-data',
          CHEDDAR_DB_PATH: '',
          DATABASE_PATH: '',
          RECORD_DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/tmp/cheddar-data/cheddar.db');
      expect(resolved.source).toBe('CHEDDAR_DATA_DIR');
    });
  });

  describe('Migration scenarios (from legacy DATABASE_PATH)', () => {
    test('legacy app with only DATABASE_PATH should still work', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          DATABASE_PATH: '/opt/legacy/cheddar.db',
          CHEDDAR_DB_PATH: '',
          RECORD_DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/opt/legacy/cheddar.db');
      expect(resolved.source).toBe('DATABASE_PATH');
    });

    test('migration: setting both CHEDDAR_DB_PATH and DATABASE_PATH is an error', () => {
      // During migration, if both paths are set, throw an error
      // This prevents the "web/.env.local vs CLI env var" bug
      expect(() =>
        resolveDatabasePath({
          cwd,
          env: {
            // New preferred path
            CHEDDAR_DB_PATH: '/new/path/cheddar.db',
            // Old legacy path (conflict!)
            DATABASE_PATH: '/old/path/cheddar.db',
          },
        })
      ).toThrow('Conflicting explicit DB paths detected');
    });
  });

  describe('Error case: empty strings should not conflict', () => {
    test('empty string env vars are treated as unset', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          CHEDDAR_DB_PATH: '/actual/path.db',
          DATABASE_PATH: '', // Empty should not be treated as "set"
          RECORD_DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/actual/path.db');
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
    });

    test('whitespace-only env vars are treated as unset', () => {
      const resolved = resolveDatabasePath({
        cwd,
        env: {
          CHEDDAR_DB_PATH: '/actual/path.db',
          DATABASE_PATH: '   ', // Whitespace should not be treated as "set"
          RECORD_DATABASE_PATH: '\t',
          DATABASE_URL: '\n',
        },
      });

      expect(resolved.dbPath).toBe('/actual/path.db');
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
    });
  });
});
