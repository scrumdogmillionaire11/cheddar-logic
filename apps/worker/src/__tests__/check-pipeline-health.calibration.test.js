'use strict';

/**
 * WI-0861: checkCalibrationKillSwitches — pipeline health section
 */

describe('checkCalibrationKillSwitches', () => {
  let checkCalibrationKillSwitches;
  let pipelineWrites;
  let calibrationRows;

  beforeEach(() => {
    jest.resetModules();
    pipelineWrites = [];
    calibrationRows = [];

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return { run: (...args) => { pipelineWrites.push(args); } };
        }
        if (sql.includes('FROM calibration_reports')) {
          return { all: () => calibrationRows };
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
      wasJobRecentlySuccessful: jest.fn(() => false),
      v4: jest.fn(() => 'test-uuid'),
    }));

    // Stub dependencies not under test
    jest.doMock('../jobs/run_mlb_model', () => ({ buildMlbMarketAvailability: jest.fn() }));
    jest.doMock('../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../jobs/post_discord_cards', () => ({ sendDiscordMessages: jest.fn() }));

    ({ checkCalibrationKillSwitches } = require('../jobs/check_pipeline_health'));
  });

  test('returns ok=false and flags CALIB_KILL_SWITCH_ACTIVE when any market is active', () => {
    calibrationRows = [
      { market: 'NBA_TOTAL', kill_switch_active: 1, ece: 0.09, n_samples: 72, computed_at: '2026-04-10T04:00:00Z' },
      { market: 'NHL_TOTAL', kill_switch_active: 0, ece: 0.04, n_samples: 85, computed_at: '2026-04-10T04:00:00Z' },
    ];

    const result = checkCalibrationKillSwitches();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('CALIB_KILL_SWITCH_ACTIVE');
    expect(result.reason).toContain('NBA_TOTAL');
    expect(result.calibrationKillSwitches).toHaveLength(1);
    expect(result.calibrationKillSwitches[0].market).toBe('NBA_TOTAL');
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][0]).toBe('calibration');
    expect(pipelineWrites[0][1]).toBe('kill_switch');
    expect(pipelineWrites[0][2]).toBe('warning');
  });

  test('returns ok=true and empty array when all markets are healthy', () => {
    calibrationRows = [
      { market: 'NBA_TOTAL', kill_switch_active: 0, ece: 0.04, n_samples: 80, computed_at: '2026-04-10T04:00:00Z' },
      { market: 'NHL_TOTAL', kill_switch_active: 0, ece: 0.03, n_samples: 95, computed_at: '2026-04-10T04:00:00Z' },
    ];

    const result = checkCalibrationKillSwitches();

    expect(result.ok).toBe(true);
    expect(result.calibrationKillSwitches).toEqual([]);
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('returns ok=true and skips gracefully when calibration_reports table is absent', () => {
    // Simulate missing table by throwing on prepare
    jest.resetModules();
    const db = {
      prepare: jest.fn(() => {
        throw new Error('no such table: calibration_reports');
      }),
    };
    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));
    jest.doMock('../jobs/run_mlb_model', () => ({ buildMlbMarketAvailability: jest.fn() }));
    jest.doMock('../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../jobs/post_discord_cards', () => ({ sendDiscordMessages: jest.fn() }));

    ({ checkCalibrationKillSwitches } = require('../jobs/check_pipeline_health'));

    const result = checkCalibrationKillSwitches();

    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/absent|skipped/i);
    expect(result.calibrationKillSwitches).toEqual([]);
    // No pipeline_health write expected when table is absent
  });

  test('returns ok=true with explanatory reason when calibration_reports is empty', () => {
    calibrationRows = [];

    const result = checkCalibrationKillSwitches();

    expect(result.ok).toBe(true);
    expect(result.calibrationKillSwitches).toEqual([]);
    // No pipeline_health write when no rows
    expect(pipelineWrites).toHaveLength(0);
  });
});
