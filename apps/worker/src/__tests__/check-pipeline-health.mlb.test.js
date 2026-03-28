'use strict';

describe('checkMlbF5MarketAvailability', () => {
  let upcomingGames;
  let latestOddsByGame;
  let pipelineWrites;
  let checkMlbF5MarketAvailability;

  beforeEach(() => {
    jest.resetModules();
    upcomingGames = [];
    latestOddsByGame = {};
    pipelineWrites = [];

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return {
            run: (...args) => {
              pipelineWrites.push(args);
            },
          };
        }

        if (
          sql.includes("LOWER(sport) = 'mlb'") &&
          sql.includes('FROM games')
        ) {
          return {
            all: () => upcomingGames,
          };
        }

        if (
          sql.includes('FROM odds_snapshots') &&
          sql.includes('ORDER BY captured_at DESC')
        ) {
          return {
            get: (gameId) => latestOddsByGame[gameId] ?? null,
          };
        }

        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDb: jest.fn(() => db),
      recordJobStart: jest.fn(() => 'job-check-health'),
      recordJobSuccess: jest.fn(),
      recordJobError: jest.fn(),
    }));

    ({ checkMlbF5MarketAvailability } = require('../jobs/check_pipeline_health'));
  });

  test('reports MLB F5 availability separately and does not fail when only full-game totals are missing', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-001',
        game_time_utc: '2026-03-27T22:00:00.000Z',
        home_team: 'Yankees',
        away_team: 'Red Sox',
      },
    ];
    latestOddsByGame['mlb-game-001'] = {
      game_id: 'mlb-game-001',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: null,
      total_price_over: null,
      total_price_under: null,
      total_f5: 4.5,
      total_price_over_f5: -112,
      total_price_under_f5: -108,
    };

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(true);
    expect(result.games_checked).toBe(1);
    expect(result.missing_f5_total_count).toBe(0);
    expect(result.missing_full_game_total_count).toBe(1);
    expect(result.reason).toContain('missing full-game totals (informational)');
    expect(pipelineWrites).toEqual([]);
  });

  test('fails with a distinct MLB row when F5 totals are missing', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-002',
        game_time_utc: '2026-03-27T23:00:00.000Z',
        home_team: 'Dodgers',
        away_team: 'Padres',
      },
    ];
    latestOddsByGame['mlb-game-002'] = {
      game_id: 'mlb-game-002',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: 8.0,
      total_price_over: -110,
      total_price_under: -110,
      total_f5: null,
      total_price_over_f5: null,
      total_price_under_f5: null,
      raw_data: JSON.stringify({
        totals: [{ line: 8.0, over: -110, under: -110 }],
      }),
    };

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(false);
    expect(result.missing_f5_total_count).toBe(1);
    expect(result.missing_full_game_total_count).toBe(0);
    expect(result.reason).toContain('missing F5 totals');
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][0]).toBe('mlb');
    expect(pipelineWrites[0][1]).toBe('f5_market_availability');
    expect(pipelineWrites[0][2]).toBe('failed');
  });

  test('keeps F5 ML informational while dormant', () => {
    upcomingGames = [
      {
        game_id: 'mlb-game-003',
        game_time_utc: '2026-03-27T23:30:00.000Z',
        home_team: 'Mets',
        away_team: 'Phillies',
      },
    ];
    latestOddsByGame['mlb-game-003'] = {
      game_id: 'mlb-game-003',
      captured_at: '2026-03-27T18:00:00.000Z',
      total: 8.0,
      total_price_over: -110,
      total_price_under: -110,
      total_f5: 4.0,
      total_price_over_f5: -110,
      total_price_under_f5: -110,
    };

    const result = checkMlbF5MarketAvailability();

    expect(result.ok).toBe(true);
    expect(result.expected_f5_ml_count).toBe(0);
    expect(result.missing_f5_ml_count).toBe(0);
    expect(result.reason).toContain('F5 ML health dormant');
  });
});
