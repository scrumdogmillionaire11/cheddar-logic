'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');

const TEST_DB_PATH = '/tmp/cheddar-test-run-potd-engine.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

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
    DELETE FROM potd_bankroll;
    DELETE FROM potd_plays;
    DELETE FROM potd_daily_stats;
    DELETE FROM potd_nominees;
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
    modelWinProb: 0.49,
    impliedProb: 0.465,
    edgePct: 0.025,
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

function insertOddsSnapshotRow({
  id,
  gameId,
  sport,
  capturedAt,
  h2hHome,
  h2hAway,
  rawData,
}) {
  const db = new Database(TEST_DB_PATH);
  db.prepare(`
    INSERT INTO odds_snapshots (
      id, game_id, sport, captured_at, h2h_home, h2h_away, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, gameId, sport, capturedAt, h2hHome, h2hAway, rawData);
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

  test('hydrates MLB games from persisted odds snapshots before candidate construction', async () => {
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
      gameTimeUtc: '2026-04-12T01:10:00.000Z',
    });
    insertOddsSnapshotRow({
      id: 'mlb-potd-001-snapshot',
      gameId: 'mlb-potd-001',
      sport: 'mlb',
      capturedAt: '2026-04-11T18:00:00.000Z',
      h2hHome: -170,
      h2hAway: 150,
      rawData: JSON.stringify({
        mlb: {
          home_pitcher: {
            siera: 2.5,
            x_fip: 2.6,
            x_era: 2.55,
            k_per_9: 11.0,
            bb_per_9: 1.8,
            gb_pct: 0.5,
            hr_per_9: 0.6,
          },
          away_pitcher: {
            siera: 5.8,
            x_fip: 5.9,
            x_era: 5.85,
            k_per_9: 5.5,
            bb_per_9: 4.2,
            gb_pct: 0.35,
            hr_per_9: 1.8,
          },
          home_offense_profile: {
            wrc_plus: 100,
            xwoba: 0.32,
            k_pct: 0.225,
            iso: 0.165,
            bb_pct: 0.085,
            hard_hit_pct: 39,
          },
          away_offense_profile: {
            wrc_plus: 70,
            xwoba: 0.28,
            k_pct: 0.28,
            iso: 0.12,
            bb_pct: 0.07,
            hard_hit_pct: 30,
          },
          park_run_factor: 1,
          temp_f: 72,
          wind_mph: 0,
          wind_dir: 'CALM',
          roof: 'OPEN',
          home_bullpen_era: 3.2,
          away_bullpen_era: 5.8,
        },
      }),
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
              gameTimeUtc: '2026-04-12T01:10:00.000Z',
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
            modelWinProb: 0.61,
            edgePct: 0.05,
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
    expect(receivedGame.oddsSnapshot).toMatchObject({
      game_id: 'mlb-potd-001',
      h2h_home: -170,
      h2h_away: 150,
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

  test('no-pick day with no positive edge still stores diagnostic nominees', async () => {
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
    expect(nomineeRows).toHaveLength(1);
    expect(nomineeRows[0].winner_status).toBe('NO_PICK');
    expect(nomineeRows[0].sport).toBe('NHL');
    expect(nomineeRows[0].edge_pct).toBeCloseTo(-0.004, 6);
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
