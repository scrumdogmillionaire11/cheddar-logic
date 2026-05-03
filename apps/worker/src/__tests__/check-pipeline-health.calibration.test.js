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
    expect(result.calibrationRows).toHaveLength(2);
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
    expect(result.calibrationRows).toHaveLength(2);
    expect(result.reason).toContain('NBA_TOTAL(ECE=0.04,n=80,kill=0)');
    expect(result.reason).toContain('NHL_TOTAL(ECE=0.03,n=95,kill=0)');
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
    expect(result.calibrationRows).toEqual([]);
    // No pipeline_health write expected when table is absent
  });

  test('returns ok=true with explanatory reason when calibration_reports is empty', () => {
    calibrationRows = [];

    const result = checkCalibrationKillSwitches();

    expect(result.ok).toBe(true);
    expect(result.calibrationKillSwitches).toEqual([]);
    expect(result.calibrationRows).toEqual([]);
    // No pipeline_health write when no rows
    expect(pipelineWrites).toHaveLength(0);
  });

  test('returns ok=false and writes failed state for non-table calibration query errors', () => {
    jest.resetModules();
    pipelineWrites = [];
    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return { run: (...args) => { pipelineWrites.push(args); } };
        }
        if (sql.includes('FROM calibration_reports')) {
          throw new Error('database is locked');
        }
        throw new Error();
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

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/calibration_reports check failed/i);
  });
});

describe('visibility integrity health checks', () => {
  let checkVisibilityIntegrity;
  let checkPipelineHealth;
  let buildVisibilityIntegrityAlertMarker;
  let pipelineWrites;
  let visibilityRows;
  let insertJobRun;
  let markJobRunSuccess;

  beforeEach(() => {
    jest.resetModules();
    pipelineWrites = [];
    visibilityRows = [];
    insertJobRun = jest.fn(() => 1);
    markJobRunSuccess = jest.fn();

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return { run: (...args) => { pipelineWrites.push(args); } };
        }
        if (
          sql.includes('FROM card_payloads cp') &&
          sql.includes('LEFT JOIN card_display_log cdl ON cdl.pick_id = cp.id')
        ) {
          return { all: () => visibilityRows };
        }
        if (
          sql.includes('FROM pipeline_health') &&
          sql.includes('WHERE phase = ? AND check_name = ?')
        ) {
          return { all: () => [], get: () => null };
        }
        throw new Error(`Unhandled SQL in visibility test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      insertJobRun,
      markJobRunSuccess,
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
      writePipelineHealthState: null,
      buildPipelineHealthCheckId: null,
    }));

    jest.doMock('../jobs/run_mlb_model', () => ({ buildMlbMarketAvailability: jest.fn() }));
    jest.doMock('../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../jobs/post_discord_cards', () => ({ sendDiscordMessages: jest.fn() }));
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({
      buildVisibilityIntegrityAlertMarker,
      checkPipelineHealth,
      checkVisibilityIntegrity,
    } = require('../jobs/check_pipeline_health'));
  });

  test('returns ok=false, writes failed state, and emits marker when missing enrollment exists', () => {
    visibilityRows = [
      {
        card_id: 'card-miss-1',
        game_id: 'game-1',
        sport: 'nba',
        card_type: 'nba-model-output',
        card_title: 'Missing display log',
        created_at: '2026-05-03T11:30:00.000Z',
        payload_data: JSON.stringify({
          kind: 'PLAY',
          sport: 'NBA',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          price: -110,
          decision_v2: { official_status: 'PLAY' },
        }),
        display_log_pick_id: null,
        displayed_at: null,
      },
    ];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = checkVisibilityIntegrity({ lookbackHours: 24, sampleLimit: 5 });

    expect(result.ok).toBe(false);
    expect(result.missingEnrollmentCount).toBe(1);
    expect(result.sampleIds).toEqual(['card-miss-1']);
    expect(result.alertMarker).toBe(
      'VISIBILITY_INTEGRITY_ALERT count=1 lookback_hours=24 sample_ids=card-miss-1',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[check_pipeline_health] VISIBILITY_INTEGRITY_ALERT count=1 lookback_hours=24 sample_ids=card-miss-1',
    );
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][0]).toBe('cards');
    expect(pipelineWrites[0][1]).toBe('visibility_integrity');
    expect(pipelineWrites[0][2]).toBe('failed');

    warnSpy.mockRestore();
  });

  test('returns ok=true and stays quiet when no missing enrollment exists', () => {
    visibilityRows = [
      {
        card_id: 'card-enrolled-1',
        game_id: 'game-1',
        sport: 'nba',
        card_type: 'nba-model-output',
        card_title: 'Enrolled',
        created_at: '2026-05-03T11:30:00.000Z',
        payload_data: JSON.stringify({
          kind: 'PLAY',
          sport: 'NBA',
          market_type: 'MONEYLINE',
          selection: 'AWAY',
          price: 105,
          decision_v2: { official_status: 'LEAN' },
        }),
        display_log_pick_id: 'card-enrolled-1',
        displayed_at: '2026-05-03T11:31:00.000Z',
      },
    ];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = checkVisibilityIntegrity({ lookbackHours: 24, sampleLimit: 5 });

    expect(result.ok).toBe(true);
    expect(result.missingEnrollmentCount).toBe(0);
    expect(result.sampleIds).toEqual([]);
    expect(result.alertMarker).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][2]).toBe('ok');

    warnSpy.mockRestore();
  });

  test('builds deterministic alert markers', () => {
    expect(
      buildVisibilityIntegrityAlertMarker({
        count: 2,
        sampleIds: ['card-a', 'card-b'],
        lookbackHours: 12,
      }),
    ).toBe(
      'VISIBILITY_INTEGRITY_ALERT count=2 lookback_hours=12 sample_ids=card-a,card-b',
    );
  });

  test('returns top-level ok=false only for visibility integrity breaches', async () => {
    const result = await checkPipelineHealth({
      jobKey: 'test-job',
      dryRun: false,
      skipHeartbeat: true,
      checksOverride: {
        visibility_integrity: async () => ({
          ok: false,
          reason: '1 display-eligible row missing enrollment',
          missingEnrollmentCount: 1,
          sampleIds: ['card-miss-1'],
          diagnostics: null,
          alertMarker:
            'VISIBILITY_INTEGRITY_ALERT count=1 lookback_hours=24 sample_ids=card-miss-1',
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.allOk).toBe(false);
    expect(result.visibilityIntegrity).toMatchObject({
      missingEnrollmentCount: 1,
      sampleIds: ['card-miss-1'],
    });
    expect(insertJobRun).toHaveBeenCalled();
    expect(markJobRunSuccess).toHaveBeenCalled();
  });
});
