'use strict';

const {
  assignStatus,
  buildPotdHealth,
  floorToFiveMinuteBucketUtc,
  parseArgs,
  persistModelHealthSnapshots,
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

describe('parseArgs', () => {
  test('supports --persist alongside existing flags', () => {
    const opts = parseArgs(['--persist', '--json', '--days=14', '--sport=nba']);

    expect(opts).toEqual({
      persist: true,
      json: true,
      days: 14,
      sport: 'nba',
    });
  });
});

describe('floorToFiveMinuteBucketUtc', () => {
  test('floors timestamps to the 5-minute UTC bucket', () => {
    expect(floorToFiveMinuteBucketUtc('2026-04-10T18:07:49.123Z')).toBe(
      '2026-04-10T18:05:00.000Z',
    );
  });
});

describe('persistModelHealthSnapshots', () => {
  function makeReport() {
    return {
      generatedAt: '2026-04-10T18:07:49.123Z',
      lookbackDays: 30,
      sports: {
        nba: {
          hitRate: 0.55,
          netUnits: 3.25,
          roiPct: 4.5,
          totalPredictions: 20,
          wins: 11,
          losses: 9,
          streak: 'W2',
          last10HitRate: 0.6,
          status: 'healthy',
          degradationSignals: ['Negative ROI: -1.0%'],
        },
        nhl: {
          hitRate: 0.48,
          netUnits: -1.5,
          roiPct: -2.1,
          totalPredictions: 18,
          wins: 8,
          losses: 10,
          streak: 'L1',
          last10HitRate: 0.4,
          status: 'degraded',
          degradationSignals: [],
        },
      },
    };
  }

  function makeWriterDeps(runCalls) {
    return {
      openWriterDb: jest.fn(() => ({
        prepare: jest.fn(() => ({
          run: jest.fn((...args) => {
            runCalls.push(args);
          }),
        })),
      })),
      closeWriterDb: jest.fn(),
    };
  }

  test('does not open the writer without --persist', () => {
    const runCalls = [];
    const deps = makeWriterDeps(runCalls);

    const result = persistModelHealthSnapshots(makeReport(), { persist: false }, deps);

    expect(result).toEqual({ persisted: false, rowCount: 0, runAt: null });
    expect(deps.openWriterDb).not.toHaveBeenCalled();
    expect(runCalls).toHaveLength(0);
  });

  test('writes one upsert row per sport in the bucketed run window', () => {
    const runCalls = [];
    const deps = makeWriterDeps(runCalls);

    const result = persistModelHealthSnapshots(
      makeReport(),
      { persist: true, days: 30 },
      deps,
    );

    expect(result).toEqual({
      persisted: true,
      rowCount: 2,
      runAt: '2026-04-10T18:05:00.000Z',
    });
    expect(deps.openWriterDb).toHaveBeenCalledTimes(1);
    expect(deps.closeWriterDb).toHaveBeenCalledTimes(1);
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]).toEqual([
      'nba',
      '2026-04-10T18:05:00.000Z',
      0.55,
      3.25,
      4.5,
      20,
      11,
      9,
      'W2',
      0.6,
      'healthy',
      JSON.stringify(['Negative ROI: -1.0%']),
      30,
    ]);
    expect(runCalls[1][0]).toBe('nhl');
  });

  test('supports single-sport persistence', () => {
    const runCalls = [];
    const deps = makeWriterDeps(runCalls);
    const report = makeReport();
    report.sports = { nba: report.sports.nba };

    const result = persistModelHealthSnapshots(
      report,
      { persist: true, days: 30, runAt: '2026-04-10T18:10:00.000Z' },
      deps,
    );

    expect(result.rowCount).toBe(1);
    expect(result.runAt).toBe('2026-04-10T18:10:00.000Z');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0][0]).toBe('nba');
  });

  test('keeps different lookback windows isolated within the same bucket', () => {
    const runCalls = [];
    const deps = makeWriterDeps(runCalls);
    const report = makeReport();

    persistModelHealthSnapshots(
      report,
      { persist: true, days: 14, runAt: '2026-04-10T18:05:00.000Z' },
      deps,
    );
    persistModelHealthSnapshots(
      report,
      { persist: true, days: 30, runAt: '2026-04-10T18:05:00.000Z' },
      deps,
    );

    expect(runCalls).toHaveLength(4);
    expect(runCalls[0][12]).toBe(14);
    expect(runCalls[2][12]).toBe(30);
    expect(runCalls[0][1]).toBe(runCalls[2][1]);
  });
});

describe('buildPotdHealth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-10T18:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makePotdDb({
    tables = ['potd_daily_stats', 'potd_plays', 'potd_nominees', 'potd_shadow_candidates', 'potd_shadow_results'],
    latestDaily = null,
    todayDaily = null,
    todayPlay = null,
    latestPlay = null,
    nomineeCount = 0,
    shadowCandidateCount = 0,
    shadowStatusRows = [],
    latestShadowResult = null,
  } = {}) {
    return {
      prepare: jest.fn((sql) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (normalized.includes("FROM sqlite_master WHERE type='table'")) {
          return {
            get: jest.fn((tableName) => (
              tables.includes(tableName) ? { name: tableName } : null
            )),
          };
        }
        if (normalized.includes('FROM potd_daily_stats') && normalized.includes('WHERE play_date = ?')) {
          return { get: jest.fn(() => todayDaily) };
        }
        if (normalized.includes('FROM potd_daily_stats')) {
          return { get: jest.fn(() => latestDaily) };
        }
        if (normalized.includes('FROM potd_plays') && normalized.includes('WHERE play_date = ?')) {
          return { get: jest.fn(() => todayPlay) };
        }
        if (normalized.includes('FROM potd_plays')) {
          return { get: jest.fn(() => latestPlay) };
        }
        if (normalized.includes('FROM potd_nominees')) {
          return { get: jest.fn(() => ({ count: nomineeCount })) };
        }
        if (normalized.includes('FROM potd_shadow_candidates')) {
          return { get: jest.fn(() => ({ count: shadowCandidateCount })) };
        }
        if (normalized.includes('FROM potd_shadow_results') && normalized.includes('GROUP BY')) {
          return { all: jest.fn(() => shadowStatusRows) };
        }
        if (normalized.includes('FROM potd_shadow_results')) {
          return { get: jest.fn(() => latestShadowResult) };
        }

        return { get: jest.fn(() => null), all: jest.fn(() => []) };
      }),
    };
  }

  test('returns no-data without POTD history', () => {
    const result = buildPotdHealth(makePotdDb({ tables: [] }));

    expect(result.status).toBe('no-data');
    expect(result.today_state).toBe('no-data');
    expect(result.candidate_count).toBe(0);
    expect(result.near_miss.counts.total).toBe(0);
    expect(result.signals).toContain('No POTD run history found');
  });

  test('summarizes fired state, candidate volume, and near-miss settlement freshness', () => {
    const db = makePotdDb({
      latestDaily: {
        play_date: '2026-04-10',
        potd_fired: 1,
        candidate_count: 8,
        viable_count: 3,
        created_at: '2026-04-10T16:00:00.000Z',
      },
      todayDaily: {
        play_date: '2026-04-10',
        potd_fired: 1,
        candidate_count: 8,
        viable_count: 3,
        created_at: '2026-04-10T16:00:00.000Z',
      },
      todayPlay: {
        play_date: '2026-04-10',
        posted_at: '2026-04-10T16:10:00.000Z',
        created_at: '2026-04-10T16:10:00.000Z',
      },
      latestPlay: {
        play_date: '2026-04-10',
        posted_at: '2026-04-10T16:10:00.000Z',
        created_at: '2026-04-10T16:10:00.000Z',
      },
      shadowStatusRows: [
        { status: 'settled', result: 'win', count: 2 },
        { status: 'settled', result: 'loss', count: 1 },
        { status: 'pending', result: null, count: 1 },
      ],
      latestShadowResult: {
        settled_at: '2026-04-10T17:00:00.000Z',
        updated_at: '2026-04-10T17:00:00.000Z',
        created_at: '2026-04-10T16:30:00.000Z',
      },
    });

    const result = buildPotdHealth(db);

    expect(result.status).toBe('healthy');
    expect(result.today_state).toBe('fired');
    expect(result.candidate_count).toBe(8);
    expect(result.viable_count).toBe(3);
    expect(result.near_miss.counts).toEqual({
      total: 4,
      pending: 1,
      settled: 3,
      win: 2,
      loss: 1,
      push: 0,
    });
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
