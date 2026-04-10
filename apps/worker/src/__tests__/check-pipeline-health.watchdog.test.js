'use strict';

/**
 * WI-0846: checkWatchdogHeartbeat — self-check for check_pipeline_health gap
 */

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
          return { run: (...args) => { pipelineWrites.push(args); } };
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

    jest.doMock('../jobs/run_mlb_model', () => ({ buildMlbMarketAvailability: jest.fn() }));
    jest.doMock('../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../jobs/post_discord_cards', () => ({ sendDiscordMessages }));

    ({ checkWatchdogHeartbeat } = require('../jobs/check_pipeline_health'));
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_CARD_WEBHOOK_URL;
  });

  test('3h gap → writes warning heartbeat row and sends Discord alert', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    jobRunsRow = { started_at: threeHoursAgo };
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_CARD_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkWatchdogHeartbeat();

    expect(pipelineWrites).toHaveLength(1);
    const [phase, checkName, status, reason] = pipelineWrites[0];
    expect(phase).toBe('watchdog');
    expect(checkName).toBe('heartbeat');
    expect(status).toBe('warning');
    expect(reason).toMatch(/3\.0h ago/);

    expect(sendDiscordMessages).toHaveBeenCalledTimes(1);
    const call = sendDiscordMessages.mock.calls[0][0];
    expect(call.messages[0]).toMatch(/3\.0h/);
  });

  test('30m gap → writes ok heartbeat row and does not send Discord alert', async () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    jobRunsRow = { started_at: thirtyMinutesAgo };
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
    process.env.DISCORD_CARD_WEBHOOK_URL = 'https://discord.example/webhook';

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
    process.env.DISCORD_CARD_WEBHOOK_URL = 'https://discord.example/webhook';

    await checkWatchdogHeartbeat();

    expect(pipelineWrites[0][2]).toBe('warning');
    expect(sendDiscordMessages).not.toHaveBeenCalled();
  });
});
