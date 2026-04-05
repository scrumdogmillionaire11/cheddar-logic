const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-projection-audit-'));
  return path.join(dir, 'test.db');
}

function resetDbEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.RECORD_DATABASE_PATH;
}

describe('insertProjectionAudit', () => {
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

  test('normal write inserts one row with correct field values', () => {
    const { insertProjectionAudit } = require('../src/db/tracking');
    const { getDatabase } = require('../src/db/connection');

    insertProjectionAudit({
      cardResultId: 'cr-001',
      sport: 'NHL',
      marketType: 'total',
      period: '1P',
      playerCount: 3,
      confidenceScore: 0.62,
      oddsAmerican: -110,
      sharpPriceStatus: 'CONFIRMED',
      direction: 'OVER',
      result: 'win',
      pnlUnits: 0.9,
      settledAt: '2026-04-05T01:00:00Z',
      jobRunId: 'job-abc',
      metadata: { source: 'test' },
    });

    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM projection_audit WHERE id = ?').all('cr-001');

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.card_result_id).toBe('cr-001');
    expect(row.sport).toBe('NHL');
    expect(row.market_type).toBe('total');
    expect(row.period).toBe('1P');
    expect(row.player_count).toBe(3);
    expect(row.confidence_score).toBeCloseTo(0.62);
    expect(row.confidence_band).toBe('60+');
    expect(row.odds_american).toBe(-110);
    expect(row.sharp_price_status).toBe('CONFIRMED');
    expect(row.direction).toBe('OVER');
    expect(row.result).toBe('win');
    expect(row.pnl_units).toBeCloseTo(0.9);
    expect(row.settled_at).toBe('2026-04-05T01:00:00Z');
    expect(row.job_run_id).toBe('job-abc');
    expect(JSON.parse(row.metadata)).toEqual({ source: 'test' });
  });

  test('confidence_band is derived correctly from confidenceScore', () => {
    const { insertProjectionAudit } = require('../src/db/tracking');
    const { getDatabase } = require('../src/db/connection');

    const cases = [
      { cardResultId: 'cr-band-1', confidenceScore: 0.35, expectedBand: '<40' },
      { cardResultId: 'cr-band-2', confidenceScore: 0.45, expectedBand: '40-50' },
      { cardResultId: 'cr-band-3', confidenceScore: 0.55, expectedBand: '50-60' },
      { cardResultId: 'cr-band-4', confidenceScore: 0.65, expectedBand: '60+' },
      { cardResultId: 'cr-band-5', confidenceScore: null, expectedBand: 'unknown' },
    ];

    for (const { cardResultId, confidenceScore, expectedBand } of cases) {
      insertProjectionAudit({
        cardResultId,
        sport: 'NHL',
        marketType: 'total',
        result: 'win',
        pnlUnits: 0.9,
        settledAt: '2026-04-05T01:00:00Z',
        confidenceScore,
      });
    }

    const db = getDatabase();
    for (const { cardResultId, expectedBand } of cases) {
      const row = db.prepare('SELECT confidence_band FROM projection_audit WHERE id = ?').get(cardResultId);
      expect(row).toBeDefined();
      expect(row.confidence_band).toBe(expectedBand);
    }
  });

  test('duplicate insert (same cardResultId) is silently ignored — row count stays at 1', () => {
    const { insertProjectionAudit } = require('../src/db/tracking');
    const { getDatabase } = require('../src/db/connection');

    const base = {
      cardResultId: 'cr-001',
      sport: 'NHL',
      marketType: 'total',
      result: 'win',
      pnlUnits: 0.9,
      settledAt: '2026-04-05T01:00:00Z',
    };

    // First insert
    expect(() => insertProjectionAudit(base)).not.toThrow();
    // Second insert with same cardResultId — should be silently ignored
    expect(() => insertProjectionAudit({ ...base, sport: 'NBA', pnlUnits: 99 })).not.toThrow();

    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM projection_audit WHERE id = ?').all('cr-001');
    expect(rows).toHaveLength(1);
    // Original row should be unchanged (INSERT OR IGNORE)
    expect(rows[0].sport).toBe('NHL');
    expect(rows[0].pnl_units).toBeCloseTo(0.9);
  });

  test('missing optional fields — insert succeeds and optional columns are NULL', () => {
    const { insertProjectionAudit } = require('../src/db/tracking');
    const { getDatabase } = require('../src/db/connection');

    expect(() => insertProjectionAudit({
      cardResultId: 'cr-001',
      sport: 'NHL',
      marketType: 'total',
      result: 'win',
      pnlUnits: 0.9,
      settledAt: '2026-04-05T01:00:00Z',
      // Intentionally omitting: period, playerCount, confidenceScore, oddsAmerican, sharpPriceStatus, jobRunId, metadata
      period: null,
      playerCount: undefined,
      confidenceScore: undefined,
      oddsAmerican: undefined,
      sharpPriceStatus: null,
      jobRunId: null,
      metadata: null,
    })).not.toThrow();

    const db = getDatabase();
    const row = db.prepare('SELECT * FROM projection_audit WHERE id = ?').get('cr-001');
    expect(row).toBeDefined();
    expect(row.period).toBeNull();
    expect(row.player_count).toBeNull();
    expect(row.confidence_score).toBeNull();
    expect(row.odds_american).toBeNull();
    expect(row.sharp_price_status).toBeNull();
    expect(row.job_run_id).toBeNull();
    expect(row.metadata).toBeNull();
    // confidence_band should be 'unknown' when confidenceScore is undefined/null
    expect(row.confidence_band).toBe('unknown');
  });
});
