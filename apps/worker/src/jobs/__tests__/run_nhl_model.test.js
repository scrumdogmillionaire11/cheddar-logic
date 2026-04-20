/**
 * Smoke Test — Run NHL Model Job
 *
 * Verifies:
 * 1. Job runs without error (exit code 0)
 * 2. job_runs table records job execution (status='success')
 * 3. model_outputs table has valid schema + non-null fields
 * 4. card_payloads table stores generated cards
 * 5. Cards expire before game time (if game_time_utc is set)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {getDatabase, closeDatabase, runMigrations } = require('@cheddar-logic/data');
const {
  generateNHLMarketCallCards,
  applyNhlSettlementMarketContext,
  extractNhlEspnNullMetricTeams,
  recordEspnNullTeams,
  sendEspnNullDiscordAlert,
  applyExecutionGateToNhlCard,
  stampTrainingRowExclusion,
} = require('../run_nhl_model');
const { computeNHLDriverCards } = require('../../models/index');

const TEST_DB_PATH = '/tmp/cheddar-nhl-test.db';

function buildBaseOddsSnapshot() {
  return {
    game_time_utc: '2026-03-11T00:00:00.000Z',
    home_team: 'Home Team',
    away_team: 'Away Team',
    h2h_home: -130,
    h2h_away: 115,
    spread_home: -1.5,
    spread_away: 1.5,
    spread_price_home: -110,
    spread_price_away: -110,
    total: 6.5,
    total_price_over: -112,
    total_price_under: -108,
    captured_at: '2026-03-10T18:00:00.000Z',
  };
}

function buildBaseDecisions() {
  return {
    TOTAL: {
      status: 'WATCH',
      best_candidate: { side: 'OVER', line: 6.5 },
      edge: 0.02,
      edge_points: 0.4,
      p_fair: 0.53,
      p_implied: 0.5,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      drivers: [],
      score: 0.25,
      net: 0.25,
      conflict: 0.1,
      coverage: 0.75,
      reasoning: 'Totals edge',
      projection: {
        projected_total: 6.9,
      },
    },
    SPREAD: {
      status: 'PASS',
      best_candidate: { side: 'HOME', line: -1.5 },
      drivers: [],
      score: 0.1,
      net: 0.1,
      conflict: 0.1,
      coverage: 0.5,
      reasoning: 'No spread edge',
      projection: {
        projected_margin: 0.8,
      },
    },
    ML: {
      status: 'FIRE',
      best_candidate: { side: 'AWAY', price: 115 },
      edge: 0.034,
      p_fair: 0.499,
      p_implied: 0.465,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      drivers: [],
      score: 0.52,
      net: 0.61,
      conflict: 0.07,
      coverage: 0.79,
      reasoning: 'Away side carries the strongest edge.',
      projection: {
        projected_margin: -0.9,
        win_prob_home: 0.501,
      },
    },
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

describe('run_nhl_model job', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    delete process.env.DATABASE_PATH;
    // Remove test DB if exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Ensure schema is present even when pull-odds is skipped (no API key in CI)
    await runMigrations();

    // Run odds job first to populate test data
    try {
      execSync(`CHEDDAR_DB_PATH=${TEST_DB_PATH} npm run job:pull-odds`, {
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
        `CHEDDAR_DB_PATH=${TEST_DB_PATH} npm run job:run-nhl-model`,
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

  test('extracts and logs unique NHL ESPN null metrics teams from raw_data', () => {
    const entries = extractNhlEspnNullMetricTeams({
      home_team: 'Boston Bruins',
      away_team: 'New York Rangers',
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgGoalsFor: null,
              avgGoalsAgainst: null,
              espn_null_reason: 'espn_no_data',
            },
          },
          away: {
            metrics: {
              avgGoalsFor: null,
              avgGoalsAgainst: null,
              espn_null_reason: 'fetch_error',
            },
          },
        },
      },
    });

    expect(entries).toEqual([
      { team: 'Boston Bruins', reason: 'ESPN_NO_DATA' },
      { team: 'New York Rangers', reason: 'FETCH_ERROR' },
    ]);

    const registry = new Map();
    const warn = jest.fn();
    recordEspnNullTeams({
      sport: 'NHL',
      registry,
      nullMetricTeams: [...entries, entries[1]],
      logger: { warn },
    });

    expect(registry.size).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[ESPN_NULL] sport=NHL team=Boston Bruins reason=ESPN_NO_DATA',
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[ESPN_NULL] sport=NHL team=New York Rangers reason=FETCH_ERROR',
    );
  });

  test('sends NHL ESPN null Discord alert at threshold and records cooldown run', async () => {
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

    const result = await sendEspnNullDiscordAlert({
      sport: 'NHL',
      nullMetricTeams: [
        { team: 'Boston Bruins', reason: 'ESPN_NO_DATA' },
        { team: 'New York Rangers', reason: 'FETCH_ERROR' },
      ],
      logger: { log: jest.fn(), warn: jest.fn() },
      sendDiscordMessagesFn,
      wasJobRecentlySuccessfulFn,
      insertJobRunFn,
      markJobRunSuccessFn,
      markJobRunFailureFn,
    });

    expect(result).toMatchObject({ sent: true, reason: 'sent', count: 2 });
    expect(sendDiscordMessagesFn).toHaveBeenCalledTimes(1);
    expect(sendDiscordMessagesFn.mock.calls[0][0].messages[0]).toContain(
      'Boston Bruins',
    );
    expect(wasJobRecentlySuccessfulFn).toHaveBeenCalledWith(
      'espn_null_alert_nhl',
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

  test('suppresses NHL ESPN null Discord alert during cooldown', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origWebhook = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook';

    const sendDiscordMessagesFn = jest.fn();
    const wasJobRecentlySuccessfulFn = jest.fn(() => true);

    const result = await sendEspnNullDiscordAlert({
      sport: 'NHL',
      nullMetricTeams: [
        { team: 'Boston Bruins', reason: 'ESPN_NO_DATA' },
        { team: 'New York Rangers', reason: 'FETCH_ERROR' },
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

  test('orchestrated market routing reduces legacy actionable cards to one canonical card', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();

    const legacyCards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
      { useOrchestratedMarket: false },
    );
    const orchestratedCards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
      { useOrchestratedMarket: true },
    );

    expect(legacyCards.map((card) => card.cardType).sort()).toEqual([
      'nhl-moneyline-call',
      'nhl-totals-call',
    ]);
    expect(orchestratedCards.map((card) => card.cardType)).toEqual([
      'nhl-moneyline-call',
    ]);
    expect(orchestratedCards[0].payloadData.expression_choice).toMatchObject({
      chosen_market: 'ML',
      status: 'FIRE',
    });
  });

  test('job_runs table records job execution as success', async () => {
    const result = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT id, job_name, status, started_at, ended_at
        FROM job_runs
        WHERE job_name = 'run_nhl_model' AND status = 'success'
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return stmt.get();
    });

    expect(result).toBeDefined();
    if (result) {
      expect(result.job_name).toBe('run_nhl_model');
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
        WHERE sport = 'NHL'
        LIMIT 100
      `);
      return stmt.all();
    });

    // It's OK if no results (no odds data), but if they exist, verify schema
    if (results && results.length > 0) {
      results.forEach((row) => {
        expect(row.id).toBeTruthy();
        expect(row.game_id).toBeTruthy();
        expect(row.sport).toBe('NHL');
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
        WHERE sport = 'nhl'
        LIMIT 100
      `);
      return stmt.all();
    });

    // It's OK if no results (no odds data or all abstained), but if they exist, verify schema
    if (results && results.length > 0) {
      results.forEach((row) => {
        expect(row.id).toBeTruthy();
        expect(row.game_id).toBeTruthy();
        expect(row.sport).toBe('nhl');
        expect(row.card_type).toBeTruthy();
        expect(row.card_title).toBeTruthy();
        expect(row.payload_data).toBeTruthy();
        expect(row.created_at).toBeTruthy();

        // payload_data should be valid JSON
        const parsed = JSON.parse(row.payload_data);
        expect(parsed).toHaveProperty('game_id');
        expect(parsed).toHaveProperty('sport');
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
        WHERE sport = 'nhl'
        LIMIT 100
      `);
      return stmt.all();
    });

    if (results && results.length > 0) {
      results.forEach((row) => {
        const parsed = JSON.parse(row.payload_data);
        if (parsed.raw_data !== undefined && parsed.raw_data !== null) {
          expect(['calibrated', 'default']).toContain(parsed.raw_data.sigma_source);
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
          (SELECT COUNT(*) FROM card_payloads WHERE sport = 'nhl') AS cards,
          (SELECT COUNT(*) FROM card_results WHERE sport = 'nhl') AS results
      `);
      return stmt.get();
    });

    if (results && results.cards > 0) {
      expect(results.results).toBeGreaterThanOrEqual(results.cards);

      const rows = await queryDb((db) => {
        const stmt = db.prepare(`
          SELECT card_id, sport, status, recommended_bet_type
          FROM card_results
          WHERE sport = 'nhl'
          LIMIT 50
        `);
        return stmt.all();
      });

      rows.forEach((row) => {
        expect(row.card_id).toBeTruthy();
        expect(row.sport).toBe('nhl');
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
        WHERE cp.expires_at IS NOT NULL
          AND cp.sport = 'nhl'
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

  // WI-0505: Phase-2 fair probability gate — integration-level assertions
  describe('Phase-2 fair probability gate via computeNHLDriverCards context', () => {
    const baseOdds = {
      game_id: 'nhl-phase2-gate-test',
      total: 6.5,
      total_price_over: -110,
      total_price_under: -110,
      raw_data: JSON.stringify({
        goalie: {
          home: { name: 'Igor Shesterkin', status: 'CONFIRMED' },
          away: { name: 'Thatcher Demko', status: 'CONFIRMED' },
        },
        espn_metrics: {
          home: {
            metrics: {
              avgGoalsFor: 4.2,
              avgGoalsAgainst: 2.5,
              pace_factor: 1.15,
              ppPct: 0.28,
              pkPct: 0.76,
              restDays: 2,
            },
          },
          away: {
            metrics: {
              avgGoalsFor: 4.0,
              avgGoalsAgainst: 2.6,
              pace_factor: 1.12,
              ppPct: 0.26,
              pkPct: 0.78,
              restDays: 2,
            },
          },
        },
      }),
    };

    function get1pCard(context) {
      const cards = computeNHLDriverCards('nhl-phase2-gate-test', baseOdds, context);
      return cards.find((c) => c.cardType === 'nhl-pace-1p');
    }

    test('gate off: 1P driverInputs.fair_over_1_5_prob is null', () => {
      const card = get1pCard({ phase2FairProbEnabled: false });
      expect(card).toBeDefined();
      expect(card.driverInputs.fair_over_1_5_prob).toBeNull();
      expect(card.driverInputs.fair_under_1_5_prob).toBeNull();
    });

    test('gate on but total_1p absent from snapshot: fair probs are null (market-line prerequisite guard)', () => {
      // total_1p is absent from baseOdds — run_nhl_model will not activate phase2
      // Simulate the guard: pass phase2FairProbEnabled=false to model (as job would do)
      const oddsWithout1p = { ...baseOdds };
      delete oddsWithout1p.total_1p;
      // Job sets phase2FairProbEnabled: NHL_1P_FAIR_PROB_PHASE2 && hasReal1pLine
      // hasReal1pLine = typeof undefined === 'number' -> false -> context gets false
      const card = get1pCard({ phase2FairProbEnabled: false });
      expect(card).toBeDefined();
      expect(card.driverInputs.fair_over_1_5_prob).toBeNull();
      expect(card.driverInputs.fair_under_1_5_prob).toBeNull();
    });

    test('gate on + total_1p present + eligible classification: driverInputs.fair_over_1_5_prob is a number', () => {
      const oddsWithLine = { ...baseOdds, total_1p: 1.5 };
      const cards = computeNHLDriverCards('nhl-phase2-gate-test', oddsWithLine, {
        phase2FairProbEnabled: true,
        sigma1p: 1.26,
      });
      const card = cards.find((c) => c.cardType === 'nhl-pace-1p');
      expect(card).toBeDefined();
      const classification = card.driverInputs.classification;
      if (classification !== 'PASS') {
        expect(typeof card.driverInputs.fair_over_1_5_prob).toBe('number');
        expect(typeof card.driverInputs.fair_under_1_5_prob).toBe('number');
      } else {
        expect(card.driverInputs.fair_over_1_5_prob).toBeNull();
        expect(card.driverInputs.fair_under_1_5_prob).toBeNull();
      }
    });
  });

  describe('WI-0839: NHL 1P sigma static gate', () => {
    function build1pCard(overrides = {}) {
      return {
        cardType: 'nhl-pace-1p',
        payloadData: {
          status: 'FIRE',
          classification: 'OVER_1P',
          reason_codes: [],
          ...overrides,
        },
      };
    }

    const playableOdds = {
      total_1p: 1.5,
      total_1p_price_over: -115,
      total_1p_price_under: -105,
    };

    const noOdds = {};

    test('sigma_1p_source is always static on 1P card payloads', () => {
      const card = build1pCard();
      applyNhlSettlementMarketContext(card, playableOdds, true);
      expect(card.payloadData.sigma_1p_source).toBe('static');
    });

    test('PLAY card is downgraded to LEAN when sigma1pGatePassed is false', () => {
      const card = build1pCard();
      applyNhlSettlementMarketContext(card, playableOdds, false);
      expect(card.payloadData.kind).toBe('LEAN');
      expect(card.payloadData.reason_codes).toContain('SIGMA_1P_INSUFFICIENT_HISTORY');
    });

    test('PLAY card is NOT downgraded when sigma1pGatePassed is true', () => {
      const card = build1pCard();
      applyNhlSettlementMarketContext(card, playableOdds, true);
      expect(card.payloadData.kind).toBe('PLAY');
      expect(card.payloadData.reason_codes).not.toContain('SIGMA_1P_INSUFFICIENT_HISTORY');
    });

    test('EVIDENCE card is not affected by sigma1pGatePassed', () => {
      // noOdds → sidePrice is null → isPlayable = false → kind = EVIDENCE
      const card = build1pCard();
      applyNhlSettlementMarketContext(card, noOdds, false);
      expect(card.payloadData.kind).toBe('EVIDENCE');
      expect(card.payloadData.reason_codes).not.toContain('SIGMA_1P_INSUFFICIENT_HISTORY');
    });
  });
});

describe('generateNHLMarketCallCards independent evaluation (IME-01-04)', () => {
  function buildOdds() {
    return {
      game_time_utc: '2026-04-20T00:00:00.000Z',
      home_team: 'BOS',
      away_team: 'TOR',
      h2h_home: -130,
      h2h_away: 115,
      spread_home: -1.5,
      spread_away: 1.5,
      spread_price_home: -110,
      spread_price_away: -110,
      total: 6.5,
      total_price_over: -112,
      total_price_under: -108,
      captured_at: '2026-04-19T18:00:00.000Z',
    };
  }

  function buildDecisionWithTotal(mlStatus = 'FIRE', totalStatus = 'WATCH') {
    return {
      TOTAL: {
        status: totalStatus,
        best_candidate: { side: 'OVER', line: 6.5 },
        edge: 0.03,
        edge_points: 0.4,
        p_fair: 0.53,
        p_implied: 0.50,
        score: 0.62,
        net: 0.62,
        conflict: 0.1,
        coverage: 0.75,
        reasoning: 'Totals edge',
        projection: { projected_total: 6.9 },
      },
      SPREAD: {
        status: 'PASS',
        best_candidate: { side: 'HOME', line: -1.5 },
        edge: 0.0,
        score: 0.1,
        net: 0.1,
        conflict: 0.1,
        coverage: 0.4,
        reasoning: 'No spread edge',
        projection: { projected_margin: 0.5 },
      },
      ML: {
        status: mlStatus,
        best_candidate: { side: 'HOME', price: -130 },
        edge: 0.045,
        p_fair: 0.56,
        p_implied: 0.515,
        score: 0.70,
        net: 0.70,
        conflict: 0.07,
        coverage: 0.79,
        reasoning: 'Home side carries edge.',
        projection: { projected_margin: 0.9, win_prob_home: 0.56 },
      },
    };
  }

  test('ML card emitted when ML=FIRE even if TOTAL=WATCH ranks higher as primary display', () => {
    const { evaluateNHLGameMarkets, choosePrimaryDisplayMarket } = require('../../models');
    const marketDecisions = buildDecisionWithTotal('FIRE', 'WATCH');
    const gameEval = evaluateNHLGameMarkets({ marketDecisions, game_id: 'TEST-001' });
    const primaryDisplayMarket = choosePrimaryDisplayMarket(gameEval);

    const cards = generateNHLMarketCallCards('TEST-001', marketDecisions, buildOdds(), {
      useOrchestratedMarket: false,
      gameEval,
      primaryDisplayMarket,
    });

    const cardTypes = cards.map((c) => c.cardType);
    expect(cardTypes).toContain('nhl-moneyline-call');
    expect(cardTypes).toContain('nhl-totals-call');
  });

  test('all PASS decisions → no cards generated', () => {
    const { evaluateNHLGameMarkets, choosePrimaryDisplayMarket } = require('../../models');
    const marketDecisions = buildDecisionWithTotal('PASS', 'PASS');
    // also set SPREAD to PASS (already default)
    const gameEval = evaluateNHLGameMarkets({ marketDecisions, game_id: 'TEST-002' });
    const primaryDisplayMarket = choosePrimaryDisplayMarket(gameEval);

    const cards = generateNHLMarketCallCards('TEST-002', marketDecisions, buildOdds(), {
      useOrchestratedMarket: false,
      gameEval,
      primaryDisplayMarket,
    });

    expect(cards).toHaveLength(0);
    expect(gameEval.official_plays).toHaveLength(0);
    expect(gameEval.leans).toHaveLength(0);
  });
});

describe('applyExecutionGateToNhlCard timestamp provenance', () => {
  test('attaches execution_envelope.snapshot_timestamp and freshness_decision', () => {
    const card = {
      sport: 'NHL',
      cardType: 'nhl-moneyline-call',
      payloadData: {
        sport: 'NHL',
        game_id: 'nhl_1',
        execution_status: 'EXECUTABLE',
        status: 'WATCH',
        action: 'LEAN',
        classification: 'LEAN',
        model_status: 'MODEL_OK',
        edge: 0.03,
        confidence: 0.61,
        market_type: 'MONEYLINE',
        recommended_bet_type: 'MONEYLINE',
      },
    };

    applyExecutionGateToNhlCard(card, {
      oddsSnapshot: {
        id: 'odds_nhl_test_1',
        game_id: 'nhl_1',
        captured_at: '2026-04-15T19:20:00Z',
        pulled_at: '2026-04-15T19:20:05Z',
        updated_at: '2026-04-15T19:20:07Z',
      },
      nowMs: Date.parse('2026-04-15T19:30:00Z'),
    });

    expect(card.payloadData.snapshot_timestamp).toBeDefined();
    expect(card.payloadData.snapshot_timestamp).toMatchObject({
      captured_at: '2026-04-15T19:20:00Z',
      resolved_source: 'captured_at',
      resolved_timestamp: expect.any(String),
      resolved_age_ms: expect.any(Number),
    });
    expect(card.payloadData.execution_envelope).toBeDefined();
    expect(card.payloadData.execution_envelope.snapshot_timestamp).toBeDefined();
    expect(card.payloadData.execution_gate).toHaveProperty('freshness_decision');
  });
});

describe('stampTrainingRowExclusion (WI-0970)', () => {
  function makeCard(rawDataOverrides = {}) {
    return {
      payloadData: {
        status: 'FIRE',
        officialStatus: 'FIRE',
        raw_data: { sigma_games_sampled: 10, ...rawDataOverrides },
      },
    };
  }

  function makeGoalieState(adjustmentTrust) {
    return { adjustment_trust: adjustmentTrust };
  }

  function validOdds(overrides = {}) {
    return {
      total: 6.5,
      h2h_home: -130,
      h2h_away: 115,
      ...overrides,
    };
  }

  test('eligible card: sets training_row_excluded=false and reason=null', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds(),
      homeGoalieState: makeGoalieState('FULL'),
      awayGoalieState: makeGoalieState('DEGRADED'),
      sigmaGamesSampled: 12,
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(false);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBeNull();
  });

  test('MALFORMED_INPUT: null oddsSnapshot', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, { oddsSnapshot: null });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('MALFORMED_INPUT');
  });

  test('MALFORMED_INPUT: total is null', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds({ total: null }),
      homeGoalieState: makeGoalieState('FULL'),
      awayGoalieState: makeGoalieState('FULL'),
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('MALFORMED_INPUT');
  });

  test('MALFORMED_INPUT: h2h_home is NaN', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds({ h2h_home: NaN }),
      homeGoalieState: makeGoalieState('FULL'),
      awayGoalieState: makeGoalieState('FULL'),
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('MALFORMED_INPUT');
  });

  test('GOALIE_UNCERTAIN: home goalie NEUTRALIZED', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds(),
      homeGoalieState: makeGoalieState('NEUTRALIZED'),
      awayGoalieState: makeGoalieState('FULL'),
      sigmaGamesSampled: 10,
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('GOALIE_UNCERTAIN');
  });

  test('GOALIE_UNCERTAIN: away goalie BLOCKED', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds(),
      homeGoalieState: makeGoalieState('DEGRADED'),
      awayGoalieState: makeGoalieState('BLOCKED'),
      sigmaGamesSampled: 10,
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('GOALIE_UNCERTAIN');
  });

  test('INSUFFICIENT_DATA: sigma_games_sampled below 5', () => {
    const card = makeCard();
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds(),
      homeGoalieState: makeGoalieState('FULL'),
      awayGoalieState: makeGoalieState('FULL'),
      sigmaGamesSampled: 4,
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('INSUFFICIENT_DATA');
  });

  test('INSUFFICIENT_DATA: uses raw_data.sigma_games_sampled when param not supplied', () => {
    const card = makeCard({ sigma_games_sampled: 3 });
    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds(),
      homeGoalieState: makeGoalieState('FULL'),
      awayGoalieState: makeGoalieState('FULL'),
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(true);
    expect(card.payloadData.raw_data.training_exclusion_reason).toBe('INSUFFICIENT_DATA');
  });

  test('PASS-status card is not auto-excluded by stampTrainingRowExclusion (caller must check status)', () => {
    // Directional exclusion for PASS/HOLD/WATCH is the caller's responsibility —
    // stampTrainingRowExclusion only checks data quality. A PASS card with good data
    // will have training_row_excluded=false; caller filters it via officialStatus/status.
    const card = makeCard();
    card.payloadData.status = 'PASS';
    card.payloadData.officialStatus = 'PASS';

    stampTrainingRowExclusion(card, {
      oddsSnapshot: validOdds(),
      homeGoalieState: makeGoalieState('FULL'),
      awayGoalieState: makeGoalieState('FULL'),
      sigmaGamesSampled: 10,
    });

    expect(card.payloadData.raw_data.training_row_excluded).toBe(false);
  });

  test('PASS/HOLD/WATCH cards excluded from directional training target filter', () => {
    const cards = [
      { payloadData: { status: 'FIRE', officialStatus: 'FIRE' } },
      { payloadData: { status: 'PASS', officialStatus: 'PASS' } },
      { payloadData: { status: 'WATCH', officialStatus: 'WATCH' } },
      { payloadData: { status: 'HOLD', officialStatus: 'HOLD' } },
      { payloadData: { status: 'FIRE', officialStatus: 'FIRE' } },
    ];

    const directionalCandidates = cards.filter((c) => {
      const status = (c.payloadData.officialStatus || c.payloadData.status || '').toUpperCase();
      return status !== 'PASS' && status !== 'HOLD' && status !== 'WATCH';
    });

    expect(directionalCandidates).toHaveLength(2);
    expect(directionalCandidates.every((c) => c.payloadData.status === 'FIRE')).toBe(true);
  });

  test('no-op when raw_data is not initialized', () => {
    const card = { payloadData: {} };
    expect(() => stampTrainingRowExclusion(card, { oddsSnapshot: validOdds() })).not.toThrow();
  });
});
