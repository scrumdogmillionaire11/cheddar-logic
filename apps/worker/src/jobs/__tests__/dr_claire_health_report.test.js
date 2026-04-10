'use strict';

const {
  assignStatus,
  runSportHealthQuery,
} = require('../dr_claire_health_report');

function makeDb({
  results = [],
  rawCount = results.length,
  latestCardCreatedAt = null,
  modelHealthRow = null,
  modelConf = null,
} = {}) {
  return {
    prepare: jest.fn((sql) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.includes('SELECT COUNT(*) as n FROM card_results')) {
        return { get: jest.fn(() => ({ n: rawCount })) };
      }

      if (normalized.includes('FROM card_results') && normalized.includes('GROUP BY game_id, card_type, recommended_bet_type')) {
        return { all: jest.fn(() => results) };
      }

      if (normalized.includes('FROM card_payloads')) {
        return {
          get: jest.fn(() => (
            latestCardCreatedAt
              ? { created_at: latestCardCreatedAt }
              : null
          )),
        };
      }

      if (normalized.includes('FROM pipeline_health') && normalized.includes("check_name = 'model_freshness'")) {
        return { get: jest.fn(() => modelHealthRow) };
      }

      if (normalized.includes('FROM model_outputs')) {
        return { get: jest.fn(() => modelConf) };
      }

      return { get: jest.fn(() => null), all: jest.fn(() => []) };
    }),
  };
}

describe('assignStatus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-10T18:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('skips stale card age when model freshness is recently ok', () => {
    const staleCardMs = Date.now() - (200 * 60 * 1000);

    expect(assignStatus(0.6, staleCardMs, true)).toBe('healthy');
  });
});

describe('runSportHealthQuery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-10T18:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('uses fresh ok model_freshness instead of stale card age', () => {
    const db = makeDb({
      results: [
        { result: 'win', pnl_units: 1, settled_at: '2026-04-10T17:00:00Z' },
        { result: 'win', pnl_units: 1, settled_at: '2026-04-10T16:00:00Z' },
        { result: 'win', pnl_units: 1, settled_at: '2026-04-10T15:00:00Z' },
        { result: 'loss', pnl_units: -1, settled_at: '2026-04-10T14:00:00Z' },
      ],
      rawCount: 4,
      latestCardCreatedAt: '2026-04-10T14:40:00Z',
      modelHealthRow: {
        status: 'ok',
        created_at: '2026-04-10T16:30:00Z',
      },
      modelConf: {
        avg_conf: 0.62,
        last_run: '2026-04-10T16:30:00Z',
      },
    });

    const result = runSportHealthQuery(db, 'nba', 30);

    expect(result.status).toBe('healthy');
    expect(result.hitRate).toBeCloseTo(0.75, 6);
  });

  test('falls back to card age when no recent model_freshness row exists', () => {
    const db = makeDb({
      results: [
        { result: 'win', pnl_units: 1, settled_at: '2026-04-10T17:00:00Z' },
        { result: 'loss', pnl_units: -1, settled_at: '2026-04-10T16:00:00Z' },
      ],
      rawCount: 2,
      latestCardCreatedAt: '2026-04-10T14:40:00Z',
      modelHealthRow: null,
      modelConf: {
        avg_conf: 0.55,
        last_run: '2026-04-10T15:00:00Z',
      },
    });

    const result = runSportHealthQuery(db, 'nba', 30);

    expect(result.status).toBe('stale');
  });
});
