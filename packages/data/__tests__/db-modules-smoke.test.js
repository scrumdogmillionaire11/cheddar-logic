const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-db-modules-'));
  return path.join(dir, 'test.db');
}

function resetDbEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.RECORD_DATABASE_PATH;
}

describe('db module decomposition smoke', () => {
  let dbPath;

  beforeEach(() => {
    jest.resetModules();
    resetDbEnv();
    dbPath = makeTempDbPath();
    process.env.CHEDDAR_DB_PATH = dbPath;
  });

  afterEach(() => {
    try {
      require('../src/db/connection').closeDatabase();
    } catch {
      // best effort cleanup
    }
    resetDbEnv();
  });

  test('compat shim re-exports the canonical db index surface', () => {
    const shim = require('../src/db.js');
    const index = require('../src/db');

    expect(Object.keys(shim).sort()).toEqual(Object.keys(index).sort());
    expect(typeof shim.getDatabase).toBe('function');
    expect(typeof shim.insertCardPayload).toBe('function');
    expect(typeof shim.issueRefreshToken).toBe('function');
  });

  test('direct domain module requires work against a temp migrated database', async () => {
    const { runMigrations } = require('../src/migrate');
    await runMigrations();

    const connection = require('../src/db/connection');
    const games = require('../src/db/games');
    const odds = require('../src/db/odds');
    const models = require('../src/db/models');
    const cards = require('../src/db/cards');
    const results = require('../src/db/results');
    const tracking = require('../src/db/tracking');
    const players = require('../src/db/players');
    const quota = require('../src/db/quota');
    const scheduler = require('../src/db/scheduler');
    const authStore = require('../src/db/auth-store');
    const jobRuns = require('../src/db/job-runs');

    games.upsertGame({
      id: 'game-row-1',
      gameId: 'nhl-2026-03-29-test',
      sport: 'NHL',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Toronto Maple Leafs',
      gameTimeUtc: '2026-03-29T19:00:00.000Z',
      status: 'scheduled',
    });

    odds.insertOddsSnapshot({
      id: 'odds-1',
      gameId: 'nhl-2026-03-29-test',
      sport: 'NHL',
      capturedAt: '2026-03-29T12:00:00.000Z',
      h2hHome: -120,
      h2hAway: 100,
      total: 6.5,
      spreadHome: -1.5,
      spreadAway: 1.5,
      moneylineHome: -120,
      moneylineAway: 100,
      rawData: { source: 'smoke' },
      jobRunId: null,
    });

    models.insertModelOutput({
      id: 'model-1',
      gameId: 'nhl-2026-03-29-test',
      sport: 'nhl',
      modelName: 'smoke-model',
      modelVersion: '1.0.0',
      predictionType: 'moneyline',
      predictedAt: '2026-03-29T12:05:00.000Z',
      confidence: 0.61,
      outputData: { winner: 'home' },
      oddsSnapshotId: 'odds-1',
      jobRunId: null,
    });

    const db = connection.getDatabase();
    db.prepare(`
      INSERT INTO card_payloads (
        id, game_id, sport, card_type, card_title, created_at, payload_data, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'card-1',
      'nhl-2026-03-29-test',
      'nhl',
      'smoke-card',
      'Smoke Card',
      '2026-03-29T12:10:00.000Z',
      JSON.stringify({ kind: 'PLAY', sport: 'NHL' }),
      'run-1',
    );

    results.insertCardResult({
      id: 'result-1',
      cardId: 'card-1',
      gameId: 'nhl-2026-03-29-test',
      sport: 'NHL',
      cardType: 'smoke-card',
      recommendedBetType: 'moneyline',
      status: 'pending',
      result: null,
      settledAt: null,
      pnlUnits: null,
      metadata: { smoke: true },
    });

    tracking.upsertTrackingStat({
      id: 'tracking-1',
      statKey: 'NHL|moneyline|all|all|all|alltime',
      sport: 'NHL',
      marketType: 'moneyline',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'alltime',
      totalCards: 1,
      settledCards: 1,
      wins: 1,
      losses: 0,
      pushes: 0,
      totalPnlUnits: 0.91,
      winRate: 1,
      avgPnlPerCard: 0.91,
      confidenceCalibration: null,
      metadata: { smoke: true },
    });

    const nowIso = '2026-03-29T12:00:00.000Z';
    db.prepare(`
      INSERT INTO users (id, email, role, user_status, flags, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'user-1',
      'smoke@example.com',
      'FREE_ACCOUNT',
      'ACTIVE',
      '[]',
      nowIso,
      nowIso,
    );
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, plan_id, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sub-1',
      'user-1',
      'free',
      'NONE',
      '{}',
      nowIso,
      nowIso,
    );

    players.upsertPlayerAvailability({
      playerId: 99,
      sport: 'NHL',
      status: 'available',
      checkedAt: '2026-03-29T12:00:00.000Z',
    });

    quota.upsertQuotaLedger({
      provider: 'odds-api',
      period: '2026-03',
      tokens_remaining: 1000,
      tokens_spent_session: 25,
      monthly_limit: 20000,
      circuit_open_until: null,
      circuit_reason: null,
      updated_by: 'db-smoke-test',
    });

    jobRuns.insertJobRun('db-smoke-job', 'run-smoke-1', 'db-smoke-job|2026-03-29T12');
    jobRuns.markJobRunSuccess('run-smoke-1');

    const authIssue = authStore.issueRefreshToken('user-1', {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(games.getUpcomingGames({
      startUtcIso: '2026-03-29T00:00:00.000Z',
      endUtcIso: '2026-03-30T00:00:00.000Z',
      sports: ['nhl'],
    })).toHaveLength(1);
    expect(odds.getLatestOdds('nhl-2026-03-29-test')).toMatchObject({ game_id: 'nhl-2026-03-29-test' });
    expect(models.getLatestModelOutput('nhl-2026-03-29-test', 'smoke-model')).toMatchObject({ id: 'model-1' });
    expect(cards.getCardPayloads('nhl-2026-03-29-test')).toHaveLength(1);
    expect(results.getGameResult('missing-game')).toBeNull();
    expect(tracking.getTrackingStats({ sport: 'NHL' })).toHaveLength(1);
    expect(players.getPlayerAvailability(99, 'NHL')).toMatchObject({ status: 'available' });
    expect(quota.getQuotaLedger('odds-api', '2026-03')).toMatchObject({ tokens_remaining: 1000 });
    expect(scheduler.claimTminusPullSlot('nhl', 'nhl|T-30|2026-03-29T19')).toBe(true);
    expect(scheduler.claimTminusPullSlot('nhl', 'nhl|T-30|2026-03-29T19')).toBe(false);
    expect(jobRuns.wasJobRecentlySuccessful('db-smoke-job', 60)).toBe(true);
    expect(authStore.isRefreshTokenValid(authIssue.token)).toBe(true);
  });
});
