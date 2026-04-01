'use strict';

/**
 * Tests for schedulers/player-props.js
 *
 * TDD: Written before implementation to define the contract.
 * All tests verify computePlayerPropsDueJobs behavior, key formats, and feature flags.
 */

const { DateTime } = require('luxon');

// Mock all job execute functions before requiring the module under test
jest.mock('../../jobs/sync_nhl_sog_player_ids', () => ({
  syncNhlSogPlayerIds: jest.fn(),
}));
jest.mock('../../jobs/sync_nhl_blk_player_ids', () => ({
  syncNhlBlkPlayerIds: jest.fn(),
}));
jest.mock('../../jobs/pull_nhl_player_blk', () => ({
  pullNhlPlayerBlk: jest.fn(),
}));
jest.mock('../../jobs/ingest_nst_blk_rates', () => ({
  ingestNstBlkRates: jest.fn(),
}));
jest.mock('../../jobs/pull_nhl_player_shots_props', () => ({
  pullNhlPlayerShotsProps: jest.fn(),
}));
jest.mock('../../jobs/run_nhl_player_shots_model', () => ({
  runNHLPlayerShotsModel: jest.fn(),
}));
jest.mock('../../jobs/pull_mlb_pitcher_stats', () => ({
  pullMlbPitcherStats: jest.fn(),
}));
jest.mock('../../jobs/pull_mlb_weather', () => ({
  pullMlbWeather: jest.fn(),
}));
jest.mock('../../jobs/run_mlb_prop_pipeline', () => ({
  runMlbPropPipeline: jest.fn(),
}));

const {
  computePlayerPropsDueJobs,
  keyNhlFixed,
  keyNhlTminus,
  keyNhlBlkIngest,
  keyMlbFixed,
  keyMlbTminus,
} = require('../player-props');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ET_ZONE = 'America/New_York';

/**
 * Create a Luxon DateTime in ET at a specific time on 2026-03-28.
 * @param {string} hhmm - e.g. "09:00"
 * @returns {DateTime}
 */
function makeNowEt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromObject(
    { year: 2026, month: 3, day: 28, hour: h, minute: m, second: 0 },
    { zone: ET_ZONE },
  );
}

/**
 * Create a mock game object.
 * @param {string} sport - 'nhl' or 'mlb'
 * @param {number} minsFromNow - how many minutes from nowUtc the game starts (positive = future)
 * @param {DateTime} nowEt - reference time in ET
 * @returns {object}
 */
function makeGame(sport, minsFromNow, nowEt) {
  const nowUtc = nowEt.toUTC();
  const startUtc = nowUtc.plus({ minutes: minsFromNow });
  return {
    game_id: `${sport}_game_${minsFromNow}`,
    sport,
    game_time_utc: startUtc.toISO(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computePlayerPropsDueJobs', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Default: FIXED_CATCHUP=false so isFixedDue fires only within the window tolerance
    process.env.FIXED_CATCHUP = 'false';
    // Large tick so the 2×TICK_MS window is wide enough to fire
    process.env.TICK_MS = '120000';
    // Clear all feature flags to defaults
    delete process.env.ENABLE_PLAYER_PROPS_SCHEDULER;
    delete process.env.ENABLE_NHL_BLK_INGEST;
    delete process.env.PLAYER_PROPS_FIXED_TIMES_ET;
    process.env.NHL_SOG_PROP_EVENTS_ENABLED = 'true';
    process.env.NHL_1P_ODDS_ENABLED = 'true';
    process.env.MLB_PITCHER_K_PROP_EVENTS_ENABLED = 'true';
    process.env.PITCHER_KS_MODEL_MODE = 'ODDS_BACKED';
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ─── Feature flag: entire scheduler off ──────────────────────────────────

  describe('ENABLE_PLAYER_PROPS_SCHEDULER=false', () => {
    it('returns empty array', () => {
      process.env.ENABLE_PLAYER_PROPS_SCHEDULER = 'false';
      const nowEt = makeNowEt('09:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });
      expect(result).toEqual([]);
    });
  });

  describe('default conservative posture', () => {
    it('does not queue NHL player-prop jobs when NHL prop env flags are not explicitly enabled', () => {
      delete process.env.NHL_SOG_PROP_EVENTS_ENABLED;
      delete process.env.NHL_1P_ODDS_ENABLED;

      const nowEt = makeNowEt('09:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });
      const jobNames = result.map((j) => j.jobName);

      expect(jobNames).not.toContain('sync_nhl_sog_player_ids');
      expect(jobNames).not.toContain('pull_nhl_player_shots_props');
      expect(jobNames).not.toContain('pull_nhl_1p_odds');
      expect(jobNames).not.toContain('run_nhl_player_shots_model');
    });
  });

  // ─── 09:00 ET fixed window ────────────────────────────────────────────────

  describe('09:00 ET fixed window', () => {
    it('NHL: queues sync_nhl_sog_player_ids, BLK ingest chain, pull_nhl_player_shots_props, run_nhl_player_shots_model in order', () => {
      const nowEt = makeNowEt('09:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('sync_nhl_sog_player_ids');
      expect(jobNames).toContain('sync_nhl_blk_player_ids');
      expect(jobNames).toContain('pull_nhl_player_blk');
      expect(jobNames).toContain('ingest_nst_blk_rates');
      expect(jobNames).toContain('pull_nhl_player_shots_props');
      expect(jobNames).toContain('run_nhl_player_shots_model');

      // Verify ordering: SOG sync before BLK jobs before shots prop/model
      const sogIdx = jobNames.indexOf('sync_nhl_sog_player_ids');
      const blkIdx = jobNames.indexOf('sync_nhl_blk_player_ids');
      const shotsPropsIdx = jobNames.indexOf('pull_nhl_player_shots_props');
      const shotsModelIdx = jobNames.indexOf('run_nhl_player_shots_model');
      expect(sogIdx).toBeLessThan(blkIdx);
      expect(blkIdx).toBeLessThan(shotsPropsIdx);
      expect(shotsPropsIdx).toBeLessThan(shotsModelIdx);
    });

    it('MLB: queues pull_mlb_pitcher_stats, pull_mlb_weather, run_mlb_prop_pipeline(window=MORNING)', () => {
      const nowEt = makeNowEt('09:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('pull_mlb_pitcher_stats');
      expect(jobNames).toContain('pull_mlb_weather');
      expect(jobNames).toContain('run_mlb_prop_pipeline');
      expect(jobNames).not.toContain('pull_mlb_pitcher_strikeout_props');
      expect(jobNames).not.toContain('run_mlb_model');

      // pitcher_stats and weather come before pipeline
      const statsIdx = jobNames.indexOf('pull_mlb_pitcher_stats');
      const weatherIdx = jobNames.indexOf('pull_mlb_weather');
      const pipelineIdx = jobNames.indexOf('run_mlb_prop_pipeline');
      expect(statsIdx).toBeLessThan(pipelineIdx);
      expect(weatherIdx).toBeLessThan(pipelineIdx);

      const pipelineJob = result.find((j) => j.jobName === 'run_mlb_prop_pipeline');
      expect(pipelineJob.args.window).toBe('MORNING');
    });

    it('ENABLE_NHL_BLK_INGEST=false: BLK jobs absent, SOG jobs present', () => {
      process.env.ENABLE_NHL_BLK_INGEST = 'false';
      const nowEt = makeNowEt('09:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).not.toContain('sync_nhl_blk_player_ids');
      expect(jobNames).not.toContain('pull_nhl_player_blk');
      expect(jobNames).not.toContain('ingest_nst_blk_rates');

      expect(jobNames).toContain('sync_nhl_sog_player_ids');
      expect(jobNames).toContain('pull_nhl_player_shots_props');
      expect(jobNames).toContain('run_nhl_player_shots_model');
    });
  });

  // ─── 15:00 ET fixed window ────────────────────────────────────────────────

  describe('15:00 ET fixed window', () => {
    it('NHL: only pull_nhl_player_shots_props + run_nhl_player_shots_model (no sync, no BLK)', () => {
      const nowEt = makeNowEt('15:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('pull_nhl_player_shots_props');
      expect(jobNames).toContain('run_nhl_player_shots_model');

      // No heavy ingest at 15:00
      expect(jobNames).not.toContain('sync_nhl_sog_player_ids');
      expect(jobNames).not.toContain('sync_nhl_blk_player_ids');
      expect(jobNames).not.toContain('pull_nhl_player_blk');
      expect(jobNames).not.toContain('ingest_nst_blk_rates');
    });

    it('MLB: only run_mlb_prop_pipeline(window=MIDDAY) (no pitcher stats, no weather)', () => {
      const nowEt = makeNowEt('15:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('run_mlb_prop_pipeline');

      expect(jobNames).not.toContain('pull_mlb_pitcher_stats');
      expect(jobNames).not.toContain('pull_mlb_weather');

      const pipelineJob = result.find((j) => j.jobName === 'run_mlb_prop_pipeline');
      expect(pipelineJob.args.window).toBe('MIDDAY');
    });
  });

  // ─── T-60 per game ────────────────────────────────────────────────────────

  describe('T-60 per game', () => {
    it('NHL game at T-60: queues pull_nhl_player_shots_props + run_nhl_player_shots_model', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('nhl', 58, nowEt)]; // within [55,60] band

      // Use FIXED_CATCHUP=true so fixed windows don't fire (15:00 is past 09:00)
      // We want only T-60 games to trigger
      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00'; // disable fixed windows
      const result = computePlayerPropsDueJobs(nowEt, { games, dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('pull_nhl_player_shots_props');
      expect(jobNames).toContain('run_nhl_player_shots_model');
      // No heavy ingest at T-60
      expect(jobNames).not.toContain('sync_nhl_sog_player_ids');
      expect(jobNames).not.toContain('sync_nhl_blk_player_ids');
    });

    it('MLB game at T-60: queues one run_mlb_prop_pipeline job with scoped gameIds', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('mlb', 57, nowEt)]; // within [55,60] band

      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00'; // disable fixed windows
      const result = computePlayerPropsDueJobs(nowEt, { games, dryRun: false });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('run_mlb_prop_pipeline');
      expect(jobNames).not.toContain('pull_mlb_pitcher_stats');
      expect(jobNames).not.toContain('pull_mlb_weather');

      const pipelineJob = result.find((j) => j.jobName === 'run_mlb_prop_pipeline');
      expect(pipelineJob.args).toMatchObject({ window: 'T60', gameIds: ['mlb_game_57'] });
    });

    it('T-120 game: no player-prop jobs returned', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('nhl', 118, nowEt)]; // within [115,120] band

      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00';
      const result = computePlayerPropsDueJobs(nowEt, { games, dryRun: false });
      expect(result).toHaveLength(0);
    });

    it('T-90 game: no player-prop jobs returned', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('nhl', 87, nowEt)]; // within [85,90] band

      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00';
      const result = computePlayerPropsDueJobs(nowEt, { games, dryRun: false });
      expect(result).toHaveLength(0);
    });

    it('T-30 game: no player-prop jobs returned', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('nhl', 27, nowEt)]; // within [25,30] band

      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00';
      const result = computePlayerPropsDueJobs(nowEt, { games, dryRun: false });
      expect(result).toHaveLength(0);
    });
  });

  describe('quota tier gating', () => {
    it('MEDIUM tier still queues the MLB pipeline and leaves candidate selection to the pipeline budget controller', () => {
      const nowEt = makeNowEt('15:00');
      const result = computePlayerPropsDueJobs(nowEt, {
        games: [],
        dryRun: false,
        quotaTier: 'MEDIUM',
      });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).toContain('run_mlb_prop_pipeline');
    });

    it('MEDIUM tier suppresses MLB T-60 prop pipeline jobs', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('mlb', 57, nowEt)];
      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00';

      const result = computePlayerPropsDueJobs(nowEt, {
        games,
        dryRun: false,
        quotaTier: 'MEDIUM',
      });

      const jobNames = result.map((j) => j.jobName);
      expect(jobNames).not.toContain('run_mlb_prop_pipeline');
    });
  });

  // ─── Idempotency keys ────────────────────────────────────────────────────

  describe('idempotency keys', () => {
    it('NHL fixed key format: player_props|nhl|fixed|YYYY-MM-DD|HH:MM', () => {
      const key = keyNhlFixed('2026-03-28', '09:00');
      expect(key).toBe('player_props|nhl|fixed|2026-03-28|09:00');
    });

    it('NHL T-60 key format: player_props|nhl|tminus|<game_id>|T60', () => {
      const key = keyNhlTminus('nhl_game_12345');
      expect(key).toBe('player_props|nhl|tminus|nhl_game_12345|T60');
    });

    it('BLK ingest daily key: player_props|nhl_blk_ingest|daily|YYYY-MM-DD', () => {
      const key = keyNhlBlkIngest('2026-03-28');
      expect(key).toBe('player_props|nhl_blk_ingest|daily|2026-03-28');
    });

    it('MLB fixed key format: player_props|mlb|fixed|YYYY-MM-DD|HH:MM', () => {
      const key = keyMlbFixed('2026-03-28', '15:00');
      expect(key).toBe('player_props|mlb|fixed|2026-03-28|15:00');
    });

    it('MLB T-60 key format: player_props|mlb|tminus|<game_id>|T60', () => {
      const key = keyMlbTminus('mlb_game_67890');
      expect(key).toBe('player_props|mlb|tminus|mlb_game_67890|T60');
    });

    it('keys in 09:00 NHL jobs use correct format', () => {
      const nowEt = makeNowEt('09:00');
      const result = computePlayerPropsDueJobs(nowEt, { games: [], dryRun: false });
      // SOG player sync key
      const sogJob = result.find((j) => j.jobName === 'sync_nhl_sog_player_ids');
      expect(sogJob).toBeDefined();
      expect(sogJob.jobKey).toMatch(/^player_props\|nhl\|fixed\|2026-03-28\|09:00/);

      // BLK daily key
      const blkSyncJob = result.find((j) => j.jobName === 'sync_nhl_blk_player_ids');
      expect(blkSyncJob).toBeDefined();
      expect(blkSyncJob.jobKey).toBe('player_props|nhl_blk_ingest|daily|2026-03-28');
    });

    it('MLB T-60 key contains game_id and T60', () => {
      const nowEt = makeNowEt('15:00');
      const games = [makeGame('mlb', 57, nowEt)];
      process.env.PLAYER_PROPS_FIXED_TIMES_ET = '99:00';
      const result = computePlayerPropsDueJobs(nowEt, { games, dryRun: false });

      const pipelineJob = result.find((j) => j.jobName === 'run_mlb_prop_pipeline');
      expect(pipelineJob).toBeDefined();
      expect(pipelineJob.jobKey).toMatch(/^player_props\|mlb\|tminus\|mlb_game_57\|T60/);
    });
  });
});
