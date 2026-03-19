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
const { initDb, getDatabase, closeDatabase } = require('@cheddar-logic/data');
const { generateNHLMarketCallCards } = require('../run_nhl_model');

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
  await initDb();
  const db = getDatabase();
  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

describe('run_nhl_model job', () => {
  beforeAll(() => {
    process.env.DATABASE_PATH = TEST_DB_PATH;
    // Remove test DB if exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Run odds job first to populate test data
    try {
      execSync(`DATABASE_PATH=${TEST_DB_PATH} npm run job:pull-odds`, {
        cwd: '/Users/ajcolubiale/projects/cheddar-logic/apps/worker',
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
        `DATABASE_PATH=${TEST_DB_PATH} npm run job:run-nhl-model`,
        {
          cwd: '/Users/ajcolubiale/projects/cheddar-logic/apps/worker',
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

  test('card_results auto-enrolls for generated cards', async () => {
    const results = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM card_payloads) AS cards,
          (SELECT COUNT(*) FROM card_results) AS results
      `);
      return stmt.get();
    });

    if (results && results.cards > 0) {
      expect(results.results).toBeGreaterThanOrEqual(results.cards);

      const rows = await queryDb((db) => {
        const stmt = db.prepare(`
          SELECT card_id, sport, status, recommended_bet_type
          FROM card_results
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
