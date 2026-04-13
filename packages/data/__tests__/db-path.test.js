const path = require('path');
const { resolveDatabasePath, parseSqliteUrl, DEFAULT_DATABASE_PATH } = require('../src/db-path');

describe('db-path resolver', () => {
  const cwd = '/repo';

  test('uses CHEDDAR_DB_PATH as canonical source when present', () => {
    const resolved = resolveDatabasePath({
      cwd,
      env: {
        CHEDDAR_DB_PATH: './shared/record.db',
      },
    });

    expect(resolved.dbPath).toBe(path.resolve(cwd, 'shared/record.db'));
    expect(resolved.source).toBe('CHEDDAR_DB_PATH');
  });

  test('respects CHEDDAR_DB_PATH when set', () => {
    const resolved = resolveDatabasePath({
      cwd,
      env: {
        CHEDDAR_DB_PATH: './data/main.db',
      },
    });

    expect(resolved.dbPath).toBe(path.resolve(cwd, 'data/main.db'));
    expect(resolved.source).toBe('CHEDDAR_DB_PATH');
  });

  test('throws on conflicting explicit DB paths', () => {
    expect(() =>
      resolveDatabasePath({
        cwd,
        env: {
          CHEDDAR_DB_PATH: '/tmp/a.db',
          DATABASE_URL: 'sqlite:////tmp/b.db',
        },
      })
    ).toThrow('Conflicting explicit DB paths');
  });

  test('parses sqlite DATABASE_URL', () => {
    const resolved = resolveDatabasePath({
      cwd,
      env: {
        DATABASE_URL: 'sqlite:////opt/cheddar-logic/packages/data/cheddar.db',
      },
    });

    expect(resolved.dbPath).toBe('/opt/cheddar-logic/packages/data/cheddar.db');
    expect(resolved.source).toBe('DATABASE_URL');
  });

  test('falls back to package default path when no env vars are provided', () => {
    const resolved = resolveDatabasePath({ cwd, env: {} });
    expect(resolved.dbPath).toBe(DEFAULT_DATABASE_PATH);
    expect(resolved.source).toBe('DEFAULT');
  });

  test('parseSqliteUrl returns null for non-sqlite url', () => {
    expect(parseSqliteUrl('postgresql://localhost:5432/app', cwd)).toBeNull();
  });
});
