'use strict';

const { DateTime } = require('luxon');

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  createJob: jest.fn(),
  wasJobRecentlySuccessful: jest.fn(() => true),
}));

jest.mock('../post_discord_cards', () => ({
  sendDiscordMessages: jest.fn().mockResolvedValue(1),
}));

jest.mock('../run_mlb_model', () => ({
  buildMlbMarketAvailability: jest.fn(() => ({
    f5_line_ok: true,
    full_game_total_ok: true,
    expect_f5_ml: false,
    f5_ml_ok: true,
  })),
}));

jest.mock('../../schedulers/quota', () => ({
  getCurrentQuotaTier: jest.fn(() => 'FULL'),
}));

jest.mock('../refresh_stale_odds', () => ({
  refreshStaleOdds: jest.fn().mockResolvedValue({
    success: true,
    staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 },
  }),
}));

jest.mock('@cheddar-logic/data/src/feature-flags', () => ({
  isFeatureEnabled: jest.fn(() => false),
}));

const { getDatabase, wasJobRecentlySuccessful } = require('@cheddar-logic/data');
const { sendDiscordMessages } = require('../post_discord_cards');
const { refreshStaleOdds } = require('../refresh_stale_odds');
const { isFeatureEnabled } = require('@cheddar-logic/data/src/feature-flags');
const {
  shouldSendAlert,
  buildHealthAlertMessage,
  checkCardsFreshness,
  checkCardOutputIntegrity,
  checkOddsFreshness,
  checkMlbF5MarketAvailability,
  checkMlbSeedFreshness,
  checkPipelineHealth,
  checkNhlSogSyncFreshness,
  checkNhlBlkSourceIntegrity,
  checkNhlBlkRatesFreshness,
  checkNhlMoneyPuckBlkRatesFreshness,
  checkNbaMoneylineCoverage,
} = require('../check_pipeline_health');

// ---------------------------------------------------------------------------
// DB mock factory
// scheduleCount: returned for COUNT(*) FROM games queries (schedule freshness, model freshness)
// backlogCount:  returned for settlement backlog query
// pipelineRows:  returned for pipeline_health SELECT queries (used by shouldSendAlert)
// ---------------------------------------------------------------------------
function makeDb({
  pipelineRows = [],
  scheduleCount = 5,
  backlogCount = 0,
  upcomingGames = [],
  latestCardsByGame = {},
  latestOddsByGame = {},
  nbaMoneylineCardsCount = 0,
  jobRunsByKey = {},
  failedJobRunsByName = {},
  cardOutputIntegrityRow = null,
} = {}) {
  return {
    prepare: jest.fn((sql) => {
      const s = sql.replace(/\s+/g, ' ').trim();

      // writePipelineHealth INSERT
      if (s.includes('INSERT INTO pipeline_health')) {
        return { run: jest.fn() };
      }

      // shouldSendAlert SELECT from pipeline_health
      if (s.includes('FROM pipeline_health') && s.includes('ORDER BY created_at')) {
        return { all: jest.fn(() => pipelineRows) };
      }

      // settlement backlog: games g WHERE status IN ('final'...) AND NOT EXISTS (game_results)
      if (s.includes('FROM games g') && s.includes('NOT EXISTS')) {
        return { get: jest.fn(() => ({ cnt: backlogCount })) };
      }

      // schedule freshness and model freshness: COUNT(*) FROM games
      if (s.includes('COUNT(*)') && s.includes('FROM games')) {
        return { get: jest.fn(() => ({ cnt: scheduleCount })) };
      }

      if (s.includes('FROM job_runs') && s.includes('job_key = ?') && s.includes("status = 'success'")) {
        return {
          get: jest.fn((jobName, jobKey) => jobRunsByKey[`${jobName}|${jobKey}`] ?? null),
        };
      }

      if (s.includes('FROM job_runs') && s.includes("status = 'failed'") && s.includes('job_name = ?')) {
        return {
          get: jest.fn((jobName) => failedJobRunsByName[jobName] ?? null),
        };
      }

      if (s.includes('FROM card_payloads') && s.includes('WHERE game_id = ?')) {
        return {
          get: jest.fn((gameId) => latestCardsByGame[gameId] ?? null),
        };
      }

      if (s.includes('FROM card_payloads') && s.includes("card_type = 'nba-moneyline-call'")) {
        return {
          get: jest.fn(() => ({ cnt: nbaMoneylineCardsCount })),
        };
      }

      if (s.includes('FROM card_payloads') && s.includes('COUNT(*) AS total_cards')) {
        return {
          get: jest.fn(() => cardOutputIntegrityRow ?? {
            total_cards: 0,
            pass_cards: 0,
            missing_odds_cards: 0,
            degraded_cards: 0,
          }),
        };
      }

      if (s.includes('FROM odds_snapshots') && s.includes('WHERE game_id = ?')) {
        return {
          get: jest.fn((gameId) => latestOddsByGame[gameId] ?? null),
        };
      }

      // game list queries (T-6h, T-2h for odds/cards/mlb checks)
      if (s.includes('FROM games') && s.includes('game_time_utc')) {
        return { all: jest.fn(() => upcomingGames) };
      }

      // default fallback
      return { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn() };
    }),
  };
}

// 3 consecutive 'failed' rows, all fresh (within 2 minutes = well inside 30m cooldown)
function freshFailedRows(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    status: 'failed',
    created_at: DateTime.utc()
      .minus({ minutes: 2 + i })
      .toISO(),
  }));
}

// N 'failed' rows but oldest is stale (outside the cooldown window)
function staleFailedRows(n = 3, cooldownMinutes = 30) {
  return Array.from({ length: n }, (_, i) => ({
    status: 'failed',
    created_at: DateTime.utc()
      .minus({ minutes: cooldownMinutes + 5 + i })
      .toISO(),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
  delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  delete process.env.PIPELINE_HEALTH_ALERT_CONSECUTIVE;
});

// ===========================================================================
describe('shouldSendAlert (unit)', () => {
  test('returns false when fewer than consecutiveRequired rows exist', () => {
    getDatabase.mockReturnValue(makeDb({ pipelineRows: freshFailedRows(2) }));
    // consecutiveRequired = 3, only 2 rows → false
    expect(shouldSendAlert('schedule', 'freshness', 3, 30)).toBe(false);
  });

  test('returns false when N rows exist but not all have status=failed', () => {
    const rows = [
      { status: 'failed', created_at: DateTime.utc().minus({ minutes: 1 }).toISO() },
      { status: 'failed', created_at: DateTime.utc().minus({ minutes: 2 }).toISO() },
      { status: 'ok', created_at: DateTime.utc().minus({ minutes: 3 }).toISO() },
    ];
    getDatabase.mockReturnValue(makeDb({ pipelineRows: rows }));
    expect(shouldSendAlert('schedule', 'freshness', 3, 30)).toBe(false);
  });

  test('returns true when N rows are all failed and oldest is within cooldown window', () => {
    getDatabase.mockReturnValue(makeDb({ pipelineRows: freshFailedRows(3) }));
    expect(shouldSendAlert('schedule', 'freshness', 3, 30)).toBe(true);
  });

  test('returns false when N rows are all failed but oldest is older than cooldown window', () => {
    getDatabase.mockReturnValue(makeDb({ pipelineRows: staleFailedRows(3, 30) }));
    // oldest row is 35+ minutes old, cooldown is 30 → suppress
    expect(shouldSendAlert('schedule', 'freshness', 3, 30)).toBe(false);
  });

  test('returns false when the failed streak was already active before this run', () => {
    const rows = [
      { status: 'failed', created_at: DateTime.utc().minus({ minutes: 1 }).toISO() },
      { status: 'failed', created_at: DateTime.utc().minus({ minutes: 2 }).toISO() },
      { status: 'failed', created_at: DateTime.utc().minus({ minutes: 3 }).toISO() },
      { status: 'failed', created_at: DateTime.utc().minus({ minutes: 4 }).toISO() },
    ];
    getDatabase.mockReturnValue(makeDb({ pipelineRows: rows }));
    expect(shouldSendAlert('schedule', 'freshness', 3, 30)).toBe(false);
  });
});

// ===========================================================================
describe('buildHealthAlertMessage', () => {
  test('output contains 🚨 and "Pipeline Health Alert"', () => {
    const msg = buildHealthAlertMessage([
      { phase: 'schedule', checkName: 'freshness', reason: 'No upcoming games' },
    ]);
    expect(msg).toContain('🚨');
    expect(msg).toContain('Pipeline Health Alert');
  });

  test('each failed check phase, checkName, and reason appear in output', () => {
    const msg = buildHealthAlertMessage([
      { phase: 'schedule', checkName: 'freshness', reason: 'No upcoming games in next 48h' },
      { phase: 'cards', checkName: 'freshness', reason: '3/5 games missing cards' },
    ]);
    expect(msg).toContain('schedule');
    expect(msg).toContain('freshness');
    expect(msg).toContain('No upcoming games in next 48h');
    expect(msg).toContain('cards');
    expect(msg).toContain('3/5 games missing cards');
  });
});

// ===========================================================================
describe('checkCardsFreshness', () => {
  test('returns ok when NBA model window succeeded even if no card was emitted', () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-001',
        sport: 'NBA',
        game_time_utc: now.plus({ minutes: 80 }).toISO(),
      },
    ];
    const jobRunsByKey = {
      'run_nba_model|nba|tminus|nba-001|90': { started_at: now.minus({ minutes: 8 }).toISO() },
    };
    getDatabase.mockReturnValue(makeDb({ upcomingGames, jobRunsByKey }));

    const result = checkCardsFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('recent model runs');
    expect(result.reason).toContain('informational');
  });

  test('returns ok during the natural gap before the first due model window closes', () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-002',
        sport: 'NBA',
        game_time_utc: now.plus({ minutes: 118 }).toISO(),
      },
    ];
    getDatabase.mockReturnValue(makeDb({ upcomingGames }));

    const result = checkCardsFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('awaiting first model window');
  });

  test('returns warning when the expected model job has not run after a due window closes', () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nhl-001',
        sport: 'NHL',
        game_time_utc: now.plus({ minutes: 50 }).toISO(),
      },
    ];
    const db = makeDb({ upcomingGames });
    const writes = [];
    db.prepare = jest.fn((sql) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('INSERT INTO pipeline_health')) {
        return { run: jest.fn((...args) => writes.push(args)) };
      }
      if (s.includes('FROM card_payloads') && s.includes('WHERE game_id = ?')) {
        return { get: jest.fn(() => null) };
      }
      if (s.includes('FROM job_runs') && s.includes('job_key = ?') && s.includes("status = 'success'")) {
        return { get: jest.fn(() => null) };
      }
      if (s.includes('FROM games') && s.includes('game_time_utc')) {
        return { all: jest.fn(() => upcomingGames) };
      }
      return makeDb().prepare(sql);
    });
    getDatabase.mockReturnValue(db);

    const result = checkCardsFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing expected model runs');
    expect(writes[0][2]).toBe('warning');
  });
});

describe('checkCardOutputIntegrity', () => {
  test('returns ok when sample is below minimum threshold', () => {
    getDatabase.mockReturnValue(
      makeDb({
        cardOutputIntegrityRow: {
          total_cards: 5,
          pass_cards: 4,
          missing_odds_cards: 1,
          degraded_cards: 2,
        },
      }),
    );

    const result = checkCardOutputIntegrity();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('Insufficient sample');
  });

  test('returns failed when pass, missing odds, and degraded rates spike', () => {
    getDatabase.mockReturnValue(
      makeDb({
        cardOutputIntegrityRow: {
          total_cards: 100,
          pass_cards: 98,
          missing_odds_cards: 80,
          degraded_cards: 70,
        },
      }),
    );

    const result = checkCardOutputIntegrity();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('CARD_OUTPUT_INTEGRITY_DEGRADED');
    expect(result.reason).toContain('PASS spike');
    expect(result.reason).toContain('missing_odds spike');
    expect(result.reason).toContain('degraded spike');
  });

  test('returns ok when rates are within thresholds', () => {
    getDatabase.mockReturnValue(
      makeDb({
        cardOutputIntegrityRow: {
          total_cards: 100,
          pass_cards: 60,
          missing_odds_cards: 10,
          degraded_cards: 20,
        },
      }),
    );

    const result = checkCardOutputIntegrity();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('Card output integrity healthy');
  });
});

describe('checkNbaMoneylineCoverage', () => {
  test('returns warning when spread/total exist but moneyline is missing', () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-ml-missing-001',
        sport: 'NBA',
        game_time_utc: now.plus({ minutes: 50 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      'nba-ml-missing-001': {
        captured_at: now.minus({ minutes: 3 }).toISO(),
        spread_home: -4.5,
        spread_away: 4.5,
        total: 226.5,
        h2h_home: null,
        h2h_away: null,
      },
    };

    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame }));

    const result = checkNbaMoneylineCoverage();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('NBA_ML_MISSING_WITH_OTHER_MARKETS');
    expect(result.diagnostics.nba_games_missing_ml).toBe(1);
    expect(result.diagnostics.alert_code).toBe('NBA_ML_MISSING_WITH_OTHER_MARKETS');
  });

  test('returns ok when spread/total and moneyline are both present', () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-ml-present-001',
        sport: 'NBA',
        game_time_utc: now.plus({ minutes: 45 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      'nba-ml-present-001': {
        captured_at: now.minus({ minutes: 4 }).toISO(),
        spread_home: -2.5,
        spread_away: 2.5,
        total: 219.5,
        h2h_home: -125,
        h2h_away: 110,
      },
    };

    getDatabase.mockReturnValue(
      makeDb({ upcomingGames, latestOddsByGame, nbaMoneylineCardsCount: 1 }),
    );

    const result = checkNbaMoneylineCoverage();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('spread/total+moneyline odds');
    expect(result.diagnostics.nba_games_missing_ml).toBe(0);
  });
});

describe('checkNhlBlkSourceIntegrity', () => {
  test('returns failed when recent NST schema drift is detected', () => {
    const db = makeDb({
      failedJobRunsByName: {
        pull_nst_blk_rates: {
          started_at: DateTime.utc().minus({ hours: 1 }).toISO(),
          error_message: '[SCHEMA_DRIFT] NST season CSV missing required headers: ev blocks',
        },
      },
    });
    getDatabase.mockReturnValue(db);
    isFeatureEnabled.mockImplementation((sport, flag) =>
      sport === 'nhl' && flag === 'blk-ingest',
    );

    const result = checkNhlBlkSourceIntegrity();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('schema drift');
  });

  test('returns ok when no recent schema drift failures exist', () => {
    const db = makeDb();
    getDatabase.mockReturnValue(db);
    isFeatureEnabled.mockImplementation((sport, flag) =>
      sport === 'nhl' && flag === 'blk-ingest',
    );

    const result = checkNhlBlkSourceIntegrity();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('passed');
  });
});

// ===========================================================================
describe('checkOddsFreshness', () => {
  test('dedupes ESPN numeric and espndirect duplicates when a fresh canonical matchup exists', async () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: '401811039',
        sport: 'NBA',
        away_team: 'Golden State Warriors',
        home_team: 'Sacramento Kings',
        game_time_utc: now.plus({ minutes: 20 }).toISO(),
      },
      {
        game_id: 'espndirect_nba_401811039',
        sport: 'NBA',
        away_team: 'Golden State Warriors',
        home_team: 'Sacramento Kings',
        game_time_utc: now.plus({ minutes: 20 }).toISO(),
      },
      {
        game_id: 'canonical-warriors-kings',
        sport: 'NBA',
        away_team: 'Golden State Warriors',
        home_team: 'Sacramento Kings',
        game_time_utc: now.plus({ minutes: 20 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      espndirect_nba_401811039: { captured_at: now.minus({ minutes: 141 }).toISO() },
      'canonical-warriors-kings': { captured_at: now.minus({ minutes: 10 }).toISO() },
    };

    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame }));

    const result = await checkOddsFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('All 1 games within T-6h have fresh odds');
    expect(result.reason).toContain('duplicate game_id rows ignored');
  });

  test('reports one stale matchup still stale after remediation attempt (duplicate dedup intact)', async () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: '401811040',
        sport: 'NBA',
        away_team: 'Phoenix Suns',
        home_team: 'Los Angeles Lakers',
        game_time_utc: now.plus({ minutes: 45 }).toISO(),
      },
      {
        game_id: 'espndirect_nba_401811040',
        sport: 'NBA',
        away_team: 'Phoenix Suns',
        home_team: 'Los Angeles Lakers',
        game_time_utc: now.plus({ minutes: 45 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      espndirect_nba_401811040: { captured_at: now.minus({ minutes: 141 }).toISO() },
    };

    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame }));
    refreshStaleOdds.mockResolvedValueOnce({
      success: true,
      staleDiagnostics: { detected: 1, refreshed: 0, blocked: 1 },
    });

    const result = await checkOddsFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('still stale after remediation');
    expect(result.reason).toContain('remediation: detected=1 refreshed=0 blocked=1');
    expect(result.reason).toContain('duplicate game_id rows ignored');
    expect(refreshStaleOdds).toHaveBeenCalledTimes(1);
  });

  test('returns warning when stale odds are outside alert window', async () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-far-window-1',
        sport: 'NBA',
        away_team: 'Miami Heat',
        home_team: 'Orlando Magic',
        game_time_utc: now.plus({ hours: 4 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      'nba-far-window-1': { captured_at: now.minus({ minutes: 141 }).toISO() },
    };

    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame }));

    const result = await checkOddsFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('but none within alert window T-2h');
    expect(result.diagnostics).toEqual({ detected: 1, blocked: 0, refreshed: 0 });
  });
});

// ===========================================================================
describe('checkOddsFreshness remediation-success path', () => {
  test('returns ok when remediation clears all near-term stale games', async () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-stale-001',
        sport: 'NBA',
        away_team: 'Boston Celtics',
        home_team: 'Miami Heat',
        game_time_utc: now.plus({ minutes: 30 }).toISO(),
      },
    ];
    const staleOdds = { captured_at: now.minus({ minutes: 200 }).toISO() };
    const freshOdds = { captured_at: now.minus({ minutes: 3 }).toISO() };

    // Initial check sees stale; after remediation the DB mock returns fresh.
    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame: { 'nba-stale-001': staleOdds } }));
    refreshStaleOdds.mockImplementationOnce(async () => {
      getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame: { 'nba-stale-001': freshOdds } }));
      return { success: true, staleDiagnostics: { detected: 1, refreshed: 1, blocked: 0 } };
    });

    const result = await checkOddsFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('remediation');
    expect(result.reason).toContain('remediation: detected=1 refreshed=1 blocked=0');
    expect(result.diagnostics).toEqual({ detected: 1, refreshed: 1, blocked: 0 });
    expect(refreshStaleOdds).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe('checkNhlSogSyncFreshness', () => {
  afterEach(() => {
    delete process.env.ENABLE_NHL_SOG_PLAYER_SYNC;
  });

  test('feature disabled → returns ok with "feature disabled" reason and writes ok health row', () => {
    isFeatureEnabled.mockReturnValueOnce(false);
    const writes = [];
    const db = makeDb();
    db.prepare = jest.fn((sql) => {
      if (sql.includes('INSERT INTO pipeline_health')) {
        return { run: (...args) => writes.push(args) };
      }
      return makeDb().prepare(sql);
    });
    getDatabase.mockReturnValue(db);

    const result = checkNhlSogSyncFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/feature disabled/i);
    expect(writes).toHaveLength(1);
    expect(writes[0][2]).toBe('ok');
  });

  test('feature enabled + stale sync → returns failed with at-risk reason', () => {
    isFeatureEnabled.mockReturnValueOnce(true);
    // wasJobRecentlySuccessful returns false → sync is stale
    wasJobRecentlySuccessful.mockReturnValueOnce(false);
    // scheduleCount=1 so there are upcoming NHL games for the check to fire
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 1 }));

    const result = checkNhlSogSyncFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/has NOT run successfully/);
    expect(result.reason).toContain('threshold=expected:1440m grace:0m window:1440m');
  });

  test('feature enabled + stale sync includes latest failed run details in reason', () => {
    isFeatureEnabled.mockReturnValueOnce(true);
    wasJobRecentlySuccessful.mockReturnValueOnce(false);
    getDatabase.mockReturnValue(
      makeDb({
        scheduleCount: 1,
        failedJobRunsByName: {
          sync_nhl_sog_player_ids: {
            started_at: '2026-04-27T10:00:00.000Z',
            error_message: 'API timeout while syncing NHL SOG player ids',
          },
        },
      }),
    );

    const result = checkNhlSogSyncFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('latest failed run at 2026-04-27T10:00:00.000Z');
    expect(result.reason).toContain('API timeout while syncing NHL SOG player ids');
  });

  test('feature enabled + recent successful run → returns ok', () => {
    isFeatureEnabled.mockReturnValueOnce(true);
    // wasJobRecentlySuccessful returns true (default)
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 1 }));

    const result = checkNhlSogSyncFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/ran successfully/);
  });
});

// ===========================================================================
describe('NHL BLK rates freshness watchdog checks', () => {
  test('checkNhlBlkRatesFreshness: feature disabled returns ok and writes ok health row', () => {
    isFeatureEnabled.mockImplementation(() => false);
    const writes = [];
    const db = makeDb();
    db.prepare = jest.fn((sql) => {
      if (sql.includes('INSERT INTO pipeline_health')) {
        return { run: (...args) => writes.push(args) };
      }
      return makeDb().prepare(sql);
    });
    getDatabase.mockReturnValue(db);

    const result = checkNhlBlkRatesFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/feature disabled/i);
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe('blk_rates_nst_freshness');
    expect(writes[0][2]).toBe('ok');
  });

  test('checkNhlBlkRatesFreshness: enabled + stale returns failed', () => {
    isFeatureEnabled.mockImplementation((sport, feature) =>
      sport === 'nhl' && feature === 'blk-ingest',
    );
    wasJobRecentlySuccessful.mockReturnValueOnce(false);
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 1 }));

    const result = checkNhlBlkRatesFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/has NOT run successfully/i);
  });

  test('checkNhlMoneyPuckBlkRatesFreshness: moneypuck feature disabled returns ok skip', () => {
    isFeatureEnabled.mockImplementation((sport, feature) =>
      sport === 'nhl' && feature === 'blk-ingest',
    );
    const writes = [];
    const db = makeDb();
    db.prepare = jest.fn((sql) => {
      if (sql.includes('INSERT INTO pipeline_health')) {
        return { run: (...args) => writes.push(args) };
      }
      return makeDb().prepare(sql);
    });
    getDatabase.mockReturnValue(db);

    const result = checkNhlMoneyPuckBlkRatesFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/feature disabled/i);
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe('blk_rates_moneypuck_freshness');
    expect(writes[0][2]).toBe('ok');
  });
});

// ===========================================================================
describe('MLB health checks', () => {
  afterEach(() => {
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
  });

  test('fails MLB market availability when full-game totals are missing', () => {
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'mlb-001',
        sport: 'MLB',
        away_team: 'Boston Red Sox',
        home_team: 'New York Yankees',
        game_time_utc: now.plus({ minutes: 45 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      'mlb-001': {
        captured_at: now.minus({ minutes: 5 }).toISO(),
      },
    };

    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame }));
    const mockBuildAvailability = require('../run_mlb_model').buildMlbMarketAvailability;
    mockBuildAvailability.mockReturnValueOnce({
      f5_line_ok: true,
      full_game_total_ok: false,
      expect_f5_ml: false,
      f5_ml_ok: true,
    });

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(false);
    expect(result.missing_full_game_total_count).toBe(1);
    expect(result.reason).toContain('missing full-game totals');
    expect(result.reason).not.toContain('informational');
  });

  test('skips MLB seed freshness in live-odds mode by default', () => {
    const result = checkMlbSeedFreshness(75);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('MLB live-odds mode active - seed freshness check skipped');
  });

  test('checks ESPN seed freshness when global without-odds mode is enabled', () => {
    process.env.ENABLE_WITHOUT_ODDS_MODE = 'true';
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 2 }));
    const { wasJobRecentlySuccessful } = require('@cheddar-logic/data');
    wasJobRecentlySuccessful.mockReturnValue(false);

    const result = checkMlbSeedFreshness(75);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pull_espn_games_direct has NOT run successfully');
  });
});

// ===========================================================================
describe('checkPipelineHealth Discord alert integration', () => {
  test('does NOT call sendDiscordMessages when ENABLE_PIPELINE_HEALTH_WATCHDOG is not set', async () => {
    // schedule fails (scheduleCount=0) but watchdog env var is absent
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 0 }));
    await checkPipelineHealth({ jobKey: 'test', dryRun: false });
    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('does NOT call sendDiscordMessages when ENABLE_PIPELINE_HEALTH_WATCHDOG=false', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'false';
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 0 }));
    await checkPipelineHealth({ jobKey: 'test', dryRun: false });
    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('calls sendDiscordMessages when watchdog=true, check fails, and shouldSendAlert returns true', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';
    // scheduleCount=0 → schedule_freshness fails; pipelineRows → shouldSendAlert returns true
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 0, pipelineRows: freshFailedRows(3) }));

    await checkPipelineHealth({ jobKey: 'test', dryRun: false });

    expect(sendDiscordMessages).toHaveBeenCalledTimes(1);
    const callArgs = sendDiscordMessages.mock.calls[0][0];
    expect(callArgs.webhookUrl).toBe('https://discord.example/webhook');
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0]).toContain('No upcoming games in next 48h');
    expect(callArgs.messages[0]).toContain('[schedule:freshness:global]');
  });

  test('does NOT call sendDiscordMessages when watchdog=true but all checks pass', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';
    // scheduleCount=5 → schedule ok; game list empty → odds/cards/mlb ok; backlog=0 → settlement ok
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 5, backlogCount: 0 }));

    await checkPipelineHealth({ jobKey: 'test', dryRun: false });

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('does NOT call sendDiscordMessages when dryRun=true', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkPipelineHealth({ jobKey: 'test', dryRun: true });

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('does NOT call sendDiscordMessages when DISCORD_ALERT_WEBHOOK_URL is unset', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    // DISCORD_ALERT_WEBHOOK_URL intentionally not set
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 0, pipelineRows: freshFailedRows(3) }));

    await checkPipelineHealth({ jobKey: 'test', dryRun: false });

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('warning-only failures (settlement_backlog writes warning) do NOT trigger Discord alert', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';
    // backlogCount=5 → checkSettlementBacklog returns { ok: false } and writes 'warning'
    // scheduleCount=5 → schedule ok; game list empty → odds/cards/mlb ok
    // pipelineRows contains 'warning' rows → shouldSendAlert finds no 'failed' streak → returns false
    const warningRows = [
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 2 }).toISO() },
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 4 }).toISO() },
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 6 }).toISO() },
    ];
    getDatabase.mockReturnValue(
      makeDb({ scheduleCount: 5, backlogCount: 5, pipelineRows: warningRows }),
    );

    await checkPipelineHealth({ jobKey: 'test', dryRun: false });

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('cards freshness warnings do NOT trigger Discord alert', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';
    const warningRows = [
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 2 }).toISO() },
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 4 }).toISO() },
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 6 }).toISO() },
      { status: 'warning', created_at: DateTime.utc().minus({ minutes: 8 }).toISO() },
    ];
    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-003',
        sport: 'NBA',
        game_time_utc: now.plus({ minutes: 50 }).toISO(),
      },
    ];
    getDatabase.mockReturnValue(makeDb({ scheduleCount: 5, backlogCount: 0, pipelineRows: warningRows, upcomingGames }));

    await checkPipelineHealth({ jobKey: 'test', dryRun: false });

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('persists alert_delivery failure when Discord send rejects and still completes the run', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    const writes = [];
    const db = makeDb({ scheduleCount: 0, pipelineRows: freshFailedRows(3) });
    db.prepare = jest.fn((sql) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('INSERT INTO pipeline_health')) {
        return { run: jest.fn((...args) => writes.push(args)) };
      }
      return makeDb({ scheduleCount: 0, pipelineRows: freshFailedRows(3) }).prepare(sql);
    });
    getDatabase.mockReturnValue(db);
    sendDiscordMessages.mockRejectedValueOnce(new Error('discord transport failed'));

    await expect(checkPipelineHealth({ jobKey: 'test', dryRun: false })).resolves.toMatchObject({
      allOk: false,
    });

    expect(
      writes.some(
        (args) =>
          args[0] === 'watchdog' &&
          args[1] === 'alert_delivery' &&
          args[2] === 'failed' &&
          String(args[3]).includes('discord transport failed'),
      ),
    ).toBe(true);
  });
});

// ===========================================================================
describe('checkPipelineHealth alert threshold env override', () => {
  test('PIPELINE_HEALTH_ALERT_CONSECUTIVE=4 pages on the fourth consecutive failed row', async () => {
    jest.resetModules();
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';
    process.env.PIPELINE_HEALTH_ALERT_CONSECUTIVE = '4';

    const mockGetDatabase = jest.fn(() =>
      makeDb({ scheduleCount: 0, pipelineRows: freshFailedRows(4) }),
    );
    const mockSendDiscordMessages = jest.fn().mockResolvedValue(1);

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: mockGetDatabase,
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));
    jest.doMock('../post_discord_cards', () => ({
      sendDiscordMessages: mockSendDiscordMessages,
    }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({
        f5_line_ok: true,
        full_game_total_ok: true,
        expect_f5_ml: false,
        f5_ml_ok: true,
      })),
    }));
    jest.doMock('../../schedulers/quota', () => ({
      getCurrentQuotaTier: jest.fn(() => 'FULL'),
    }));

    const isolated = require('../check_pipeline_health');
    await isolated.checkPipelineHealth({ jobKey: 'test', dryRun: false });

    expect(mockSendDiscordMessages).toHaveBeenCalledTimes(1);

    delete process.env.PIPELINE_HEALTH_ALERT_CONSECUTIVE;
  });
});
