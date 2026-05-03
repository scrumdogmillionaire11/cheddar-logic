'use strict';

/**
 * WI-0846: checkWatchdogHeartbeat — self-check for check_pipeline_health gap
 * WI-1182: Discord suppression/emission for feature-disabled SOG sync and odds remediation paths
 */

const { DateTime } = require('luxon');

describe('checkWatchdogHeartbeat', () => {
  let checkWatchdogHeartbeat;
  let pipelineWrites;
  let jobRunsRow;
  let sendDiscordMessages;

  beforeEach(() => {
    jest.resetModules();
    pipelineWrites = [];
    jobRunsRow = null;
    sendDiscordMessages = jest.fn().mockResolvedValue(undefined);

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return {
            run: (...args) => {
              pipelineWrites.push(args);
            },
          };
        }

        if (sql.includes('FROM job_runs') && sql.includes("job_name = 'check_pipeline_health'")) {
          return { get: () => jobRunsRow };
        }

        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));

    jest.doMock('../run_mlb_model', () => ({ buildMlbMarketAvailability: jest.fn() }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages }));

    ({ checkWatchdogHeartbeat } = require('../check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('3h gap → writes warning heartbeat row and sends Discord alert', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    jobRunsRow = { started_at: threeHoursAgo };
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkWatchdogHeartbeat();

    expect(pipelineWrites).toHaveLength(2);
    const heartbeatWrites = pipelineWrites.filter(
      ([phase, checkName]) => phase === 'watchdog' && checkName === 'heartbeat',
    );
    expect(heartbeatWrites).toHaveLength(1);

    const [phase, checkName, status, reason] = heartbeatWrites[0];
    expect(phase).toBe('watchdog');
    expect(checkName).toBe('heartbeat');
    expect(status).toBe('warning');
    expect(reason).toMatch(/3\.0h ago/);

    const alertDeliveryWrites = pipelineWrites.filter(
      ([phase, checkName]) => phase === 'watchdog' && checkName === 'alert_delivery',
    );
    expect(alertDeliveryWrites).toHaveLength(1);
    expect(alertDeliveryWrites[0][2]).toBe('ok');

    expect(sendDiscordMessages).toHaveBeenCalledTimes(1);
    const call = sendDiscordMessages.mock.calls[0][0];
    expect(call.messages[0]).toMatch(/3\.0h/);
  });

  test('30m gap → writes ok heartbeat row and does not send Discord alert', async () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    jobRunsRow = { started_at: thirtyMinutesAgo };
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkWatchdogHeartbeat();

    expect(pipelineWrites).toHaveLength(1);
    const [phase, checkName, status, reason] = pipelineWrites[0];
    expect(phase).toBe('watchdog');
    expect(checkName).toBe('heartbeat');
    expect(status).toBe('ok');
    expect(reason).toMatch(/Heartbeat OK/);

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('no prior run → skips heartbeat write entirely', async () => {
    jobRunsRow = null;

    await checkWatchdogHeartbeat();

    expect(pipelineWrites).toHaveLength(0);
    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });

  test('3h gap but watchdog disabled → writes warning row, no Discord alert', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    jobRunsRow = { started_at: threeHoursAgo };
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'false';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkWatchdogHeartbeat();

    expect(pipelineWrites[0][2]).toBe('warning');
    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// WI-1182: Discord suppression / emission for SOG sync feature gate + odds remediation
// ===========================================================================

/**
 * Minimal DB factory that returns sensible defaults for all pipeline-health SQL queries.
 * pipelineRowsByCheck: Map of "<phase>|<check_name>" → rows[] for shouldSendAlert queries.
 */
function makeFullDb({
  pipelineRowsByCheck = {},
  scheduleCount = 5,
  backlogCount = 0,
  upcomingGames = [],
  latestOddsByGameRef = {},
} = {}) {
  return {
    prepare: jest.fn((sql) => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.includes('INSERT INTO pipeline_health')) {
        return { run: jest.fn() };
      }

      // shouldSendAlert — keyed by most recent phase/check query context.
      // We return based on the first argument pair.
      if (s.includes('FROM pipeline_health') && s.includes('ORDER BY created_at')) {
        return {
          all: jest.fn((phase, checkName) => {
            const key = `${phase}|${checkName}`;
            return pipelineRowsByCheck[key] || [];
          }),
        };
      }

      if (
        s.includes('FROM games g') &&
        s.includes('LEFT JOIN card_payloads cp') &&
        s.includes('FROM odds_snapshots o')
      ) {
        return { all: jest.fn(() => []) };
      }

      if (s.includes('FROM games g') && s.includes('NOT EXISTS')) {
        return { get: jest.fn(() => ({ cnt: backlogCount })) };
      }

      if (s.includes('COUNT(*)') && s.includes('FROM games')) {
        return { get: jest.fn(() => ({ cnt: scheduleCount })) };
      }

      if (s.includes('FROM odds_snapshots') && s.includes('WHERE game_id = ?')) {
        return { get: jest.fn((gameId) => latestOddsByGameRef[gameId] ?? null) };
      }

      if (s.includes('FROM games') && s.includes('game_time_utc')) {
        return { all: jest.fn(() => upcomingGames) };
      }

      if (s.includes('FROM job_runs') && s.includes("status = 'success'")) {
        return { get: jest.fn(() => null) };
      }

      if (s.includes('FROM card_payloads')) {
        return { get: jest.fn(() => null), all: jest.fn(() => []) };
      }

      if (s.includes('FROM calibration_reports')) {
        return { all: jest.fn(() => []) };
      }

      return { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn() };
    }),
  };
}

function freshFailedPipelineRows(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    status: 'failed',
    created_at: DateTime.utc().minus({ minutes: 2 + i }).toISO(),
  }));
}

describe('WI-1182: Discord suppression for feature-disabled SOG sync', () => {
  let checkPipelineHealth;
  let sendDiscordMessages;

  beforeEach(() => {
    jest.resetModules();
    sendDiscordMessages = jest.fn().mockResolvedValue(undefined);

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => makeFullDb({ scheduleCount: 5 })),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({ f5_line_ok: true, full_game_total_ok: true, expect_f5_ml: false, f5_ml_ok: true })),
    }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../refresh_stale_odds', () => ({
      refreshStaleOdds: jest.fn().mockResolvedValue({ success: true, staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 } }),
    }));
    // sog-sync feature is DISABLED → checkNhlSogSyncFreshness returns ok
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({ checkPipelineHealth } = require('../check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('feature disabled → sog_sync_freshness returns ok → no Discord alert for that check', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkPipelineHealth({ jobKey: 'test-1182-disabled', dryRun: false });

    // No failed checks → no Discord
    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });
});

describe('WI-1182: Discord emission for true stale-sync-risk (feature enabled)', () => {
  let checkPipelineHealth;
  let sendDiscordMessages;

  beforeEach(() => {
    jest.resetModules();
    sendDiscordMessages = jest.fn().mockResolvedValue(undefined);

    const staleSyncRows = freshFailedPipelineRows(3);
    const dbInstance = makeFullDb({
      scheduleCount: 5,
      pipelineRowsByCheck: { 'nhl|sog_sync_freshness': staleSyncRows },
      upcomingGames: [
        { game_id: 'nhl-001', sport: 'NHL', game_time_utc: DateTime.utc().plus({ hours: 3 }).toISO() },
      ],
    });

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => dbInstance),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      // sync job NOT recently successful → stale
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({ f5_line_ok: true, full_game_total_ok: true, expect_f5_ml: false, f5_ml_ok: true })),
    }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../refresh_stale_odds', () => ({
      refreshStaleOdds: jest.fn().mockResolvedValue({ success: true, staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 } }),
    }));
    // sog-sync feature is ENABLED → real staleness check fires
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => true),
    }));

    ({ checkPipelineHealth } = require('../check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('feature enabled + stale sync → Discord emitted with at-risk reason', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkPipelineHealth({ jobKey: 'test-1182-stale-sync', dryRun: false });

    expect(sendDiscordMessages).toHaveBeenCalledTimes(1);
    const message = sendDiscordMessages.mock.calls[0][0].messages[0];
    expect(message).toContain('sog_sync_freshness');
    expect(message).toContain('has NOT run successfully');
  });
});

describe('WI-1182: Discord suppression when odds freshness remediation succeeds', () => {
  let checkPipelineHealth;
  let sendDiscordMessages;
  let latestOddsByGameRef;

  beforeEach(() => {
    jest.resetModules();
    sendDiscordMessages = jest.fn().mockResolvedValue(undefined);
    latestOddsByGameRef = {};

    const now = DateTime.utc();
    const upcomingGames = [
      {
        game_id: 'nba-remedy-001',
        sport: 'NBA',
        away_team: 'TeamA',
        home_team: 'TeamB',
        game_time_utc: now.plus({ minutes: 25 }).toISO(),
      },
    ];

    // Start stale; refreshStaleOdds will make it fresh via the ref object
    latestOddsByGameRef['nba-remedy-001'] = { captured_at: now.minus({ minutes: 200 }).toISO() };
    const dbInstance = makeFullDb({ scheduleCount: 5, upcomingGames, latestOddsByGameRef });

    const refreshStaleOddsMock = jest.fn().mockImplementation(async () => {
      latestOddsByGameRef['nba-remedy-001'] = { captured_at: now.minus({ minutes: 2 }).toISO() };
      return { success: true, staleDiagnostics: { detected: 1, refreshed: 1, blocked: 0 } };
    });

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => dbInstance),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({ f5_line_ok: true, full_game_total_ok: true, expect_f5_ml: false, f5_ml_ok: true })),
    }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../refresh_stale_odds', () => ({ refreshStaleOdds: refreshStaleOddsMock }));
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({ checkPipelineHealth } = require('../check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('odds freshness remediation succeeds → check returns ok → no Discord alert', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkPipelineHealth({ jobKey: 'test-1182-remedy-ok', dryRun: false });

    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });
});

describe('WI-1182: Discord emission with remediation summary when odds remain stale after remediation', () => {
  let checkPipelineHealth;
  let sendDiscordMessages;

  beforeEach(() => {
    jest.resetModules();
    sendDiscordMessages = jest.fn().mockResolvedValue(undefined);

    const now = DateTime.utc();
    const staleOdds = { captured_at: now.minus({ minutes: 200 }).toISO() };
    const upcomingGames = [
      {
        game_id: 'nba-still-stale-001',
        sport: 'NBA',
        away_team: 'TeamC',
        home_team: 'TeamD',
        game_time_utc: now.plus({ minutes: 25 }).toISO(),
      },
    ];
    const latestOddsByGameRef = { 'nba-still-stale-001': staleOdds };

    const staleFreshnessRows = freshFailedPipelineRows(3);
    const dbInstance = makeFullDb({
      scheduleCount: 5,
      upcomingGames,
      latestOddsByGameRef,
      pipelineRowsByCheck: { 'odds|freshness': staleFreshnessRows },
    });

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => dbInstance),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({ f5_line_ok: true, full_game_total_ok: true, expect_f5_ml: false, f5_ml_ok: true })),
    }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    // Remediation runs but doesn't fix the game (odds still stale in DB)
    jest.doMock('../refresh_stale_odds', () => ({
      refreshStaleOdds: jest.fn().mockResolvedValue({
        success: true,
        staleDiagnostics: { detected: 1, refreshed: 0, blocked: 1 },
      }),
    }));
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({ checkPipelineHealth } = require('../check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('odds still stale after remediation → Discord emitted with concise remediation summary', async () => {
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkPipelineHealth({ jobKey: 'test-1182-still-stale', dryRun: false });

    expect(sendDiscordMessages).toHaveBeenCalledTimes(1);
    const message = sendDiscordMessages.mock.calls[0][0].messages[0];
    expect(message).toContain('odds');
    expect(message).toContain('freshness');
    expect(message).toContain('remediation');
  });
});

describe('WI-1193: degraded-state persistence', () => {
  let checkPipelineHealth;
  let pipelineWrites;

  beforeEach(() => {
    jest.resetModules();
    pipelineWrites = [];

    const dbInstance = makeFullDb({ scheduleCount: 5 });
    const basePrepare = dbInstance.prepare;
    dbInstance.prepare = jest.fn((sql) => {
      if (sql.includes('INSERT INTO pipeline_health')) {
        return {
          run: (...args) => {
            pipelineWrites.push(args);
          },
        };
      }
      return basePrepare(sql);
    });

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => dbInstance),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages: jest.fn().mockResolvedValue(undefined) }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({ f5_line_ok: true, full_game_total_ok: true, expect_f5_ml: false, f5_ml_ok: true })),
    }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../refresh_stale_odds', () => ({
      refreshStaleOdds: jest.fn().mockResolvedValue({ success: true, staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 } }),
    }));
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({ checkPipelineHealth } = require('../check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('writes watchdog/degraded_state=ok when all checks pass', async () => {
    await checkPipelineHealth({ jobKey: 'wi-1193-healthy', dryRun: false });

    const degradedRows = pipelineWrites.filter(
      ([phase, checkName]) => phase === 'watchdog' && checkName === 'degraded_state',
    );
    expect(degradedRows).toHaveLength(1);
    expect(degradedRows[0][2]).toBe('ok');
    expect(degradedRows[0][3]).toContain('all checks passed');
  });

  test('writes watchdog/degraded_state=failed with failing check names when any check fails', async () => {
    const failingDb = makeFullDb({ scheduleCount: 0 });
    const basePrepare = failingDb.prepare;
    failingDb.prepare = jest.fn((sql) => {
      if (sql.includes('INSERT INTO pipeline_health')) {
        return {
          run: (...args) => {
            pipelineWrites.push(args);
          },
        };
      }
      return basePrepare(sql);
    });

    jest.resetModules();
    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => failingDb),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => true),
    }));
    jest.doMock('../post_discord_cards', () => ({ sendDiscordMessages: jest.fn().mockResolvedValue(undefined) }));
    jest.doMock('../run_mlb_model', () => ({
      buildMlbMarketAvailability: jest.fn(() => ({ f5_line_ok: true, full_game_total_ok: true, expect_f5_ml: false, f5_ml_ok: true })),
    }));
    jest.doMock('../../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../refresh_stale_odds', () => ({
      refreshStaleOdds: jest.fn().mockResolvedValue({ success: true, staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 } }),
    }));
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({ checkPipelineHealth } = require('../check_pipeline_health'));

    await checkPipelineHealth({ jobKey: 'wi-1193-degraded', dryRun: false });

    const degradedRows = pipelineWrites.filter(
      ([phase, checkName]) => phase === 'watchdog' && checkName === 'degraded_state',
    );
    expect(degradedRows).toHaveLength(1);
    expect(degradedRows[0][2]).toBe('failed');
    expect(degradedRows[0][3]).toContain('Pipeline degraded');
    expect(degradedRows[0][3]).toContain('schedule:freshness:global');
  });
});
