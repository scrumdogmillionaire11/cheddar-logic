'use strict';

const { DateTime } = require('luxon');

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(() => 1),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  createJob: jest.fn(),
  wasJobRecentlySuccessful: jest.fn(() => true),
  writePipelineHealthState: jest.fn(),
  buildPipelineHealthCheckId: jest.fn((phase, checkName) => `${phase}:${checkName}`),
}));

jest.mock('../jobs/post_discord_cards', () => ({
  sendDiscordMessages: jest.fn().mockResolvedValue(1),
}));

jest.mock('../jobs/run_mlb_model', () => ({
  buildMlbMarketAvailability: jest.fn(() => ({
    f5_line_ok: true,
    full_game_total_ok: true,
    expect_f5_ml: false,
    f5_ml_ok: true,
  })),
}));

jest.mock('../schedulers/quota', () => ({
  getCurrentQuotaTier: jest.fn(() => 'FULL'),
}));

jest.mock('../jobs/refresh_stale_odds', () => ({
  refreshStaleOdds: jest.fn().mockResolvedValue({
    success: true,
    staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 },
  }),
}));

jest.mock('@cheddar-logic/data/src/feature-flags', () => ({
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock('../jobs/execution-gate-freshness-contract', () => ({
  getContractForSport: jest.fn(() => ({ hardMaxMinutes: 120 })),
}));

jest.mock('@cheddar-logic/odds/src/config', () => ({
  SPORTS_CONFIG: {
    MLB: { active: false, markets: [] },
    NBA: { active: false, markets: [] },
    NHL: { active: false, markets: [] },
    NFL: { active: false, markets: [] },
  },
}));

jest.mock('../jobs/report_settlement_health', () => ({
  collectVisibilityIntegrityDiagnostics: jest.fn(() => ({
    counts: { DISPLAY_LOG_NOT_ENROLLED: 0 },
    displayLogNotEnrolled: { count: 0, samples: [] },
    samples: { DISPLAY_LOG_NOT_ENROLLED: [] },
  })),
}));

const {
  getDatabase,
  insertJobRun,
  markJobRunFailure,
  markJobRunSuccess,
  writePipelineHealthState,
} = require('@cheddar-logic/data');
const {
  checkScheduledGameCardCoverage,
  checkPipelineHealth,
} = require('../jobs/check_pipeline_health');

function makeGame(gameId, sport, minutesFromNow, status = 'scheduled') {
  return {
    game_id: gameId,
    sport,
    status,
    home_team: `${sport}-home-${gameId}`,
    away_team: `${sport}-away-${gameId}`,
    game_time_utc: DateTime.utc().plus({ minutes: minutesFromNow }).toISO(),
  };
}

function makeDb({ games = [], coveredGameIds = new Set(), oddsSnapshotsByGame = {} } = {}) {
  const getGamesInWindow = (startIso, endIso, predicate = () => true) =>
    games.filter((game) => {
      const gameTime = DateTime.fromISO(game.game_time_utc, { zone: 'utc' });
      return (
        gameTime >= DateTime.fromISO(startIso, { zone: 'utc' }) &&
        gameTime <= DateTime.fromISO(endIso, { zone: 'utc' }) &&
        predicate(game)
      );
    });

  return {
    prepare: jest.fn((sql) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (
        normalized.includes('COUNT(cp.id) AS card_count') &&
        normalized.includes("LOWER(COALESCE(g.status, '')) IN ('scheduled', 'pre')")
      ) {
        return {
          all: (sport, startIso, endIso) =>
            getGamesInWindow(
              startIso,
              endIso,
              (game) =>
                String(game.sport).toUpperCase() === String(sport).toUpperCase() &&
                ['scheduled', 'pre'].includes(String(game.status || '').toLowerCase()),
            )
              .sort((a, b) => String(a.game_time_utc).localeCompare(String(b.game_time_utc)))
              .map((game) => ({
                game_id: game.game_id,
                game_time_utc: game.game_time_utc,
                card_count: coveredGameIds.has(game.game_id) ? 1 : 0,
              })),
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) as cnt FROM games') &&
        normalized.includes('WHERE game_time_utc >= ? AND game_time_utc <= ?')
      ) {
        return {
          get: (startIso, endIso) => ({
            cnt: getGamesInWindow(startIso, endIso).length,
          }),
        };
      }

      if (
        normalized.includes('SELECT game_id, game_time_utc, sport FROM games') &&
        normalized.includes('WHERE game_time_utc >= ? AND game_time_utc <= ?')
      ) {
        return {
          all: (startIso, endIso) =>
            getGamesInWindow(startIso, endIso).map((game) => ({
              game_id: game.game_id,
              game_time_utc: game.game_time_utc,
              sport: game.sport,
            })),
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) as cnt FROM games') &&
        normalized.includes('WHERE LOWER(sport) = LOWER(?)')
      ) {
        return {
          get: (sport, startIso, endIso) => ({
            cnt: getGamesInWindow(
              startIso,
              endIso,
              (game) =>
                String(game.sport || '').toLowerCase() === String(sport || '').toLowerCase(),
            ).length,
          }),
        };
      }

      if (
        normalized.includes("SELECT game_id, sport, game_time_utc FROM games") &&
        normalized.includes("WHERE sport = 'NBA'")
      ) {
        return {
          all: (startIso, endIso) =>
            getGamesInWindow(
              startIso,
              endIso,
              (game) => String(game.sport || '').toUpperCase() === 'NBA',
            ).map((game) => ({
              game_id: game.game_id,
              sport: game.sport,
              game_time_utc: game.game_time_utc,
            })),
        };
      }

      if (normalized.includes('SELECT * FROM odds_snapshots WHERE game_id = ?')) {
        return {
          get: (gameId) => oddsSnapshotsByGame[gameId] || null,
        };
      }

      if (
        normalized.includes("SELECT COUNT(*) AS cnt FROM card_payloads") &&
        normalized.includes("card_type = 'nba-moneyline-call'")
      ) {
        return {
          get: () => ({ cnt: 0 }),
        };
      }

      if (
        normalized.includes("SELECT COUNT(DISTINCT g.game_id) AS cnt") &&
        normalized.includes("WHERE g.sport = 'NHL'")
      ) {
        return {
          get: () => ({ cnt: 0 }),
          all: () => [{ cnt: 0 }],
        };
      }

      if (
        normalized.includes("SELECT COUNT(*) AS cnt FROM card_payloads") &&
        normalized.includes("card_type = 'nhl-moneyline-call'")
      ) {
        return {
          get: () => ({ cnt: 0 }),
          all: () => [{ cnt: 0 }],
        };
      }

      if (normalized.includes('COUNT(*) AS total_cards')) {
        return {
          get: () => ({
            total_cards: 0,
            pass_cards: 0,
            missing_odds_cards: 0,
            degraded_cards: 0,
            missing_decision_v2_count: 0,
            invalid_decision_count: 0,
          }),
        };
      }

      if (
        normalized.includes("GROUP BY UPPER(COALESCE(json_extract(payload_data, '$.sport'), 'UNKNOWN'))") ||
        normalized.includes("ORDER BY datetime(created_at) DESC LIMIT 5") ||
        normalized.includes("card_type IN ('nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call')") ||
        normalized.includes("card_type IN ('nba-totals-call', 'nba-spread-call')") ||
        normalized.includes("card_type IN ('mlb-f5', 'mlb-full-game', 'mlb-full-game-ml')") ||
        normalized.includes("SELECT run_id FROM card_payloads WHERE sport = 'MLB' AND run_id IS NOT NULL") ||
        normalized.includes("WHERE UPPER(g.sport) = 'NHL'") ||
        normalized.includes("WHERE LOWER(sport) = 'mlb'") ||
        normalized.includes("LOWER(g.status) IN ('final', 'ft', 'completed')") ||
        normalized.includes("WHERE status = 'final'") ||
        normalized.includes('FROM calibration_reports')
      ) {
        return {
          all: () => [],
          get: () => ({ cnt: 0 }),
        };
      }

      if (normalized.includes('SELECT created_at FROM card_payloads WHERE game_id = ?')) {
        return {
          get: (gameId) =>
            coveredGameIds.has(gameId)
              ? { created_at: DateTime.utc().minus({ minutes: 5 }).toISO() }
              : null,
        };
      }

      if (
        normalized.includes("FROM job_runs") &&
        normalized.includes("status = 'success'")
      ) {
        return {
          get: () => null,
        };
      }

      if (
        normalized.includes("FROM job_runs") &&
        normalized.includes("status = 'failed'")
      ) {
        return {
          get: () => null,
        };
      }

      throw new Error(`Unhandled SQL in scheduled coverage test: ${normalized}`);
    }),
  };
}

describe('checkScheduledGameCardCoverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
  });

  test('returns ok when all scheduled games have at least one card row', () => {
    const games = [
      makeGame('mlb-1', 'MLB', 60),
      makeGame('mlb-2', 'MLB', 90),
      makeGame('mlb-3', 'MLB', 120),
      makeGame('mlb-4', 'MLB', 150),
      makeGame('mlb-5', 'MLB', 180),
    ];
    getDatabase.mockReturnValue(
      makeDb({
        games,
        coveredGameIds: new Set(games.map((game) => game.game_id)),
      }),
    );

    const result = checkScheduledGameCardCoverage('MLB');

    expect(result).toMatchObject({
      ok: true,
      status: 'ok',
      sport: 'MLB',
      diagnostics: {
        total_games: 5,
        covered_games: 5,
        missing_game_ids: [],
      },
    });
    expect(result.reason).toContain('Coverage 5/5 (100%).');
    expect(writePipelineHealthState).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'mlb',
        checkName: 'scheduled_game_card_coverage',
        status: 'ok',
      }),
    );
  });

  test('returns warning when coverage drops below 80 percent but stays at or above 50 percent', () => {
    const games = [
      makeGame('nba-1', 'NBA', 60),
      makeGame('nba-2', 'NBA', 90),
      makeGame('nba-3', 'NBA', 120),
      makeGame('nba-4', 'NBA', 150),
      makeGame('nba-5', 'NBA', 180),
    ];
    getDatabase.mockReturnValue(
      makeDb({
        games,
        coveredGameIds: new Set(['nba-1', 'nba-2', 'nba-3']),
      }),
    );

    const result = checkScheduledGameCardCoverage('NBA');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('warning');
    expect(result.diagnostics).toMatchObject({
      total_games: 5,
      covered_games: 3,
      missing_game_ids: ['nba-4', 'nba-5'],
    });
    expect(result.reason).toContain('Coverage 3/5 (60%). Missing: [nba-4, nba-5]');
    expect(writePipelineHealthState).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'nba',
        checkName: 'scheduled_game_card_coverage',
        status: 'warning',
      }),
    );
  });

  test('returns failed when coverage drops below 50 percent', () => {
    const games = [
      makeGame('nhl-1', 'NHL', 60),
      makeGame('nhl-2', 'NHL', 90),
      makeGame('nhl-3', 'NHL', 120),
      makeGame('nhl-4', 'NHL', 150),
      makeGame('nhl-5', 'NHL', 180),
    ];
    getDatabase.mockReturnValue(
      makeDb({
        games,
        coveredGameIds: new Set(['nhl-1', 'nhl-2']),
      }),
    );

    const result = checkScheduledGameCardCoverage('NHL');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.diagnostics).toMatchObject({
      total_games: 5,
      covered_games: 2,
      missing_game_ids: ['nhl-3', 'nhl-4', 'nhl-5'],
    });
    expect(result.reason).toContain('Coverage 2/5 (40%). Missing: [nhl-3, nhl-4, nhl-5]');
    expect(writePipelineHealthState).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'nhl',
        checkName: 'scheduled_game_card_coverage',
        status: 'failed',
      }),
    );
  });

  test('excludes games inside the 15-minute start buffer from the denominator', () => {
    const games = [
      makeGame('nba-buffered', 'NBA', 10),
      makeGame('nba-counted', 'NBA', 75),
    ];
    getDatabase.mockReturnValue(
      makeDb({
        games,
        coveredGameIds: new Set(['nba-counted']),
      }),
    );

    const result = checkScheduledGameCardCoverage('NBA');

    expect(result).toMatchObject({
      ok: true,
      status: 'ok',
      diagnostics: {
        total_games: 1,
        covered_games: 1,
        missing_game_ids: [],
      },
    });
  });

  test('returns ok when no scheduled games are in the watch window', () => {
    getDatabase.mockReturnValue(
      makeDb({
        games: [makeGame('nba-late', 'NBA', 500)],
        coveredGameIds: new Set(),
      }),
    );

    const result = checkScheduledGameCardCoverage('NBA');

    expect(result).toMatchObject({
      ok: true,
      status: 'ok',
      diagnostics: {
        total_games: 0,
        covered_games: 0,
        missing_game_ids: [],
      },
    });
    expect(result.reason).toContain('no scheduled games between T+15m and T+6h');
  });
});

describe('checkPipelineHealth scheduled game coverage integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'false';
  });

  afterEach(() => {
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
  });

  test('runs the scheduled game coverage checks through the default watchdog runner', async () => {
    getDatabase.mockReturnValue(
      makeDb({
        games: [makeGame('nba-gap-1', 'NBA', 180)],
        coveredGameIds: new Set(),
      }),
    );

    const result = await checkPipelineHealth({
      jobKey: 'wi-1250-runner',
      dryRun: false,
      skipHeartbeat: true,
    });

    expect(insertJobRun).toHaveBeenCalled();
    expect(markJobRunFailure).toHaveBeenCalled();
    expect(markJobRunSuccess).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.criticalHealthIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkName: 'nba_scheduled_game_card_coverage',
        }),
      ]),
    );
    expect(writePipelineHealthState).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'nba',
        checkName: 'scheduled_game_card_coverage',
        status: 'failed',
      }),
    );
  });
});
