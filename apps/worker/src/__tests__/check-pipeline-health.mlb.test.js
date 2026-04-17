'use strict';

const { DateTime } = require('luxon');

describe('checkMlbF5MarketAvailability', () => {
  let upcomingGames;
  let latestOddsByGame;
  let rejectReasonRows;
  let pipelineWrites;
  let checkMlbF5MarketAvailability;

  beforeEach(() => {
    jest.resetModules();
    upcomingGames = [];
    latestOddsByGame = {};
    rejectReasonRows = [];
    pipelineWrites = [];

    jest.doMock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: {
        NHL: { active: true },
        NBA: { active: true },
        MLB: { active: true, markets: ['h2h', 'totals'] },
        NFL: { active: false },
      },
    }));

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return {
            run: (...args) => {
              pipelineWrites.push(args);
            },
          };
        }

        if (
          sql.includes("LOWER(sport) = 'mlb'") &&
          sql.includes('FROM games')
        ) {
          return {
            all: () => upcomingGames,
          };
        }

        if (
          sql.includes('FROM odds_snapshots') &&
          sql.includes('ORDER BY captured_at DESC')
        ) {
          return {
            get: (gameId) => latestOddsByGame[gameId] ?? null,
          };
        }

        if (
          sql.includes('FROM card_payloads') &&
          sql.includes("card_type IN ('mlb-f5', 'mlb-full-game', 'mlb-full-game-ml')")
        ) {
          return {
            all: () => rejectReasonRows,
          };
        }

        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      getDb: jest.fn(() => db),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
      recordJobStart: jest.fn(() => 'job-check-health'),
      recordJobSuccess: jest.fn(),
      recordJobError: jest.fn(),
    }));

    ({ checkMlbF5MarketAvailability } = require('../jobs/check_pipeline_health'));
  });

  test('fails when full-game totals are missing even if F5 totals are present', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-001',
        game_time_utc: '2026-03-27T22:00:00.000Z',
        home_team: 'Yankees',
        away_team: 'Red Sox',
      },
    ];
    latestOddsByGame['mlb-game-001'] = {
      game_id: 'mlb-game-001',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: null,
      total_price_over: null,
      total_price_under: null,
      total_f5: 4.5,
      total_price_over_f5: -112,
      total_price_under_f5: -108,
    };

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(false);
    expect(result.games_checked).toBe(1);
    expect(result.missing_f5_total_count).toBe(0);
    expect(result.missing_full_game_total_count).toBe(1);
    expect(result.reason).toContain('missing full-game totals');
    expect(result.reason).toContain('reason families uncategorized=0');
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][0]).toBe('mlb');
    expect(pipelineWrites[0][1]).toBe('f5_market_availability');
    expect(pipelineWrites[0][2]).toBe('failed');
  });

  test('does not fail when F5 totals are missing but F5 markets are not configured', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-002',
        game_time_utc: '2026-03-27T23:00:00.000Z',
        home_team: 'Dodgers',
        away_team: 'Padres',
      },
    ];
    latestOddsByGame['mlb-game-002'] = {
      game_id: 'mlb-game-002',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: 8.0,
      total_price_over: -110,
      total_price_under: -110,
      total_f5: null,
      total_price_over_f5: null,
      total_price_under_f5: null,
      raw_data: JSON.stringify({
        totals: [{ line: 8.0, over: -110, under: -110 }],
      }),
    };

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(true);
    expect(result.missing_f5_total_count).toBe(0);
    expect(result.missing_full_game_total_count).toBe(0);
    expect(result.reason).toContain('not enforced');
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][0]).toBe('mlb');
    expect(pipelineWrites[0][1]).toBe('f5_market_availability');
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('keeps F5 ML informational while dormant', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-003',
        game_time_utc: '2026-03-27T23:30:00.000Z',
        home_team: 'Mets',
        away_team: 'Phillies',
      },
    ];
    latestOddsByGame['mlb-game-003'] = {
      game_id: 'mlb-game-003',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: 8.0,
      total_price_over: -110,
      total_price_under: -110,
      total_f5: 4.0,
      total_price_over_f5: -110,
      total_price_under_f5: -110,
    };

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(true);
    expect(result.expected_f5_ml_count).toBe(0);
    expect(result.missing_f5_ml_count).toBe(0);
    expect(result.reason).not.toContain('missing');
  });

  test('returns deterministic reject reason-family buckets for MLB markets', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-004',
        game_time_utc: '2026-03-28T00:00:00.000Z',
        home_team: 'Cubs',
        away_team: 'Cardinals',
      },
    ];
    latestOddsByGame['mlb-game-004'] = {
      game_id: 'mlb-game-004',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: 8.0,
      total_price_over: -110,
      total_price_under: -110,
      total_f5: 4.0,
      total_price_over_f5: -108,
      total_price_under_f5: -112,
    };
    rejectReasonRows = [
      {
        card_type: 'mlb-full-game',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 3,
      },
      {
        card_type: 'mlb-full-game-ml',
        decision_reason: 'STALE_ODDS_SNAPSHOT',
        pass_reason: null,
        reason_codes_json: '["STALE_ODDS_SNAPSHOT"]',
        cnt: 2,
      },
    ];

    const result = checkMlbF5MarketAvailability();

    expect(result.reject_reason_diagnostics).toBeDefined();
    expect(result.reject_reason_diagnostics.uncategorized_count).toBe(0);
    expect(
      result.reject_reason_diagnostics.reason_family_counts.full_game_total.NO_EDGE,
    ).toBe(3);
    expect(
      result.reject_reason_diagnostics.reason_family_counts.full_game_ml.DATA_STALENESS,
    ).toBe(2);
    expect(
      result.reject_reason_diagnostics.reason_family_counts.f5_total.UNCATEGORIZED,
    ).toBe(0);
  });
});

describe('checkOddsFreshness — quota-aware status downgrade', () => {
  let upcomingGames;
  let latestOddsByGame;
  let pipelineWrites;
  let checkOddsFreshness;
  let mockGetCurrentQuotaTier;

  beforeEach(() => {
    jest.resetModules();
    upcomingGames = [];
    latestOddsByGame = {};
    pipelineWrites = [];

    mockGetCurrentQuotaTier = jest.fn(() => 'FULL');

    jest.doMock('../schedulers/quota', () => ({
      getCurrentQuotaTier: mockGetCurrentQuotaTier,
    }));

    jest.doMock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: {
        NHL: { active: true },
        NBA: { active: true },
        MLB: { active: true },
        NFL: { active: false },
      },
    }));

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return {
            run: (...args) => {
              pipelineWrites.push(args);
            },
          };
        }

        if (
          sql.includes('FROM games') &&
          sql.includes('game_time_utc >= ?') &&
          sql.includes('LOWER(sport) IN') &&
          !sql.includes('FROM odds_snapshots')
        ) {
          return {
            all: () => upcomingGames,
          };
        }

        if (
          sql.includes('FROM odds_snapshots') &&
          sql.includes('WHERE game_id = ?')
        ) {
          return {
            get: (gameId) => latestOddsByGame[gameId] ?? null,
          };
        }

        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      getDb: jest.fn(() => db),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
      recordJobStart: jest.fn(() => 'job-check-health'),
      recordJobSuccess: jest.fn(),
      recordJobError: jest.fn(),
    }));
  });

  test('writes warning (not failed) when odds are stale and quota tier is MEDIUM', () => {
    upcomingGames = [{ game_id: 'g-001', game_time_utc: DateTime.utc().plus({ hours: 2 }).toISO() }];
    latestOddsByGame['g-001'] = { captured_at: DateTime.utc().minus({ minutes: 90 }).toISO() };
    mockGetCurrentQuotaTier.mockReturnValue('MEDIUM');

    ({ checkOddsFreshness } = require('../jobs/check_pipeline_health'));
    const result = checkOddsFreshness();

    expect(result.ok).toBe(false);
    expect(pipelineWrites[0][2]).toBe('warning');
    expect(pipelineWrites[0][3]).toContain('MEDIUM');
    expect(pipelineWrites[0][3]).toContain('paused');
  });

  test('writes failed when odds are stale and quota tier is FULL', () => {
    upcomingGames = [{ game_id: 'g-002', game_time_utc: DateTime.utc().plus({ hours: 2 }).toISO() }];
    latestOddsByGame['g-002'] = { captured_at: DateTime.utc().minus({ minutes: 90 }).toISO() };
    mockGetCurrentQuotaTier.mockReturnValue('FULL');

    ({ checkOddsFreshness } = require('../jobs/check_pipeline_health'));
    const result = checkOddsFreshness();

    expect(result.ok).toBe(false);
    expect(pipelineWrites[0][2]).toBe('failed');
  });

  test('writes ok when odds are fresh regardless of quota tier', () => {
    upcomingGames = [{ game_id: 'g-003', game_time_utc: DateTime.utc().plus({ hours: 2 }).toISO() }];
    latestOddsByGame['g-003'] = { captured_at: DateTime.utc().minus({ minutes: 5 }).toISO() };
    mockGetCurrentQuotaTier.mockReturnValue('CRITICAL');

    ({ checkOddsFreshness } = require('../jobs/check_pipeline_health'));
    const result = checkOddsFreshness();

    expect(result.ok).toBe(true);
    expect(pipelineWrites[0][2]).toBe('ok');
  });
});

describe('checkMlbSeedFreshness', () => {
  let pipelineWrites;
  let upcomingCount;
  let mockWasJobRecentlySuccessful;
  let checkMlbSeedFreshness;

  beforeEach(() => {
    jest.resetModules();
    pipelineWrites = [];
    upcomingCount = 0;
    mockWasJobRecentlySuccessful = jest.fn(() => false);

    jest.doMock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: {
        NHL: { active: true },
        NBA: { active: true },
        MLB: { active: true },
        NFL: { active: false },
      },
    }));

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return {
            run: (...args) => {
              pipelineWrites.push(args);
            },
          };
        }

        if (
          sql.includes('SELECT COUNT(*) as cnt FROM games') &&
          sql.includes("LOWER(sport) = 'mlb'")
        ) {
          return {
            get: () => ({ cnt: upcomingCount }),
          };
        }

        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      getDb: jest.fn(() => db),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: mockWasJobRecentlySuccessful,
      recordJobStart: jest.fn(() => 'job-check-health'),
      recordJobSuccess: jest.fn(),
      recordJobError: jest.fn(),
    }));

    ({ checkMlbSeedFreshness } = require('../jobs/check_pipeline_health'));
  });

  test('skips seed freshness when MLB odds are active', () => {
    upcomingCount = 4;
    mockWasJobRecentlySuccessful.mockReturnValue(false);

    const result = checkMlbSeedFreshness(75);

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('MLB live-odds mode active - seed freshness check skipped');
    expect(pipelineWrites[0][0]).toBe('mlb');
    expect(pipelineWrites[0][1]).toBe('seed_freshness');
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('skips seed freshness even when ESPN-direct would be fresh', () => {
    upcomingCount = 3;
    mockWasJobRecentlySuccessful.mockReturnValue(true);

    const result = checkMlbSeedFreshness(75);

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('MLB live-odds mode active - seed freshness check skipped');
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('skips seed freshness regardless of upcoming MLB game count when odds are active', () => {
    upcomingCount = 0;

    const result = checkMlbSeedFreshness(75);

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('MLB live-odds mode active - seed freshness check skipped');
    expect(pipelineWrites[0][2]).toBe('ok');
  });
});

describe('checkMlbGameLineCoverage', () => {
  let upcomingGames;
  let latestOddsByGame;
  let cardRowsByMarket;
  let rejectReasonRows;
  let pipelineWrites;
  let latestRunId;
  let checkMlbGameLineCoverage;

  beforeEach(() => {
    jest.resetModules();
    upcomingGames = [];
    latestOddsByGame = {};
    cardRowsByMarket = {};
    rejectReasonRows = [];
    pipelineWrites = [];
    latestRunId = 'run-current';

    jest.doMock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: {
        NHL: { active: true },
        NBA: { active: true },
        MLB: { active: true, markets: ['h2h', 'totals'] },
        NFL: { active: false },
      },
    }));

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return {
            run: (...args) => {
              pipelineWrites.push(args);
            },
          };
        }

        if (
          sql.includes('FROM games') &&
          sql.includes("LOWER(sport) = 'mlb'")
        ) {
          return {
            all: () => upcomingGames,
          };
        }

        if (
          sql.includes('FROM odds_snapshots') &&
          sql.includes('ORDER BY captured_at DESC')
        ) {
          return {
            get: (gameId) => latestOddsByGame[gameId] ?? null,
          };
        }

        if (
          sql.includes('FROM card_payloads') &&
          sql.includes('WHERE game_id = ?') &&
          sql.includes('card_type = ?')
        ) {
          return {
            all: (gameId, cardType) => cardRowsByMarket[`${gameId}|${cardType}`] ?? [],
          };
        }

        if (
          sql.includes('FROM card_payloads') &&
          sql.includes("sport = 'MLB'") &&
          sql.includes('run_id IS NOT NULL')
        ) {
          return {
            get: () => ({ run_id: latestRunId }),
          };
        }

        if (
          sql.includes('FROM card_payloads') &&
          sql.includes("card_type IN ('mlb-f5', 'mlb-full-game', 'mlb-full-game-ml')")
        ) {
          return {
            all: () => rejectReasonRows,
          };
        }

        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      getDb: jest.fn(() => db),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
      recordJobStart: jest.fn(() => 'job-check-health'),
      recordJobSuccess: jest.fn(),
      recordJobError: jest.fn(),
    }));

    ({ checkMlbGameLineCoverage } = require('../jobs/check_pipeline_health'));
  });

  test('reports missing current full-game coverage and bucketed reasons', () => {
    upcomingGames = [
      {
        game_id: 'mlb-gap-1',
        game_time_utc: '2026-03-27T22:00:00.000Z',
        home_team: 'Yankees',
        away_team: 'Red Sox',
      },
      {
        game_id: 'mlb-gap-2',
        game_time_utc: '2026-03-27T23:00:00.000Z',
        home_team: 'Dodgers',
        away_team: 'Padres',
      },
    ];

    latestOddsByGame['mlb-gap-1'] = {
      captured_at: DateTime.utc().minus({ minutes: 2 }).toISO(),
      total: 8.5,
      h2h_home: -120,
      h2h_away: 110,
    };
    latestOddsByGame['mlb-gap-2'] = {
      captured_at: DateTime.utc().minus({ minutes: 2 }).toISO(),
      total: 9.0,
      h2h_home: -132,
      h2h_away: 118,
    };

    cardRowsByMarket['mlb-gap-1|mlb-full-game'] = [
      {
        id: 'row-blocked',
        game_id: 'mlb-gap-1',
        card_type: 'mlb-full-game',
        run_id: 'run-current',
        created_at: DateTime.utc().minus({ minutes: 5 }).toISO(),
        payload_data: JSON.stringify({
          basis: 'ODDS_BACKED',
          execution_status: 'BLOCKED',
          decision_v2: { official_status: 'PASS' },
          selection: { side: 'OVER' },
          line: 8.5,
          price: -110,
        }),
      },
    ];

    cardRowsByMarket['mlb-gap-1|mlb-full-game-ml'] = [
      {
        id: 'row-ml-ok',
        game_id: 'mlb-gap-1',
        card_type: 'mlb-full-game-ml',
        run_id: 'run-current',
        created_at: DateTime.utc().minus({ minutes: 5 }).toISO(),
        payload_data: JSON.stringify({
          basis: 'ODDS_BACKED',
          execution_status: 'EXECUTABLE',
          decision_v2: {
            official_status: 'LEAN',
            canonical_envelope_v2: { official_status: 'LEAN', selection_side: 'AWAY' },
          },
          selection: { side: 'AWAY' },
          ml_home: -120,
          ml_away: 110,
          created_at: DateTime.utc().minus({ minutes: 5 }).toISO(),
        }),
      },
    ];

    rejectReasonRows = [
      {
        card_type: 'mlb-full-game',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 1,
      },
    ];

    const result = checkMlbGameLineCoverage();

    expect(result.ok).toBe(false);
    expect(result.markets.full_game_total.games_with_odds).toBe(2);
    expect(result.markets.full_game_total.current_publishable_count).toBe(0);
    expect(result.markets.full_game_total.missing_count).toBe(2);
    expect(result.markets.full_game_ml.current_publishable_count).toBe(1);
    expect(result.reason_buckets.current_blocked.count).toBeGreaterThanOrEqual(1);
    expect(result.reason_buckets.no_card_row.count).toBeGreaterThanOrEqual(2);
    expect(result.reject_reason_diagnostics.uncategorized_count).toBe(0);
    expect(pipelineWrites[0][1]).toBe('game_line_coverage');
  });

  test('distinguishes stale vs stale-or-unverifiable snapshot buckets', () => {
    upcomingGames = [
      {
        game_id: 'mlb-gap-3',
        game_time_utc: '2026-03-27T22:00:00.000Z',
        home_team: 'Mets',
        away_team: 'Phillies',
      },
    ];

    latestOddsByGame['mlb-gap-3'] = {
      captured_at: DateTime.utc().toISO(),
      total: 8.0,
      h2h_home: -118,
      h2h_away: 108,
    };

    cardRowsByMarket['mlb-gap-3|mlb-full-game'] = [
      {
        id: 'row-unverifiable',
        game_id: 'mlb-gap-3',
        card_type: 'mlb-full-game',
        run_id: 'run-current',
        created_at: 'invalid-created-at',
        payload_data: JSON.stringify({
          basis: 'ODDS_BACKED',
          execution_status: 'EXECUTABLE',
          decision_v2: {
            official_status: 'PLAY',
            canonical_envelope_v2: { official_status: 'PLAY', selection_side: 'OVER' },
          },
          selection: { side: 'OVER' },
          line: 8.0,
          price: -110,
          snapshot_at: 'not-a-date',
        }),
      },
    ];

    cardRowsByMarket['mlb-gap-3|mlb-full-game-ml'] = [
      {
        id: 'row-stale',
        game_id: 'mlb-gap-3',
        card_type: 'mlb-full-game-ml',
        run_id: 'run-current',
        created_at: DateTime.utc().minus({ minutes: 130 }).toISO(),
        payload_data: JSON.stringify({
          basis: 'ODDS_BACKED',
          execution_status: 'EXECUTABLE',
          decision_v2: {
            official_status: 'PLAY',
            canonical_envelope_v2: { official_status: 'PLAY', selection_side: 'HOME' },
          },
          selection: { side: 'HOME' },
          ml_home: -118,
          ml_away: 108,
          snapshot_at: DateTime.utc().minus({ minutes: 130 }).toISO(),
        }),
      },
    ];

    const result = checkMlbGameLineCoverage();

    expect(result.ok).toBe(false);
    expect(result.reason_buckets.stale_or_unverifiable_snapshot.count).toBeGreaterThanOrEqual(1);
    expect(result.reason_buckets.stale_snapshot.count).toBeGreaterThanOrEqual(1);
  });
});
