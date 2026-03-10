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

    test('production with Postgres DATABASE_URL throws because no explicit path resolves', () => {
      // This system only supports SQLite. A PostgreSQL DATABASE_URL is not parsed by
      // parseSqliteUrl, so no explicit path resolves. In production this must throw loudly
      // rather than silently falling back to DEFAULT (which would open an empty local DB).
      expect(() =>
        resolveDatabasePath({
          cwd,
          env: {
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://user:pass@prod.example.com:5432/cheddar',
            CHEDDAR_DB_PATH: '',
            RECORD_DATABASE_PATH: '',
            DATABASE_PATH: '',
          },
        })
      ).toThrow('Production requires CHEDDAR_DB_PATH to be set explicitly');
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

    test('production with legacy RECORD_DATABASE_PATH fallback', () => {
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
    test('railway with PostgreSQL DATABASE_URL throws because no explicit path resolves', () => {
      // This system only supports SQLite databases. A PostgreSQL URL is ignored by
      // parseSqliteUrl. In production, reaching the fallback path is a misconfiguration
      // and must throw loudly — not silently open an empty local DB.
      expect(() =>
        resolveDatabasePath({
          cwd,
          env: {
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://railway:abc123@localhost:5432/cheddar',
            CHEDDAR_DB_PATH: '',
            RECORD_DATABASE_PATH: '',
            DATABASE_PATH: '',
          },
        })
      ).toThrow('Production requires CHEDDAR_DB_PATH to be set explicitly');
    });
  });

  describe('Vercel deployment (web app hosting)', () => {
    test('vercel with CHEDDAR_DATA_DIR only (no CHEDDAR_DB_PATH) throws in production', () => {
      // Vercel has an ephemeral FS; SQLite does not persist between deploys. Previously
      // CHEDDAR_DATA_DIR would silently resolve to {dir}/cheddar.db — an empty file that
      // does not match the production DB filename (cheddar-prod.db). In production the
      // code now throws so the misconfiguration is caught immediately at startup.
      // Correct fix: set CHEDDAR_DB_PATH explicitly, or migrate Vercel to a persistent store.
      const vercelCwd = '/var/task';
      expect(() =>
        resolveDatabasePath({
          cwd: vercelCwd,
          env: {
            NODE_ENV: 'production',
            CHEDDAR_DATA_DIR: '/tmp/cheddar-data',
            CHEDDAR_DB_PATH: '',
            DATABASE_PATH: '',
            RECORD_DATABASE_PATH: '',
            DATABASE_URL: '',
          },
        })
      ).toThrow('Production requires CHEDDAR_DB_PATH to be set explicitly');
    });

    test('vercel with explicit CHEDDAR_DB_PATH works correctly', () => {
      const vercelCwd = '/var/task';
      const resolved = resolveDatabasePath({
        cwd: vercelCwd,
        env: {
          NODE_ENV: 'production',
          CHEDDAR_DB_PATH: '/tmp/cheddar-data/cheddar-prod.db',
          CHEDDAR_DATA_DIR: '',
          DATABASE_PATH: '',
          RECORD_DATABASE_PATH: '',
          DATABASE_URL: '',
        },
      });

      expect(resolved.dbPath).toBe('/tmp/cheddar-data/cheddar-prod.db');
      expect(resolved.source).toBe('CHEDDAR_DB_PATH');
      expect(resolved.isExplicitFile).toBe(true);
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
