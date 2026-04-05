'use strict';

/**
 * Unit tests for insertProjectionAudit
 * WI-0787 — projection_audit table
 */

const fs = require('fs');
const {
  closeDatabase,
  getDatabase,
  insertProjectionAudit,
  runMigrations,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test-projection-audit-unit.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExistsLocal(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort */ }
}

beforeEach(async () => {
  process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
  process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
  process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

  removeIfExistsLocal(TEST_DB_PATH);
  removeIfExistsLocal(LOCK_PATH);

  await runMigrations();
});

afterEach(() => {
  closeDatabase();
  removeIfExistsLocal(TEST_DB_PATH);
  removeIfExistsLocal(LOCK_PATH);
});

describe('insertProjectionAudit', () => {
  test('writes a complete row with all optional fields', () => {
    insertProjectionAudit({
      cardResultId: 'cr-001',
      sport: 'NBA',
      marketType: 'total',
      period: null,
      playerCount: 2,
      confidenceScore: 0.62,
      oddsAmerican: -110,
      sharpPriceStatus: 'CONFIRMED',
      direction: 'OVER',
      result: 'win',
      pnlUnits: 0.909,
      settledAt: '2026-03-01T22:00:00Z',
      jobRunId: 'jr-xyz',
      metadata: { note: 'test row' },
    });

    const db = getDatabase();
    const row = db.prepare('SELECT * FROM projection_audit WHERE id = ?').get('cr-001');

    expect(row).toBeTruthy();
    expect(row.card_result_id).toBe('cr-001');
    expect(row.sport).toBe('NBA');
    expect(row.market_type).toBe('total');
    expect(row.period).toBeNull();
    expect(row.player_count).toBe(2);
    expect(row.confidence_score).toBeCloseTo(0.62);
    expect(row.confidence_band).toBe('60+');
    expect(row.odds_american).toBe(-110);
    expect(row.sharp_price_status).toBe('CONFIRMED');
    expect(row.direction).toBe('OVER');
    expect(row.result).toBe('win');
    expect(row.pnl_units).toBeCloseTo(0.909);
    expect(row.settled_at).toBe('2026-03-01T22:00:00Z');
    expect(row.job_run_id).toBe('jr-xyz');
    expect(JSON.parse(row.metadata)).toEqual({ note: 'test row' });
  });

  test('correct confidence_band derivation across band boundaries', () => {
    const cases = [
      { score: 0.30, expected: '<40' },
      { score: 0.39, expected: '<40' },
      { score: 0.40, expected: '40-50' },
      { score: 0.499, expected: '40-50' },
      { score: 0.50, expected: '50-60' },
      { score: 0.599, expected: '50-60' },
      { score: 0.60, expected: '60+' },
      { score: 0.99, expected: '60+' },
    ];
    const db = getDatabase();

    for (const { score, expected } of cases) {
      const id = `cr-band-${String(score).replace('.', '_')}`;
      insertProjectionAudit({
        cardResultId: id,
        sport: 'NBA',
        marketType: 'total',
        period: null,
        playerCount: null,
        confidenceScore: score,
        oddsAmerican: null,
        sharpPriceStatus: null,
        direction: null,
        result: 'win',
        pnlUnits: 0,
        settledAt: '2026-03-01T22:00:00Z',
        jobRunId: null,
        metadata: null,
      });
      const row = db.prepare('SELECT confidence_band FROM projection_audit WHERE id = ?').get(id);
      expect(row.confidence_band).toBe(expected);
    }
  });

  test('writes row with all optional fields absent (NULL)', () => {
    insertProjectionAudit({
      cardResultId: 'cr-minimal',
      sport: 'NHL',
      marketType: 'moneyline',
      period: null,
      playerCount: null,
      confidenceScore: null,
      oddsAmerican: null,
      sharpPriceStatus: null,
      direction: null,
      result: 'loss',
      pnlUnits: -1,
      settledAt: '2026-03-01T22:00:00Z',
      jobRunId: null,
      metadata: null,
    });

    const db = getDatabase();
    const row = db.prepare('SELECT * FROM projection_audit WHERE id = ?').get('cr-minimal');

    expect(row).toBeTruthy();
    expect(row.sport).toBe('NHL');
    expect(row.result).toBe('loss');
    expect(row.player_count).toBeNull();
    expect(row.confidence_score).toBeNull();
    expect(row.confidence_band).toBe('unknown');
    expect(row.odds_american).toBeNull();
    expect(row.sharp_price_status).toBeNull();
    expect(row.direction).toBeNull();
    expect(row.job_run_id).toBeNull();
    expect(row.metadata).toBeNull();
  });

  test('duplicate insert (same card_result_id) is silently ignored — INSERT OR IGNORE', () => {
    const base = {
      cardResultId: 'cr-dup',
      sport: 'NBA',
      marketType: 'total',
      period: null,
      playerCount: null,
      confidenceScore: 0.55,
      oddsAmerican: -110,
      sharpPriceStatus: null,
      direction: 'OVER',
      result: 'win',
      pnlUnits: 0.909,
      settledAt: '2026-03-01T22:00:00Z',
      jobRunId: null,
      metadata: null,
    };

    // First insert
    insertProjectionAudit(base);

    // Second insert with different result — should be ignored
    expect(() =>
      insertProjectionAudit({ ...base, result: 'loss' })
    ).not.toThrow();

    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM projection_audit WHERE id = ?').get('cr-dup');
    expect(count.cnt).toBe(1);

    // Original result must be preserved
    const row = db.prepare('SELECT result FROM projection_audit WHERE id = ?').get('cr-dup');
    expect(row.result).toBe('win');
  });
});
