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
const { generateNHLMarketCallCards } = require('../run_nhl_model');
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
        `CHEDDAR_DB_PATH= DATABASE_PATH=${TEST_DB_PATH} npm run job:run-nhl-model`,
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
});
