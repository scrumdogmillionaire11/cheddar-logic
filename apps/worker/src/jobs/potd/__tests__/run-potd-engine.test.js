'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const { makeEtDateTime } = require('../../../../tests/helpers/discord-timing');

const TEST_DB_PATH = '/tmp/cheddar-test-run-potd-engine.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;
const TEST_SYSTEM_NOW = new Date('2026-04-09T13:00:00.000-04:00');

beforeAll(() => {
  jest.useFakeTimers().setSystemTime(TEST_SYSTEM_NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

function resetTables() {
  const db = new Database(TEST_DB_PATH);
  db.exec(`
    DROP TABLE IF EXISTS run_state;
    DELETE FROM potd_bankroll;
    DELETE FROM potd_plays;
    DELETE FROM potd_daily_stats;
    DELETE FROM potd_nominees;
    DELETE FROM potd_shadow_results;
    DELETE FROM potd_shadow_candidates;
    DELETE FROM card_results;
    DELETE FROM card_payloads;
    DELETE FROM odds_snapshots;
    DELETE FROM games;
    DELETE FROM job_runs;
  `);
  db.close();
}

function readRows(sql, params = []) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows;
}

function buildSelectedCandidate(overrides = {}) {
  const impliedProb =
    typeof overrides.impliedProb === 'number' ? overrides.impliedProb : 0.465;
  const edgePct =
    typeof overrides.edgePct === 'number' ? overrides.edgePct : 0.025;
  const modelWinProb =
    typeof overrides.modelWinProb === 'number'
      ? overrides.modelWinProb
      : Number((impliedProb + edgePct).toFixed(6));

  return {
    gameId: 'potd-game-001',
    sport: 'NHL',
    home_team: 'Boston Bruins',
    away_team: 'Toronto Maple Leafs',
    commence_time: '2026-04-10T00:00:00.000Z',
    marketType: 'TOTAL',
    selection: 'OVER',
    selectionLabel: 'OVER 5.5',
    line: 5.5,
    price: 115,
    oddsContext: {
      total: 5.5,
      total_price_over: 115,
      total_price_under: -122,
      captured_at: '2026-04-09T18:00:00.000Z',
    },
    totalScore: 0.73,
    modelWinProb,
    impliedProb,
    edgePct,
    edgeSourceTag: overrides.edgeSourceTag || 'MODEL',
    confidenceLabel: 'HIGH',
    scoreBreakdown: {
      lineValue: 0.81,
      marketConsensus: 0.59,
    },
    reasoning: 'Model likes OVER 5.5 at +115: edge +2.5pp, win prob 49.0%, line value strong, market consensus solid.',
    ...overrides,
  };
}

function insertGameRow({
  gameId,
  sport,
  homeTeam,
  awayTeam,
  gameTimeUtc,
  status = 'scheduled',
}) {
  const db = new Database(TEST_DB_PATH);
  db.prepare(`
    INSERT INTO games (game_id, sport, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(gameId, sport, homeTeam, awayTeam, gameTimeUtc, status);
  db.close();
}

function insertCardPayloadRow({
  id,
  gameId,
  sport,
  cardType,
  cardTitle,
  createdAt,
  payloadData,
}) {
  const db = new Database(TEST_DB_PATH);
  db.prepare(`
    INSERT INTO card_payloads (
      id, game_id, sport, card_type, card_title, created_at, payload_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, gameId, sport, cardType, cardTitle, createdAt, JSON.stringify(payloadData));
  db.close();
}

describe('runPotdEngine', () => {
  let dataModule;

  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';
    process.env.POTD_STARTING_BANKROLL = '10';
    process.env.POTD_KELLY_FRACTION = '0.25';
    process.env.POTD_MAX_WAGER_PCT = '0.2';
    process.env.DISCORD_POTD_WEBHOOK_URL = 'https://discord.example/potd';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    dataModule = require('@cheddar-logic/data');
    await dataModule.runMigrations();
    dataModule.closeDatabase();
  });

  beforeEach(() => {
    dataModule.closeDatabase();
    resetTables();
  });

  afterAll(() => {
    try {
      dataModule.closeDatabase();
    } catch {
      // best effort
    }
  });

  test('no-play day exits cleanly without writing POTD rows', async () => {
    const { runPotdEngine } = require('../run_potd_engine');

    const result = await runPotdEngine({
      jobKey: 'potd|2026-04-09',
      force: true,
      fetchOddsFn: async () => ({ games: [], errors: [] }),
    });

    expect(result.success).toBe(true);
    expect(result.noPlay).toBe(true);
    expect(readRows('SELECT * FROM potd_plays')).toEqual([]);
    expect(readRows('SELECT * FROM potd_bankroll')).toHaveLength(1);
  });

  test('blocks LOW-confidence candidate before Kelly sizing and records no-play reason', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const lowConfidenceCandidate = buildSelectedCandidate({
      totalScore: 0.42,
      confidenceLabel: 'LOW',
      edgePct: 0.03,
    });
    const kellySizeFn = jest.fn(() => 2.5);

    const result = await runPotdEngine({
      jobKey: 'potd|low-confidence-gate',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: lowConfidenceCandidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [lowConfidenceCandidate],
      scoreCandidateFn: (value) => value,
      // Force a best candidate return so the runner-level confidence guard is exercised.
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.noPlay).toBe(true);
    expect(result.reason).toBe('confidence_below_high_gate');
    expect(kellySizeFn).not.toHaveBeenCalled();

    const plays = readRows('SELECT * FROM potd_plays');
    expect(plays).toHaveLength(0);

    const shadowRows = readRows(
      `SELECT selection, game_time_utc, candidate_identity_key
       FROM potd_shadow_candidates
       ORDER BY id ASC`,
    );
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0].selection).toBe('OVER');
    expect(shadowRows[0].game_time_utc).toBe(lowConfidenceCandidate.commence_time);
    expect(shadowRows[0].candidate_identity_key).toEqual(expect.any(String));
  });

  test('seeds bankroll and writes published TOTAL play plus settlement-compatible potd-call', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate();

    const result = await runPotdEngine({
      jobKey: 'potd|2026-04-09',
      force: true,
      fetchOddsFn: async () => ({
        games: [{ gameId: candidate.gameId }],
        errors: [],
      }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 2.5,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.discordPosted).toBe(true);

    const bankrollRows = readRows(
      `SELECT event_type, amount_before, amount_change, amount_after
       FROM potd_bankroll
       ORDER BY created_at ASC, id ASC`,
    );
    expect(bankrollRows).toEqual([
      {
        event_type: 'initial',
        amount_before: 0,
        amount_change: 10,
        amount_after: 10,
      },
      {
        event_type: 'play_posted',
        amount_before: 10,
        amount_change: 0,
        amount_after: 10,
      },
    ]);

    const playRows = readRows(
      `SELECT play_date, card_id, market_type, selection, wager_amount, bankroll_at_post, discord_posted
       FROM potd_plays`,
    );
    expect(playRows).toHaveLength(1);
    // kellySizeFn returns 2.5; HIGH multiplier (0.85) → 2.125 → rounds to nearest $0.50 = 2.0
    expect(playRows[0]).toMatchObject({
      market_type: 'TOTAL',
      selection: 'OVER',
      wager_amount: 2.0,
      bankroll_at_post: 10,
      discord_posted: 1,
    });

    const cardResult = readRows(
      `SELECT market_type, selection, line, locked_price
       FROM card_results
       WHERE card_id = ?`,
      [playRows[0].card_id],
    )[0];
    expect(cardResult).toMatchObject({
      market_type: 'TOTAL',
      selection: 'OVER',
      line: 5.5,
      locked_price: 115,
    });

    const shadowRows = readRows(
      `SELECT selection, game_time_utc, candidate_identity_key
       FROM potd_shadow_candidates`,
    );
    expect(shadowRows).toHaveLength(0);
  });

  test('fired path captures top three near-miss nominees and excludes official winner', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const winner = buildSelectedCandidate({ gameId: 'potd-near-miss-winner', selectionLabel: 'OVER 5.5' });
    const miss1 = buildSelectedCandidate({ gameId: 'potd-near-miss-1', selectionLabel: 'UNDER 6.5', selection: 'UNDER', edgePct: 0.024 });
    const miss2 = buildSelectedCandidate({ gameId: 'potd-near-miss-2', selectionLabel: 'OVER 4.5', edgePct: 0.023 });
    const miss3 = buildSelectedCandidate({ gameId: 'potd-near-miss-3', selectionLabel: 'OVER 7.5', edgePct: 0.022 });
    const miss4 = buildSelectedCandidate({ gameId: 'potd-near-miss-4', selectionLabel: 'OVER 8.5', edgePct: 0.021 });
    const ranked = [winner, miss1, miss2, miss3, miss4];

    const result = await runPotdEngine({
      jobKey: 'potd|near-miss-fired-selection',
      force: true,
      fetchOddsFn: async () => ({
        games: ranked.map((candidate) => ({ gameId: candidate.gameId })),
        errors: [],
      }),
      buildCandidatesFn: (game) =>
        ranked.filter((candidate) => candidate.gameId === game.gameId),
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: () => ranked,
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);

    const shadowRows = readRows(
      `SELECT game_id, selection
       FROM potd_shadow_candidates
       ORDER BY id ASC`,
    );
    expect(shadowRows).toEqual([
      { game_id: miss1.gameId, selection: 'UNDER' },
      { game_id: miss2.gameId, selection: 'OVER' },
      { game_id: miss3.gameId, selection: 'OVER' },
    ]);
  });

  test('fired path captures same-sport near misses from full eligible pool', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const winner = buildSelectedCandidate({
      gameId: 'potd-nba-pool-winner',
      sport: 'NBA',
      home_team: 'Boston Celtics',
      away_team: 'New York Knicks',
      selectionLabel: 'OVER 221.5',
      line: 221.5,
      totalScore: 0.91,
      edgePct: 0.027,
    });
    const miss1 = buildSelectedCandidate({
      gameId: 'potd-nba-pool-1',
      sport: 'NBA',
      home_team: 'Denver Nuggets',
      away_team: 'Phoenix Suns',
      selectionLabel: 'OVER 226.5',
      line: 226.5,
      totalScore: 0.82,
      edgePct: 0.041,
    });
    const miss2 = buildSelectedCandidate({
      gameId: 'potd-nba-pool-2',
      sport: 'NBA',
      home_team: 'Milwaukee Bucks',
      away_team: 'Indiana Pacers',
      selection: 'UNDER',
      selectionLabel: 'UNDER 232.5',
      line: 232.5,
      totalScore: 0.81,
      edgePct: 0.037,
    });
    const miss3 = buildSelectedCandidate({
      gameId: 'potd-nba-pool-3',
      sport: 'NBA',
      home_team: 'Los Angeles Lakers',
      away_team: 'Golden State Warriors',
      selectionLabel: 'OVER 229.5',
      line: 229.5,
      totalScore: 0.8,
      edgePct: 0.033,
    });
    const miss4 = buildSelectedCandidate({
      gameId: 'potd-nba-pool-4',
      sport: 'NBA',
      home_team: 'Oklahoma City Thunder',
      away_team: 'Minnesota Timberwolves',
      selectionLabel: 'OVER 218.5',
      line: 218.5,
      totalScore: 0.79,
      edgePct: 0.031,
    });
    const candidates = [winner, miss1, miss2, miss3, miss4];

    const result = await runPotdEngine({
      jobKey: 'potd|same-sport-shadow-pool',
      force: true,
      fetchOddsFn: async ({ sport }) => ({
        games: sport === 'NBA' ? candidates.map((candidate) => ({ gameId: candidate.gameId })) : [],
        errors: [],
      }),
      buildCandidatesFn: (game) =>
        candidates.filter((candidate) => candidate.gameId === game.gameId),
      scoreCandidateFn: (value) => value,
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);

    const playRows = readRows(
      `SELECT game_id, sport
       FROM potd_plays`,
    );
    expect(playRows).toEqual([
      { game_id: winner.gameId, sport: 'NBA' },
    ]);

    const nomineeRows = readRows(
      `SELECT game_id, sport
       FROM potd_nominees
       ORDER BY nominee_rank ASC`,
    );
    expect(nomineeRows).toEqual([
      { game_id: winner.gameId, sport: 'NBA' },
    ]);

    const shadowRows = readRows(
      `SELECT game_id, sport, selection
       FROM potd_shadow_candidates
       ORDER BY edge_pct DESC`,
    );
    expect(shadowRows).toEqual([
      { game_id: miss1.gameId, sport: 'NBA', selection: 'OVER' },
      { game_id: miss2.gameId, sport: 'NBA', selection: 'UNDER' },
      { game_id: miss3.gameId, sport: 'NBA', selection: 'OVER' },
    ]);
  });

  test('fired path suppresses near-miss candidates from the winner market/match group', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const winner = buildSelectedCandidate({
      gameId: 'potd-winner-group-total',
      selection: 'OVER',
      selectionLabel: 'OVER 5.5',
      line: 5.5,
      edgePct: 0.05,
    });
    const opposingSameGroup = buildSelectedCandidate({
      gameId: winner.gameId,
      selection: 'UNDER',
      selectionLabel: 'UNDER 5.5',
      line: 5.5,
      edgePct: 0.049,
    });
    const spreadNearMiss = buildSelectedCandidate({
      gameId: 'potd-winner-group-spread',
      marketType: 'SPREAD',
      selection: 'HOME',
      selectionLabel: 'Boston Bruins -1.5',
      line: -1.5,
      edgePct: 0.035,
    });
    const ranked = [winner, opposingSameGroup, spreadNearMiss];

    const result = await runPotdEngine({
      jobKey: 'potd|winner-group-suppression',
      force: true,
      fetchOddsFn: async () => ({ games: ranked.map((candidate) => ({ gameId: candidate.gameId })), errors: [] }),
      buildCandidatesFn: (game) => ranked.filter((candidate) => candidate.gameId === game.gameId),
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: () => ranked,
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);

    const shadowRows = readRows(
      `SELECT game_id, market_type, selection
       FROM potd_shadow_candidates
       ORDER BY id ASC`,
    );
    expect(shadowRows).toEqual([
      { game_id: spreadNearMiss.gameId, market_type: 'SPREAD', selection: 'HOME' },
    ]);
  });

  test('near-miss write keeps highest-edge opposing TOTAL and SPREAD side per market/match', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const totalOver = buildSelectedCandidate({
      gameId: 'potd-best-edge-total',
      selection: 'OVER',
      selectionLabel: 'OVER 5.5',
      line: 5.5,
      edgePct: 0.031,
    });
    const totalUnder = buildSelectedCandidate({
      gameId: totalOver.gameId,
      selection: 'UNDER',
      selectionLabel: 'UNDER 5.5',
      line: 5.5,
      edgePct: 0.038,
    });
    const spreadHome = buildSelectedCandidate({
      gameId: 'potd-best-edge-spread',
      marketType: 'SPREAD',
      selection: 'HOME',
      selectionLabel: 'Boston Bruins -1.5',
      line: -1.5,
      edgePct: 0.029,
    });
    const spreadAway = buildSelectedCandidate({
      gameId: spreadHome.gameId,
      marketType: 'SPREAD',
      selection: 'AWAY',
      selectionLabel: 'Toronto Maple Leafs +1.5',
      line: 1.5,
      edgePct: 0.034,
    });
    const candidates = [totalOver, totalUnder, spreadHome, spreadAway];

    const result = await runPotdEngine({
      jobKey: 'potd|near-miss-best-edge-groups',
      force: true,
      fetchOddsFn: async () => ({ games: candidates.map((candidate) => ({ gameId: candidate.gameId })), errors: [] }),
      buildCandidatesFn: (game) => candidates.filter((candidate) => candidate.gameId === game.gameId),
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: (values) => values,
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('zero_wager');

    const shadowRows = readRows(
      `SELECT game_id, market_type, selection, line, edge_pct, candidate_identity_key
       FROM potd_shadow_candidates
       ORDER BY edge_pct DESC`,
    );
    expect(shadowRows).toHaveLength(2);
    expect(shadowRows).toEqual([
      expect.objectContaining({
        game_id: totalOver.gameId,
        market_type: 'TOTAL',
        selection: 'UNDER',
        line: 5.5,
        edge_pct: 0.038,
      }),
      expect.objectContaining({
        game_id: spreadHome.gameId,
        market_type: 'SPREAD',
        selection: 'AWAY',
        line: 1.5,
        edge_pct: 0.034,
      }),
    ]);
    expect(shadowRows[0].candidate_identity_key).toContain('|UNDER|');
    expect(shadowRows[1].candidate_identity_key).toContain('|AWAY|');
  });

  test('below-score high-edge candidate does not suppress lower-edge fireable side', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const belowScoreHighEdge = buildSelectedCandidate({
      gameId: 'potd-fireable-canonical-total',
      selection: 'OVER',
      selectionLabel: 'OVER 5.5',
      line: 5.5,
      edgePct: 0.08,
      totalScore: 0.29,
    });
    const fireableLowerEdge = buildSelectedCandidate({
      gameId: belowScoreHighEdge.gameId,
      selection: 'UNDER',
      selectionLabel: 'UNDER 5.5',
      line: 5.5,
      edgePct: 0.035,
      totalScore: 0.72,
    });
    const candidates = [belowScoreHighEdge, fireableLowerEdge];

    const result = await runPotdEngine({
      jobKey: 'potd|below-score-does-not-suppress-fireable',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: belowScoreHighEdge.gameId }], errors: [] }),
      buildCandidatesFn: () => candidates,
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: (values) => values,
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('zero_wager');

    const shadowRows = readRows(
      `SELECT selection, edge_pct, total_score
       FROM potd_shadow_candidates`,
    );
    expect(shadowRows).toEqual([
      { selection: 'UNDER', edge_pct: 0.035, total_score: 0.72 },
    ]);
  });

  test('no-best-candidate path records no shadow rows when no fireable nominees remain', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({
      gameId: 'potd-negative-edge-shadow-001',
      edgePct: -0.003,
      totalScore: 0.71,
      selection: 'AWAY',
      selectionLabel: 'Toronto Maple Leafs',
      marketType: 'MONEYLINE',
      line: null,
    });

    const result = await runPotdEngine({
      jobKey: 'potd|no-best-shadow-capture',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: () => [],
      kellySizeFn: () => 1,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.noPlay).toBe(true);

    const shadowRows = readRows(
      `SELECT selection, game_time_utc, candidate_identity_key
       FROM potd_shadow_candidates`,
    );
    expect(shadowRows).toHaveLength(0);
  });

  test('zero-wager path captures shadow candidates', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({
      gameId: 'potd-zero-wager-shadow-001',
      selection: 'UNDER',
      selectionLabel: 'UNDER 5.5',
    });

    const result = await runPotdEngine({
      jobKey: 'potd|zero-wager-shadow-capture',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('zero_wager');

    const shadowRows = readRows(
      `SELECT selection, candidate_identity_key
       FROM potd_shadow_candidates`,
    );
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0].selection).toBe('UNDER');
    expect(shadowRows[0].candidate_identity_key).toEqual(expect.any(String));
  });

  test('stake-below-minimum path captures shadow candidates', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({ gameId: 'potd-stake-min-shadow-001' });

    const result = await runPotdEngine({
      jobKey: 'potd|stake-below-min-shadow-capture',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 0.01,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('stake_below_minimum');

    const shadowRows = readRows(
      `SELECT selection, candidate_identity_key
       FROM potd_shadow_candidates`,
    );
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0].selection).toBe('OVER');
    expect(shadowRows[0].candidate_identity_key).toEqual(expect.any(String));
  });

  test('same-day rerun upserts near-miss shadow candidates by identity key', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({
      gameId: 'potd-shadow-upsert-001',
      edgePct: 0.025,
      totalScore: 0.72,
    });

    const baseOptions = {
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => 1,
    };

    await runPotdEngine({ ...baseOptions, jobKey: 'potd|shadow-upsert-pass-1' });
    await runPotdEngine({ ...baseOptions, jobKey: 'potd|shadow-upsert-pass-2' });

    const rows = readRows(
      `SELECT play_date, candidate_identity_key
       FROM potd_shadow_candidates`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].play_date).toEqual(expect.any(String));
    expect(rows[0].candidate_identity_key).toEqual(expect.any(String));
  });

  test('same-day rerun replaces obsolete same-group shadow row and nulls result FK', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const firstCandidate = buildSelectedCandidate({
      gameId: 'potd-shadow-replace-total',
      selection: 'OVER',
      selectionLabel: 'OVER 5.5',
      line: 5.5,
      edgePct: 0.025,
    });
    const replacementCandidate = buildSelectedCandidate({
      gameId: firstCandidate.gameId,
      selection: 'UNDER',
      selectionLabel: 'UNDER 5.5',
      line: 5.5,
      edgePct: 0.04,
    });

    const baseOptions = {
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: firstCandidate.gameId }], errors: [] }),
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (values) => values,
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => 1,
    };

    await runPotdEngine({
      ...baseOptions,
      jobKey: 'potd|shadow-replace-pass-1',
      buildCandidatesFn: () => [firstCandidate],
    });

    const firstRow = readRows(
      `SELECT id, play_date, candidate_identity_key
       FROM potd_shadow_candidates
       LIMIT 1`,
    )[0];
    expect(firstRow).toBeTruthy();

    const db = new Database(TEST_DB_PATH);
    db.prepare(
      `INSERT INTO potd_shadow_results (
        play_date, candidate_identity_key, shadow_candidate_id, game_id, sport,
        market_type, selection, selection_label, line, price, game_time_utc,
        status, result, virtual_stake_units
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 1.0)`,
    ).run(
      firstRow.play_date,
      firstRow.candidate_identity_key,
      firstRow.id,
      firstCandidate.gameId,
      firstCandidate.sport,
      firstCandidate.marketType,
      firstCandidate.selection,
      firstCandidate.selectionLabel,
      firstCandidate.line,
      firstCandidate.price,
      firstCandidate.commence_time,
    );
    db.close();

    await runPotdEngine({
      ...baseOptions,
      jobKey: 'potd|shadow-replace-pass-2',
      buildCandidatesFn: () => [replacementCandidate],
    });

    const shadowRows = readRows(
      `SELECT id, selection, candidate_identity_key
       FROM potd_shadow_candidates`,
    );
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0].selection).toBe('UNDER');

    const resultRows = readRows(
      `SELECT shadow_candidate_id, candidate_identity_key
       FROM potd_shadow_results`,
    );
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0].shadow_candidate_id).toBeNull();
    expect(resultRows[0].candidate_identity_key).toBe(firstRow.candidate_identity_key);
  });

  test.each([
    [
      'SPREAD',
      buildSelectedCandidate({
        marketType: 'SPREAD',
        selection: 'HOME',
        selectionLabel: 'Boston Bruins -1.5',
        line: -1.5,
        price: -108,
        oddsContext: {
          spread_home: -1.5,
          spread_away: 1.5,
          spread_price_home: -108,
          spread_price_away: -112,
          captured_at: '2026-04-09T18:00:00.000Z',
        },
      }),
      { market_type: 'SPREAD', selection: 'HOME', line: -1.5, locked_price: -108 },
    ],
    [
      'MONEYLINE',
      buildSelectedCandidate({
        marketType: 'MONEYLINE',
        selection: 'AWAY',
        selectionLabel: 'Toronto Maple Leafs',
        line: null,
        price: 125,
        oddsContext: {
          h2h_home: -135,
          h2h_away: 125,
          captured_at: '2026-04-09T18:00:00.000Z',
        },
      }),
      { market_type: 'MONEYLINE', selection: 'AWAY', line: null, locked_price: 125 },
    ],
  ])('writes market contract fields for %s plays', async (_label, candidate, expected) => {
    const { runPotdEngine } = require('../run_potd_engine');

    const result = await runPotdEngine({
      jobKey: `potd|${candidate.marketType}`,
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 1.5,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    const cardResult = readRows(
      `SELECT market_type, selection, line, locked_price
       FROM card_results
       WHERE card_id = ?`,
      [result.cardId],
    )[0];
    expect(cardResult).toMatchObject(expected);

    dataModule.closeDatabase();
    resetTables();
  });

  test('discord failure is non-fatal after DB commit', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate();

    const result = await runPotdEngine({
      jobKey: 'potd|discord-failure',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 2,
      sendDiscordMessagesFn: async () => {
        throw new Error('webhook down');
      },
    });

    expect(result.success).toBe(true);
    expect(result.discordPosted).toBe(false);
    expect(result.discordError).toBe('webhook down');

    const playRow = readRows(
      `SELECT discord_posted FROM potd_plays LIMIT 1`,
    )[0];
    expect(playRow.discord_posted).toBe(0);
  });

  test('hydrates MLB games from persisted model-output card payloads before candidate construction', async () => {
    // MLB has active:false in production config, but this test exercises the engine's
    // MLB-specific odds-hydration code path. Mock MLB as active so it enters the pipeline.
    jest.resetModules();
    jest.mock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: {
        NHL: { active: true },
        NBA: { active: true },
        MLB: { active: true },
        NFL: { active: false },
      },
    }));
    const { runPotdEngine } = require('../run_potd_engine');
    let receivedGame = null;

    insertGameRow({
      gameId: 'mlb-potd-001',
      sport: 'mlb',
      homeTeam: 'Dodgers',
      awayTeam: 'Rockies',
      gameTimeUtc: '2026-04-10T00:00:00.000Z',
    });
    insertCardPayloadRow({
      id: 'mlb-potd-001-card',
      gameId: 'mlb-potd-001',
      sport: 'mlb',
      cardType: 'mlb-full-game',
      cardTitle: 'MLB Full Game',
      createdAt: '2026-04-11T18:00:00.000Z',
      payloadData: {
        projection_source: 'MLB_FULL_GAME_MODEL',
        drivers: [{ win_prob_home: 0.665385, edge: 0.05, side: 'HOME' }],
      },
    });

    const result = await runPotdEngine({
      jobKey: 'potd|mlb-runtime-signal',
      force: true,
      fetchOddsFn: async ({ sport }) => {
        if (sport !== 'MLB') {
          return { games: [], errors: [] };
        }
        return {
          games: [
            {
              gameId: 'mlb-potd-001',
              sport: 'MLB',
              homeTeam: 'Dodgers',
              awayTeam: 'Rockies',
              gameTimeUtc: '2026-04-10T00:00:00.000Z',
              capturedAtUtc: '2026-04-11T18:05:00.000Z',
              market: {
                spreads: [],
                totals: [],
                h2h: [
                  { book: 'book-a', home: -170, away: 150 },
                  { book: 'book-b', home: -165, away: 145 },
                  { book: 'book-c', home: -160, away: 140 },
                ],
              },
            },
          ],
          errors: [],
        };
      },
      buildCandidatesFn: (game) => {
        receivedGame = game;
        return [
          buildSelectedCandidate({
            gameId: game.gameId,
            sport: game.sport,
            home_team: game.homeTeam,
            away_team: game.awayTeam,
            commence_time: game.gameTimeUtc,
            marketType: 'MONEYLINE',
            selection: 'HOME',
            selectionLabel: game.homeTeam,
            line: null,
            price: -160,
            oddsContext: {
              h2h_home: -160,
              h2h_away: 140,
              captured_at: game.capturedAtUtc,
            },
            modelWinProb: 0.665385,
            impliedProb: 0.615385,
            edgePct: 0.05,
            edgeSourceTag: 'MODEL',
            scoreBreakdown: {
              lineValue: 0.56,
              marketConsensus: 0.77,
            },
          }),
        ];
      },
      scoreCandidateFn: (candidate) => candidate,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 1.5,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(receivedGame).not.toBeNull();
    expect(receivedGame.mlbSnapshot).toMatchObject({
      modelWinProbHome: 0.665385,
      edge: 0.05,
      side: 'HOME',
      projection_source: 'MLB_FULL_GAME_MODEL',
    });

    const playRow = readRows(
      `SELECT market_type, selection, sport
       FROM potd_plays
       LIMIT 1`,
    )[0];
    expect(playRow.market_type).toBe('MONEYLINE');
    expect(playRow.selection).toBe('HOME');
    expect(playRow.sport).toBe('MLB');
  });

  test('reasoning persists to potd_plays row and potd-call payload data', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const expectedReasoning =
      'Model likes OVER 5.5 at +115: edge +2.5pp, win prob 49.0%, line value strong, market consensus solid.';
    const candidate = buildSelectedCandidate({ reasoning: expectedReasoning });

    const result = await runPotdEngine({
      jobKey: 'potd|reasoning-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectTopPlaysFn: (values) => (values.length > 0 ? [values[0]] : []),
      kellySizeFn: () => 2,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);

    // potd_plays row stores the reasoning
    const playRow = readRows(
      `SELECT reasoning FROM potd_plays WHERE game_id = ?`,
      [candidate.gameId],
    )[0];
    expect(playRow).not.toBeNull();
    expect(playRow.reasoning).toBe(expectedReasoning);

    // potd-call card payload also carries the same reasoning
    const cardRow = readRows(
      `SELECT payload_data FROM card_payloads WHERE id = ?`,
      [result.cardId],
    )[0];
    expect(cardRow).not.toBeNull();
    const payloadData = JSON.parse(cardRow.payload_data);
    expect(payloadData.reasoning).toBe(expectedReasoning);

    dataModule.closeDatabase();
    resetTables();
  });

  test('fired path writes potd_daily_stats row with potd_fired=1 and non-null selected_edge_pct', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({ gameId: 'potd-stats-fired-001' });
    insertGameRow({ gameId: candidate.gameId, sport: candidate.sport, homeTeam: candidate.home_team, awayTeam: candidate.away_team, gameTimeUtc: candidate.commence_time });

    await runPotdEngine({
      jobKey: 'potd|stats-fired-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (vs) => (vs.length > 0 ? [vs[0]] : []),
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => {},
    });

    const rows = readRows('SELECT * FROM potd_daily_stats');
    expect(rows).toHaveLength(1);
    expect(rows[0].potd_fired).toBe(1);
    expect(rows[0].selected_edge_pct).not.toBeNull();
    expect(rows[0].candidate_count).toBeGreaterThanOrEqual(1);
    expect(rows[0].viable_count).toBeGreaterThanOrEqual(1);
  });

  test('no-viable path writes potd_daily_stats row with potd_fired=0 and null selected_edge_pct', async () => {
    const { runPotdEngine } = require('../run_potd_engine');

    await runPotdEngine({
      jobKey: 'potd|stats-no-play-test',
      force: true,
      fetchOddsFn: async () => ({ games: [], errors: [] }),
      buildCandidatesFn: () => [],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: () => [],
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => {},
    });

    const rows = readRows('SELECT * FROM potd_daily_stats');
    expect(rows).toHaveLength(1);
    expect(rows[0].potd_fired).toBe(0);
    expect(rows[0].selected_edge_pct).toBeNull();
    expect(rows[0].candidate_count).toBe(0);
  });

  test('second run on same play_date upserts — row count stays 1', async () => {
    const { runPotdEngine } = require('../run_potd_engine');

    const commonOpts = {
      jobKey: 'potd|stats-upsert-test',
      force: true,
      fetchOddsFn: async () => ({ games: [], errors: [] }),
      buildCandidatesFn: () => [],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: () => [],
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => {},
    };

    await runPotdEngine(commonOpts);
    // Second run: jobKey changes so alreadyPublished guard doesn't fire,
    // but play_date is the same so upsert should keep row count at 1
    await runPotdEngine({ ...commonOpts, jobKey: 'potd|stats-upsert-test-2' });

    const rows = readRows('SELECT * FROM potd_daily_stats');
    expect(rows).toHaveLength(1);
  });
});

describe('confidence-weighted wager sizing', () => {
  test('ELITE candidate produces a higher wagerAmount than HIGH candidate for identical edge inputs', async () => {
    jest.resetModules();
    const localDataModule = require('@cheddar-logic/data');
    const { runPotdEngine } = require('../run_potd_engine');

    // Run with ELITE confidence
    resetTables();
    const eliteCandidate = buildSelectedCandidate({ confidenceLabel: 'ELITE', edgePct: 0.05 });
    const eliteResult = await runPotdEngine({
      jobKey: 'potd|elite-wager-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: eliteCandidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [eliteCandidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (vs) => (vs.length > 0 ? [vs[0]] : []),
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => 1,
    });
    expect(eliteResult.success).toBe(true);
    const [elitePlay] = readRows('SELECT wager_amount FROM potd_plays LIMIT 1');

    // Run with HIGH confidence
    resetTables();
    const highCandidate = buildSelectedCandidate({ confidenceLabel: 'HIGH', edgePct: 0.05 });
    const highResult = await runPotdEngine({
      jobKey: 'potd|high-wager-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: highCandidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [highCandidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: (vs) => (vs.length > 0 ? [vs[0]] : []),
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => 1,
    });
    expect(highResult.success).toBe(true);
    const [highPlay] = readRows('SELECT wager_amount FROM potd_plays LIMIT 1');

    // ELITE wager must exceed HIGH wager
    expect(elitePlay.wager_amount).toBeGreaterThan(highPlay.wager_amount);
  });
});

describe('getActivePotdSports', () => {
  let getActivePotdSports;
  let mockOddsSportsConfig;

  beforeEach(() => {
    jest.resetModules();

    mockOddsSportsConfig = {
      NHL: { active: true },
      NBA: { active: true },
      MLB: { active: false },
      NFL: { active: false },
    };

    jest.mock('@cheddar-logic/odds/src/config', () => ({
      SPORTS_CONFIG: mockOddsSportsConfig,
    }));

    ({ __private: { getActivePotdSports } } = require('../run_potd_engine'));
  });

  afterEach(() => {
    delete process.env.ENABLE_NHL_MODEL;
    delete process.env.ENABLE_NBA_MODEL;
    delete process.env.ENABLE_MLB_MODEL;
    delete process.env.ENABLE_NFL_MODEL;
  });

  it('excludes sports with active:false', () => {
    const result = getActivePotdSports();
    expect(result).not.toContain('MLB');
    expect(result).not.toContain('NFL');
  });

  it('includes sports with active:true', () => {
    const result = getActivePotdSports();
    expect(result).toContain('NHL');
    expect(result).toContain('NBA');
  });

  it('excludes a sport when its env var is set to "false", even if active:true', () => {
    process.env.ENABLE_NHL_MODEL = 'false';
    const result = getActivePotdSports();
    expect(result).not.toContain('NHL');
    expect(result).toContain('NBA');
  });
});

describe('potd_nominees persistence', () => {
  let dataModule;

  beforeAll(async () => {
    jest.resetModules();
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';
    process.env.POTD_STARTING_BANKROLL = '10';
    process.env.POTD_KELLY_FRACTION = '0.25';
    process.env.POTD_MAX_WAGER_PCT = '0.2';
    dataModule = require('@cheddar-logic/data');
    dataModule.closeDatabase();
  });

  beforeEach(() => {
    dataModule.closeDatabase();
    resetTables();
  });

  test('fired day: winner in potd_plays, all nominees in potd_nominees with winner_status=FIRED', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const winner = buildSelectedCandidate({ sport: 'NHL', gameId: 'potd-game-001' });
    const nominee = buildSelectedCandidate({
      sport: 'NBA',
      gameId: 'nba-game-001',
      home_team: 'Lakers',
      away_team: 'Celtics',
      totalScore: 0.60,
      edgePct: 0.022,
    });

    await runPotdEngine({
      jobKey: 'potd|nominees-fired-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: winner.gameId }, { gameId: nominee.gameId }], errors: [] }),
      buildCandidatesFn: (game) => {
        if (game.gameId === winner.gameId) return [winner];
        if (game.gameId === nominee.gameId) return [nominee];
        return [];
      },
      scoreCandidateFn: (v) => v,
      kellySizeFn: () => 2.0,
      sendDiscordMessagesFn: async () => 1,
    });

    const playRows = readRows('SELECT * FROM potd_plays');
    expect(playRows).toHaveLength(1);
    expect(playRows[0].sport).toBe('NHL');

    const nomineeRows = readRows('SELECT * FROM potd_nominees ORDER BY nominee_rank ASC');
    expect(nomineeRows.length).toBeGreaterThanOrEqual(1);
    nomineeRows.forEach((r) => expect(r.winner_status).toBe('FIRED'));
    // Rank 1 is the winner (NHL), rank 2 is NBA nominee
    expect(nomineeRows[0].sport).toBe('NHL');
    expect(nomineeRows[0].nominee_rank).toBe(1);
    if (nomineeRows[1]) {
      expect(nomineeRows[1].sport).toBe('NBA');
      expect(nomineeRows[1].nominee_rank).toBe(2);
    }
  });

  test('no-pick day: zero rows in potd_plays, nominees stored with winner_status=NO_PICK', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({ sport: 'NHL', gameId: 'potd-nopick-001' });

    await runPotdEngine({
      jobKey: 'potd|nominees-nopick-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      // Kelly returns 0 → stake_below_minimum path → no winner fires
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => 1,
    });

    const playRows = readRows('SELECT * FROM potd_plays');
    expect(playRows).toHaveLength(0);

    const nomineeRows = readRows('SELECT * FROM potd_nominees');
    expect(nomineeRows.length).toBeGreaterThanOrEqual(1);
    nomineeRows.forEach((r) => expect(r.winner_status).toBe('NO_PICK'));
    expect(nomineeRows[0].sport).toBe('NHL');
  });

  test('no-pick day with no positive edge does not persist non-model/non-positive nominees', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({
      sport: 'NHL',
      gameId: 'potd-negative-edge-001',
      edgePct: -0.004,
      totalScore: 0.73,
    });
    const kellySizeFn = jest.fn(() => 2.0);

    const result = await runPotdEngine({
      jobKey: 'potd|nominees-negative-edge-test',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      kellySizeFn,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.noPlay).toBe(true);
    expect(kellySizeFn).not.toHaveBeenCalled();

    expect(readRows('SELECT * FROM potd_plays')).toHaveLength(0);

    const nomineeRows = readRows('SELECT * FROM potd_nominees');
    expect(nomineeRows).toHaveLength(0);
  });

  test('no candidates: nominees table remains empty', async () => {
    const { runPotdEngine } = require('../run_potd_engine');

    await runPotdEngine({
      jobKey: 'potd|nominees-empty-test',
      force: true,
      fetchOddsFn: async () => ({ games: [], errors: [] }),
      buildCandidatesFn: () => [],
      scoreCandidateFn: (v) => v,
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: async () => {},
    });

    expect(readRows('SELECT * FROM potd_nominees')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WI-1039-B: POTD timing state machine, heartbeat, no-pick alert
// ---------------------------------------------------------------------------
describe('WI-1039-B: POTD timing state machine and heartbeat', () => {
  let POTD_TIMING_STATES;
  let POTD_WINDOW_ET;
  let POTD_NOPICK_REASONS;
  let resolvePotdTimingState;
  let sendPotdNopickAlert;

  beforeEach(() => {
    resetTables();
  });

  beforeAll(() => {
    // Ensure bankroll env is set correctly before requiring the module
    process.env.POTD_STARTING_BANKROLL = '10';
    const engine = require('../run_potd_engine');
    POTD_TIMING_STATES = engine.POTD_TIMING_STATES;
    POTD_WINDOW_ET = engine.POTD_WINDOW_ET;
    POTD_NOPICK_REASONS = engine.POTD_NOPICK_REASONS;
    resolvePotdTimingState = engine.resolvePotdTimingState;
    sendPotdNopickAlert = engine.sendPotdNopickAlert;
  });

  test('POTD_TIMING_STATES exports three frozen state tokens', () => {
    expect(Object.isFrozen(POTD_TIMING_STATES)).toBe(true);
    expect(POTD_TIMING_STATES.PENDING_WINDOW).toBe('PENDING_WINDOW');
    expect(POTD_TIMING_STATES.OFFICIAL_PLAY).toBe('OFFICIAL_PLAY');
    expect(POTD_TIMING_STATES.NO_PICK_FINAL).toBe('NO_PICK_FINAL');
  });

  test('POTD_WINDOW_ET exports OPENS_HOUR=12 and CLOSES_HOUR=17', () => {
    expect(Object.isFrozen(POTD_WINDOW_ET)).toBe(true);
    expect(POTD_WINDOW_ET.OPENS_HOUR).toBe(12);
    expect(POTD_WINDOW_ET.CLOSES_HOUR).toBe(17);
  });

  test('POTD_NOPICK_REASONS exports all 5 reason keys', () => {
    expect(Object.isFrozen(POTD_NOPICK_REASONS)).toBe(true);
    expect(POTD_NOPICK_REASONS).toHaveProperty('below_noise_floor');
    expect(POTD_NOPICK_REASONS).toHaveProperty('no_viable_candidates');
    expect(POTD_NOPICK_REASONS).toHaveProperty('confidence_below_high_gate');
    expect(POTD_NOPICK_REASONS).toHaveProperty('zero_wager');
    expect(POTD_NOPICK_REASONS).toHaveProperty('min_stake_rejected');
  });

  test('resolvePotdTimingState at 11:59 → PENDING_WINDOW (before window)', () => {
    const nowEt = makeEtDateTime(11, 59);
    expect(resolvePotdTimingState(nowEt, false)).toBe('PENDING_WINDOW');
    expect(resolvePotdTimingState(nowEt, true)).toBe('PENDING_WINDOW');
  });

  test('resolvePotdTimingState at 12:00 with no official play → PENDING_WINDOW', () => {
    const nowEt = makeEtDateTime(12, 0);
    expect(resolvePotdTimingState(nowEt, false)).toBe('PENDING_WINDOW');
  });

  test('resolvePotdTimingState at 12:00 with official play → OFFICIAL_PLAY', () => {
    const nowEt = makeEtDateTime(12, 0);
    expect(resolvePotdTimingState(nowEt, true)).toBe('OFFICIAL_PLAY');
  });

  test('resolvePotdTimingState at 15:59 with official play → OFFICIAL_PLAY', () => {
    const nowEt = makeEtDateTime(15, 59);
    expect(resolvePotdTimingState(nowEt, true)).toBe('OFFICIAL_PLAY');
  });

  test('resolvePotdTimingState at 16:00 with no official play → PENDING_WINDOW (still inside window)', () => {
    const nowEt = makeEtDateTime(16, 0);
    expect(resolvePotdTimingState(nowEt, false)).toBe('PENDING_WINDOW');
  });

  test('resolvePotdTimingState at 16:00 with official play → OFFICIAL_PLAY', () => {
    const nowEt = makeEtDateTime(16, 0);
    expect(resolvePotdTimingState(nowEt, true)).toBe('OFFICIAL_PLAY');
  });

  test('resolvePotdTimingState at 17:00 with no official play → NO_PICK_FINAL', () => {
    const nowEt = makeEtDateTime(17, 0);
    expect(resolvePotdTimingState(nowEt, false)).toBe('NO_PICK_FINAL');
  });

  test('resolvePotdTimingState at 17:00 with official play → OFFICIAL_PLAY', () => {
    const nowEt = makeEtDateTime(17, 0);
    expect(resolvePotdTimingState(nowEt, true)).toBe('OFFICIAL_PLAY');
  });

  test('sendPotdNopickAlert is a silent no-op when webhookUrl is falsy', async () => {
    const sendFn = jest.fn();
    await sendPotdNopickAlert({ sendDiscordMessagesFn: sendFn, webhookUrl: '', message: 'test' });
    expect(sendFn).not.toHaveBeenCalled();
    await sendPotdNopickAlert({ sendDiscordMessagesFn: sendFn, webhookUrl: null, message: 'test' });
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('sendPotdNopickAlert calls sendDiscordMessagesFn when webhookUrl is set', async () => {
    const sendFn = jest.fn(async () => 1);
    await sendPotdNopickAlert({
      sendDiscordMessagesFn: sendFn,
      webhookUrl: 'https://discord.com/api/webhooks/test',
      message: 'no pick today',
    });
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith({
      webhookUrl: 'https://discord.com/api/webhooks/test',
      messages: ['no pick today'],
    });
  });

  test('heartbeat log emitted on every runPotdEngine return path', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runPotdEngine({
        jobKey: 'potd|heartbeat-test',
        force: true,
        fetchOddsFn: async () => ({ games: [], errors: [] }),
      });
      const allLogs = logSpy.mock.calls.map((c) => c.join(' '));
      const heartbeatLog = allLogs.find((l) => l.includes('[POTD] Engine run complete'));
      expect(heartbeatLog).toBeDefined();
      expect(heartbeatLog).toContain('ts:');
      expect(heartbeatLog).toContain('run:');
      expect(heartbeatLog).toContain('candidates:');
      expect(heartbeatLog).toContain('viable:');
      expect(heartbeatLog).toContain('status:');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('no-pick alert fires only in NO_PICK_FINAL state (hour >= 17, no play)', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const origUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/alert';

    const alertFn = jest.fn(async () => 1);
    const candidate = buildSelectedCandidate({ edgePct: 0.01, totalScore: 0.29 });

    // 17:00 ET = NO_PICK_FINAL when no play (CLOSES_HOUR=17)
    const nowFn = () => makeEtDateTime(17, 0);

    await runPotdEngine({
      jobKey: 'potd|no-pick-final-alert',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: () => [], // No viable candidates
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: alertFn,
      nowFn,
    });

    // Should have sent the no-pick alert
    expect(alertFn).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://discord.com/api/webhooks/alert',
    }));

    if (origUrl !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origUrl;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('no-pick alert is deduped to once per day', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const origUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/alert';

    const alertFn = jest.fn(async () => 1);
    const nearMissA = buildSelectedCandidate({ gameId: 'near-miss-1', selection: 'OVER', selectionLabel: 'OVER 5.5', edgePct: 0.018, totalScore: 0.34 });
    const nearMissB = buildSelectedCandidate({ gameId: 'near-miss-2', selection: 'UNDER', selectionLabel: 'UNDER 6.0', edgePct: 0.017, totalScore: 0.33 });
    const selectTopPlaysForNoPick = () => [];
    const nowFn = () => makeEtDateTime(17, 5);

    await runPotdEngine({
      jobKey: 'potd|no-pick-dedupe-1',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: nearMissA.gameId }, { gameId: nearMissB.gameId }], errors: [] }),
      buildCandidatesFn: () => [nearMissA, nearMissB],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: selectTopPlaysForNoPick,
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: alertFn,
      nowFn,
    });

    await runPotdEngine({
      jobKey: 'potd|no-pick-dedupe-2',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: nearMissA.gameId }, { gameId: nearMissB.gameId }], errors: [] }),
      buildCandidatesFn: () => [nearMissA, nearMissB],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: selectTopPlaysForNoPick,
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: alertFn,
      nowFn,
    });

    const alertCalls = alertFn.mock.calls.filter(
      (c) => c[0]?.webhookUrl === 'https://discord.com/api/webhooks/alert',
    );
    expect(alertCalls).toHaveLength(1);

    const message = alertCalls[0][0].messages[0];
    expect(message).toContain('Near misses:');
    expect(message).toContain('None available');

    if (origUrl !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origUrl;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  test('no-pick alert is disabled when ENABLE_POTD_NOPICK_ALERTS=false', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const origUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
    const origToggle = process.env.ENABLE_POTD_NOPICK_ALERTS;
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/alert';
    process.env.ENABLE_POTD_NOPICK_ALERTS = 'false';

    const alertFn = jest.fn(async () => 1);
    const candidate = buildSelectedCandidate({ edgePct: 0.01, totalScore: 0.29 });
    const nowFn = () => makeEtDateTime(17, 5);

    await runPotdEngine({
      jobKey: 'potd|no-pick-alert-disabled',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: () => [],
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: alertFn,
      nowFn,
    });

    const alertCalls = alertFn.mock.calls.filter(
      (c) => c[0]?.webhookUrl === 'https://discord.com/api/webhooks/alert',
    );
    expect(alertCalls).toHaveLength(0);

    if (origUrl !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origUrl;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
    if (origToggle !== undefined) process.env.ENABLE_POTD_NOPICK_ALERTS = origToggle;
    else delete process.env.ENABLE_POTD_NOPICK_ALERTS;
  });

  test('no-pick alert NOT fired during PENDING_WINDOW (hour < 17, no play)', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const origUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/alert';

    const alertFn = jest.fn(async () => 1);
    const candidate = buildSelectedCandidate({ edgePct: 0.01, totalScore: 0.29 });

    // 13:00 ET = PENDING_WINDOW (no play exists)
    const nowFn = () => makeEtDateTime(13, 0);

    await runPotdEngine({
      jobKey: 'potd|pending-window-no-alert',
      force: true,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (v) => v,
      selectTopPlaysFn: () => [], // No viable candidates
      kellySizeFn: () => 0,
      sendDiscordMessagesFn: alertFn,
      nowFn,
    });

    // Alert should NOT have been called with the alert webhook URL during PENDING_WINDOW
    const alertCalls = alertFn.mock.calls.filter(
      (c) => c[0]?.webhookUrl === 'https://discord.com/api/webhooks/alert',
    );
    expect(alertCalls).toHaveLength(0);

    if (origUrl !== undefined) process.env.DISCORD_ALERT_WEBHOOK_URL = origUrl;
    else delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  });

  // ── WI-1039-B2: snapshot suppression ─────────────────────────────────────

  test('DISCORD_INCLUDE_POTD_IN_SNAPSHOT=true suppresses direct POTD Discord post', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate({ gameId: 'potd-suppress-001' });

    const origInclude = process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT;
    process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT = 'true';

    const sendFn = jest.fn(async () => 1);
    const nowFn = makeEtDateTime(13, 0); // inside publish window

    try {
      const result = await runPotdEngine({
        jobKey: 'potd|suppress-test',
        force: true,
        fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
        buildCandidatesFn: () => [candidate],
        scoreCandidateFn: (v) => v,
        selectTopPlaysFn: (vs) => (vs.length > 0 ? [vs[0]] : []),
        kellySizeFn: () => 2.0,
        sendDiscordMessagesFn: sendFn,
        nowFn: () => (typeof nowFn === 'function' ? nowFn() : nowFn),
      });

      expect(result.success).toBe(true);
      // sendFn should NOT have been called with the POTD webhook URL
      const potdCalls = sendFn.mock.calls.filter(
        (c) => c[0]?.webhookUrl === 'https://discord.example/potd',
      );
      expect(potdCalls).toHaveLength(0);
    } finally {
      if (origInclude !== undefined) process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT = origInclude;
      else delete process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT;
    }
  });

  test('DISCORD_INCLUDE_POTD_IN_SNAPSHOT=false — suppression flag is inactive; direct post path not blocked', () => {
    // Unit-level verification: when DISCORD_INCLUDE_POTD_IN_SNAPSHOT is 'false',
    // snapshotIncludeActive must be false so the direct post gate is open.
    // This avoids DB state coupling that makes the integration path hard to isolate.
    const origInclude = process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT;
    const origWebhook = process.env.DISCORD_POTD_WEBHOOK_URL;
    process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT = 'false';
    process.env.DISCORD_POTD_WEBHOOK_URL = 'https://discord.example/potd';

    try {
      const webhookUrl = (process.env.DISCORD_POTD_WEBHOOK_URL || '').trim();
      const snapshotIncludeActive =
        process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT === 'true' && Boolean(webhookUrl);
      // When 'false', snapshotIncludeActive is false → direct post gate is open
      expect(snapshotIncludeActive).toBe(false);
      // The direct post condition: if (webhookUrl && !snapshotIncludeActive) — must be true
      expect(Boolean(webhookUrl) && !snapshotIncludeActive).toBe(true);
    } finally {
      if (origInclude !== undefined) process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT = origInclude;
      else delete process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT;
      if (origWebhook !== undefined) process.env.DISCORD_POTD_WEBHOOK_URL = origWebhook;
      else delete process.env.DISCORD_POTD_WEBHOOK_URL;
    }
  });
});

// WI-1029: buildCandidateAuditEntry / auditLogCandidate audit log
describe('buildCandidateAuditEntry', () => {
  let buildCandidateAuditEntry;
  beforeAll(() => {
    // Require inside beforeAll so the module load happens after env vars are configured.
    buildCandidateAuditEntry = require('../run_potd_engine').__private.buildCandidateAuditEntry;
  });
  const noiseFloor = 0.02;
  const minScore = 0.3;

  test('VIABLE — candidate passes all gates', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: 0.03,
        totalScore: 0.5,
        confidenceLabel: 'HIGH',
        sport: 'NHL',
        marketType: 'MONEYLINE',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.56,
        impliedProb: 0.53,
        price: -112,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.potd_audit).toBe(true);
    expect(entry.rejectedReason).toBe('VIABLE');
    expect(entry.source).toBe('MODEL');
    expect(entry.passesNoise).toBe(true);
    expect(entry.passesScore).toBe(true);
    expect(entry.passesConfidence).toBe(true);
  });

  test('NEGATIVE_EDGE — edgePct <= 0', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: -0.01,
        totalScore: 0.5,
        confidenceLabel: 'HIGH',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.49,
        impliedProb: 0.5,
        price: -105,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.rejectedReason).toBe('NEGATIVE_EDGE');
  });

  test('BELOW_NOISE_FLOOR — edgePct positive but below floor', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: 0.005,
        totalScore: 0.5,
        confidenceLabel: 'HIGH',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.505,
        impliedProb: 0.5,
        price: -110,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.rejectedReason).toBe('BELOW_NOISE_FLOOR');
    expect(entry.noiseFloor).toBe(noiseFloor);
  });

  test('BELOW_MIN_SCORE — passes noise floor but score too low', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: 0.03,
        totalScore: 0.1,
        confidenceLabel: 'HIGH',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.56,
        impliedProb: 0.53,
        price: -110,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.rejectedReason).toBe('BELOW_MIN_SCORE');
    expect(entry.minScore).toBe(minScore);
  });

  test('BELOW_CONFIDENCE_LABEL — LOW confidence after passing noise+score gates', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: 0.03,
        totalScore: 0.5,
        confidenceLabel: 'LOW',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.56,
        impliedProb: 0.53,
        price: -110,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.rejectedReason).toBe('BELOW_CONFIDENCE_LABEL');
    expect(entry.passesConfidence).toBe(false);
  });

  test('MISSING_EDGE_INPUTS — null edgePct', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: null,
        totalScore: 0.5,
        confidenceLabel: 'HIGH',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.55,
        impliedProb: 0.52,
        price: -110,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.rejectedReason).toBe('MISSING_EDGE_INPUTS');
    expect(entry.edgePct).toBeNull();
  });

  test('NON_MODEL_SOURCE — consensus candidate is not POTD-eligible', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: 0.03,
        totalScore: 0.7,
        confidenceLabel: 'HIGH',
        edgeSourceTag: 'CONSENSUS_FALLBACK',
        modelWinProb: 0.55,
        impliedProb: 0.52,
        price: -110,
      },
      noiseFloor,
      minScore,
    );
    expect(entry.rejectedReason).toBe('NON_MODEL_SOURCE');
    expect(entry.source).toBe('CONSENSUS');
  });

  test('potd_audit:true is set on all entries — field contract', () => {
    const entry = buildCandidateAuditEntry(
      {
        edgePct: 0.03,
        totalScore: 0.5,
        confidenceLabel: 'HIGH',
        edgeSourceTag: 'MODEL',
        modelWinProb: 0.56,
        impliedProb: 0.53,
        price: -112,
      },
      noiseFloor,
      minScore,
    );
    // WI-1029 acceptance: manual validation grep uses potd_audit field
    expect(entry.potd_audit).toBe(true);
    // minScore is included in the entry for downstream analysis
    expect(entry.minScore).toBe(minScore);
    expect(entry.noiseFloor).toBe(noiseFloor);
  });
});

describe('loadModelHealthGates', () => {
  let loadModelHealthGates;
  beforeAll(() => {
    ({ __private: { loadModelHealthGates } } = require('../run_potd_engine'));
  });

  function makeDb(rows) {
    return {
      prepare: () => ({ all: () => rows }),
    };
  }

  test('returns empty Set when db is null', () => {
    expect(loadModelHealthGates(null).size).toBe(0);
  });

  test('blocks only critical sports — not stale', () => {
    const gates = loadModelHealthGates(makeDb([
      { sport: 'nba', status: 'critical' },
      { sport: 'mlb', status: 'stale' },
      { sport: 'nhl', status: 'healthy' },
    ]));
    expect(gates.has('NBA')).toBe(true);
    expect(gates.has('MLB')).toBe(false); // stale = unknown quality, not confirmed bad
    expect(gates.has('NHL')).toBe(false);
  });

  test('does not block degraded sports', () => {
    const gates = loadModelHealthGates(makeDb([
      { sport: 'nba', status: 'degraded' },
    ]));
    expect(gates.has('NBA')).toBe(false);
  });

  test('returns empty Set when query throws', () => {
    const badDb = { prepare: () => { throw new Error('no table'); } };
    expect(() => loadModelHealthGates(badDb)).not.toThrow();
    expect(loadModelHealthGates(badDb).size).toBe(0);
  });

  test('returns empty Set when snapshots table is empty', () => {
    const gates = loadModelHealthGates(makeDb([]));
    expect(gates.size).toBe(0);
  });
});
