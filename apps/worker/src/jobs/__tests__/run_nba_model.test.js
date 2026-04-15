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

describe('run_nba_model job', () => {
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
    expect(card.payloadData.execution_gate.net_edge).toBeCloseTo(0.06, 6);
    expect(card.payloadData.status).not.toBe('PASS');
  });

  test('execution gate demotes blocked executable market-call cards to PASS', () => {
    const card = {
      payloadData: {
        execution_status: 'EXECUTABLE',
        edge: 0.055,
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
