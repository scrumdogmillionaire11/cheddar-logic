const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-odds-rawdata-'));
  return path.join(dir, 'test.db');
}

function resetDbEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.RECORD_DATABASE_PATH;
}

describe('odds raw_data carry-forward', () => {
  let dbPath;

  beforeEach(async () => {
    jest.resetModules();
    resetDbEnv();
    dbPath = makeTempDbPath();
    process.env.CHEDDAR_DB_PATH = dbPath;

    const { runMigrations } = require('../src/migrate');
    await runMigrations();
  });

  afterEach(() => {
    try {
      require('../src/db/connection').closeDatabase();
    } catch {
      // best effort cleanup
    }
    resetDbEnv();
  });

  test('parses string rawData and carries forward ESPN metrics without double encoding', () => {
    const connection = require('../src/db/connection');
    const games = require('../src/db/games');
    const odds = require('../src/db/odds');

    games.upsertGame({
      id: 'game-row-rawdata',
      gameId: 'nhl-rawdata-test',
      sport: 'NHL',
      homeTeam: 'Tampa Bay Lightning',
      awayTeam: 'Edmonton Oilers',
      gameTimeUtc: '2026-04-26T19:00:00.000Z',
      status: 'scheduled',
    });

    odds.insertOddsSnapshot({
      id: 'odds-raw-1',
      gameId: 'nhl-rawdata-test',
      sport: 'NHL',
      capturedAt: '2026-04-26T19:00:00.000Z',
      rawData: {
        seed: true,
        espn_metrics: {
          home: { metrics: { avgGoalsFor: 3.1, avgGoalsAgainst: 2.8 } },
          away: { metrics: { avgGoalsFor: 3.4, avgGoalsAgainst: 3.0 } },
        },
      },
      jobRunId: null,
    });

    odds.insertOddsSnapshot({
      id: 'odds-raw-2',
      gameId: 'nhl-rawdata-test',
      sport: 'NHL',
      capturedAt: '2026-04-26T19:05:00.000Z',
      rawData: JSON.stringify({ source: 'espn-direct-seed' }),
      jobRunId: null,
    });

    const db = connection.getDatabase();
    const row = db
      .prepare('SELECT raw_data FROM odds_snapshots WHERE id = ?')
      .get('odds-raw-2');

    const parsed = JSON.parse(row.raw_data);

    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(parsed.source).toBe('espn-direct-seed');
    expect(parsed.espn_metrics?.home?.metrics?.avgGoalsFor).toBe(3.1);
    expect(parsed.espn_metrics?.away?.metrics?.avgGoalsAgainst).toBe(3.0);
  });
});
