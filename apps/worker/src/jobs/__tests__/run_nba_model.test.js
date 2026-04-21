/**
 * Smoke Test — Run NBA Model Job
 *
 * Verifies:
 * 1. Job runs without error (exit code 0)
 * 2. job_runs table records job execution (status='success')
 * 3. model_outputs table has valid schema if any records exist
 * 4. card_payloads table stores generated cards if any passed threshold
 * 5. Cards expire before game time (if game_time_utc is set)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {getDatabase, closeDatabase, runMigrations } = require('@cheddar-logic/data');
const {
  generateNBAMarketCallCards,
  deriveExecutionStatusForCard,
  applyExecutionGateToNbaCard,
  extractNbaEspnNullMetricTeams,
  recordEspnNullTeams,
  sendEspnNullDiscordAlert,
  computeNbaRollingBias,
  applyNbaTeamContext,
  computeVolEnvSigmaMultipliers,
  applyVolEnvSigmaMultiplier,
  formatVolEnvSigmaLog,
  deriveVolEnv,
} = require('../run_nba_model');
const {
  publishDecisionForCard,
} = require('../../utils/decision-publisher');

const TEST_DB_PATH = '/tmp/cheddar-nba-test.db';

const baseOdds = {
  home_team: 'LAL',
  away_team: 'GSW',
  game_time_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  spread_home: -4.5,
  spread_away: 4.5,
  spread_price_home: -110,
  spread_price_away: -110,
  h2h_home: -180,
  h2h_away: 155,
  total: 224.5,
  total_price_over: -110,
  total_price_under: -110,
  captured_at: new Date().toISOString(),
};

function makeTotalDecision(overrides = {}) {
  return {
    status: 'FIRE',
    edge: 0.08,
    edge_points: 2.4,
    best_candidate: { side: 'OVER', line: 224.5 },
    drivers: [],
    reasoning: 'test reasoning',
    score: 0.7,
    net: 0.6,
    conflict: 0.1,
    coverage: 0.8,
    p_fair: 0.58,
    p_implied: 0.52,
    projection: { projected_total: 226.5 },
    line_source: 'odds_snapshot',
    price_source: 'odds_snapshot',
    ...overrides,
  };
}

async function queryDb(fn) {
  const db = getDatabase();
  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

describe('WI-1020: NBA rolling bias calibration', () => {
  function fakeBiasDb(row, sqlSink = []) {
    return {
      prepare: jest.fn((sql) => {
        sqlSink.push(sql);
        return { get: jest.fn(() => row) };
      }),
    };
  }

  test('computeNbaRollingBias returns computed mean error and enforces anti-leak query', () => {
    const sqlSeen = [];
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: 2.25, n: 50 }, sqlSeen),
      windowGames: 50,
      logger,
    });

    expect(result).toEqual({ bias: 2.25, games_sampled: 50, source: 'computed' });
    expect(sqlSeen[0]).toContain('settled_at < datetime(\'now\')');
    expect(sqlSeen[0]).toContain('ORDER BY settled_at DESC');
    expect(sqlSeen[0]).toContain('LIMIT 50');
    expect(sqlSeen[0]).toContain('raw_total');
    expect(sqlSeen[0]).toContain('actual_total');
    expect(sqlSeen[0]).not.toContain('created_at');
    expect(sqlSeen[0]).not.toContain('updated_at');
    expect(logger.log).toHaveBeenCalledWith(
      '[NBAModel] [BIAS_CORRECTION] rolling_bias=+2.3 games_sampled=50',
    );
  });

  test('computeNbaRollingBias hard-gates fallback when settled rows are below 50', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: 3.5, n: 49 }),
      logger,
    });

    expect(result).toEqual({ bias: 0, games_sampled: 49, source: 'fallback' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[NBAModel] [CALIBRATION_INACTIVE] 49 settled games - minimum 50 required before correction activates',
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('computeNbaRollingBias returns zero fallback when no settled rows exist', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: null, n: 0 }),
      logger,
    });

    expect(result).toEqual({ bias: 0, games_sampled: 0, source: 'fallback' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[NBAModel] [CALIBRATION_INACTIVE] 0 settled games - minimum 50 required before correction activates',
    );
  });

  test('computeNbaRollingBias clamps outlier correction to +/-4 points', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: 8, n: 50 }),
      logger,
    });

    expect(result).toEqual({ bias: 4, games_sampled: 50, source: 'computed' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[NBAModel] [BIAS_CORRECTION] bias_raw=8.0 clamped to +/-4.0 - investigate outlier',
    );
  });

  test('applyNbaTeamContext subtracts rolling bias before blending with market total', async () => {
    const oddsSnapshot = {
      home_team: 'Boston Celtics',
      away_team: 'Miami Heat',
      total: 220,
      raw_data: {},
    };
    const getTeamMetricsWithGamesFn = jest.fn(async (team) => ({
      metrics: team === 'Boston Celtics'
        ? { avgPoints: 120, avgPointsAllowed: 110 }
        : { avgPoints: 114, avgPointsAllowed: 106 },
      impactContext: null,
    }));

    const result = await applyNbaTeamContext('nba-bias-game', oddsSnapshot, {
      rollingBias: { bias: 4, games_sampled: 50, source: 'computed' },
      getTeamMetricsWithGamesFn,
    });

    expect(result.available).toBe(true);
    expect(result.rawPaceAnchorTotal).toBe(225);
    expect(result.paceAnchorTotal).toBe(221);
    expect(result.blendedTotal).toBe(220.25);
    expect(oddsSnapshot.raw_data).toMatchObject({
      pace_anchor_total_raw: 225,
      pace_anchor_total: 221,
      blended_total: 220.25,
      calibration_state: {
        bias: 4,
        games_sampled: 50,
        source: 'computed',
        correction_applied: true,
      },
    });
  });
});

describe('WI-1023: NBA Phase 2C — vol_env sigma multipliers', () => {
  function fakeVolEnvDb(rows) {
    return {
      prepare: jest.fn((sql) => ({
        all: jest.fn(() => sql.includes('GROUP BY vol_env') ? rows : []),
        get: jest.fn(() => {
          if (sql.includes('COUNT(*) AS n')) {
            return { n: rows[0]?.n ?? 0 };
          }
          return rows[0] ?? null;
        }),
      })),
    };
  }

  test('computeVolEnvSigmaMultipliers with all buckets empirical: returns ratios vs MED', () => {
    const rows = [
      { vol_env: 'HIGH', rmse: 4.33, n: 23 },
      { vol_env: 'MED', rmse: 3.33, n: 45 },
      { vol_env: 'LOW', rmse: 2.73, n: 18 },
    ];

    const result = computeVolEnvSigmaMultipliers({ db: fakeVolEnvDb(rows) });

    expect(result.mode).toBe('empirical');
    expect(result.multipliers.HIGH).toBeCloseTo(1.3, 1);
    expect(result.multipliers.MED).toBe(1);
    expect(result.multipliers.LOW).toBeCloseTo(0.82, 1);
    expect(result.sourceByBucket.HIGH).toBe('empirical');
    expect(result.sourceByBucket.MED).toBe('empirical');
    expect(result.sourceByBucket.LOW).toBe('empirical');
    expect(result.sampleByBucket).toEqual({ HIGH: 23, MED: 45, LOW: 18 });
  });

  test('computeVolEnvSigmaMultipliers with MED sparse: returns all fallback', () => {
    const rows = [
      { vol_env: 'HIGH', rmse: 4.5, n: 20 },
      { vol_env: 'LOW', rmse: 2.5, n: 20 },
    ];

    const result = computeVolEnvSigmaMultipliers({ db: fakeVolEnvDb(rows) });

    expect(result.mode).toBe('fallback');
    expect(result.multipliers).toEqual({ HIGH: 1.25, MED: 1.0, LOW: 0.85 });
    expect(result.sourceByBucket).toEqual({
      HIGH: 'fallback',
      MED: 'fallback',
      LOW: 'fallback',
    });
  });

  test('computeVolEnvSigmaMultipliers with HIGH missing: uses fallback for HIGH', () => {
    const rows = [
      { vol_env: 'MED', rmse: 3.5, n: 50 },
      { vol_env: 'LOW', rmse: 2.8, n: 20 },
    ];

    const result = computeVolEnvSigmaMultipliers({ db: fakeVolEnvDb(rows) });

    expect(result.mode).toBe('mixed');
    expect(result.multipliers.HIGH).toBe(1.25);
    expect(result.multipliers.MED).toBe(1);
    expect(result.multipliers.LOW).toBeCloseTo(0.8, 1);
    expect(result.sourceByBucket.HIGH).toBe('fallback');
    expect(result.sourceByBucket.MED).toBe('empirical');
    expect(result.sourceByBucket.LOW).toBe('empirical');
  });

  test('computeVolEnvSigmaMultipliers with LOW missing: uses fallback for LOW', () => {
    const rows = [
      { vol_env: 'HIGH', rmse: 4.2, n: 30 },
      { vol_env: 'MED', rmse: 3.0, n: 45 },
    ];

    const result = computeVolEnvSigmaMultipliers({ db: fakeVolEnvDb(rows) });

    expect(result.mode).toBe('mixed');
    expect(result.multipliers.HIGH).toBeCloseTo(1.4, 1);
    expect(result.multipliers.MED).toBe(1);
    expect(result.multipliers.LOW).toBe(0.85);
    expect(result.sourceByBucket.HIGH).toBe('empirical');
    expect(result.sourceByBucket.MED).toBe('empirical');
    expect(result.sourceByBucket.LOW).toBe('fallback');
  });

  test('computeVolEnvSigmaMultipliers clamps extreme ratios to [0.75, 1.5]', () => {
    const rows = [
      { vol_env: 'HIGH', rmse: 10, n: 20 },
      { vol_env: 'MED', rmse: 3, n: 50 },
      { vol_env: 'LOW', rmse: 0.5, n: 20 },
    ];

    const result = computeVolEnvSigmaMultipliers({ db: fakeVolEnvDb(rows) });

    expect(result.multipliers.HIGH).toBe(1.5);
    expect(result.multipliers.MED).toBe(1);
    expect(result.multipliers.LOW).toBe(0.75);
  });

  test('formatVolEnvSigmaLog renders empirical config', () => {
    const config = {
      mode: 'empirical',
      multipliers: { HIGH: 1.3, MED: 1.0, LOW: 0.82 },
      sourceByBucket: { HIGH: 'empirical', MED: 'empirical', LOW: 'empirical' },
      sampleByBucket: { HIGH: 23, MED: 45, LOW: 18 },
    };

    const log = formatVolEnvSigmaLog(config);

    expect(log).toContain('[NBAModel] [VOL_ENV_SIGMA]');
    expect(log).toContain('HIGH=1.30x(n=23,empirical)');
    expect(log).toContain('MED=1.00x(n=45,empirical)');
    expect(log).toContain('LOW=0.82x(n=18,empirical)');
  });

  test('formatVolEnvSigmaLog renders mixed config', () => {
    const config = {
      mode: 'mixed',
      multipliers: { HIGH: 1.25, MED: 1.0, LOW: 0.8 },
      sourceByBucket: { HIGH: 'fallback', MED: 'empirical', LOW: 'empirical' },
      sampleByBucket: { HIGH: null, MED: 50, LOW: 20 },
    };

    const log = formatVolEnvSigmaLog(config);

    expect(log).toContain('HIGH=1.25x(fallback)');
    expect(log).toContain('MED=1.00x(n=50,empirical)');
    expect(log).toContain('LOW=0.80x(n=20,empirical)');
  });

  test('formatVolEnvSigmaLog renders fallback config', () => {
    const config = {
      mode: 'fallback',
      multipliers: { HIGH: 1.25, MED: 1.0, LOW: 0.85 },
      medSamples: 9,
    };

    const log = formatVolEnvSigmaLog(config);

    expect(log).toContain('using hardcoded defaults');
    expect(log).toContain('insufficient MED samples (n=9)');
  });

  test('applyVolEnvSigmaMultiplier modifies sigma fields by vol_env bucket', () => {
    const sigma = {
      margin: 2.4,
      total: 12.0,
      spread: 1.8,
      sigma_source: 'computed',
    };

    const result = applyVolEnvSigmaMultiplier(sigma, 'HIGH', {
      multipliers: { HIGH: 1.3, MED: 1.0, LOW: 0.85 },
      sourceByBucket: { HIGH: 'empirical', MED: 'empirical', LOW: 'fallback' },
    });

    expect(result.margin).toBeCloseTo(3.12, 1);
    expect(result.total).toBeCloseTo(15.6, 1);
    expect(result.spread).toBeCloseTo(2.34, 1);
    expect(result.vol_env_sigma_multiplier).toBe(1.3);
    expect(result.vol_env_sigma_source).toBe('empirical');
    expect(result.vol_env_bucket).toBe('HIGH');
    expect(result.sigma_source).toBe('computed');
  });

  test('applyVolEnvSigmaMultiplier on LOW: multiplier < 1 reduces sigma', () => {
    const sigma = {
      margin: 2.4,
      total: 12.0,
      spread: 1.8,
    };

    const result = applyVolEnvSigmaMultiplier(sigma, 'LOW', {
      multipliers: { HIGH: 1.25, MED: 1.0, LOW: 0.82 },
      sourceByBucket: { HIGH: 'fallback', MED: 'empirical', LOW: 'empirical' },
    });

    expect(result.margin).toBeCloseTo(1.968, 1);
    expect(result.total).toBeCloseTo(9.84, 1);
    expect(result.vol_env_sigma_multiplier).toBe(0.82);
    expect(result.vol_env_bucket).toBe('LOW');
  });

  test('applyVolEnvSigmaMultiplier on MED: multiplier = 1.0 identity', () => {
    const sigma = {
      margin: 2.4,
      total: 12.0,
      spread: 1.8,
    };

    const result = applyVolEnvSigmaMultiplier(sigma, 'MED', {
      multipliers: { HIGH: 1.25, MED: 1.0, LOW: 0.85 },
      sourceByBucket: { HIGH: 'empirical', MED: 'empirical', LOW: 'empirical' },
    });

    expect(result.margin).toBe(2.4);
    expect(result.total).toBe(12.0);
    expect(result.spread).toBe(1.8);
    expect(result.vol_env_sigma_multiplier).toBe(1.0);
  });

  test('applyVolEnvSigmaMultiplier with unknown vol_env defaults to MED', () => {
    const sigma = { margin: 2.4, total: 12.0, spread: 1.8 };

    const result = applyVolEnvSigmaMultiplier(sigma, null, {
      multipliers: { HIGH: 1.25, MED: 1.0, LOW: 0.85 },
      sourceByBucket: { HIGH: 'empirical', MED: 'empirical', LOW: 'fallback' },
    });

    expect(result.vol_env_bucket).toBe('MED');
    expect(result.vol_env_sigma_multiplier).toBe(1.0);
    expect(result.vol_env_sigma_source).toBe('empirical');
  });

  test('deriveVolEnv buckets total sigma correctly', () => {
    expect(deriveVolEnv(10.5)).toBe('LOW');
    expect(deriveVolEnv(11)).toBe('MED');
    expect(deriveVolEnv(13.9)).toBe('MED');
    expect(deriveVolEnv(14)).toBe('HIGH');
    expect(deriveVolEnv(20)).toBe('HIGH');
    expect(deriveVolEnv(null)).toBeNull();
    expect(deriveVolEnv(undefined)).toBeNull();
  });
});

describe('WI-1020: NBA rolling bias calibration', () => {
  function fakeBiasDb(row, sqlSink = []) {
    return {
      prepare: jest.fn((sql) => {
        sqlSink.push(sql);
        return { get: jest.fn(() => row) };
      }),
    };
  }

  test('computeNbaRollingBias returns computed mean error and enforces anti-leak query', () => {
    const sqlSeen = [];
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: 2.25, n: 50 }, sqlSeen),
      windowGames: 50,
      logger,
    });

    expect(result).toEqual({ bias: 2.25, games_sampled: 50, source: 'computed' });
    expect(sqlSeen[0]).toContain('settled_at < datetime(\'now\')');
    expect(sqlSeen[0]).toContain('ORDER BY settled_at DESC');
    expect(sqlSeen[0]).toContain('LIMIT 50');
    expect(sqlSeen[0]).toContain('raw_total');
    expect(sqlSeen[0]).toContain('actual_total');
    expect(sqlSeen[0]).not.toContain('created_at');
    expect(sqlSeen[0]).not.toContain('updated_at');
    expect(logger.log).toHaveBeenCalledWith(
      '[NBAModel] [BIAS_CORRECTION] rolling_bias=+2.3 games_sampled=50',
    );
  });

  test('computeNbaRollingBias hard-gates fallback when settled rows are below 50', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: 3.5, n: 49 }),
      logger,
    });

    expect(result).toEqual({ bias: 0, games_sampled: 49, source: 'fallback' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[NBAModel] [CALIBRATION_INACTIVE] 49 settled games - minimum 50 required before correction activates',
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('computeNbaRollingBias returns zero fallback when no settled rows exist', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: null, n: 0 }),
      logger,
    });

    expect(result).toEqual({ bias: 0, games_sampled: 0, source: 'fallback' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[NBAModel] [CALIBRATION_INACTIVE] 0 settled games - minimum 50 required before correction activates',
    );
  });

  test('computeNbaRollingBias clamps outlier correction to +/-4 points', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = computeNbaRollingBias({
      db: fakeBiasDb({ mean_error: 8, n: 50 }),
      logger,
    });

    expect(result).toEqual({ bias: 4, games_sampled: 50, source: 'computed' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[NBAModel] [BIAS_CORRECTION] bias_raw=8.0 clamped to +/-4.0 - investigate outlier',
    );
  });

  test('applyNbaTeamContext subtracts rolling bias before blending with market total', async () => {
    const oddsSnapshot = {
      home_team: 'Boston Celtics',
      away_team: 'Miami Heat',
      total: 220,
      raw_data: {},
    };
    const getTeamMetricsWithGamesFn = jest.fn(async (team) => ({
      metrics: team === 'Boston Celtics'
        ? { avgPoints: 120, avgPointsAllowed: 110 }
        : { avgPoints: 114, avgPointsAllowed: 106 },
      impactContext: null,
    }));

    const result = await applyNbaTeamContext('nba-bias-game', oddsSnapshot, {
      rollingBias: { bias: 4, games_sampled: 50, source: 'computed' },
      getTeamMetricsWithGamesFn,
    });

    expect(result.available).toBe(true);
    expect(result.rawPaceAnchorTotal).toBe(225);
    expect(result.paceAnchorTotal).toBe(221);
    expect(result.blendedTotal).toBe(220.25);
    expect(oddsSnapshot.raw_data).toMatchObject({
      pace_anchor_total_raw: 225,
      pace_anchor_total: 221,
      blended_total: 220.25,
      calibration_state: {
        bias: 4,
        games_sampled: 50,
        source: 'computed',
        correction_applied: true,
      },
    });
  });
});

describe('WI-1020: NBA rolling bias calibration (section 2)', () => {
  beforeAll(async () => {
    process.env.DATABASE_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_PATH = '';
    // Remove test DB if exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Ensure schema is present even when pull-odds is skipped (no API key in CI)
    await runMigrations();

    // Run odds job first to populate test data
    try {
      execSync(`DATABASE_PATH=${TEST_DB_PATH} npm run job:pull-odds`, {
        cwd: path.resolve(__dirname, '../../..'),
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch (e) {
      console.log(
        'Note: odds job may not have API key, continuing with test setup',
      );
    }
  });

  afterAll(() => {
    // Clean up test DB
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  test('job executes successfully with exit code 0', () => {
    try {
      const result = execSync(
        `CHEDDAR_DB_PATH= DATABASE_PATH=${TEST_DB_PATH} npm run job:run-nba-model`,
        {
          cwd: path.resolve(__dirname, '../../..'),

          stdio: 'pipe',
          encoding: 'utf-8',
        },
      );
      expect(result).toBeDefined();
    } catch (error) {
      throw new Error(
        `Job failed with exit code ${error.status}: ${error.stdout || error.message}`,
      );
    }
  });

  test('without-odds market call cards carry PROJECTION_ONLY execution status and never surface PLAY', () => {
    const [card] = generateNBAMarketCallCards(
      'game-123',
      { TOTAL: makeTotalDecision({ status: 'PASS', edge: null }) },
      baseOdds,
      { withoutOddsMode: true },
    );

    expect(card).toBeDefined();
    expect(card.payloadData.execution_status).toBe('PROJECTION_ONLY');

    publishDecisionForCard({
      card,
      oddsSnapshot: {
        game_time_utc: baseOdds.game_time_utc,
      },
    });

    expect(card.payloadData.ui_display_status).toBe('WATCH');
  });

  test('deriveExecutionStatusForCard blocks unpriced cards outside without-odds mode', () => {
    const card = {
      payloadData: {
        kind: 'PLAY',
        price: null,
        tags: [],
      },
    };

    expect(deriveExecutionStatusForCard(card)).toBe('BLOCKED');
  });

  test('priced cards derive EXECUTABLE execution status', () => {
    const card = {
      payloadData: {
        kind: 'PLAY',
        price: -110,
        tags: [],
      },
    };

    expect(deriveExecutionStatusForCard(card)).toBe('EXECUTABLE');
  });

  test('execution gate annotates executable market-call cards that clear the veto', () => {
    const card = {
      payloadData: {
        execution_status: 'EXECUTABLE',
        edge: 0.11,
        confidence: 0.74,
        model_status: 'MODEL_OK',
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        pass_reason_code: null,
        reason_codes: [],
        decision_v2: {
          official_status: 'PLAY',
        },
      },
    };
    const nowMs = new Date(baseOdds.captured_at).getTime() + 90_000;

    const result = applyExecutionGateToNbaCard(card, {
      oddsSnapshot: baseOdds,
      nowMs,
    });

    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(false);
    expect(card.payloadData.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: true,
      model_status: 'MODEL_OK',
      snapshot_age_ms: 90_000,
    });
    expect(card.payloadData.execution_gate.net_edge).toBeCloseTo(0.11, 6);
    expect(card.payloadData.status).not.toBe('PASS');
  });

  test('execution gate demotes blocked executable market-call cards to PASS', () => {
    const card = {
      payloadData: {
        execution_status: 'EXECUTABLE',
        edge: 0.005,
        confidence: 0.74,
        model_status: 'MODEL_OK',
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        pass_reason_code: null,
        reason_codes: [],
        decision_v2: {
          official_status: 'PLAY',
        },
      },
    };
    const nowMs = new Date(baseOdds.captured_at).getTime() + 90_000;

    const result = applyExecutionGateToNbaCard(card, {
      oddsSnapshot: baseOdds,
      nowMs,
    });

    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(true);
    expect(card.payloadData.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: false,
      snapshot_age_ms: 90_000,
    });
    expect(card.payloadData.execution_gate.blocked_by).toContain(
      'NET_EDGE_INSUFFICIENT:0.0050',
    );
    expect(card.payloadData.classification).toBe('PASS');
    expect(card.payloadData.action).toBe('PASS');
    expect(card.payloadData.status).toBe('PASS');
    expect(card.payloadData.execution_status).toBe('BLOCKED');
    expect(card.payloadData.pass_reason_code).toBe(
      'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
    );
    // WI-0941 TD-01: Execution gate now stamps decision_v2.official_status to PASS for consistency
    expect(card.payloadData.decision_v2?.official_status).toBe('PASS');
    expect(card.payloadData.decision_v2?.primary_reason_code).toBe(
      'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
    );
    expect(result.strictDecisionSnapshot).toMatchObject({
      classification: 'PASS',
      action: 'PASS',
      status: 'PASS',
      execution_status: 'BLOCKED',
      pass_reason_code: 'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
      decision_v2_official_status: 'PASS',
    });
  });

  test('execution gate tags projection-only NBA cards with explicit early-exit reason metadata', () => {
    const card = {
      payloadData: {
        execution_status: 'PROJECTION_ONLY',
        model_status: 'MODEL_OK',
        status: 'WATCH',
        action: 'HOLD',
        classification: 'LEAN',
        pass_reason_code: 'PROJECTION_ONLY_EXCLUSION',
        reason_codes: ['PROJECTION_ONLY_EXCLUSION'],
      },
    };
    const nowMs = new Date(baseOdds.captured_at).getTime() + 90_000;

    const result = applyExecutionGateToNbaCard(card, {
      oddsSnapshot: baseOdds,
      nowMs,
    });

    expect(result.evaluated).toBe(false);
    expect(result.blocked).toBe(false);
    expect(card.payloadData.execution_gate).toMatchObject({
      evaluated: false,
      blocked_by: ['PROJECTION_ONLY_EXCLUSION'],
      snapshot_age_ms: 90_000,
      drop_reason: {
        drop_reason_code: 'PROJECTION_ONLY_EXCLUSION',
        drop_reason_layer: 'worker_gate',
      },
    });
  });

  test('extracts and logs unique NBA ESPN null metrics teams', () => {
    const entries = extractNbaEspnNullMetricTeams({
      homeTeam: 'Boston Celtics',
      awayTeam: 'New York Knicks',
      homeResult: {
        metrics: {
          avgPoints: null,
          avgPointsAllowed: null,
          espn_null_reason: 'team_map_miss',
        },
      },
      awayResult: {
        metrics: {
          avgPoints: null,
          avgPointsAllowed: null,
          espn_null_reason: 'espn_no_data',
        },
      },
    });

    expect(entries).toEqual([
      { team: 'Boston Celtics', reason: 'TEAM_MAP_MISS' },
      { team: 'New York Knicks', reason: 'ESPN_NO_DATA' },
    ]);

    const registry = new Map();
    const warn = jest.fn();
    const logger = { warn };
    recordEspnNullTeams({
      sport: 'NBA',
      registry,
      nullMetricTeams: [...entries, entries[0]],
      logger,
    });

    expect(registry.size).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[ESPN_NULL] sport=NBA team=Boston Celtics reason=TEAM_MAP_MISS',
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[ESPN_NULL] sport=NBA team=New York Knicks reason=ESPN_NO_DATA',
    );
  });

  test('sends NBA ESPN null Discord alert at threshold and records cooldown run', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origWebhook = process.env.DISCORD_ALERT_WEBHOOK_URL;
    const origThreshold = process.env.ESPN_NULL_ALERT_THRESHOLD;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';
    process.env.ESPN_NULL_ALERT_THRESHOLD = '2';

    const sendDiscordMessagesFn = jest.fn().mockResolvedValue(1);
    const wasJobRecentlySuccessfulFn = jest.fn(() => false);
    const insertJobRunFn = jest.fn();
    const markJobRunSuccessFn = jest.fn();
    const markJobRunFailureFn = jest.fn();
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = await sendEspnNullDiscordAlert({
      sport: 'NBA',
      nullMetricTeams: [
        { team: 'Boston Celtics', reason: 'TEAM_MAP_MISS' },
        { team: 'New York Knicks', reason: 'ESPN_NO_DATA' },
      ],
      logger,
      sendDiscordMessagesFn,
      wasJobRecentlySuccessfulFn,
      insertJobRunFn,
      markJobRunSuccessFn,
      markJobRunFailureFn,
    });

    expect(result).toMatchObject({ sent: true, reason: 'sent', count: 2 });
    expect(sendDiscordMessagesFn).toHaveBeenCalledTimes(1);
    expect(sendDiscordMessagesFn.mock.calls[0][0]).toMatchObject({
      webhookUrl: 'https://discord.example/webhook',
    });
    expect(sendDiscordMessagesFn.mock.calls[0][0].messages[0]).toContain(
      'Boston Celtics',
    );
    expect(wasJobRecentlySuccessfulFn).toHaveBeenCalledWith(
      'espn_null_alert_nba',
      60,
    );
    expect(insertJobRunFn).toHaveBeenCalledTimes(1);
    expect(markJobRunSuccessFn).toHaveBeenCalledTimes(1);
    expect(markJobRunFailureFn).not.toHaveBeenCalled();

    if (origEnabled !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnabled;
    else delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    if (origWebhook !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origWebhook;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
    if (origThreshold !== undefined) process.env.ESPN_NULL_ALERT_THRESHOLD = origThreshold;
    else delete process.env.ESPN_NULL_ALERT_THRESHOLD;
  });

  test('suppresses NBA ESPN null Discord alert during cooldown', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origWebhook = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    const sendDiscordMessagesFn = jest.fn();
    const wasJobRecentlySuccessfulFn = jest.fn(() => true);

    const result = await sendEspnNullDiscordAlert({
      sport: 'NBA',
      nullMetricTeams: [
        { team: 'Boston Celtics', reason: 'TEAM_MAP_MISS' },
        { team: 'New York Knicks', reason: 'ESPN_NO_DATA' },
      ],
      sendDiscordMessagesFn,
      wasJobRecentlySuccessfulFn,
      insertJobRunFn: jest.fn(),
      markJobRunSuccessFn: jest.fn(),
      markJobRunFailureFn: jest.fn(),
    });

    expect(result).toMatchObject({
      sent: false,
      reason: 'cooldown_active',
      count: 2,
    });
    expect(sendDiscordMessagesFn).not.toHaveBeenCalled();

    if (origEnabled !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnabled;
    else delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    if (origWebhook !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origWebhook;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('suppresses single-run NO_GAMES null alerts pending persistence', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origWebhook = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    const sendDiscordMessagesFn = jest.fn();
    const wasJobRecentlySuccessfulFn = jest.fn((jobName) => {
      if (String(jobName).startsWith('espn_null_seen_nba_')) return false;
      return false;
    });
    const insertJobRunFn = jest.fn();
    const markJobRunSuccessFn = jest.fn();
    const markJobRunFailureFn = jest.fn();
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = await sendEspnNullDiscordAlert({
      sport: 'NBA',
      nullMetricTeams: [
        { team: 'Boston Celtics', reason: 'NO_GAMES' },
        { team: 'New York Knicks', reason: 'NO_GAMES' },
      ],
      logger,
      sendDiscordMessagesFn,
      wasJobRecentlySuccessfulFn,
      insertJobRunFn,
      markJobRunSuccessFn,
      markJobRunFailureFn,
    });

    expect(result).toMatchObject({ sent: false, reason: 'below_threshold', count: 0 });
    expect(sendDiscordMessagesFn).not.toHaveBeenCalled();
    expect(insertJobRunFn).toHaveBeenCalledTimes(2);
    expect(markJobRunSuccessFn).toHaveBeenCalledTimes(2);

    if (origEnabled !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnabled;
    else delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    if (origWebhook !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origWebhook;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('sends NO_GAMES alerts once recurrence threshold is met for each team', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origWebhook = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    const sendDiscordMessagesFn = jest.fn().mockResolvedValue(1);
    const wasJobRecentlySuccessfulFn = jest.fn((jobName) => {
      if (String(jobName).startsWith('espn_null_seen_nba_')) return true;
      return false;
    });
    const insertJobRunFn = jest.fn();
    const markJobRunSuccessFn = jest.fn();
    const markJobRunFailureFn = jest.fn();
    const logger = { log: jest.fn(), warn: jest.fn() };

    const result = await sendEspnNullDiscordAlert({
      sport: 'NBA',
      nullMetricTeams: [
        { team: 'Boston Celtics', reason: 'NO_GAMES' },
        { team: 'New York Knicks', reason: 'NO_GAMES' },
      ],
      logger,
      sendDiscordMessagesFn,
      wasJobRecentlySuccessfulFn,
      insertJobRunFn,
      markJobRunSuccessFn,
      markJobRunFailureFn,
    });

    expect(result).toMatchObject({ sent: true, reason: 'sent', count: 2 });
    expect(sendDiscordMessagesFn).toHaveBeenCalledTimes(1);
    expect(sendDiscordMessagesFn.mock.calls[0][0].messages[0]).toContain('NO_GAMES');
    // 2 observation runs + 1 alert run
    expect(insertJobRunFn).toHaveBeenCalledTimes(3);
    expect(markJobRunSuccessFn).toHaveBeenCalledTimes(3);
    expect(markJobRunFailureFn).not.toHaveBeenCalled();

    if (origEnabled !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnabled;
    else delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    if (origWebhook !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origWebhook;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('job_runs table records job execution as success', async () => {
    const result = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT id, job_name, status, started_at, ended_at
        FROM job_runs
        WHERE job_name = 'run_nba_model' AND status = 'success'
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return stmt.get();
    });

    expect(result).toBeDefined();
    if (result) {
      expect(result.job_name).toBe('run_nba_model');
      expect(result.status).toBe('success');
      expect(result.started_at).toBeTruthy();
      expect(result.ended_at).toBeTruthy();
      expect(new Date(result.started_at).getTime()).toBeLessThan(
        new Date(result.ended_at).getTime(),
      );
    }
  });

  test('model_outputs table has valid schema if any records exist', async () => {
    const results = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT 
          id, game_id, sport, model_name, confidence, output_data
        FROM model_outputs
        WHERE sport = 'NBA'
        LIMIT 100
      `);
      return stmt.all();
    });

    // It's OK if no results (no odds data), but if they exist, verify schema
    if (results && results.length > 0) {
      results.forEach((row) => {
        expect(row.id).toBeTruthy();
        expect(row.game_id).toBeTruthy();
        expect(row.sport).toBe('NBA');
        expect(row.model_name).toBeTruthy();
        expect(row.confidence).toBeGreaterThanOrEqual(0);
        expect(row.confidence).toBeLessThanOrEqual(1);
        expect(row.output_data).toBeTruthy();

        // output_data should be valid JSON
        const parsed = JSON.parse(row.output_data);
        expect(parsed).toHaveProperty('prediction');
        expect(parsed).toHaveProperty('confidence');
        expect(parsed).toHaveProperty('reasoning');
      });
    }
  });

  test('card_payloads table stores generated cards if any passed confidence threshold', async () => {
    const results = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT 
          id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at
        FROM card_payloads
        WHERE sport = 'NBA'
        LIMIT 100
      `);
      return stmt.all();
    });

    // It's OK if no results (no odds data or all abstained), but if they exist, verify schema
    if (results && results.length > 0) {
      results.forEach((row) => {
        expect(row.id).toBeTruthy();
        expect(row.game_id).toBeTruthy();
        expect(row.sport).toBe('NBA');
        expect(row.card_type).toBeTruthy();
        expect(row.card_title).toBeTruthy();
        expect(row.payload_data).toBeTruthy();
        expect(row.created_at).toBeTruthy();

        // payload_data should be valid JSON
        const parsed = JSON.parse(row.payload_data);
        expect(parsed).toHaveProperty('game_id');
        expect(parsed).toHaveProperty('sport');
        expect(parsed.sport).toBe('NBA');
        expect(parsed).toHaveProperty('prediction');
        expect(parsed).toHaveProperty('confidence');
        expect(parsed).toHaveProperty('recommended_bet_type');
        expect(parsed).toHaveProperty('disclaimer');
      });
    }
  });

  test('WI-0835: card payloads carry sigma_source and sigma_games_sampled in raw_data', async () => {
    const results = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT payload_data FROM card_payloads
        WHERE sport = 'NBA'  
        LIMIT 100
      `);
      return stmt.all();
    });

    if (results && results.length > 0) {
      results.forEach((row) => {
        const parsed = JSON.parse(row.payload_data);
        if (parsed.raw_data !== undefined && parsed.raw_data !== null) {
          expect(['computed', 'fallback']).toContain(parsed.raw_data.sigma_source);
          const sampled = parsed.raw_data.sigma_games_sampled;
          expect(sampled === null || typeof sampled === 'number').toBe(true);
        }
      });
    }
  });

  test('card_results auto-enrolls for generated cards', async () => {
    const results = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM card_payloads WHERE sport = 'NBA') AS cards,
          (SELECT COUNT(*) FROM card_results WHERE sport = 'NBA') AS results
      `);
      return stmt.get();
    });

    if (results && results.cards > 0) {
      expect(results.results).toBeGreaterThanOrEqual(results.cards);

      const rows = await queryDb((db) => {
        const stmt = db.prepare(`
          SELECT card_id, status, recommended_bet_type
          FROM card_results
          WHERE sport = 'NBA'
          LIMIT 50
        `);
        return stmt.all();
      });

      rows.forEach((row) => {
        expect(row.card_id).toBeTruthy();
        expect(row.status).toBe('pending');
        expect(row.recommended_bet_type).toBeTruthy();
      });
    }
  });

  test('card_payloads with expires_at should expire before game start', async () => {
    const results = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT 
          cp.id, cp.expires_at, g.game_time_utc
        FROM card_payloads cp
        LEFT JOIN games g ON cp.game_id = g.game_id
        WHERE cp.sport = 'NBA' AND cp.expires_at IS NOT NULL
        LIMIT 100
      `);
      return stmt.all();
    });

    if (results && results.length > 0) {
      results.forEach((row) => {
        if (row.game_time_utc) {
          const expiresTime = new Date(row.expires_at).getTime();
          const gameTime = new Date(row.game_time_utc).getTime();
          expect(expiresTime).toBeLessThan(gameTime);

          // Should expire 1 hour before game
          const onlyHourBefore = gameTime - 60 * 60 * 1000;
          expect(Math.abs(expiresTime - onlyHourBefore)).toBeLessThan(
            60 * 1000,
          ); // Within 1 minute
        }
      });
    }
  });
});

describe('WI-0941 quarantine and execution-gate regression', () => {
  const gameId = 'game-wI-0941';

  function makeOddsSnapshot() {
    return {
      home_team: 'LAL',
      away_team: 'GSW',
      game_time_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      total: 224.5,
      total_price_over: -110,
      total_price_under: -110,
      spread_home: -4.5,
      spread_away: 4.5,
      spread_price_home: -110,
      spread_price_away: -110,
      h2h_home: -180,
      h2h_away: 155,
      captured_at: new Date().toISOString(),
    };
  }

  function makeTotalFireDecision(overrides = {}) {
    return {
      status: 'FIRE',
      edge: 0.08,
      edge_points: 2.4,
      best_candidate: { side: 'OVER', line: 224.5 },
      drivers: [],
      reasoning: 'test reasoning',
      score: 0.7,
      net: 0.6,
      conflict: 0.1,
      coverage: 0.8,
      // p_fair=0.595 at price=-110 gives edge≈0.071 which clears NBA TOTAL play_edge_min=0.062
      p_fair: 0.595,
      p_implied: 0.524,
      projection: { projected_total: 226.5 },
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      ...overrides,
    };
  }

  test('Test A (quarantine path): generateNBAMarketCallCards with QUARANTINE_NBA_TOTAL=true produces totals card demoted by quarantine after publish', () => {
    jest.resetModules();
    process.env.QUARANTINE_NBA_TOTAL = 'true';
    const { generateNBAMarketCallCards: genCards } = require('../run_nba_model');
    const { publishDecisionForCard: pubCard } = require('../../utils/decision-publisher');
    const odds = makeOddsSnapshot();

    const cards = genCards(gameId, { TOTAL: makeTotalFireDecision() }, odds, {
      withoutOddsMode: false,
    });

    const totalCard = cards.find((c) => c.cardType === 'nba-totals-call');
    expect(totalCard).toBeDefined();
    expect(totalCard.payloadData.execution_status).toBe('EXECUTABLE');

    pubCard({ card: totalCard, oddsSnapshot: odds });

    // Quarantine demotes PLAY → LEAN for NBA TOTAL, and records reason in price_reason_codes
    expect(totalCard.payloadData.decision_v2?.official_status).toBe('LEAN');
    expect(
      totalCard.payloadData.decision_v2?.price_reason_codes,
    ).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');

    delete process.env.QUARANTINE_NBA_TOTAL;
  });

  test('Test B (non-quarantine path): generateNBAMarketCallCards with QUARANTINE_NBA_TOTAL=false produces totals card with decision_v2.official_status=PLAY', () => {
    jest.resetModules();
    process.env.QUARANTINE_NBA_TOTAL = 'false';
    const { generateNBAMarketCallCards: genCards } = require('../run_nba_model');
    const { publishDecisionForCard: pubCard } = require('../../utils/decision-publisher');
    const odds = makeOddsSnapshot();

    const cards = genCards(gameId, { TOTAL: makeTotalFireDecision() }, odds, {
      withoutOddsMode: false,
    });

    const totalCard = cards.find((c) => c.cardType === 'nba-totals-call');
    expect(totalCard).toBeDefined();

    pubCard({ card: totalCard, oddsSnapshot: odds });

    // Without quarantine, FIRE total card should surface as PLAY
    expect(totalCard.payloadData.decision_v2?.official_status).toBe('PLAY');
    expect(
      totalCard.payloadData.decision_v2?.price_reason_codes ?? [],
    ).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');

    delete process.env.QUARANTINE_NBA_TOTAL;
  });

  test('Test C (execution gate parity): card blocked by applyExecutionGateToNbaCard has decision_v2.official_status=PASS and primary_reason_code=pass_reason_code', () => {
    const passCard = {
      cardType: 'nba-totals-call',
      payloadData: {
        execution_status: 'EXECUTABLE',
        edge: 0.005, // below threshold → will be blocked
        confidence: 0.55,
        model_status: 'MODEL_OK',
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        pass_reason_code: null,
        reason_codes: [],
        decision_v2: {
          official_status: 'PLAY',
        },
      },
    };
    const odds = makeOddsSnapshot();
    const nowMs = new Date(odds.captured_at).getTime() + 90_000;

    const result = applyExecutionGateToNbaCard(passCard, { oddsSnapshot: odds, nowMs });

    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(true);
    expect(passCard.payloadData.decision_v2?.official_status).toBe('PASS');
    expect(passCard.payloadData.decision_v2?.primary_reason_code).toBe(
      passCard.payloadData.pass_reason_code,
    );
  });
});
