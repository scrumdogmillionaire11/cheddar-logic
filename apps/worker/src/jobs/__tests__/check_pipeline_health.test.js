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

const { getDatabase } = require('@cheddar-logic/data');
const { sendDiscordMessages } = require('../post_discord_cards');
const {
  shouldSendAlert,
  buildHealthAlertMessage,
  checkCardsFreshness,
  checkOddsFreshness,
  checkMlbF5MarketAvailability,
  checkMlbSeedFreshness,
  checkPipelineHealth,
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
  jobRunsByKey = {},
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

      if (s.includes('FROM card_payloads') && s.includes('WHERE game_id = ?')) {
        return {
          get: jest.fn((gameId) => latestCardsByGame[gameId] ?? null),
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

// ===========================================================================
describe('checkOddsFreshness', () => {
  test('dedupes ESPN numeric and espndirect duplicates when a fresh canonical matchup exists', () => {
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
        game_time_utc: now.plus({ minutes: 30 }).toISO(),
      },
    ];
    const latestOddsByGame = {
      espndirect_nba_401811039: { captured_at: now.minus({ minutes: 141 }).toISO() },
      'canonical-warriors-kings': { captured_at: now.minus({ minutes: 10 }).toISO() },
    };

    getDatabase.mockReturnValue(makeDb({ upcomingGames, latestOddsByGame }));

    const result = checkOddsFreshness();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('All 1 games within T-6h have fresh odds');
    expect(result.reason).toContain('duplicate game_id rows ignored');
  });

  test('reports one stale matchup when all duplicate rows for the matchup are stale', () => {
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

    const result = checkOddsFreshness();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('1/1 games within T-2h have stale odds');
    expect(result.reason).toContain('duplicate game_id rows ignored');
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
