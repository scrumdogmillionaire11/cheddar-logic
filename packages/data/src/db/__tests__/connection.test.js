'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WARNING_DIR = path.join(os.tmpdir(), 'cheddar-logic-db-lock-warnings');

describe('database connection lock warnings', () => {
  const originalEnv = process.env;
  let tempRoots = [];
  let dbFiles = [];
  let childProcesses = [];
  let warnSpy;
  let logSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const child of childProcesses) {
      if (!child.killed) {
        try { child.kill(); } catch { /* best-effort cleanup */ }
      }
    }
    childProcesses = [];

    for (const dbFile of dbFiles) {
      try { fs.rmSync(getWarningMetadataPath(dbFile), { force: true }); } catch { /* best-effort cleanup */ }
    }
    dbFiles = [];

    for (const root of tempRoots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
    tempRoots = [];

    warnSpy.mockRestore();
    logSpy.mockRestore();
    process.env = originalEnv;
    jest.dontMock('better-sqlite3');
    jest.resetModules();
  });

  function getWarningMetadataPath(dbFile) {
    const hash = crypto.createHash('sha256').update(String(dbFile)).digest('hex');
    return path.join(WARNING_DIR, `${hash}.json`);
  }

  function makeDbFile() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-connection-test-'));
    const dbFile = path.join(root, 'cheddar.db');
    fs.writeFileSync(dbFile, '');
    tempRoots.push(root);
    dbFiles.push(dbFile);
    return dbFile;
  }

  function writeLiveLock(dbFile, pid) {
    fs.writeFileSync(
      `${dbFile}.lock`,
      `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
    );
  }

  function isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function getDifferentLivePid() {
    const candidates = [process.ppid, 1].filter((pid) => (
      Number.isFinite(pid) && pid > 0 && pid !== process.pid
    ));

    for (const pid of candidates) {
      if (isPidAlive(pid)) return pid;
    }

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);'], {
      stdio: 'ignore',
    });
    childProcesses.push(child);
    return child.pid;
  }

  function loadConnection(dbFile, env = {}) {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      CHEDDAR_DB_PATH: dbFile,
    };
    delete process.env.CHEDDAR_DATA_DIR;
    delete process.env.DATABASE_URL;
    delete process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS;
    delete process.env.CHEDDAR_DB_LOCK_TIMEOUT_MS;

    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    const mockDb = {
      close: jest.fn(),
      pragma: jest.fn(),
    };
    const MockDatabase = jest.fn(() => mockDb);
    jest.doMock('better-sqlite3', () => MockDatabase);

    return {
      connection: require('../connection'),
      MockDatabase,
      mockDb,
    };
  }

  function getRefusalWarnings() {
    return warnSpy.mock.calls
      .map((call) => call[0])
      .filter((message) => String(message).includes('[DB] Refusing to open'));
  }

  test('first non-production lock contention warns once', () => {
    const dbFile = makeDbFile();
    writeLiveLock(dbFile, process.pid);

    const { connection } = loadConnection(dbFile);

    connection.getDatabase();
    connection.getDatabase();

    expect(getRefusalWarnings()).toHaveLength(1);
    connection.closeDatabase();
  });

  test('second contention after closeDatabase and module reload suppresses for the same owner', () => {
    const dbFile = makeDbFile();
    writeLiveLock(dbFile, process.pid);

    let loaded = loadConnection(dbFile);
    loaded.connection.getDatabase();
    loaded.connection.closeDatabase();

    loaded = loadConnection(dbFile);
    loaded.connection.getDatabase();

    expect(getRefusalWarnings()).toHaveLength(1);
    loaded.connection.closeDatabase();
  });

  test('changed lock owner PID re-warns', () => {
    const dbFile = makeDbFile();
    writeLiveLock(dbFile, process.pid);

    let loaded = loadConnection(dbFile);
    loaded.connection.getDatabase();
    loaded.connection.closeDatabase();

    writeLiveLock(dbFile, getDifferentLivePid());
    loaded = loadConnection(dbFile);
    loaded.connection.getDatabase();

    expect(getRefusalWarnings()).toHaveLength(2);
    loaded.connection.closeDatabase();
  });

  test('production lock contention throws and does not warn', () => {
    const dbFile = makeDbFile();
    writeLiveLock(dbFile, process.pid);
    const { connection } = loadConnection(dbFile, { NODE_ENV: 'production' });

    expect(() => connection.getDatabase()).toThrow(
      /Refusing to open .* because another process holds the lock/,
    );
    expect(getRefusalWarnings()).toHaveLength(0);
  });

  test('corrupt warning metadata fails open by warning', () => {
    const dbFile = makeDbFile();
    writeLiveLock(dbFile, process.pid);
    fs.mkdirSync(WARNING_DIR, { recursive: true });
    fs.writeFileSync(getWarningMetadataPath(dbFile), '{not-json', 'utf8');

    const { connection } = loadConnection(dbFile);

    connection.getDatabase();

    expect(getRefusalWarnings()).toHaveLength(1);
    connection.closeDatabase();
  });

  test('expired suppression window re-warns for the same owner', () => {
    const dbFile = makeDbFile();
    writeLiveLock(dbFile, process.pid);
    let nowMs = 1776429824000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    try {
      let loaded = loadConnection(dbFile);
      loaded.connection.getDatabase();
      loaded.connection.closeDatabase();

      nowMs += 10 * 60 * 1000 + 1;
      loaded = loadConnection(dbFile);
      loaded.connection.getDatabase();

      expect(getRefusalWarnings()).toHaveLength(2);
      loaded.connection.closeDatabase();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
