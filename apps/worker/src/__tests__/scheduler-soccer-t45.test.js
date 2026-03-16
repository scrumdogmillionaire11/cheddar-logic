const { DateTime } = require('luxon');

describe('scheduler soccer T-45 lineup checkpoint', () => {
  beforeEach(() => {
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'false';
    process.env.ENABLE_SOCCER_MODEL = 'true';
    process.env.ENABLE_SOCCER_T45_LINEUP_CHECK = 'true';
    process.env.SOCCER_LINEUP_T45_MIN = '40';
    process.env.SOCCER_LINEUP_T45_MAX = '45';
    process.env.FIXED_CATCHUP = 'false';
  });

  test('queues soccer T-45 model run when kickoff is inside lineup window', () => {
    jest.resetModules();
    const scheduler = require('../schedulers/main');

    const nowUtc = DateTime.fromISO('2026-03-16T12:00:00Z', { zone: 'utc' });
    const nowEt = nowUtc.setZone('America/New_York');
    const gameStartUtc = nowUtc.plus({ minutes: 43 }).toISO();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [
        {
          game_id: 'soccer-game-001',
          sport: 'SOCCER',
          game_time_utc: gameStartUtc,
        },
      ],
      dryRun: true,
    });

    const t45Job = dueJobs.find(
      (job) =>
        job.jobKey ===
          `soccer|tminus|soccer-game-001|${scheduler.SOCCER_LINEUP_T45_MINUTES}` &&
        job.jobName === 'run_soccer_model',
    );

    expect(t45Job).toBeDefined();
    const t45PropPullJob = dueJobs.find(
      (job) =>
        job.jobKey ===
          `soccer_props|soccer|tminus|soccer-game-001|${scheduler.SOCCER_LINEUP_T45_MINUTES}` &&
        job.jobName === 'pull_soccer_player_props',
    );
    expect(t45PropPullJob).toBeDefined();
    expect(dueJobs.indexOf(t45PropPullJob)).toBeLessThan(dueJobs.indexOf(t45Job));
    expect(t45Job.reason).toContain('soccer lineup checkpoint T-45');
  });

  test('does not queue soccer T-45 run when outside lineup window', () => {
    jest.resetModules();
    const scheduler = require('../schedulers/main');

    const nowUtc = DateTime.fromISO('2026-03-16T12:00:00Z', { zone: 'utc' });
    const nowEt = nowUtc.setZone('America/New_York');
    const gameStartUtc = nowUtc.plus({ minutes: 58 }).toISO();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [
        {
          game_id: 'soccer-game-002',
          sport: 'SOCCER',
          game_time_utc: gameStartUtc,
        },
      ],
      dryRun: true,
    });

    const t45Job = dueJobs.find(
      (job) =>
        job.jobKey ===
        `soccer|tminus|soccer-game-002|${scheduler.SOCCER_LINEUP_T45_MINUTES}`,
    );

    expect(t45Job).toBeUndefined();
  });

  test('queues soccer fixed-window prop ingest before fixed soccer model run', () => {
    jest.resetModules();
    const scheduler = require('../schedulers/main');

    const nowEt = DateTime.fromISO('2026-03-16T09:02:00', { zone: 'America/New_York' });
    const nowUtc = nowEt.setZone('utc');

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    const fixedModelJob = dueJobs.find(
      (job) => job.jobName === 'run_soccer_model' && job.jobKey === 'soccer|fixed|2026-03-16|0900',
    );
    const fixedPropPullJob = dueJobs.find(
      (job) =>
        job.jobName === 'pull_soccer_player_props' &&
        job.jobKey === 'soccer_props|soccer|fixed|2026-03-16|0900',
    );

    expect(fixedModelJob).toBeDefined();
    expect(fixedPropPullJob).toBeDefined();
    expect(dueJobs.indexOf(fixedPropPullJob)).toBeLessThan(dueJobs.indexOf(fixedModelJob));
  });
});
