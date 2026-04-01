'use strict';

jest.mock('@cheddar-logic/data', () => ({
  withDb: jest.fn(async (fn) => fn()),
  getDatabase: jest.fn(),
  getUpcomingGames: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  upsertPropEventMapping: jest.fn(),
  getPropEventMapping: jest.fn(),
  recordPropOddsUsage: jest.fn(() => true),
  updatePropOddsUsage: jest.fn(),
  listPropOddsUsage: jest.fn(() => []),
  getPropOddsUsageSummary: jest.fn(() => ({ total_calls: 0, token_cost: 0 })),
}));

jest.mock('../run_mlb_model', () => ({
  resolveMlbTeamLookupKeys: jest.fn((teamName) => [teamName]),
  checkPitcherFreshness: jest.fn(() => 'FRESH'),
  validatePitcherKInputs: jest.fn(() => null),
  buildPitcherKObject: jest.fn((row) => row),
  buildPitcherStrikeoutLookback: jest.fn(() => [
    { strikeouts: 4, number_of_pitches: 86, innings_pitched: 5.0 },
    { strikeouts: 5, number_of_pitches: 87, innings_pitched: 5.1 },
    { strikeouts: 4, number_of_pitches: 85, innings_pitched: 4.2 },
    { strikeouts: 5, number_of_pitches: 88, innings_pitched: 5.0 },
    { strikeouts: 4, number_of_pitches: 84, innings_pitched: 4.1 },
    { strikeouts: 6, number_of_pitches: 89, innings_pitched: 5.2 },
  ]),
  runMLBModel: jest.fn(),
}));

jest.mock('../pull_mlb_pitcher_strikeout_props', () => ({
  pullMlbPitcherStrikeoutProps: jest.fn(),
  fetchUpcomingMlbEvents: jest.fn(),
  resolveGameId: jest.fn(),
}));

const data = require('@cheddar-logic/data');
const modelJob = require('../run_mlb_model');
const pullerJob = require('../pull_mlb_pitcher_strikeout_props');
const candidateEngine = require('../../props/mlb_pitcher_k_candidate_engine');
const budgetController = require('../../props/prop_budget_controller');
const pipelineJob = require('../run_mlb_prop_pipeline');

function makeGame(id, homeTeam = `HOME ${id}`, awayTeam = `AWAY ${id}`) {
  return {
    game_id: id,
    sport: 'MLB',
    home_team: homeTeam,
    away_team: awayTeam,
    game_time_utc: '2026-04-02T19:00:00.000Z',
    status: 'scheduled',
  };
}

function makePitcherRow(team, overrides = {}) {
  return {
    mlb_id: overrides.mlb_id || `${team}-pitcher`,
    full_name: overrides.full_name || `${team} Pitcher`,
    team,
    updated_at: overrides.updated_at || '2026-04-01T12:00:00.000Z',
    k_per_9: overrides.k_per_9 ?? 9.1,
    recent_k_per_9: overrides.recent_k_per_9 ?? 7.8,
    recent_ip: overrides.recent_ip ?? 5.1,
    season_starts: overrides.season_starts ?? 8,
    starts: overrides.starts ?? 8,
    days_since_last_start: overrides.days_since_last_start ?? 5,
    last_three_pitch_counts: overrides.last_three_pitch_counts || [86, 87, 88],
    handedness: overrides.handedness || 'R',
    ...overrides,
  };
}

function makeDb({ games = [], pitcherRows = {}, weatherRows = {} } = {}) {
  return {
    prepare: jest.fn((sql) => {
      if (sql.includes('FROM games')) {
        return {
          all: jest.fn((...args) => {
            if (args.length === 0) return games;
            const requestedIds = new Set(args.map((value) => String(value)));
            return games.filter((game) => requestedIds.has(String(game.game_id)));
          }),
        };
      }
      if (sql.includes('FROM mlb_pitcher_stats')) {
        return {
          get: jest.fn((teamName) => pitcherRows[teamName] || null),
        };
      }
      if (sql.includes('FROM mlb_game_weather')) {
        return {
          get: jest.fn((_gameDate, homeTeam) => weatherRows[homeTeam] || null),
        };
      }
      throw new Error(`Unexpected SQL in test double: ${sql}`);
    }),
  };
}

describe('MLB pitcher-K candidate engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelJob.resolveMlbTeamLookupKeys.mockImplementation((teamName) => [teamName]);
    modelJob.checkPitcherFreshness.mockImplementation((row) =>
      row?.updated_at === '2026-03-30T12:00:00.000Z' ? 'STALE' : 'FRESH',
    );
    modelJob.validatePitcherKInputs.mockImplementation(() => null);
    modelJob.buildPitcherKObject.mockImplementation((row) => row);
    modelJob.buildPitcherStrikeoutLookback.mockImplementation(() => [
      { strikeouts: 4, number_of_pitches: 86, innings_pitched: 5.0 },
      { strikeouts: 5, number_of_pitches: 87, innings_pitched: 5.1 },
      { strikeouts: 4, number_of_pitches: 85, innings_pitched: 4.2 },
      { strikeouts: 5, number_of_pitches: 88, innings_pitched: 5.0 },
      { strikeouts: 4, number_of_pitches: 84, innings_pitched: 4.1 },
      { strikeouts: 6, number_of_pitches: 89, innings_pitched: 5.2 },
    ]);
  });

  test('no eligible pitchers yields an empty candidate set with reason counts', () => {
    const db = makeDb({
      games: [makeGame('game-1')],
      pitcherRows: {},
    });

    const result = candidateEngine.buildMlbPitcherKCandidateSet({
      db,
      now: '2026-04-01T12:00:00.000Z',
    });

    expect(result.candidates).toEqual([]);
    expect(result.meta.total_candidates).toBe(2);
    expect(result.meta.filtered_out).toBe(2);
    expect(result.meta.reason_counts[candidateEngine.REASON_CODES.PITCHER_DATA_MISSING]).toBe(2);
  });

  test('mixed slate emits ranked UNDER candidates with market-aware metadata', () => {
    const db = makeDb({
      games: [makeGame('game-1', 'HOME TEAM', 'AWAY TEAM')],
      pitcherRows: {
        'HOME TEAM': makePitcherRow('HOME TEAM', {
          recent_k_per_9: 7.0,
          recent_ip: 5.0,
          last_three_pitch_counts: [84, 85, 86],
        }),
        'AWAY TEAM': makePitcherRow('AWAY TEAM', {
          recent_k_per_9: 8.4,
          recent_ip: 5.8,
          last_three_pitch_counts: [92, 93, 94],
        }),
      },
      weatherRows: {
        'HOME TEAM': { temp_f: 87 },
      },
    });

    const result = candidateEngine.buildMlbPitcherKCandidateSet({
      db,
      now: '2026-04-01T12:00:00.000Z',
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]).toMatchObject({
      market_family: candidateEngine.MARKET_FAMILY,
      market_type: candidateEngine.MARKET_TYPE,
      selection_type: candidateEngine.SELECTION_TYPE,
    });
    for (const candidate of result.candidates) {
      expect(candidate.market_type).toBe('pitcher_strikeouts');
      expect(candidate.selection_type).toBe('UNDER');
    }
  });
});

describe('prop budget controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MAX_PROP_EVENTS_PER_SLATE = '12';
    process.env.MAX_PROP_EVENTS_PER_GAME = '2';
    process.env.MAX_DAILY_PROP_CALLS = '150';
    process.env.PROP_HOURLY_BURN_CAP = '30';
    process.env.PROP_MONTHLY_BUDGET = '4000';
    process.env.SAFE_MODE_ODDS = 'false';
  });

  function makeCandidate(index, gameId = `game-${index}`) {
    return {
      game_id: gameId,
      player_id: `player-${index}`,
      player_name: `Pitcher ${index}`,
      market_family: candidateEngine.MARKET_FAMILY,
      market_type: candidateEngine.MARKET_TYPE,
      selection_type: candidateEngine.SELECTION_TYPE,
      priority_score: 50 - index,
      confidence: 'HIGH',
      reason_codes: ['TEST'],
    };
  }

  test('10 candidates under the slate cap produce 10 approved pulls', () => {
    const result = budgetController.applyPropBudgetController({
      candidates: Array.from({ length: 10 }, (_, index) => makeCandidate(index + 1)),
      window: 'T60',
      now: '2026-04-01T15:00:00.000Z',
      marketState: 'LIMITED_LIVE',
    });

    expect(result.approvedPulls).toHaveLength(10);
  });

  test('50 candidates are hard-capped at MAX_PROP_EVENTS_PER_SLATE', () => {
    const result = budgetController.applyPropBudgetController({
      candidates: Array.from({ length: 50 }, (_, index) => makeCandidate(index + 1)),
      window: 'T60',
      now: '2026-04-01T15:00:00.000Z',
      marketState: 'LIMITED_LIVE',
    });

    expect(result.approvedPulls).toHaveLength(12);
  });

  test('recent dedupe keys are skipped as RECENTLY_FETCHED', () => {
    const result = budgetController.applyPropBudgetController({
      candidates: [makeCandidate(1), makeCandidate(2)],
      window: 'T60',
      now: '2026-04-01T15:00:00.000Z',
      marketState: 'LIMITED_LIVE',
      recentUsage: [{ dedupe_key: 'game-1:pitcher_strikeouts:T60|2026-04-01T15:00' }],
    });

    expect(result.approvedPulls).toHaveLength(1);
    expect(result.skipped[0].reason).toBe(budgetController.SKIP_REASONS.RECENTLY_FETCHED);
  });

  test('burn-rate watchdog disables prop odds mode', () => {
    const result = budgetController.applyPropBudgetController({
      candidates: [makeCandidate(1)],
      window: 'T60',
      now: '2026-04-01T15:00:00.000Z',
      marketState: 'LIMITED_LIVE',
      hourlySummary: { token_cost: 31 },
      dailySummary: { total_calls: 0, token_cost: 0 },
      monthlySummary: { token_cost: 50 },
    });

    expect(result.globalReason).toBe(budgetController.SKIP_REASONS.BURN_RATE_EXCEEDED);
    expect(result.approvedPulls).toHaveLength(0);
  });
});

describe('runMlbPropPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MLB_K_PROPS = 'LIMITED_LIVE';
    process.env.SAFE_MODE_ODDS = 'false';
    process.env.MAX_PROP_EVENTS_PER_SLATE = '12';
    process.env.MAX_PROP_EVENTS_PER_GAME = '2';
    process.env.MAX_DAILY_PROP_CALLS = '150';
    process.env.PROP_HOURLY_BURN_CAP = '30';
    process.env.PROP_MONTHLY_BUDGET = '4000';
    process.env.ODDS_API_KEY = 'test-key';
    pullerJob.fetchUpcomingMlbEvents.mockResolvedValue({
      events: [{ id: 'evt-1', commence_time: '2026-04-02T19:00:00.000Z' }],
    });
    pullerJob.resolveGameId.mockImplementation((_db, event) => event.id.replace('evt-', 'game-'));
    pullerJob.pullMlbPitcherStrikeoutProps.mockResolvedValue({
      success: true,
      skipped: false,
      tokenCost: 1,
      remainingQuota: 222,
    });
    modelJob.runMLBModel.mockResolvedValue({
      success: true,
      pitcher_prop_summary: {},
    });
  });

  test('no candidates means no Odds API call', async () => {
    const db = makeDb({ games: [] });
    data.getDatabase.mockReturnValue(db);
    data.getUpcomingGames.mockReturnValue([]);

    const result = await pipelineJob.runMlbPropPipeline({
      jobKey: 'pipeline|empty',
      window: 'T60',
    });

    expect(result.success).toBe(true);
    expect(result.skipped_reason).toBe(budgetController.SKIP_REASONS.NO_CANDIDATES);
    expect(pullerJob.fetchUpcomingMlbEvents).not.toHaveBeenCalled();
    expect(pullerJob.pullMlbPitcherStrikeoutProps).not.toHaveBeenCalled();
  });

  test('missing event mapping skips without a scoped pull or fallback', async () => {
    const games = [makeGame('game-1', 'HOME TEAM', 'AWAY TEAM')];
    const db = makeDb({
      games,
      pitcherRows: {
        'HOME TEAM': makePitcherRow('HOME TEAM', {
          recent_k_per_9: 7.0,
          recent_ip: 5.0,
          last_three_pitch_counts: [84, 85, 86],
        }),
        'AWAY TEAM': makePitcherRow('AWAY TEAM', {
          recent_k_per_9: 7.6,
          recent_ip: 5.1,
          last_three_pitch_counts: [85, 86, 87],
        }),
      },
      weatherRows: { 'HOME TEAM': { temp_f: 86 } },
    });
    data.getDatabase.mockReturnValue(db);
    data.getUpcomingGames.mockReturnValue(games);
    data.getPropEventMapping.mockReturnValue(null);

    const result = await pipelineJob.runMlbPropPipeline({
      jobKey: 'pipeline|missing-event',
      window: 'T60',
    });

    expect(result.success).toBe(true);
    expect(pullerJob.pullMlbPitcherStrikeoutProps).not.toHaveBeenCalled();
    expect(data.recordPropOddsUsage).toHaveBeenCalled();
    expect(data.updatePropOddsUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: budgetController.SKIP_REASONS.NO_EVENT_ID }),
    );
  });

  test('10 games at T-60 produce 10 scoped prop pulls and no full-slate fetch path', async () => {
    const games = Array.from({ length: 10 }, (_, index) =>
      makeGame(`game-${index + 1}`, `HOME ${index + 1}`, `AWAY ${index + 1}`),
    );
    const pitcherRows = {};
    const weatherRows = {};
    for (const game of games) {
      pitcherRows[game.home_team] = makePitcherRow(game.home_team, {
        recent_k_per_9: 7.0,
        recent_ip: 5.0,
        last_three_pitch_counts: [84, 85, 86],
      });
      pitcherRows[game.away_team] = makePitcherRow(game.away_team, {
        recent_k_per_9: 7.4,
        recent_ip: 5.1,
        last_three_pitch_counts: [85, 86, 87],
      });
      weatherRows[game.home_team] = { temp_f: 86 };
    }

    data.getDatabase.mockReturnValue(makeDb({ games, pitcherRows, weatherRows }));
    data.getUpcomingGames.mockReturnValue(games);
    data.getPropEventMapping.mockImplementation(({ gameId }) => ({
      odds_event_id: `evt-${gameId}`,
      expires_at: '2026-04-02T19:00:00.000Z',
      status: 'ACTIVE',
    }));
    modelJob.runMLBModel.mockResolvedValue({
      success: true,
      pitcher_prop_summary: Object.fromEntries(
        games.map((game) => [
          game.game_id,
          { executable_props_published: 1, leans_only_count: 0, pass_count: 0 },
        ]),
      ),
    });

    const result = await pipelineJob.runMlbPropPipeline({
      jobKey: 'pipeline|t60',
      window: 'T60',
    });

    expect(result.success).toBe(true);
    expect(pullerJob.pullMlbPitcherStrikeoutProps).toHaveBeenCalledTimes(10);
    for (const call of pullerJob.pullMlbPitcherStrikeoutProps.mock.calls) {
      expect(call[0]).toMatchObject({
        gameId: expect.any(String),
        oddsEventId: expect.any(String),
        pipelineMode: true,
        requireScoped: true,
      });
    }
    expect(modelJob.runMLBModel).toHaveBeenCalledWith(
      expect.objectContaining({
        gameIds: expect.arrayContaining(games.map((game) => game.game_id)),
      }),
    );
    expect(result.telemetry.scoped_calls).toBe(10);
  });
});
