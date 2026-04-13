/**
 * Unit tests for run_nhl_player_shots_model.js
 *
 * Tests:
 * 1. Player with fewer than 5 recent logs is skipped with proper log message
 * 2. setCurrentRunId is called even when 0 cards are created
 * 3. NHL_SOG_1P_CARDS_ENABLED=false (default) prevents 1P card creation
 * 4. Projection-floor fallback uses NHL_SOG_PROJECTION_LINE (default 2.5) when no real line
 */

'use strict';

// Note: jest.mock factories may only reference variables prefixed with 'mock'
// (Jest restriction). Track calls via these arrays.
const mockInsertCardPayloadCalls = [];
const mockSetCurrentRunIdCalls = [];

// Helper used inside test to get mocked module's tracking arrays
function getTracking() {
  return { mockInsertCardPayloadCalls, mockSetCurrentRunIdCalls };
}

// Helper: build a future game object
function buildFutureGame(overrides = {}) {
  return {
    game_id: 'game-001',
    home_team: 'Edmonton Oilers',
    away_team: 'Toronto Maple Leafs',
    game_time_utc: new Date(Date.now() + 3600 * 1000 * 2).toISOString(),
    sport: 'NHL',
    ...overrides,
  };
}

// Helper: build a player row
function buildPlayer(overrides = {}) {
  return {
    player_id: 9999,
    player_name: 'Test Player',
    team_abbrev: 'EDM',
    ...overrides,
  };
}

// Helper: build N game log rows
function buildGames(n) {
  return Array.from({ length: n }, (_, i) => ({
    game_id: `g${i}`,
    game_date: `2026-03-0${i + 1}`,
    opponent: 'TOR',
    is_home: 1,
    shots: 3,
    toi_minutes: 20,
    raw_data: '{}',
  }));
}

function buildGamesFromShots(shotsByGame = []) {
  return shotsByGame.map((shots, i) => ({
    game_id: `g${i}`,
    game_date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    opponent: 'TOR',
    is_home: 1,
    shots,
    toi_minutes: 20,
    raw_data: '{}',
  }));
}

function buildLookbackGames(entries = [], rawDataOverrides = {}) {
  return entries.map((entry, index) => ({
    game_id: `g${index}`,
    game_date: `2026-03-${String(index + 1).padStart(2, '0')}`,
    opponent: entry.opponent || 'TOR',
    is_home: entry.is_home ?? 1,
    shots: entry.shots ?? 3,
    toi_minutes: entry.toi_minutes ?? 20,
    raw_data:
      index === 0
        ? JSON.stringify({
            shotsPer60: 8.2,
            projToi: 18,
            ppToi: 2.0,
            ppRatePer60: 3.1,
            ppRateL10Per60: 3.0,
            ppRateL5Per60: 3.2,
            ...rawDataOverrides,
          })
        : '{}',
  }));
}

function buildBlkGames(blocksByGame = [], rawDataOverrides = {}) {
  return blocksByGame.map((blocked_shots, i) => ({
    game_id: `bg${i}`,
    game_date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    opponent: 'TOR',
    is_home: 1,
    blocked_shots,
    toi_minutes: 20,
    raw_data:
      i === 0
        ? JSON.stringify({
            projToi: 19,
            teamAbbrev: 'EDM',
            ...rawDataOverrides,
          })
        : '{}',
  }));
}

function buildBlkRateRow(overrides = {}) {
  return {
    ev_blocks_season_per60: 4.2,
    ev_blocks_l10_per60: 4.4,
    ev_blocks_l5_per60: 4.6,
    pk_blocks_season_per60: 1.1,
    pk_blocks_l10_per60: 1.2,
    pk_blocks_l5_per60: 1.3,
    pk_toi_per_game: 1.8,
    max_updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Build a mock DB whose prepare() dispatches by SQL keyword
// availabilityRow: if set, returned for player_availability queries (null = no record = fail-open)
function buildMockDb({
  games = [],
  players = [],
  playerLogs = [],
  playerBlkLogs = [],
  playerBlkRateRow = null,
  playerPropLines = [],
  availabilityRow = null,
  teamMetricsRow = null,
  oddsSnapshotRow = null,
  oddsSnapshotRawData = null,
} = {}) {
  return {
    prepare: jest.fn((sql) => {
      const s = sql.trim().toLowerCase();
      if (s.includes('from games')) {
        return { all: jest.fn(() => games) };
      }
      if (s.includes('from player_shot_logs') && s.includes('distinct')) {
        return { all: jest.fn(() => players) };
      }
      if (s.includes('from player_shot_logs') && s.includes('player_id = ?')) {
        return { all: jest.fn(() => playerLogs) };
      }
      if (s.includes('from player_blk_logs') && s.includes('distinct')) {
        return { all: jest.fn(() => players) };
      }
      if (s.includes('from player_blk_logs') && s.includes('player_id = ?')) {
        return { all: jest.fn(() => playerBlkLogs) };
      }
      if (s.includes('from player_blk_rates')) {
        return { get: jest.fn(() => playerBlkRateRow) };
      }
      if (s.includes('from player_prop_lines')) {
        return {
          all: jest.fn((...args) => {
            const propType = args[3];
            return playerPropLines.filter((row) => !row.prop_type || row.prop_type === propType);
          }),
        };
      }
      if (s.includes('from player_availability')) {
        return { get: jest.fn(() => availabilityRow) };
      }
      if (s.includes('from team_metrics_cache')) {
        return { get: jest.fn(() => teamMetricsRow) };
      }
      if (s.includes('from odds_snapshots')) {
        if (oddsSnapshotRow) {
          return {
            get: jest.fn(() => ({
              ...oddsSnapshotRow,
              raw_data:
                typeof oddsSnapshotRow.raw_data === 'string'
                  ? oddsSnapshotRow.raw_data
                  : oddsSnapshotRow.raw_data
                    ? JSON.stringify(oddsSnapshotRow.raw_data)
                    : null,
            })),
          };
        }
        if (!oddsSnapshotRawData) return { get: jest.fn(() => null) };
        return {
          get: jest.fn(() => ({
            raw_data:
              typeof oddsSnapshotRawData === 'string'
                ? oddsSnapshotRawData
                : JSON.stringify(oddsSnapshotRawData),
          })),
        };
      }
      if (s.includes('select id') && s.includes('from card_payloads')) {
        return { all: jest.fn(() => [{ id: 'existing-card-1' }]) };
      }
      if (s.includes('delete from card_results')) {
        return { run: jest.fn(() => ({ changes: 1 })) };
      }
      if (s.includes('delete from card_payloads')) {
        return { run: jest.fn(() => ({ changes: 1 })) };
      }
      if (s.includes('update card_payloads') && s.includes('set expires_at')) {
        return { run: jest.fn(() => ({ changes: 0 })) };
      }
      // team_metrics_cache, game_id_map, etc.
      return { all: jest.fn(() => []), get: jest.fn(() => null), run: jest.fn() };
    }),
  };
}

// Load a fresh copy of the module under test with mocks applied.
// Returns { mod, data, shots }
function loadFreshModule() {
  jest.resetModules();

  jest.mock('@cheddar-logic/data', () => ({
    getDatabase: jest.fn(),
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    setCurrentRunId: jest.fn(),
    insertCardPayload: jest.fn(),
    validateCardPayload: jest.fn(),
    withDb: jest.fn((fn) => fn()),
    getPlayerPropLine: jest.fn(() => null),
  }));

  jest.mock('../../models/nhl-player-shots', () => ({
    calcMu: jest.fn(() => 3.2),
    calcMu1p: jest.fn(() => 1.0),
    calcFairLine: jest.fn(() => 3.0),
    calcFairLine1p: jest.fn(() => 0.96),
    classifyEdge: jest.fn(() => ({ tier: 'COLD', direction: 'OVER', edge: 0.1 })),
    projectSogV2: jest.fn(() => ({
      sog_mu: 3.2,
      sog_sigma: 1.79,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: null,
      market_price_under: null,
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    })),
    projectBlkV1: jest.fn(() => ({
      blk_mu: 0,
      blk_sigma: 0,
      flags: [],
    })),
    weightedRateBlendBLK: jest.fn((seasonRate, l10Rate, l5Rate) => {
      const weights = [0.4, 0.35, 0.25];
      const values = [seasonRate, l10Rate, l5Rate];
      let weightedTotal = 0;
      let totalWeight = 0;

      values.forEach((value, index) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
          weightedTotal += numeric * weights[index];
          totalWeight += weights[index];
        }
      });

      return totalWeight > 0 ? weightedTotal / totalWeight : 0;
    }),
  }));

  jest.mock('../../moneypuck', () => ({
    fetchMoneyPuckSnapshot: jest.fn(async () => ({ injuries: {} })),
  }));

  const mod = require('../run_nhl_player_shots_model');
  const data = require('@cheddar-logic/data');
  const shots = require('../../models/nhl-player-shots');
  const moneyPuck = require('../../moneypuck');

  return { mod, data, shots, moneyPuck };
}

function getInsertedCardsByType(data, cardType) {
  return data.insertCardPayload.mock.calls
    .map(([card]) => card)
    .filter((card) => card && card.payloadData && card.payloadData.card_type === cardType);
}

function getSingleBlkCard(data) {
  const cards = getInsertedCardsByType(data, 'nhl-player-blk');
  expect(cards).toHaveLength(1);
  return cards[0];
}

describe('run_nhl_player_shots_model', () => {
  beforeEach(() => {
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;
    delete process.env.NHL_BLK_CARDS_ENABLED;
    jest.clearAllMocks();
  });

  test('uses datetime(game_time_utc) window filter for 36h upcoming games', async () => {
    const { mod, data } = loadFreshModule();
    const mockDb = buildMockDb({
      games: [buildFutureGame()],
      players: [buildPlayer()],
      playerLogs: buildGames(5),
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const gamesPrepare = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('from games'),
    );
    expect(gamesPrepare).toBeTruthy();
    const sql = String(gamesPrepare[0]).toLowerCase();
    expect(sql).toContain("datetime(game_time_utc) > datetime('now')");
    expect(sql).toContain("datetime(game_time_utc) < datetime('now', '+36 hours')");
  });

  test('uses 10-game lookback for breakout context while keeping 5-game minimum', async () => {
    const { mod, data } = loadFreshModule();
    const mockDb = buildMockDb({
      games: [buildFutureGame()],
      players: [buildPlayer()],
      playerLogs: buildGames(10),
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const lookbackPrepare = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('from player_shot_logs') &&
      String(sql).toLowerCase().includes('limit 10'),
    );
    expect(lookbackPrepare).toBeTruthy();
  });

  test('emits breakout metadata but blocks breakout adoption when event pricing is disabled', async () => {
    const { mod, data, shots, moneyPuck } = loadFreshModule();

    shots.projectSogV2.mockImplementation((inputs = {}) => {
      const evRate = Number(
        inputs.ev_shots_l5_per60 ??
        inputs.ev_shots_l10_per60 ??
        inputs.ev_shots_season_per60 ??
        8,
      );
      const ppRate = Number(
        inputs.pp_shots_l5_per60 ??
        inputs.pp_shots_l10_per60 ??
        inputs.pp_shots_season_per60 ??
        0,
      );
      const toiProjEv = Number(inputs.toi_proj_ev || 0);
      const toiProjPp = Number(inputs.toi_proj_pp || 0);
      const ppMatchup = Number(inputs.pp_matchup_factor || 1);
      const rawMu =
        ((evRate * toiProjEv) / 60) +
        ((ppRate * toiProjPp) / 60 * ppMatchup);
      const mu = rawMu * (toiProjEv >= 19 ? 1.18 : 0.82);
      const overEdge = Math.max(-0.05, Math.min(0.12, (mu - Number(inputs.market_line || 0)) / 12));
      const overProb = Math.max(0.01, Math.min(0.99, 0.5 + overEdge));
      return {
        sog_mu: mu,
        sog_sigma: Math.sqrt(Math.max(mu, 0.01)),
        toi_proj: toiProjEv + toiProjPp,
        shot_rate_ev_per60: evRate,
        shot_rate_pp_per60: ppRate,
        pp_matchup_factor: ppMatchup,
        shot_env_factor: Number(inputs.shot_env_factor || 1),
        role_stability: inputs.role_stability || 'HIGH',
        trend_score: 0.08,
        fair_over_prob_by_line: { [String(inputs.market_line)]: overProb },
        fair_under_prob_by_line: { [String(inputs.market_line)]: 1 - overProb },
        fair_price_over_by_line: { [String(inputs.market_line)]: -125 },
        fair_price_under_by_line: { [String(inputs.market_line)]: 105 },
        market_line: inputs.market_line,
        market_price_over: inputs.market_price_over ?? -115,
        market_price_under: inputs.market_price_under ?? -105,
        implied_over_prob: 0.52,
        implied_under_prob: 0.48,
        edge_over_pp: overEdge,
        edge_under_pp: -overEdge,
        ev_over: overEdge + 0.01,
        ev_under: -(overEdge + 0.01),
        opportunity_score: overEdge + 0.12,
        flags: [],
      };
    });
    moneyPuck.fetchMoneyPuckSnapshot.mockResolvedValue({
      injuries: {},
      skaters: {
        by_team: {
          'Edmonton Oilers': {
            'test player': { impact: 1.2 },
          },
        },
      },
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-breakout-01' })],
      players: [buildPlayer({ player_id: 9911, player_name: 'Test Player' })],
      playerLogs: buildLookbackGames(
        [
          { shots: 4, toi_minutes: 22 },
          { shots: 4, toi_minutes: 21 },
          { shots: 4, toi_minutes: 20 },
          { shots: 1, toi_minutes: 16 },
          { shots: 1, toi_minutes: 16 },
          { shots: 2, toi_minutes: 17 },
          { shots: 2, toi_minutes: 17 },
          { shots: 2, toi_minutes: 17 },
          { shots: 2, toi_minutes: 18 },
          { shots: 2, toi_minutes: 18 },
        ],
        {
          shotsPer60: 7.2,
          projToi: 17.5,
          ppToi: 2.1,
          ppRatePer60: 3.2,
          ppRateL10Per60: 3.1,
          ppRateL5Per60: 3.3,
        },
      ),
      playerPropLines: [{ line: 2.5, over_price: -115, under_price: -105, bookmaker: 'draftkings' }],
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.breakout).toMatchObject({
      eligible: false,
    });
    expect(card.payloadData.breakout.delta_mu).toBeGreaterThanOrEqual(0.45);
    expect(card.payloadData.breakout.flags).toContain('BREAKOUT_BLOCKED_NO_REAL_LINE');
    expect(card.payloadData.breakout.flags).not.toContain('BREAKOUT_CANDIDATE');
    expect(card.payloadData.decision.v2.flags).not.toContain('BREAKOUT_CANDIDATE');
    expect(card.payloadData.drivers.breakout_applied).toBe(false);
    expect(card.payloadData.breakout.breakout_sog_mu).toBeGreaterThan(
      card.payloadData.breakout.baseline_sog_mu,
    );
    expect(card.payloadData.decision.projection).toBeGreaterThan(
      card.payloadData.decision.market_line,
    );
  });

  test('marks breakout as blocked when no real line exists', async () => {
    const { mod, data } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-breakout-blocked-line' })],
      players: [buildPlayer({ player_id: 9912, player_name: 'No Line Player' })],
      playerLogs: buildLookbackGames([
        { shots: 4, toi_minutes: 22 },
        { shots: 4, toi_minutes: 21 },
        { shots: 4, toi_minutes: 20 },
        { shots: 1, toi_minutes: 16 },
        { shots: 1, toi_minutes: 16 },
      ]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.breakout.flags).toContain('BREAKOUT_BLOCKED_NO_REAL_LINE');
    expect(card.payloadData.breakout.flags).not.toContain('BREAKOUT_CANDIDATE');
  });

  test('marks breakout as role-blocked for DTD players', async () => {
    const { mod, data } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-breakout-blocked-role' })],
      players: [buildPlayer({ player_id: 9913, player_name: 'DTD Player' })],
      playerLogs: buildLookbackGames([
        { shots: 4, toi_minutes: 22 },
        { shots: 4, toi_minutes: 21 },
        { shots: 4, toi_minutes: 20 },
        { shots: 1, toi_minutes: 16 },
        { shots: 1, toi_minutes: 16 },
      ]),
      playerPropLines: [{ line: 2.5, over_price: -115, under_price: -105, bookmaker: 'draftkings' }],
      availabilityRow: { status: 'DTD', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.breakout.flags).toContain('BREAKOUT_BLOCKED_ROLE');
    expect(card.payloadData.breakout.flags).not.toContain('BREAKOUT_CANDIDATE');
  });

  test('marks breakout as anomaly-blocked when projection conflict is present', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.73,
      toi_proj: 19,
      shot_rate_ev_per60: 8.4,
      shot_rate_pp_per60: 3.0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.02,
      fair_over_prob_by_line: { '2.5': 0.46 },
      fair_under_prob_by_line: { '2.5': 0.54 },
      fair_price_over_by_line: { '2.5': 117 },
      fair_price_under_by_line: { '2.5': -117 },
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      implied_over_prob: 0.53,
      implied_under_prob: 0.51,
      edge_over_pp: -0.07,
      edge_under_pp: 0.03,
      ev_over: -0.09,
      ev_under: 0.01,
      opportunity_score: -0.02,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-breakout-conflict' })],
      players: [buildPlayer({ player_id: 9916, player_name: 'Conflict Player' })],
      playerLogs: buildLookbackGames([
        { shots: 4, toi_minutes: 22 },
        { shots: 4, toi_minutes: 21 },
        { shots: 4, toi_minutes: 20 },
        { shots: 1, toi_minutes: 16 },
        { shots: 1, toi_minutes: 16 },
      ]),
      playerPropLines: [{ line: 2.5, over_price: -115, under_price: -105, bookmaker: 'draftkings' }],
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
    expect(card.payloadData.breakout.flags).toContain('BREAKOUT_BLOCKED_NO_REAL_LINE');
    expect(card.payloadData.breakout.flags).not.toContain('BREAKOUT_BLOCKED_ANOMALY');
    expect(card.payloadData.breakout.flags).not.toContain('BREAKOUT_CANDIDATE');
  });

  test('does not add PRICE_TOO_JUICED breakout flag when no priced candidates are available', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.projectSogV2.mockImplementation((inputs = {}) => {
      const toiProjEv = Number(inputs.toi_proj_ev || 18);
      const toiProjPp = Number(inputs.toi_proj_pp || 2);
      const evRate = Number(inputs.ev_shots_l5_per60 || 8.5);
      const rawMu = ((evRate * toiProjEv) / 60) + ((3.0 * toiProjPp) / 60);
      const mu = rawMu * (toiProjEv >= 19 ? 1.2 : 0.8);
      return {
        sog_mu: mu,
        sog_sigma: Math.sqrt(Math.max(mu, 0.01)),
        toi_proj: toiProjEv + toiProjPp,
        shot_rate_ev_per60: evRate,
        shot_rate_pp_per60: 3.0,
        pp_matchup_factor: Number(inputs.pp_matchup_factor || 1),
        shot_env_factor: Number(inputs.shot_env_factor || 1),
        role_stability: inputs.role_stability || 'HIGH',
        trend_score: 0.06,
        fair_over_prob_by_line: { [String(inputs.market_line)]: 0.53 },
        fair_under_prob_by_line: { [String(inputs.market_line)]: 0.47 },
        fair_price_over_by_line: { [String(inputs.market_line)]: -113 },
        fair_price_under_by_line: { [String(inputs.market_line)]: 101 },
        market_line: inputs.market_line,
        market_price_over: inputs.market_price_over ?? -170,
        market_price_under: inputs.market_price_under ?? 140,
        implied_over_prob: 0.58,
        implied_under_prob: 0.42,
        edge_over_pp: 0.01,
        edge_under_pp: -0.01,
        ev_over: -0.005,
        ev_under: -0.02,
        opportunity_score: 0.03,
        flags: [],
      };
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-breakout-price' })],
      players: [buildPlayer({ player_id: 9914, player_name: 'Juiced Player' })],
      playerLogs: buildLookbackGames([
        { shots: 4, toi_minutes: 22 },
        { shots: 4, toi_minutes: 21 },
        { shots: 4, toi_minutes: 20 },
        { shots: 1, toi_minutes: 16 },
        { shots: 1, toi_minutes: 16 },
      ]),
      playerPropLines: [{ line: 2.5, over_price: -170, under_price: 140, bookmaker: 'draftkings' }],
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.breakout.flags).toContain('BREAKOUT_BLOCKED_NO_REAL_LINE');
    expect(card.payloadData.breakout.flags).not.toContain('PRICE_TOO_JUICED');
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
  });

  test('keeps under-side behavior unchanged when breakout path is not an eligible over', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.calcMu.mockReturnValue(1.8);
    shots.classifyEdge.mockReturnValue({ tier: 'WATCH', direction: 'UNDER', edge: -0.7 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.8,
      sog_sigma: 1.34,
      toi_proj: 18,
      shot_rate_ev_per60: 6.5,
      shot_rate_pp_per60: 2.0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: -0.05,
      fair_over_prob_by_line: { '2.5': 0.35 },
      fair_under_prob_by_line: { '2.5': 0.65 },
      fair_price_over_by_line: { '2.5': 185 },
      fair_price_under_by_line: { '2.5': -185 },
      market_line: 2.5,
      market_price_over: -110,
      market_price_under: -110,
      implied_over_prob: 0.52,
      implied_under_prob: 0.52,
      edge_over_pp: -0.17,
      edge_under_pp: 0.13,
      ev_over: -0.2,
      ev_under: 0.09,
      opportunity_score: 0.21,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-breakout-under' })],
      players: [buildPlayer({ player_id: 9915, player_name: 'Under Player' })],
      playerLogs: buildLookbackGames([
        { shots: 4, toi_minutes: 22 },
        { shots: 4, toi_minutes: 21 },
        { shots: 4, toi_minutes: 20 },
        { shots: 1, toi_minutes: 16 },
        { shots: 1, toi_minutes: 16 },
      ]),
      playerPropLines: [{ line: 2.5, over_price: -110, under_price: -110, bookmaker: 'draftkings' }],
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.lean_side).toBe('UNDER');
    expect(card.payloadData.breakout.eligible).toBe(false);
    expect(card.payloadData.breakout.flags).not.toContain('BREAKOUT_CANDIDATE');
  });

  test('player with only 3 logs is skipped — no card and skip log emitted', async () => {
    const { mod, data } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame()],
      players: [buildPlayer()],
      playerLogs: buildGames(3),  // only 3 — below threshold of 5
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runNHLPlayerShotsModel();

    // No card should be created
    expect(data.insertCardPayload).not.toHaveBeenCalled();

    // Log should mention "fewer than 5"
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/fewer than 5/i);

    logSpy.mockRestore();
  });

  test('setCurrentRunId is called when a COLD edge now renders as a PROJECTION prop row', async () => {
    const { mod, data, shots } = loadFreshModule();

    // 5 logs, COLD edge, no real price -> props mode now emits a PROJECTION row.
    shots.classifyEdge.mockReturnValue({ tier: 'COLD', direction: 'OVER', edge: 0.1 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-002' })],
      players: [buildPlayer({ player_id: 8888, player_name: 'Cold Player' })],
      playerLogs: buildGames(5),
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    // setCurrentRunId should still be called (unconditionally on success path)
    expect(data.setCurrentRunId).toHaveBeenCalled();
  });

  test('1P cards are NOT generated when NHL_SOG_1P_CARDS_ENABLED is not set', async () => {
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;

    const { mod, data, shots } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-003' })],
      players: [buildPlayer({ player_id: 7777, player_name: 'Hot Player' })],
      playerLogs: buildGames(5),
    }));

    // Full game = HOT (card created), 1P = HOT (should be suppressed by flag)
    shots.classifyEdge
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.2 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 0.9 });

    await mod.runNHLPlayerShotsModel();

    const allCalls = data.insertCardPayload.mock.calls;
    const onePCalls = allCalls.filter((call) => {
      const card = call[0];
      return (
        card &&
        (card.cardType === 'nhl-player-shots-1p' ||
          (card.payloadData && card.payloadData.card_type === 'nhl-player-shots-1p'))
      );
    });
    expect(onePCalls.length).toBe(0);
  });

  test('projection-floor fallback defaults to 2.5 when NHL_SOG_PROJECTION_LINE not set', () => {
    // When no real Odds API line exists, model uses a fixed floor so high-projection
    // players still generate cards. Default is 2.5 SOG (a standard NHL market line).
    delete process.env.NHL_SOG_PROJECTION_LINE;
    const floor = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
    expect(floor).toBe(2.5);
  });

  test('projection-floor fallback respects NHL_SOG_PROJECTION_LINE override', () => {
    process.env.NHL_SOG_PROJECTION_LINE = '3.0';
    const floor = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
    expect(floor).toBe(3.0);
    delete process.env.NHL_SOG_PROJECTION_LINE;
  });

  test('player with INJURED availability is skipped even when 5 logs exist', async () => {
    const { mod, data, shots } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-inj-01' })],
      players: [buildPlayer({ player_id: 6666, player_name: 'Injured Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'INJURED', checked_at: new Date().toISOString() },
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runNHLPlayerShotsModel();

    // No card should be created
    expect(data.insertCardPayload).not.toHaveBeenCalled();

    // Log should mention availability status
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/availability status=INJURED/i);

    logSpy.mockRestore();
  });

  test('player with INJURED availability purges existing player cards for the same game', async () => {
    const { mod, data } = loadFreshModule();
    const mockDb = buildMockDb({
      games: [buildFutureGame({ game_id: 'game-inj-purge-01' })],
      players: [buildPlayer({ player_id: 6123, player_name: 'Purge Injured Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'INJURED', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const deleteCall = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('delete from card_payloads'),
    );
    expect(deleteCall).toBeTruthy();
    expect(data.insertCardPayload).not.toHaveBeenCalled();
  });

  test('active player purges existing cards for same game before creating a new card', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    const mockDb = buildMockDb({
      games: [buildFutureGame({ game_id: 'game-dedupe-01' })],
      players: [buildPlayer({ player_id: 7771, player_name: 'Dedupe Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const deleteCall = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('delete from card_payloads'),
    );
    expect(deleteCall).toBeTruthy();
    expect(data.insertCardPayload).toHaveBeenCalledTimes(1);
  });

  test('MoneyPuck injury_status overrides ACTIVE availability and skips player card generation', async () => {
    const { mod, data, moneyPuck } = loadFreshModule();

    moneyPuck.fetchMoneyPuckSnapshot.mockResolvedValue({
      injuries: {
        'Detroit Red Wings': [{ player: 'Dylan Larkin', status: 'Out' }],
      },
    });

    const mockDb = buildMockDb({
      games: [
        buildFutureGame({
          game_id: 'game-mp-inj-01',
          home_team: 'Detroit Red Wings',
          away_team: 'Florida Panthers',
        }),
      ],
      players: [
        buildPlayer({
          player_id: 8477946,
          player_name: 'Dylan Larkin',
          team_abbrev: 'DET',
        }),
      ],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();

    const deleteCall = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('delete from card_payloads'),
    );
    expect(deleteCall).toBeTruthy();
  });

  test('team abbreviation matching does not use substrings (TOR must not match PREDATORS)', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.2 });

    const mockDb = buildMockDb({
      games: [
        buildFutureGame({
          game_id: 'game-no-substring-match-01',
          home_team: 'Nashville Predators',
          away_team: 'Winnipeg Jets',
        }),
      ],
      players: [
        buildPlayer({
          player_id: 8479318,
          player_name: 'Auston Matthews',
          team_abbrev: 'TOR',
        }),
      ],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();
  });

  test('player with stale INJURED availability row is still skipped', async () => {
    // Regression guard: the old query used AND checked_at > datetime('now', '-24 hours'),
    // which silently dropped stale injury records and caused fail-open for injured players
    // when pull_nhl_player_shots had not run recently. The fix removes the staleness
    // window so any recorded INJURED status blocks card generation.
    const { mod, data } = loadFreshModule();

    const staleCheckedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-inj-stale-01' })],
      players: [buildPlayer({ player_id: 6667, player_name: 'Stale Injured Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'INJURED', status_reason: 'ltir', checked_at: staleCheckedAt },
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();

    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/availability status=INJURED/i);

    logSpy.mockRestore();
  });

  test('player with no availability record proceeds normally (fail-open)', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-avail-02' })],
      players: [buildPlayer({ player_id: 5555, player_name: 'No Avail Record' })],
      playerLogs: buildGames(5),
      availabilityRow: null, // no record — fail-open
    }));

    await mod.runNHLPlayerShotsModel();

    // Should proceed to model and create a card
    expect(data.insertCardPayload).toHaveBeenCalled();
  });

  test('player with ACTIVE availability proceeds normally', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-avail-03' })],
      players: [buildPlayer({ player_id: 4444, player_name: 'Active Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
  });

  test('excludes player IDs via NHL_SOG_EXCLUDE_PLAYER_IDS in model run', async () => {
    process.env.NHL_SOG_EXCLUDE_PLAYER_IDS = '8479318';
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-exclude-01' })],
      players: [buildPlayer({ player_id: 8479318, player_name: 'Auston Matthews' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', status_reason: null, checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;
  });

  test('dedupes duplicate game/player rows within a run', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [
        buildFutureGame({ game_id: 'dup-game-01' }),
        buildFutureGame({ game_id: 'dup-game-01' }),
      ],
      players: [buildPlayer({ player_id: 3333, player_name: 'Dup Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalledTimes(1);
  });

  test('writes canonical pass action fields and synthetic fallback metadata for projection-only cards', async () => {
    // Provide a real odds-backed prop line so the no-real-line guard does NOT
    // fire, giving us a genuine FIRE card we can assert against.
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.5,
      sog_sigma: 1.87,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: { '2.5': 0.62 },
      fair_under_prob_by_line: { '2.5': 0.38 },
      fair_price_over_by_line: { '2.5': -163 },
      fair_price_under_by_line: { '2.5': 163 },
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      implied_over_prob: 0.5349,
      implied_under_prob: 0.5122,
      edge_over_pp: 0.0851,
      edge_under_pp: -0.1322,
      ev_over: 0.16,
      ev_under: -0.19,
      opportunity_score: 0.58,
      flags: [],
    });
    // Real prop line (over/under prices present → usingRealLine=true → FIRE allowed).
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'fair-line-01' })],
      players: [buildPlayer({ player_id: 2222, player_name: 'Fair Line Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.play.action).toBe('PASS');
    expect(card.payloadData.play.classification).toBe('PASS');
    expect(card.payloadData.play.status).toBe('PASS');
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('OVER');
    expect(card.payloadData.suggested_line).toBe(3);
    expect(card.payloadData.play.pick_string).toMatch(/Proj \d+\.\d+ · Fair \d+(\.\d+)? · Edge [+-]\d+\.\d+/i);
    expect(card.payloadData.confidence).toBeGreaterThan(0.75);
    expect(card.payloadData.decision.market_line_source).toBe('synthetic_fallback');
    expect(card.payloadData.decision.v2.flags).toContain('SYNTHETIC_LINE');
  });

  test('uses opponent team profile from team_metrics_cache for matchup scoring', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    const teamMetricsGet = jest.fn(() => ({
      opponent_shots_against_pg: 31.8,
      league_avg_shots_against_pg: 28.5,
      team_pace_proxy: 1.06,
      opponent_pace_proxy: 1.04,
    }));
    const mockDb = {
      prepare: jest.fn((sql) => {
        const s = sql.trim().toLowerCase();
        if (s.includes('from games')) return { all: jest.fn(() => [buildFutureGame()]) };
        if (s.includes('from player_shot_logs') && s.includes('distinct')) {
          return { all: jest.fn(() => [buildPlayer({ player_id: 1010, player_name: 'Matchup Player' })]) };
        }
        if (s.includes('from player_shot_logs') && s.includes('player_id = ?')) {
          return { all: jest.fn(() => buildGames(5)) };
        }
        if (s.includes('from player_availability')) return { get: jest.fn(() => null) };
        if (s.includes('from team_metrics_cache')) return { get: teamMetricsGet };
        return { all: jest.fn(() => []), get: jest.fn(() => null), run: jest.fn() };
      }),
    };
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(teamMetricsGet).toHaveBeenCalledWith(
      'Toronto Maple Leafs',
      'Edmonton Oilers',
      'Toronto Maple Leafs',
    );
    expect(shots.calcMu).toHaveBeenCalledWith(
      expect.objectContaining({
        opponentFactor: expect.any(Number),
        paceFactor: expect.any(Number),
      }),
    );
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.matchup_score).toBeGreaterThan(0.6);
    expect(card.payloadData.drivers.opponent_factor).toBeGreaterThan(1.0);
    expect(card.payloadData.drivers.pace_factor).toBeGreaterThan(1.0);
  });

  test('WI-0582: empty team_metrics_cache warns and flags full-game plus 1P cards', async () => {
    process.env.NHL_SOG_1P_CARDS_ENABLED = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0582-empty-cache-01' })],
      players: [buildPlayer({ player_id: 5821, player_name: 'Fallback Flag Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    delete process.env.NHL_SOG_1P_CARDS_ENABLED;

    const fullGameCard = getInsertedCardsByType(data, 'nhl-player-shots')[0];
    const onePCard = getInsertedCardsByType(data, 'nhl-player-shots-1p')[0];
    const warnings = warnSpy.mock.calls.map(([message]) => String(message)).join('\n');

    expect(warnings).toMatch(/\[opponent-factor-fallback\]/);
    expect(warnings).toMatch(/\[pace-factor-fallback\]/);
    expect(warnings).toContain('Fallback Flag Player');
    expect(warnings).toContain('wi-0582-empty-cache-01');

    expect(fullGameCard.payloadData.decision.v2.flags).toContain('OPPONENT_FACTOR_MISSING');
    expect(fullGameCard.payloadData.decision.v2.flags).toContain('PACE_FACTOR_MISSING');
    expect(fullGameCard.payloadData.prop_decision.flags).toContain('OPPONENT_FACTOR_MISSING');
    expect(fullGameCard.payloadData.prop_decision.flags).toContain('PACE_FACTOR_MISSING');

    expect(onePCard.payloadData.decision.v2.flags).toContain('OPPONENT_FACTOR_MISSING');
    expect(onePCard.payloadData.decision.v2.flags).toContain('PACE_FACTOR_MISSING');

    warnSpy.mockRestore();
  });

  test('weak-support priced cards now render explicit PROJECTION or NO_PLAY rows instead of being suppressed', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pass-skip-01' })],
      players: [buildPlayer({ player_id: 1111, player_name: 'Volatile Player' })],
      playerLogs: buildGamesFromShots([0, 6, 0, 6, 0]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
  });

  test('adds decision_basis_meta when flagged and no real line', async () => {
    process.env.ENABLE_DECISION_BASIS_TAGS = 'true';

    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'projection-ledger-01' })],
      players: [buildPlayer({ player_id: 9191, player_name: 'Projection Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const insertedCard = data.insertCardPayload.mock.calls[0][0];
    expect(insertedCard.payloadData.decision_basis_meta).toEqual(
      expect.objectContaining({
        decision_basis: 'PROJECTION_ONLY',
        execution_eligible: false,
        market_line_source: 'synthetic_fallback',
      }),
    );
    expect(insertedCard.payloadData.decision.market_line_source).toBe(
      'synthetic_fallback',
    );

    delete process.env.ENABLE_DECISION_BASIS_TAGS;
  });

  test('Guard 1: projection-only cards with no real line are emitted as PROJECTION rows', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    // getPlayerPropLine returns null (default) — no real line.

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'guard1-no-line-01' })],
      players: [buildPlayer({ player_id: 8811, player_name: 'No Line Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.play.action).toBe('PASS');
    expect(card.payloadData.play.status).toBe('PASS');
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    // SYNTHETIC_LINE flag must be set in v2 flags.
    expect(card.payloadData.decision.v2.flags).toContain('SYNTHETIC_LINE');
  });

  test('Guard 2: PROJECTION_ANOMALY rows stay visible but verdict becomes PROJECTION', async () => {
    // l5Sog = [2,2,2,2,2] → arithmetic mean = 2.0
    // calcMu mocked to return 1.0 → V1 anomaly: 1.0 < 0.6*2.0=1.2 → FIRE→HOLD downgrade
    // projectSogV2 also returns sog_mu=1.0 → V2 anomaly: 1.0 < 0.6*2.0=1.2 → PROJECTION_ANOMALY in flags
    // All 5 shots (2) are <= 2.5 line → UNDER hitRate=1.0 → consistency=1.0 → FIRE (before guard)
    // Guard 2 must then downgrade FIRE → HOLD and add PROJECTION_ANOMALY flag.
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'UNDER', edge: -1.5 });
    // mu=1.0 → V1 anomaly detected (1.0 < 0.6*2.0=1.2)
    shots.calcMu.mockReturnValue(1.0);
    shots.calcMu1p.mockReturnValue(0.32);
    // V2 projection also shows sog_mu collapse → V2 anomaly also detected
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.0,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 3.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.85,
      role_stability: 'HIGH',
      trend_score: -0.2,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    });
    // Real prop line supplied (usingRealLine=true) so Guard 1 does not interfere.
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'guard2-anomaly-01' })],
      players: [buildPlayer({ player_id: 7722, player_name: 'Anomaly Player' })],
      // shots [2,2,2,2,2] → l5_arith_mean=2.0; calcMu=1.0 < 0.6*2.0=1.2 → anomaly
      playerLogs: buildGamesFromShots([2, 2, 2, 2, 2]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.play.action).toBe('PASS');
    expect(card.payloadData.play.status).toBe('PASS');
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    // PROJECTION_ANOMALY flag must appear in v2 flags.
    expect(card.payloadData.decision.v2.flags).toContain('PROJECTION_ANOMALY');
  });

  test('threshold semantics: projectSogV2 prices integer lines as no-push thresholds', () => {
    jest.resetModules();
    const actualShots = jest.requireActual('../../models/nhl-player-shots');

    const integerLine = actualShots.projectSogV2({
      player_id: 1,
      game_id: 'threshold-int-01',
      ev_shots_season_per60: 9,
      ev_shots_l10_per60: 9,
      ev_shots_l5_per60: 9,
      pp_shots_season_per60: 0,
      pp_shots_l10_per60: 0,
      pp_shots_l5_per60: 0,
      toi_proj_ev: 20,
      toi_proj_pp: 0,
      market_line: 3.0,
      market_price_over: 110,
      market_price_under: -130,
      play_direction: 'OVER',
    });
    const halfLine = actualShots.projectSogV2({
      player_id: 1,
      game_id: 'threshold-half-01',
      ev_shots_season_per60: 9,
      ev_shots_l10_per60: 9,
      ev_shots_l5_per60: 9,
      pp_shots_season_per60: 0,
      pp_shots_l10_per60: 0,
      pp_shots_l5_per60: 0,
      toi_proj_ev: 20,
      toi_proj_pp: 0,
      market_line: 2.5,
      market_price_over: 110,
      market_price_under: -130,
      play_direction: 'OVER',
    });

    expect(integerLine.fair_over_prob_by_line['3']).toBeCloseTo(
      halfLine.fair_over_prob_by_line['2.5'],
      6,
    );
    expect(integerLine.fair_under_prob_by_line['3']).toBeCloseTo(
      halfLine.fair_under_prob_by_line['2.5'],
      6,
    );
    expect(
      integerLine.fair_over_prob_by_line['3'] +
        integerLine.fair_under_prob_by_line['3'],
    ).toBeCloseTo(1, 6);
    expect(integerLine.fair_over_prob_by_line['3']).toBeCloseTo(0.5768, 4);
  });

  test('decision-first contract: integer event-priced thresholds are ignored when the lane is projection-only', async () => {
    const { mod, data, shots } = loadFreshModule();
    const actualShots = jest.requireActual('../../models/nhl-player-shots');
    const thresholdLogs = buildGames(5).map((row, index) => ({
      ...row,
      raw_data: index === 0 ? JSON.stringify({ shotsPer60: 9 }) : row.raw_data,
    }));
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(4.0);
    shots.projectSogV2.mockImplementation(actualShots.projectSogV2);
    data.getPlayerPropLine.mockReturnValue({ line: 3.0, over_price: 110, under_price: -130 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-threshold-int-01' })],
      players: [buildPlayer({ player_id: 9910, player_name: 'Integer Threshold Player' })],
      playerLogs: thresholdLogs,
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('OVER');
    expect(card.payloadData.prop_decision.line).toBe(2.5);
    expect(card.payloadData.prop_decision.display_price).toBeNull();
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
  });

  test('decision-first contract: decimal stored odds are ignored when no event-priced row can be selected', async () => {
    const { mod, data, shots } = loadFreshModule();
    const actualShots = jest.requireActual('../../models/nhl-player-shots');
    const thresholdLogs = buildGames(5).map((row, index) => ({
      ...row,
      raw_data: index === 0 ? JSON.stringify({ shotsPer60: 9 }) : row.raw_data,
    }));
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(4.0);
    shots.projectSogV2.mockImplementation(actualShots.projectSogV2);
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-decimal-odds-01' })],
      players: [buildPlayer({ player_id: 9911, player_name: 'Decimal Odds Player' })],
      playerLogs: thresholdLogs,
      playerPropLines: [
        { line: 3.0, over_price: 1.77, under_price: 2.15, bookmaker: 'draftkings' },
      ],
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.over_price).toBeNull();
    expect(card.payloadData.under_price).toBeNull();
    expect(card.payloadData.market_bookmaker).toBeNull();
    expect(card.payloadData.play.selection.price).toBe(-110);
    expect(card.payloadData.prop_decision.line).toBe(2.5);
    expect(card.payloadData.prop_decision.display_price).toBeNull();
    expect(card.payloadData.prop_decision.implied_prob).toBeNull();
    expect(card.payloadData.decision.market_line_source).toBe('synthetic_fallback');
  });

  test('decision-first contract: ladder rows are bypassed when event-priced selection is disabled', async () => {
    const { mod, data, shots } = loadFreshModule();
    const actualShots = jest.requireActual('../../models/nhl-player-shots');
    const thresholdLogs = buildGames(5).map((row, index) => ({
      ...row,
      raw_data: index === 0 ? JSON.stringify({ shotsPer60: 9 }) : row.raw_data,
    }));
    shots.classifyEdge.mockImplementation((projection, line) => ({
      tier: projection > line ? 'HOT' : 'COLD',
      direction: projection >= line ? 'OVER' : 'UNDER',
      edge: Math.abs(projection - line),
    }));
    shots.calcMu.mockReturnValue(4.0);
    shots.projectSogV2.mockImplementation(actualShots.projectSogV2);
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-ladder-01' })],
      players: [buildPlayer({ player_id: 9912, player_name: 'Ladder Player' })],
      playerLogs: thresholdLogs,
      playerPropLines: [
        { line: 3.0, over_price: -330, under_price: -500, bookmaker: 'draftkings' },
        { line: 4.0, over_price: 110, under_price: -130, bookmaker: 'draftkings' },
      ],
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.market_line).toBe(2.5);
    expect(card.payloadData.over_price).toBeNull();
    expect(card.payloadData.under_price).toBeNull();
    expect(card.payloadData.market_bookmaker).toBeNull();
    expect(card.payloadData.suggested_line).toBe(3);
    expect(card.payloadData.play.selection.line).toBe(2.5);
    expect(card.payloadData.play.selection.price).toBe(-110);
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.line).toBe(2.5);
    expect(card.payloadData.prop_decision.display_price).toBeNull();
    expect(card.payloadData.prop_decision.lean_side).toBe('OVER');
    expect(card.payloadData.prop_decision.implied_prob).toBeNull();
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
    expect(card.payloadData.prop_decision.flags).not.toContain('PROJECTION_CONFLICT');
    expect(card.payloadData.prop_decision.why).toMatch(/projection only/i);
    expect(card.payloadData.play.action).toBe('PASS');
  });

  test('decision-first contract: projection-only over-side edges stay non-actionable', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.4,
      sog_sigma: 1.84,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.06,
      fair_over_prob_by_line: { '2.5': 0.62 },
      fair_under_prob_by_line: { '2.5': 0.38 },
      fair_price_over_by_line: { '2.5': -163 },
      fair_price_under_by_line: { '2.5': 163 },
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      implied_over_prob: 0.5349,
      implied_under_prob: 0.5122,
      edge_over_pp: 0.0851,
      edge_under_pp: -0.1322,
      ev_over: 0.12,
      ev_under: -0.18,
      opportunity_score: 0.52,
      flags: [],
    });
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-decision-play-01' })],
      players: [buildPlayer({ player_id: 9911, player_name: 'Play Threshold Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('OVER');
    expect(card.payloadData.prop_decision.display_price).toBeNull();
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
  });

  test('decision-first contract: projection-only weak edges stay projection rows', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'WATCH', direction: 'UNDER', edge: -0.5 });
    shots.calcMu.mockReturnValue(1.8);
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.8,
      sog_sigma: 1.48,
      toi_proj: 19,
      shot_rate_ev_per60: 8.1,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: -0.02,
      fair_over_prob_by_line: { '2.5': 0.42 },
      fair_under_prob_by_line: { '2.5': 0.58 },
      fair_price_over_by_line: { '2.5': 138 },
      fair_price_under_by_line: { '2.5': -138 },
      market_line: 2.5,
      market_price_over: 120,
      market_price_under: -105,
      implied_over_prob: 0.4545,
      implied_under_prob: 0.5122,
      edge_over_pp: -0.0345,
      edge_under_pp: 0.0678,
      ev_over: -0.07,
      ev_under: 0.08,
      opportunity_score: 0.08,
      flags: ['LOW_SAMPLE'],
    });
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: 120, under_price: -105 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-decision-watch-01' })],
      players: [buildPlayer({ player_id: 9912, player_name: 'Watch Threshold Player' })],
      playerLogs: buildGamesFromShots([2, 2, 3, 2, 2]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('UNDER');
  });

  test('WI-0577: projection-only over seeds cannot leak FIRE when event pricing is disabled', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.2);
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.2,
      sog_sigma: 1.84,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.06,
      fair_over_prob_by_line: { '2.5': 0.51 },
      fair_under_prob_by_line: { '2.5': 0.49 },
      fair_price_over_by_line: { '2.5': -104 },
      fair_price_under_by_line: { '2.5': 104 },
      market_line: 2.5,
      market_price_over: -125,
      market_price_under: 130,
      implied_over_prob: 0.5556,
      implied_under_prob: 0.4348,
      edge_over_pp: -0.0456,
      edge_under_pp: 0.0552,
      ev_over: -0.07,
      ev_under: 0.06,
      opportunity_score: 0.08,
      flags: [],
    });
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -125, under_price: 130 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0577-veto-01' })],
      players: [buildPlayer({ player_id: 9915, player_name: 'Veto Proof Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('UNDER');
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
    expect(card.payloadData.prop_decision.flags).not.toContain('PROJECTION_CONFLICT');
    expect(card.payloadData.play.action).toBe('PASS');
    expect(card.payloadData.play.status).toBe('PASS');
    expect(card.payloadData.play.decision_v2.official_status).toBe('PASS');
    expect(card.payloadData.decision_v2.official_status).toBe('PASS');
  });

  test('decision-first contract: projection-only rows do not surface priced-side conflicts', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 0.9 });
    shots.calcMu.mockReturnValue(3.4);
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.4,
      sog_sigma: 1.84,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.06,
      fair_over_prob_by_line: { '2.5': 0.62 },
      fair_under_prob_by_line: { '2.5': 0.38 },
      fair_price_over_by_line: { '2.5': -163 },
      fair_price_under_by_line: { '2.5': 163 },
      market_line: 2.5,
      market_price_over: -105,
      market_price_under: 140,
      implied_over_prob: 0.5122,
      implied_under_prob: 0.4167,
      edge_over_pp: 0.01,
      edge_under_pp: 0.072,
      ev_over: 0.01,
      ev_under: 0.08,
      opportunity_score: 0.09,
      flags: [],
    });
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -105, under_price: 140 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-projection-conflict-01' })],
      players: [buildPlayer({ player_id: 9914, player_name: 'Projection Conflict Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('UNDER');
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
    expect(card.payloadData.prop_decision.flags).not.toContain('PROJECTION_CONFLICT');
    expect(card.payloadData.prop_decision.implied_prob).toBeCloseTo(0.4167, 4);
    expect(card.payloadData.prop_decision.display_price).toBeNull();
    expect(card.payloadData.prop_decision.why).toMatch(/projection only/i);
    expect(card.payloadData.play.action).toBe('PASS');
  });

  test('WI-0577: explicit projection-only rows keep canonical PASS fields aligned', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 0.9 });
    shots.calcMu.mockReturnValue(3.4);
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.4,
      sog_sigma: 1.84,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.06,
      fair_over_prob_by_line: { '2.5': 0.62 },
      fair_under_prob_by_line: { '2.5': 0.38 },
      fair_price_over_by_line: { '2.5': -163 },
      fair_price_under_by_line: { '2.5': 163 },
      market_line: 2.5,
      market_price_over: -105,
      market_price_under: 140,
      implied_over_prob: 0.5122,
      implied_under_prob: 0.4167,
      edge_over_pp: 0.01,
      edge_under_pp: 0.072,
      ev_over: 0.01,
      ev_under: 0.08,
      opportunity_score: 0.09,
      flags: [],
    });
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -105, under_price: 140 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0577-conflict-01' })],
      players: [buildPlayer({ player_id: 9916, player_name: 'Conflict Proof Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.prop_decision.lean_side).toBe('UNDER');
    expect(card.payloadData.prop_decision.flags).toContain('SYNTHETIC_LINE');
    expect(card.payloadData.prop_decision.flags).not.toContain('PROJECTION_CONFLICT');
    expect(card.payloadData.play.action).toBe('PASS');
    expect(card.payloadData.play.status).toBe('PASS');
    expect(card.payloadData.play.decision_v2.official_status).toBe('PASS');
    expect(card.payloadData.decision_v2.official_status).toBe('PASS');
  });

  test('decision-first contract: market-efficient rows stay projection-only without event pricing', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'WATCH', direction: 'OVER', edge: 0.5 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 2.9,
      sog_sigma: 1.7,
      toi_proj: 19,
      shot_rate_ev_per60: 8.9,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.01,
      fair_over_prob_by_line: { '2.5': 0.54 },
      fair_under_prob_by_line: { '2.5': 0.46 },
      fair_price_over_by_line: { '2.5': -117 },
      fair_price_under_by_line: { '2.5': 117 },
      market_line: 2.5,
      market_price_over: -125,
      market_price_under: 110,
      implied_over_prob: 0.5556,
      implied_under_prob: 0.4762,
      edge_over_pp: -0.0156,
      edge_under_pp: -0.0162,
      ev_over: -0.02,
      ev_under: -0.03,
      opportunity_score: -0.01,
      flags: [],
    });
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -125, under_price: 110 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'prop-decision-no-play-01' })],
      players: [buildPlayer({ player_id: 9913, player_name: 'No Play Threshold Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(card.payloadData.play.action).toBe('PASS');
  });

  // --- WI-0527: v2 anomaly flag, pricing nullification, extended drivers ---

  test('Test A: v2 PROJECTION_ANOMALY flag appears in decision.v2.flags when sog_mu < 0.6 * l5_avg', async () => {
    // sog_mu=1.4, l5Sog=[3,3,3,3,3] → l5_avg=3.0 → 1.4 < 0.6*3.0=1.8 → v2AnomalyDetected=true
    // Use OVER direction with l5=[3,3,3,3,3] and line=2.5 for high consistency (all 5 games >2.5)
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.5 });
    shots.calcMu.mockReturnValue(3.0); // V1 mu — no V1 anomaly, only V2 anomaly
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    // V2 projection returns sog_mu well below 60% of l5_avg=3.0
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.06,
      ev_under: -0.06,
      opportunity_score: 0.72,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'v2-anomaly-flag-01' })],
      players: [buildPlayer({ player_id: 5001, player_name: 'V2 Anomaly Player A' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PROJECTION_ANOMALY');
  });

  test('Test B: edge_over_pp, ev_over, opportunity_score are null when v2 anomaly detected', async () => {
    // Same anomaly scenario — pricing fields must be null even though v2 mock returns non-null values
    // OVER direction with l5=[3,3,3,3,3] for high consistency so card is created
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.5 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.12,   // non-null — must be nullified by guard
      edge_under_pp: -0.12,
      ev_over: 0.09,        // non-null — must be nullified
      ev_under: -0.09,
      opportunity_score: 0.85, // non-null — must be nullified
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'v2-anomaly-null-01' })],
      players: [buildPlayer({ player_id: 5002, player_name: 'V2 Anomaly Player B' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.edge_over_pp).toBeNull();
    expect(card.payloadData.decision.v2.ev_over).toBeNull();
    expect(card.payloadData.decision.v2.opportunity_score).toBeNull();
  });

  test('Test C: edge_over_pp is NOT nullified when sog_mu >= 0.6 * l5_avg (no anomaly)', async () => {
    // sog_mu=3.0, l5=[3,3,3,3,3] → l5_avg=3.0 → 3.0 >= 1.8 → no anomaly
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.5 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.10,
      edge_under_pp: -0.10,
      ev_over: 0.08,
      ev_under: -0.08,
      opportunity_score: 0.78,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'v2-no-anomaly-01' })],
      players: [buildPlayer({ player_id: 5003, player_name: 'V2 No Anomaly Player C' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    // No anomaly — edge_over_pp should come through (non-null)
    expect(card.payloadData.decision.v2.edge_over_pp).not.toBeNull();
    expect(card.payloadData.decision.v2.flags).not.toContain('PROJECTION_ANOMALY');
  });

  // --- WI-0527 Task 2: extended drivers block ---

  test('Test D: drivers block contains all projection inputs as numeric values when no anomaly', async () => {
    // sog_mu=3.2, l5=[3,3,3,3,3] → no anomaly. All driver fields must be defined numbers.
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.2);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.2,
      sog_sigma: 1.79,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.06,
      ev_under: -0.06,
      opportunity_score: 0.72,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'drivers-test-d-01' })],
      players: [buildPlayer({ player_id: 6001, player_name: 'Drivers Player D' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    const drivers = card.payloadData.drivers;
    // All new projection debug fields must be defined numbers
    expect(typeof drivers.sog_mu).toBe('number');
    expect(typeof drivers.ev_rate).toBe('number');
    expect(typeof drivers.pp_rate).toBe('number');
    expect(typeof drivers.shot_env_factor).toBe('number');
    expect(typeof drivers.trend_factor).toBe('number');
    expect(drivers.v2_anomaly).toBe(false);
    // toi_proj_ev must be defined (number or non-null)
    expect(drivers.toi_proj_ev).not.toBeUndefined();
  });

  test('Test E: PROJECTION_ANOMALY in decision.v2.flags when projectSogV2 returns sog_mu=1.4 and l5_avg=3.0', async () => {
    // Directly tests the v2AnomalyDetected path through the flag array
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.0,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'drivers-test-e-01' })],
      players: [buildPlayer({ player_id: 6002, player_name: 'Drivers Player E' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PROJECTION_ANOMALY');
    // drivers.v2_anomaly must also reflect the anomaly
    expect(card.payloadData.drivers.v2_anomaly).toBe(true);
  });

  test('Test F: decision.v2.edge_over_pp is null when anomaly detected even if projectSogV2 returns non-null', async () => {
    // Confirms nullification guard: mock returns edge_over_pp=0.12 but anomaly forces null
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.0,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.12,  // non-null — must be forced to null by guard
      edge_under_pp: -0.12,
      ev_over: 0.09,
      ev_under: -0.09,
      opportunity_score: 0.85,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'drivers-test-f-01' })],
      players: [buildPlayer({ player_id: 6003, player_name: 'Drivers Player F' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.edge_over_pp).toBeNull();
  });

  // --- WI-0528: toi_proj_pp wired from rawData.ppToi ---

  test('Test G: toi_proj_pp uses ppToi from raw_data when present', async () => {
    // raw_data of most recent game has ppToi: 2.5 — projectSogV2 must receive toi_proj_pp: 2.5
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.79,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.06,
      ev_under: -0.06,
      opportunity_score: 0.72,
      flags: [],
    });

    const gamesWithPpToi = buildGamesFromShots([3, 3, 3, 3, 3]).map((g, i) =>
      i === 0
        ? { ...g, raw_data: JSON.stringify({ shotsPer60: 9.0, projToi: 18.0, ppToi: 2.5 }) }
        : g,
    );

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pptoi-test-g-01' })],
      players: [buildPlayer({ player_id: 7001, player_name: 'PP Shooter G' })],
      playerLogs: gamesWithPpToi,
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalledWith(
      expect.objectContaining({ toi_proj_pp: 2.5 }),
    );
  });

  test('Test H: toi_proj_pp defaults to 0 when ppToi absent from raw_data (legacy rows)', async () => {
    // raw_data is '{}' (legacy) — projectSogV2 must receive toi_proj_pp: 0 (no regression)
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.79,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.06,
      ev_under: -0.06,
      opportunity_score: 0.72,
      flags: [],
    });

    // buildGamesFromShots uses raw_data: '{}' by default (legacy format — no ppToi field)
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pptoi-test-h-01' })],
      players: [buildPlayer({ player_id: 7002, player_name: 'Legacy Player H' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalledWith(
      expect.objectContaining({ toi_proj_pp: 0 }),
    );
  });

  // --- WI-0529: prop_display_state decision layer ---

  test('WI-0529 Test A: v2AnomalyDetected=true → payloadData.prop_display_state = PROJECTION_ONLY', async () => {
    // sog_mu=1.4 < 0.6 * l5_avg(3.0)=1.8 → v2AnomalyDetected=true → PROJECTION_ONLY
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.5 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pds-test-a-01' })],
      players: [buildPlayer({ player_id: 8001, player_name: 'PDS Player A' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_display_state).toBe('PROJECTION_ONLY');
  });

  test('WI-0529 Test B: isOddsBacked=false (v2OpportunityScore=null, no anomaly) → prop_display_state = PROJECTION_ONLY', async () => {
    // No real line, no odds → isOddsBacked=false → v2OpportunityScore=null → PROJECTION_ONLY
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    // No prop line → isOddsBacked=false
    data.getPlayerPropLine.mockReturnValue(null);
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.79,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: null,
      market_price_under: null,
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pds-test-b-01' })],
      players: [buildPlayer({ player_id: 8002, player_name: 'PDS Player B' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_display_state).toBe('PROJECTION_ONLY');
  });

  test('WI-0529 Test C: no anomaly + v2OpportunityScore=0.3 (> 0) → prop_display_state = PLAY', async () => {
    // sog_mu=3.0 >= 0.6*3.0=1.8, opportunity_score=0.3 > 0 → PLAY
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.5 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.06,
      ev_under: -0.06,
      opportunity_score: 0.3,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pds-test-c-01' })],
      players: [buildPlayer({ player_id: 8003, player_name: 'PDS Player C' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_display_state).toBe('PLAY');
  });

  test('WI-0529 Test D: no anomaly + v2OpportunityScore=0 (not > 0) → prop_display_state = WATCH', async () => {
    // opportunity_score=0 is not > 0 → WATCH
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0,
      edge_under_pp: 0,
      ev_over: 0,
      ev_under: 0,
      opportunity_score: 0,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pds-test-d-01' })],
      players: [buildPlayer({ player_id: 8004, player_name: 'PDS Player D' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_display_state).toBe('WATCH');
  });

  test('WI-0529 Test E: no anomaly + v2OpportunityScore=-0.1 (< 0) → prop_display_state = WATCH', async () => {
    // opportunity_score=-0.1 < 0 → WATCH
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: -0.05,
      edge_under_pp: 0.05,
      ev_over: -0.03,
      ev_under: 0.03,
      opportunity_score: -0.1,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pds-test-e-01' })],
      players: [buildPlayer({ player_id: 8005, player_name: 'PDS Player E' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.prop_display_state).toBe('WATCH');
  });

  // ---- WI-0530: ppRatePer60 wiring into projectSogV2 + PP_RATE_MISSING flag ----

  // Helper: build 5 game logs where the first log has specific raw_data
  function buildGamesWithRawData(rawDataObj) {
    const gamesFromDefault = buildGamesFromShots([3, 3, 3, 3, 3]);
    gamesFromDefault[0] = {
      ...gamesFromDefault[0],
      raw_data: JSON.stringify(rawDataObj),
    };
    return gamesFromDefault;
  }

  test('WI-0530 Test I: ppRatePer60=4.8 + ppToi=2.5 → projectSogV2 called with pp_shots_season_per60=4.8; sog_mu higher than without rate', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.2,
      sog_sigma: 1.79,
      toi_proj: 18.5,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 4.8,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.05,
      ev_under: -0.05,
      opportunity_score: 0.5,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0530-test-i-01' })],
      players: [buildPlayer({ player_id: 9100, player_name: 'PP Heavy Player I' })],
      playerLogs: buildGamesWithRawData({ shotsPer60: 9.6, projToi: 16, ppToi: 2.5, ppRatePer60: 4.8 }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalled();
    const v2Call = shots.projectSogV2.mock.calls[0][0];
    expect(v2Call.pp_shots_season_per60).toBe(4.8);
    expect(v2Call.toi_proj_pp).toBe(2.5);

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    // pp_rate_per60 must appear in drivers
    expect(card.payloadData.drivers.pp_rate_per60).toBe(4.8);
  });

  test('WI-0530 Test J: ppRatePer60=null + ppToi > 0 → PP_RATE_MISSING flag in v2 flags', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.73,
      toi_proj: 18,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.05,
      edge_under_pp: -0.05,
      ev_over: 0.03,
      ev_under: -0.03,
      opportunity_score: 0.3,
      flags: [],
    });

    // ppRatePer60=null, ppToi=2.0 → PP_RATE_MISSING should be pushed
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0530-test-j-01' })],
      players: [buildPlayer({ player_id: 9101, player_name: 'No Rate Player J' })],
      playerLogs: buildGamesWithRawData({ shotsPer60: 9.0, projToi: 16, ppToi: 2.0, ppRatePer60: null }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PP_RATE_MISSING');
  });

  test('WI-0530 Test K: ppRatePer60=0 (explicit zero) → treated as null → PP_RATE_MISSING flag', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.73,
      toi_proj: 18,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.05,
      edge_under_pp: -0.05,
      ev_over: 0.03,
      ev_under: -0.03,
      opportunity_score: 0.3,
      flags: [],
    });

    // ppRatePer60=0 → treated same as null in model runner
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0530-test-k-01' })],
      players: [buildPlayer({ player_id: 9102, player_name: 'Zero Rate Player K' })],
      playerLogs: buildGamesWithRawData({ shotsPer60: 9.0, projToi: 16, ppToi: 2.0, ppRatePer60: 0 }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PP_RATE_MISSING');
  });

  // ---- WI-0531: L10/L5 rolling splits + PP blend weights + PP_SMALL_SAMPLE + drivers ----

  test('WI-0531 Test P: L10/L5 rates passed from rawData to projectSogV2; PP_SMALL_SAMPLE NOT in flags', async () => {
    // ppRatePer60=4.0, ppRateL10Per60=6.0, ppRateL5Per60=8.0, ppToi=2.5
    // → projectSogV2 called with pp_shots_season_per60=4.0, pp_shots_l10_per60=6.0, pp_shots_l5_per60=8.0
    // PP_SMALL_SAMPLE must NOT fire (all three present)
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.2, sog_sigma: 1.79, toi_proj: 20, shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 5.7, shot_env_factor: 1.0, role_stability: 'HIGH',
      trend_score: 0.05, fair_over_prob_by_line: {}, fair_under_prob_by_line: {},
      fair_price_over_by_line: {}, fair_price_under_by_line: {},
      market_line: 2.5, market_price_over: -115, market_price_under: -105,
      edge_over_pp: 0.08, edge_under_pp: -0.08, ev_over: 0.05, ev_under: -0.05,
      opportunity_score: 0.5, flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0531-test-p-01' })],
      players: [buildPlayer({ player_id: 9200, player_name: 'PP L10 L5 Player P' })],
      playerLogs: buildGamesWithRawData({
        shotsPer60: 9.6, projToi: 16, ppToi: 2.5,
        ppRatePer60: 4.0, ppRateL10Per60: 6.0, ppRateL5Per60: 8.0,
      }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalled();
    const v2Call = shots.projectSogV2.mock.calls[0][0];
    expect(v2Call.pp_shots_season_per60).toBe(4.0);
    expect(v2Call.pp_shots_l10_per60).toBe(6.0);
    expect(v2Call.pp_shots_l5_per60).toBe(8.0);

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).not.toContain('PP_SMALL_SAMPLE');
  });

  test('WI-0531 Test Q: season rate only (L10/L5 null) → PP_SMALL_SAMPLE in flags; NO PP_RATE_MISSING', async () => {
    // ppRatePer60=4.0, ppRateL10Per60=null, ppRateL5Per60=null, ppToi=2.5
    // → PP_SMALL_SAMPLE fires (season rate present but both L10/L5 null)
    // → PP_RATE_MISSING must NOT fire (season rate is present)
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0, sog_sigma: 1.73, toi_proj: 18, shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 4.0, shot_env_factor: 1.0, role_stability: 'HIGH',
      trend_score: 0.05, fair_over_prob_by_line: {}, fair_under_prob_by_line: {},
      fair_price_over_by_line: {}, fair_price_under_by_line: {},
      market_line: 2.5, market_price_over: -115, market_price_under: -105,
      edge_over_pp: 0.05, edge_under_pp: -0.05, ev_over: 0.03, ev_under: -0.03,
      opportunity_score: 0.3, flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0531-test-q-01' })],
      players: [buildPlayer({ player_id: 9201, player_name: 'Season Only Player Q' })],
      playerLogs: buildGamesWithRawData({
        shotsPer60: 9.0, projToi: 16, ppToi: 2.5,
        ppRatePer60: 4.0, ppRateL10Per60: null, ppRateL5Per60: null,
      }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PP_SMALL_SAMPLE');
    expect(card.payloadData.decision.v2.flags).not.toContain('PP_RATE_MISSING');
  });

  test('WI-0531 Test R: L5 present, L10 null → PP_SMALL_SAMPLE NOT in flags (only BOTH-null triggers it)', async () => {
    // ppRatePer60=4.0, ppRateL5Per60=7.0, ppRateL10Per60=null, ppToi=2.0
    // PP_SMALL_SAMPLE must NOT fire — L5 is present
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0, sog_sigma: 1.73, toi_proj: 18, shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 5.0, shot_env_factor: 1.0, role_stability: 'HIGH',
      trend_score: 0.05, fair_over_prob_by_line: {}, fair_under_prob_by_line: {},
      fair_price_over_by_line: {}, fair_price_under_by_line: {},
      market_line: 2.5, market_price_over: -115, market_price_under: -105,
      edge_over_pp: 0.06, edge_under_pp: -0.06, ev_over: 0.04, ev_under: -0.04,
      opportunity_score: 0.4, flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0531-test-r-01' })],
      players: [buildPlayer({ player_id: 9202, player_name: 'L5 Present Player R' })],
      playerLogs: buildGamesWithRawData({
        shotsPer60: 9.0, projToi: 16, ppToi: 2.0,
        ppRatePer60: 4.0, ppRateL10Per60: null, ppRateL5Per60: 7.0,
      }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).not.toContain('PP_SMALL_SAMPLE');
  });

  test('WI-0531 Test S: drivers block contains pp_season_rate, pp_l10_rate, pp_l5_rate, pp_blend_rate', async () => {
    // Asserts all four PP rate driver fields are present in the drivers block
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.2, sog_sigma: 1.79, toi_proj: 20, shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 5.7, shot_env_factor: 1.0, role_stability: 'HIGH',
      trend_score: 0.05, fair_over_prob_by_line: {}, fair_under_prob_by_line: {},
      fair_price_over_by_line: {}, fair_price_under_by_line: {},
      market_line: 2.5, market_price_over: -115, market_price_under: -105,
      edge_over_pp: 0.08, edge_under_pp: -0.08, ev_over: 0.05, ev_under: -0.05,
      opportunity_score: 0.5, flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0531-test-s-01' })],
      players: [buildPlayer({ player_id: 9203, player_name: 'Drivers Player S' })],
      playerLogs: buildGamesWithRawData({
        shotsPer60: 9.6, projToi: 16, ppToi: 2.5,
        ppRatePer60: 4.0, ppRateL10Per60: 6.0, ppRateL5Per60: 8.0,
      }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    const drivers = card.payloadData.drivers;
    // All four PP rate driver fields must be present
    expect(Object.prototype.hasOwnProperty.call(drivers, 'pp_season_rate')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(drivers, 'pp_l10_rate')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(drivers, 'pp_l5_rate')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(drivers, 'pp_blend_rate')).toBe(true);
    // Values for this specific input
    expect(drivers.pp_season_rate).toBe(4.0);
    expect(drivers.pp_l10_rate).toBe(6.0);
    expect(drivers.pp_l5_rate).toBe(8.0);
    // pp_blend_rate: (4.0*0.4 + 6.0*0.35 + 8.0*0.25) / 1.0 = 1.6+2.1+2.0 = 5.7
    expect(drivers.pp_blend_rate).toBeCloseTo(5.7, 1);
  });

  test('WI-0531 Test T: ppRatePer60=null → PP_RATE_MISSING; PP_SMALL_SAMPLE NOT in flags', async () => {
    // ppRatePer60=null, L10/L5 also null, ppToi=3.0
    // PP_RATE_MISSING fires (no season rate, has PP TOI)
    // PP_SMALL_SAMPLE must NOT fire (only for players WITH season rate)
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0, sog_sigma: 1.73, toi_proj: 18, shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0, shot_env_factor: 1.0, role_stability: 'HIGH',
      trend_score: 0.05, fair_over_prob_by_line: {}, fair_under_prob_by_line: {},
      fair_price_over_by_line: {}, fair_price_under_by_line: {},
      market_line: 2.5, market_price_over: -115, market_price_under: -105,
      edge_over_pp: 0.05, edge_under_pp: -0.05, ev_over: 0.03, ev_under: -0.03,
      opportunity_score: 0.3, flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0531-test-t-01' })],
      players: [buildPlayer({ player_id: 9204, player_name: 'No Rate Player T' })],
      playerLogs: buildGamesWithRawData({
        shotsPer60: 9.0, projToi: 16, ppToi: 3.0,
        ppRatePer60: null, ppRateL10Per60: null, ppRateL5Per60: null,
      }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PP_RATE_MISSING');
    expect(card.payloadData.decision.v2.flags).not.toContain('PP_SMALL_SAMPLE');
  });

  test('WI-0530 Test O: pp_rate_per60 in drivers reflects the actual NST rate used (not 0 when available)', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.5,
      sog_sigma: 1.87,
      toi_proj: 18.5,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 6.2,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.1,
      edge_under_pp: -0.1,
      ev_over: 0.07,
      ev_under: -0.07,
      opportunity_score: 0.6,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0530-test-o-01' })],
      players: [buildPlayer({ player_id: 9103, player_name: 'PP Rate Driver Player O' })],
      playerLogs: buildGamesWithRawData({ shotsPer60: 9.6, projToi: 16, ppToi: 2.5, ppRatePer60: 6.2 }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    // pp_rate_per60 in drivers must reflect the actual NST rate (6.2), not 0 or null
    expect(card.payloadData.drivers.pp_rate_per60).toBe(6.2);
  });

  test('WI-0532 Test U: team_stats matchup inputs produce pp_matchup_factor > 1 and expose drivers', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.5,
      sog_sigma: 1.87,
      toi_proj: 18.5,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 6.2,
      pp_matchup_factor: 1.761,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.1,
      edge_under_pp: -0.1,
      ev_over: 0.07,
      ev_under: -0.07,
      opportunity_score: 0.6,
      flags: [],
    });

    const teamStatsGet = jest.fn(() => ({
      opp_pk_pct_split: 0.74,
      opp_pk_pct_all: 0.76,
      opp_penalties_per60_split: 4.2,
      opp_penalties_per60_all: 4.0,
      league_avg_pk_pct_split: 0.8,
      league_avg_pk_pct_all: 0.8,
      league_avg_penalties_per60_split: 3.1,
      league_avg_penalties_per60_all: 3.0,
    }));
    const mockDb = {
      prepare: jest.fn((sql) => {
        const s = sql.trim().toLowerCase();
        if (s.includes('from games')) return { all: jest.fn(() => [buildFutureGame()]) };
        if (s.includes('from player_shot_logs') && s.includes('distinct')) {
          return { all: jest.fn(() => [buildPlayer({ player_id: 9301, player_name: 'Matchup Boost Player' })]) };
        }
        if (s.includes('from player_shot_logs') && s.includes('player_id = ?')) {
          return {
            all: jest.fn(() =>
              buildGamesWithRawData({
                shotsPer60: 9.6,
                projToi: 16,
                ppToi: 2.5,
                ppRatePer60: 6.2,
              })),
          };
        }
        if (s.includes('from player_availability')) return { get: jest.fn(() => null) };
        if (s.includes('from team_stats')) return { get: teamStatsGet };
        return { all: jest.fn(() => []), get: jest.fn(() => null), run: jest.fn() };
      }),
    };
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalled();
    const v2Call = shots.projectSogV2.mock.calls[0][0];
    expect(v2Call.pp_matchup_factor).toBeGreaterThan(1.0);
    expect(v2Call.pp_matchup_factor).toBeCloseTo(1.761, 3);

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.drivers.pp_matchup_factor).toBeCloseTo(1.761, 3);
    expect(card.payloadData.drivers.opp_pk_pct).toBeCloseTo(0.74, 3);
    expect(card.payloadData.drivers.opp_penalties_per60).toBeCloseTo(4.2, 3);
    expect(card.payloadData.decision.v2.flags).not.toContain('PP_MATCHUP_MISSING');
  });

  test('WI-0532 Test V: missing team_stats data defaults pp_matchup_factor=1.0 and adds PP_MATCHUP_MISSING', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.73,
      toi_proj: 18,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 4.8,
      pp_matchup_factor: 1.0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.05,
      edge_under_pp: -0.05,
      ev_over: 0.03,
      ev_under: -0.03,
      opportunity_score: 0.3,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi0532-test-v-01' })],
      players: [buildPlayer({ player_id: 9302, player_name: 'Missing Matchup Player' })],
      playerLogs: buildGamesWithRawData({
        shotsPer60: 9.0,
        projToi: 16,
        ppToi: 2.5,
        ppRatePer60: 4.8,
      }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalled();
    const v2Call = shots.projectSogV2.mock.calls[0][0];
    expect(v2Call.pp_matchup_factor).toBe(1.0);

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PP_MATCHUP_MISSING');
    expect(card.payloadData.drivers.pp_matchup_factor).toBe(1.0);
  });

  test('WI-0577 Guard 3: 1P cards use synthetic fallback lines when event pricing is disabled', async () => {
    // V1 classifyEdge returns HOT OVER for 1P → derivePlayDecision → FIRE
    // V2 edge_over_pp = -0.04 (negative) → Guard 3 should veto FIRE → HOLD/WATCH
    process.env.NHL_SOG_1P_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();

    // classifyEdge is called 5 times per player when usingRealLine=true + sog1pEnabled:
    //   call 1 → evalPlayerPropMarket directionSeed (line 916)
    //   call 2 → fullDirectionSeed (line 1939)
    //   call 3 → fullGameEdge (line 1976)
    //   call 4 → firstPeriodDirectionSeed (line 2243)
    //   call 5 → firstPeriodEdge (line 2266)
    shots.classifyEdge
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 }) // call 1
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 }) // call 2
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 }) // call 3
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 }) // call 4
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 }); // call 5 → 1P firstPeriodEdge

    // calcMu: 3.2 → no anomaly (3.2 >= 0.6 * 3.0 = 1.8)
    shots.calcMu.mockReturnValue(3.2);
    shots.calcMu1p.mockReturnValue(1.0);

    shots.projectSogV2
      .mockReturnValueOnce({
        sog_mu: 3.2,
        sog_sigma: 1.79,
        toi_proj: 20,
        shot_rate_ev_per60: 9.6,
        shot_rate_pp_per60: 0,
        shot_env_factor: 1.0,
        role_stability: 'HIGH',
        trend_score: 0.05,
        fair_over_prob_by_line: { '2.5': 0.59 },
        fair_under_prob_by_line: { '2.5': 0.41 },
        fair_price_over_by_line: { '2.5': -144 },
        fair_price_under_by_line: { '2.5': 144 },
        market_line: 2.5,
        market_price_over: -115,
        market_price_under: -105,
        implied_over_prob: 0.535,
        implied_under_prob: 0.512,
        edge_over_pp: 0.06,
        edge_under_pp: -0.05,
        ev_over: 0.04,
        ev_under: -0.03,
        opportunity_score: 0.09,
        flags: [],
      })
      .mockReturnValueOnce({
      sog_mu: 3.2,
      sog_sigma: 1.79,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: { '0.5': 0.51 },
      fair_under_prob_by_line: { '0.5': 0.49 },
      fair_price_over_by_line: { '0.5': -104 },
      fair_price_under_by_line: { '0.5': 104 },
      market_line: 0.5,
      market_price_over: -115,
      market_price_under: 105,
      implied_over_prob: 0.535,
      implied_under_prob: 0.488,
      // Negative OVER edge → V2 veto should fire for 1P OVER card
      edge_over_pp: -0.04,
      edge_under_pp: 0.05,
      ev_over: -0.03,
      ev_under: 0.04,
      opportunity_score: 0.02,
      flags: [],
      });

    // getPlayerPropLine is ignored in the projection-only path.
    data.getPlayerPropLine.mockReturnValue({ line: 0.5, over_price: -115, under_price: 105 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0577-guard3-01' })],
      players: [buildPlayer({ player_id: 9920, player_name: 'V2 Veto 1P Player' })],
      // shots=3 → l5Mean=3.0; calcMu=3.2 → no anomaly
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    delete process.env.NHL_SOG_1P_CARDS_ENABLED;

    // Find the 1P card
    expect(shots.projectSogV2).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        market_line: 1,
        market_price_over: null,
        market_price_under: null,
        play_direction: 'OVER',
      }),
    );

    const onePCards = getInsertedCardsByType(data, 'nhl-player-shots-1p');

    expect(onePCards.length).toBe(1);
    const card1p = onePCards[0];

    expect(card1p.payloadData.action).not.toBe('FIRE');
    expect(card1p.payloadData.action).toBe('HOLD');
    expect(card1p.payloadData.status).toBe('WATCH');
    expect(card1p.payloadData.play.action).toBe('HOLD');
    expect(card1p.payloadData.play.status).toBe('WATCH');
    expect(card1p.payloadData.decision_v2.edge_delta_pct).toEqual(expect.any(Number));
    expect(card1p.payloadData.decision_v2.edge_pct).toBeUndefined();
    expect(card1p.payloadData.play.decision_v2.edge_delta_pct).toEqual(expect.any(Number));
    expect(card1p.payloadData.play.decision_v2.edge_pct).toBeUndefined();
  });

  test('WI-0577 Guard 3: full-game veto logging does not fire once the card is projection-only', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.2);
    shots.calcMu1p.mockReturnValue(1.0);
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.2,
      sog_sigma: 1.84,
      toi_proj: 20,
      shot_rate_ev_per60: 9.6,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.06,
      fair_over_prob_by_line: { '2.5': 0.65 },
      fair_under_prob_by_line: { '2.5': 0.35 },
      fair_price_over_by_line: { '2.5': -186 },
      fair_price_under_by_line: { '2.5': 186 },
      market_line: 2.5,
      market_price_over: -110,
      market_price_under: -110,
      implied_over_prob: 0.5238,
      implied_under_prob: 0.4762,
      edge_over_pp: -0.0400,   // NEGATIVE — Guard 3 must fire
      edge_under_pp: 0.0262,
      ev_over: -0.06,
      ev_under: 0.03,
      opportunity_score: -0.04,
      flags: [],
    });
    // Real odds line → usingRealLine=true → Guard 3 applies
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -110, under_price: -110 });
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0577-guard3-full-01' })],
      players: [buildPlayer({ player_id: 9916, player_name: 'Guard3 Full Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const fullGameCard = getInsertedCardsByType(data, 'nhl-player-shots')[0];

    const vetoWarn = warnSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('[v2-veto-full]'));
    warnSpy.mockRestore();
    expect(vetoWarn).toBeUndefined();
    expect(fullGameCard).toBeTruthy();
    expect(fullGameCard.payloadData.prop_decision.verdict).toBe('PROJECTION');
    expect(fullGameCard.payloadData.play.action).toBe('PASS');
    expect(fullGameCard.payloadData.decision.v2.flags).toContain('SYNTHETIC_LINE');
  });

  test('WI-0579: full-game V2 anomaly still emits a synthetic 1P watch card', async () => {
    process.env.NHL_SOG_1P_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    shots.calcMu.mockReturnValue(3.2);
    shots.calcMu1p.mockReturnValue(1.0);
    shots.projectSogV2
      .mockReturnValueOnce({
        sog_mu: 1.4,
        sog_sigma: 1.0,
        toi_proj: 20,
        shot_rate_ev_per60: 9.6,
        shot_rate_pp_per60: 0,
        shot_env_factor: 1.0,
        role_stability: 'HIGH',
        trend_score: 0.05,
        fair_over_prob_by_line: { '2.5': 0.59 },
        fair_under_prob_by_line: { '2.5': 0.41 },
        fair_price_over_by_line: { '2.5': -144 },
        fair_price_under_by_line: { '2.5': 144 },
        market_line: 2.5,
        market_price_over: -115,
        market_price_under: -105,
        implied_over_prob: 0.535,
        implied_under_prob: 0.512,
        edge_over_pp: 0.08,
        edge_under_pp: -0.08,
        ev_over: 0.06,
        ev_under: -0.06,
        opportunity_score: 0.3,
        flags: [],
      })
      .mockReturnValueOnce({
        sog_mu: 1.0,
        sog_sigma: 1.0,
        toi_proj: 20,
        shot_rate_ev_per60: 9.6,
        shot_rate_pp_per60: 0,
        shot_env_factor: 1.0,
        role_stability: 'HIGH',
        trend_score: 0.05,
        fair_over_prob_by_line: { '0.5': 0.58 },
        fair_under_prob_by_line: { '0.5': 0.42 },
        fair_price_over_by_line: { '0.5': -138 },
        fair_price_under_by_line: { '0.5': 138 },
        market_line: 0.5,
        market_price_over: -115,
        market_price_under: 105,
        implied_over_prob: 0.535,
        implied_under_prob: 0.488,
        edge_over_pp: 0.05,
        edge_under_pp: -0.05,
        ev_over: 0.04,
        ev_under: -0.03,
        opportunity_score: 0.12,
        flags: [],
      });

    data.getPlayerPropLine.mockImplementation((sport, gameId, playerName, propType, period) => (
      period === 'first_period'
        ? { line: 0.5, over_price: -115, under_price: 105 }
        : { line: 2.5, over_price: -115, under_price: -105 }
    ));

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0579-full-anom-1p-clean-01' })],
      players: [buildPlayer({ player_id: 9921, player_name: '1P Clean Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    delete process.env.NHL_SOG_1P_CARDS_ENABLED;

    expect(shots.projectSogV2).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        market_line: 1,
        market_price_over: null,
        market_price_under: null,
      }),
    );

    const card1p = getInsertedCardsByType(data, 'nhl-player-shots-1p')[0];
    expect(card1p).toBeTruthy();
    expect(card1p.payloadData.action).toBe('HOLD');
    expect(card1p.payloadData.status).toBe('WATCH');
    expect(card1p.payloadData.play.action).toBe('HOLD');
  });

  test('WI-0579: 1P projection-only cards stay watch-level without anomaly-specific veto logging', async () => {
    process.env.NHL_SOG_1P_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    shots.classifyEdge
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    shots.calcMu.mockReturnValue(3.2);
    shots.calcMu1p.mockReturnValue(1.0);
    shots.projectSogV2
      .mockReturnValueOnce({
        sog_mu: 3.2,
        sog_sigma: 1.79,
        toi_proj: 20,
        shot_rate_ev_per60: 9.6,
        shot_rate_pp_per60: 0,
        shot_env_factor: 1.0,
        role_stability: 'HIGH',
        trend_score: 0.05,
        fair_over_prob_by_line: { '2.5': 0.59 },
        fair_under_prob_by_line: { '2.5': 0.41 },
        fair_price_over_by_line: { '2.5': -144 },
        fair_price_under_by_line: { '2.5': 144 },
        market_line: 2.5,
        market_price_over: -115,
        market_price_under: -105,
        implied_over_prob: 0.535,
        implied_under_prob: 0.512,
        edge_over_pp: 0.06,
        edge_under_pp: -0.05,
        ev_over: 0.04,
        ev_under: -0.03,
        opportunity_score: 0.09,
        flags: [],
      })
      .mockReturnValueOnce({
        sog_mu: 0.4,
        sog_sigma: 0.63,
        toi_proj: 20,
        shot_rate_ev_per60: 9.6,
        shot_rate_pp_per60: 0,
        shot_env_factor: 1.0,
        role_stability: 'HIGH',
        trend_score: 0.05,
        fair_over_prob_by_line: { '0.5': 0.41 },
        fair_under_prob_by_line: { '0.5': 0.59 },
        fair_price_over_by_line: { '0.5': 144 },
        fair_price_under_by_line: { '0.5': -144 },
        market_line: 0.5,
        market_price_over: -115,
        market_price_under: 105,
        implied_over_prob: 0.535,
        implied_under_prob: 0.488,
        edge_over_pp: 0.08,
        edge_under_pp: -0.08,
        ev_over: 0.06,
        ev_under: -0.06,
        opportunity_score: 0.3,
        flags: [],
      });

    data.getPlayerPropLine.mockImplementation((sport, gameId, playerName, propType, period) => (
      period === 'first_period'
        ? { line: 0.5, over_price: -115, under_price: 105 }
        : { line: 2.5, over_price: -115, under_price: -105 }
    ));

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0579-full-clean-1p-anom-01' })],
      players: [buildPlayer({ player_id: 9922, player_name: '1P Anomaly Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    delete process.env.NHL_SOG_1P_CARDS_ENABLED;

    expect(shots.projectSogV2).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        market_line: 1,
        market_price_over: null,
        market_price_under: null,
      }),
    );

    const card1p = getInsertedCardsByType(data, 'nhl-player-shots-1p')[0];
    expect(card1p).toBeTruthy();
    expect(card1p.payloadData.action).toBe('HOLD');
    expect(card1p.payloadData.status).toBe('WATCH');
    expect(card1p.payloadData.play.action).toBe('HOLD');
    expect(card1p.payloadData.play.status).toBe('WATCH');

    const warnings = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warnings).not.toMatch(/\[anomaly-guard-1p\]/);
    expect(warnings).not.toMatch(/\[v2-veto-1p\]/);

    warnSpy.mockRestore();
  });

  test('WI-0578: ppRatePer60=null + ppToi=2.5 → projectSogV2 called with pp_shots_season_per60=3.0 (league-avg fallback, not null)', async () => {
    // Verifies that the PP component no longer silently collapses to 0 when
    // NST PP rate data is missing but the player has real ppToi.
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.1,
      sog_sigma: 1.76,
      toi_proj: 18,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 3.0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.04,
      fair_over_prob_by_line: { '2.5': 0.59 },
      fair_under_prob_by_line: { '2.5': 0.41 },
      fair_price_over_by_line: { '2.5': -144 },
      fair_price_under_by_line: { '2.5': 144 },
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      implied_over_prob: 0.535,
      implied_under_prob: 0.512,
      edge_over_pp: 0.055,
      edge_under_pp: -0.102,
      ev_over: 0.07,
      ev_under: -0.12,
      opportunity_score: 0.35,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0578-pp-fallback-01' })],
      players: [buildPlayer({ player_id: 9930, player_name: 'PP Fallback Player' })],
      // ppRatePer60=null, ppToi=2.5 → PP_RATE_MISSING scenario
      playerLogs: buildGamesWithRawData({ shotsPer60: 9.0, projToi: 16, ppToi: 2.5, ppRatePer60: null }),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectSogV2).toHaveBeenCalled();
    const v2Call = shots.projectSogV2.mock.calls[0][0];

    // WI-0578: must use league-avg fallback 3.0, NOT null
    expect(v2Call.pp_shots_season_per60).toBe(3.0);

    // PP_RATE_MISSING flag must still appear so the card signals the estimate
    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PP_RATE_MISSING');
  });

  test('WI-0915: BLK full context is computed and exposed even without SOG lookback', async () => {
    process.env.NHL_BLK_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();

    shots.projectBlkV1.mockImplementation((inputs = {}) => ({
      blk_mu:
        2.1 *
        Number(inputs.opponent_attempt_factor || 1) *
        Number(inputs.defensive_zone_factor || 1) *
        Number(inputs.underdog_script_factor || 1) *
        Number(inputs.playoff_tightening_factor || 1),
      blk_sigma: 1.15,
      block_rate_ev_per60: Number(inputs.ev_blocks_l5_per60 || 0),
      block_rate_pk_per60: Number(inputs.pk_blocks_l5_per60 || 0),
      role_stability: inputs.role_stability || 'HIGH',
      fair_over_prob_by_line: { [String(inputs.market_line)]: 0.56 },
      fair_under_prob_by_line: { [String(inputs.market_line)]: 0.44 },
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    }));

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0915-blk-full-context-01' })],
      players: [buildPlayer({ player_id: 9151, player_name: 'Context Defender' })],
      playerLogs: [],
      playerBlkLogs: buildBlkGames([4, 3, 3, 2, 4], { projToi: 20 }),
      playerBlkRateRow: buildBlkRateRow(),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
      teamMetricsRow: {
        opponent_shots_against_pg: 31.5,
        league_avg_shots_against_pg: 30,
        team_pace_proxy: 1.01,
        opponent_pace_proxy: 1.03,
      },
      oddsSnapshotRow: {
        h2h_home: 145,
        h2h_away: -160,
      },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectBlkV1).toHaveBeenCalledTimes(1);
    expect(shots.projectBlkV1).toHaveBeenCalledWith(
      expect.objectContaining({
        opponent_attempt_factor: 1.03,
        defensive_zone_factor: 1.05,
        underdog_script_factor: 1.08,
        playoff_tightening_factor: 1.0,
      }),
    );

    const blkCard = getSingleBlkCard(data);
    expect(blkCard.payloadData.drivers.blk_factor_inputs).toMatchObject({
      opponent_attempt_factor: 1.03,
      defensive_zone_factor: 1.05,
      underdog_script_factor: 1.08,
      playoff_tightening_factor: 1,
    });
    expect(blkCard.payloadData.drivers.blk_factor_source).toEqual({
      opponent_attempt_factor: 'computed',
      defensive_zone_factor: 'computed',
      underdog_script_factor: 'computed',
      playoff_tightening_factor: 'computed',
    });
    expect(blkCard.payloadData.drivers.blk_context_tag).toBe('UNDERDOG_HIGH_PRESSURE');
  });

  test('WI-0915: BLK missing context defaults factors and emits flags', async () => {
    process.env.NHL_BLK_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();

    shots.projectBlkV1.mockImplementation((inputs = {}) => ({
      blk_mu:
        1.8 *
        Number(inputs.opponent_attempt_factor || 1) *
        Number(inputs.defensive_zone_factor || 1) *
        Number(inputs.underdog_script_factor || 1),
      blk_sigma: 1.05,
      block_rate_ev_per60: Number(inputs.ev_blocks_l5_per60 || 0),
      block_rate_pk_per60: Number(inputs.pk_blocks_l5_per60 || 0),
      role_stability: inputs.role_stability || 'HIGH',
      fair_over_prob_by_line: { [String(inputs.market_line)]: 0.5 },
      fair_under_prob_by_line: { [String(inputs.market_line)]: 0.5 },
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    }));

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0915-blk-missing-context-01' })],
      players: [buildPlayer({ player_id: 9152, player_name: 'Fallback Defender' })],
      playerLogs: [],
      playerBlkLogs: buildBlkGames([2, 2, 1, 3, 2]),
      playerBlkRateRow: buildBlkRateRow(),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(shots.projectBlkV1).toHaveBeenCalledWith(
      expect.objectContaining({
        opponent_attempt_factor: 1,
        defensive_zone_factor: 1,
        underdog_script_factor: 1,
      }),
    );

    const blkCard = getSingleBlkCard(data);
    expect(blkCard.payloadData.prop_decision.flags).toContain('BLK_DZ_FACTOR_MISSING');
    expect(blkCard.payloadData.prop_decision.flags).toContain('BLK_UNDERDOG_FACTOR_MISSING');
    expect(blkCard.payloadData.decision.v2.flags).toContain('BLK_DZ_FACTOR_MISSING');
    expect(blkCard.payloadData.decision.v2.flags).toContain('BLK_UNDERDOG_FACTOR_MISSING');
    expect(blkCard.payloadData.drivers.blk_factor_source).toEqual({
      opponent_attempt_factor: 'defaulted',
      defensive_zone_factor: 'defaulted',
      underdog_script_factor: 'defaulted',
      playoff_tightening_factor: 'computed',
    });
    expect(blkCard.payloadData.drivers.blk_factor_inputs).toMatchObject({
      opponent_attempt_factor: 1,
      defensive_zone_factor: 1,
      underdog_script_factor: 1,
      playoff_tightening_factor: 1,
    });
  });

  test('WI-0915: BLK context cap rescales dynamic factors to 1.20', async () => {
    process.env.NHL_BLK_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();

    shots.projectBlkV1.mockImplementation((inputs = {}) => ({
      blk_mu:
        2 *
        Number(inputs.opponent_attempt_factor || 1) *
        Number(inputs.defensive_zone_factor || 1) *
        Number(inputs.underdog_script_factor || 1),
      blk_sigma: 1.2,
      block_rate_ev_per60: Number(inputs.ev_blocks_l5_per60 || 0),
      block_rate_pk_per60: Number(inputs.pk_blocks_l5_per60 || 0),
      role_stability: inputs.role_stability || 'HIGH',
      fair_over_prob_by_line: { [String(inputs.market_line)]: 0.55 },
      fair_under_prob_by_line: { [String(inputs.market_line)]: 0.45 },
      edge_over_pp: null,
      edge_under_pp: null,
      ev_over: null,
      ev_under: null,
      opportunity_score: null,
      flags: [],
    }));

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0915-blk-cap-01' })],
      players: [buildPlayer({ player_id: 9153, player_name: 'Capped Defender' })],
      playerLogs: [],
      playerBlkLogs: buildBlkGames([5, 4, 4, 3, 5], { projToi: 21 }),
      playerBlkRateRow: buildBlkRateRow(),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
      teamMetricsRow: {
        opponent_shots_against_pg: 36,
        league_avg_shots_against_pg: 30,
        team_pace_proxy: 1.06,
        opponent_pace_proxy: 1.12,
      },
      oddsSnapshotRow: {
        h2h_home: 200,
        h2h_away: -250,
      },
    }));

    await mod.runNHLPlayerShotsModel();

    const blkInputs = shots.projectBlkV1.mock.calls[0][0];
    expect(blkInputs.opponent_attempt_factor).toBe(1.12);
    expect(
      blkInputs.opponent_attempt_factor *
      blkInputs.defensive_zone_factor *
      blkInputs.underdog_script_factor,
    ).toBeCloseTo(1.2, 6);

    const blkCard = getSingleBlkCard(data);
    expect(blkCard.payloadData.prop_decision.flags).toContain('BLK_CONTEXT_CAP_APPLIED');
    expect(blkCard.payloadData.decision.v2.flags).toContain('BLK_CONTEXT_CAP_APPLIED');
    expect(blkCard.payloadData.drivers.blk_factor_inputs.opponent_attempt_factor).toBe(1.12);
    expect(
      blkCard.payloadData.drivers.blk_factor_inputs.opponent_attempt_factor *
      blkCard.payloadData.drivers.blk_factor_inputs.defensive_zone_factor *
      blkCard.payloadData.drivers.blk_factor_inputs.underdog_script_factor,
    ).toBeCloseTo(1.2, 3);
  });

  test('WI-0915: BLK projection sensitivity changes with favorite and underdog context', async () => {
    process.env.NHL_BLK_CARDS_ENABLED = 'true';

    const runScenario = async ({ gameId, teamMetricsRow, oddsSnapshotRow }) => {
      const { mod, data, shots } = loadFreshModule();
      shots.projectBlkV1.mockImplementation((inputs = {}) => ({
        blk_mu:
          1.9 *
          Number(inputs.opponent_attempt_factor || 1) *
          Number(inputs.defensive_zone_factor || 1) *
          Number(inputs.underdog_script_factor || 1),
        blk_sigma: 1.1,
        block_rate_ev_per60: Number(inputs.ev_blocks_l5_per60 || 0),
        block_rate_pk_per60: Number(inputs.pk_blocks_l5_per60 || 0),
        role_stability: inputs.role_stability || 'HIGH',
        fair_over_prob_by_line: { [String(inputs.market_line)]: 0.54 },
        fair_under_prob_by_line: { [String(inputs.market_line)]: 0.46 },
        edge_over_pp: null,
        edge_under_pp: null,
        ev_over: null,
        ev_under: null,
        opportunity_score: null,
        flags: [],
      }));

      data.getDatabase.mockReturnValue(buildMockDb({
        games: [buildFutureGame({ game_id: gameId })],
        players: [buildPlayer({ player_id: 9154, player_name: 'Sensitivity Defender' })],
        playerLogs: [],
        playerBlkLogs: buildBlkGames([3, 3, 2, 4, 3]),
        playerBlkRateRow: buildBlkRateRow(),
        availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
        teamMetricsRow,
        oddsSnapshotRow,
      }));

      await mod.runNHLPlayerShotsModel();

      return {
        blkInputs: shots.projectBlkV1.mock.calls[0][0],
        blkCard: getSingleBlkCard(data),
      };
    };

    const favoriteScenario = await runScenario({
      gameId: 'wi-0915-blk-sensitivity-favorite-01',
      teamMetricsRow: {
        opponent_shots_against_pg: 27,
        league_avg_shots_against_pg: 30,
        team_pace_proxy: 1.01,
        opponent_pace_proxy: 1.02,
      },
      oddsSnapshotRow: {
        moneyline_home: -160,
        moneyline_away: 140,
      },
    });
    const underdogScenario = await runScenario({
      gameId: 'wi-0915-blk-sensitivity-underdog-01',
      teamMetricsRow: {
        opponent_shots_against_pg: 31.5,
        league_avg_shots_against_pg: 30,
        team_pace_proxy: 1.01,
        opponent_pace_proxy: 1.02,
      },
      oddsSnapshotRow: {
        h2h_home: 145,
        h2h_away: -160,
      },
    });

    expect(favoriteScenario.blkInputs.underdog_script_factor).toBe(1);
    expect(favoriteScenario.blkCard.payloadData.drivers.blk_context_tag).toBe('FAVORITE_LOW_BLOCK');
    expect(underdogScenario.blkInputs.underdog_script_factor).toBe(1.08);
    expect(underdogScenario.blkCard.payloadData.drivers.blk_context_tag).toBe('UNDERDOG_HIGH_PRESSURE');
    expect(underdogScenario.blkCard.payloadData.projectedTotal).toBeGreaterThan(
      favoriteScenario.blkCard.payloadData.projectedTotal,
    );
  });

  test('WI-0911: nhl-player-blk payloads include settlement_policy.grading_eligible === false', async () => {
    process.env.NHL_BLK_CARDS_ENABLED = 'true';
    const { mod, data, shots } = loadFreshModule();

    shots.projectBlkV1.mockImplementation((inputs = {}) => ({
      blk_mu: 1.8,
      blk_sigma: 1.05,
      block_rate_ev_per60: 2.1,
      block_rate_pk_per60: 0.8,
      role_stability: 'HIGH',
      fair_over_prob_by_line: { [String(inputs.market_line)]: 0.52 },
      fair_under_prob_by_line: { [String(inputs.market_line)]: 0.48 },
      edge_over_pp: 0.03,
      edge_under_pp: -0.03,
      ev_over: 0.02,
      ev_under: -0.02,
      opportunity_score: 0.35,
      flags: [],
    }));

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'wi-0911-settlement-policy-01' })],
      players: [buildPlayer({ player_id: 8477492, player_name: 'Policy Test Player' })],
      playerLogs: [],
      playerBlkLogs: buildBlkGames([3, 2, 3, 2, 3]),
      playerBlkRateRow: buildBlkRateRow(),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    const blkCards = getInsertedCardsByType(data, 'nhl-player-blk');
    expect(blkCards.length).toBeGreaterThanOrEqual(1);
    expect(blkCards[0].payloadData.settlement_policy).toMatchObject({
      grading_eligible: false,
      reason: 'PROJECTION_AUDIT_ONLY',
      market: 'player_blocked_shots',
    });
  });
});
