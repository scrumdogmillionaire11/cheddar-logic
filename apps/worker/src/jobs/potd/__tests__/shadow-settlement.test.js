'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');

const TEST_DB_PATH = '/tmp/cheddar-test-shadow-settlement.db';
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
    DELETE FROM potd_shadow_results;
    DELETE FROM potd_shadow_candidates;
    DELETE FROM game_results;
    DELETE FROM potd_plays;
    DELETE FROM potd_bankroll;
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

function seedShadowCandidate(overrides = {}) {
  const row = {
    play_date: '2026-04-17',
    captured_at: '2026-04-17T15:00:00.000Z',
    sport: 'NHL',
    market_type: 'TOTAL',
    selection_label: 'OVER 5.5',
    home_team: 'Boston Bruins',
    away_team: 'Toronto Maple Leafs',
    game_id: 'shadow-game-001',
    price: -110,
    line: 5.5,
    edge_pct: 0.02,
    total_score: 0.72,
    line_value: 0.8,
    market_consensus: 0.6,
    model_win_prob: 0.54,
    implied_prob: 0.5,
    projection_source: 'FULL_MODEL',
    gap_to_min_edge: 0.0,
    selection: 'OVER',
    game_time_utc: '2026-04-17T23:00:00.000Z',
    candidate_identity_key: 'NHL|shadow-game-001|TOTAL|OVER|5.500',
    ...overrides,
  };

  const db = new Database(TEST_DB_PATH);
  db.prepare(
    `INSERT INTO potd_shadow_candidates (
      play_date, captured_at, sport, market_type, selection_label,
      home_team, away_team, game_id, price, line,
      edge_pct, total_score, line_value, market_consensus,
      model_win_prob, implied_prob, projection_source, gap_to_min_edge,
      selection, game_time_utc, candidate_identity_key
    ) VALUES (
      @play_date, @captured_at, @sport, @market_type, @selection_label,
      @home_team, @away_team, @game_id, @price, @line,
      @edge_pct, @total_score, @line_value, @market_consensus,
      @model_win_prob, @implied_prob, @projection_source, @gap_to_min_edge,
      @selection, @game_time_utc, @candidate_identity_key
    )`,
  ).run(row);
  db.close();
  return row;
}

function seedFinalGameResult({
  gameId,
  sport = 'NHL',
  home = 3,
  away = 2,
  status = 'final',
} = {}) {
  const db = new Database(TEST_DB_PATH);
  db.prepare(
    `INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
     ON CONFLICT(game_id) DO NOTHING`,
  ).run(
    `game-${gameId}`,
    sport,
    gameId,
    'Home',
    'Away',
    '2026-04-17T23:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away,
      status, result_source, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)
     ON CONFLICT(game_id) DO UPDATE SET
       final_score_home = excluded.final_score_home,
       final_score_away = excluded.final_score_away,
       status = excluded.status,
       settled_at = excluded.settled_at`,
  ).run(
    `gr-${gameId}`,
    gameId,
    sport,
    home,
    away,
    status,
    '2026-04-18T01:00:00.000Z',
  );
  db.close();
}

function seedOfficialPotdRows() {
  const db = new Database(TEST_DB_PATH);
  db.prepare(
    `INSERT INTO potd_plays (
      id, play_date, game_id, card_id, sport, home_team, away_team,
      market_type, selection, selection_label, line, price, confidence_label,
      total_score, model_win_prob, implied_prob, edge_pct, score_breakdown,
      wager_amount, bankroll_at_post, kelly_fraction, game_time_utc, posted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'official-play-1',
    '2026-04-17',
    'official-game-1',
    'official-card-1',
    'NHL',
    'Home',
    'Away',
    'TOTAL',
    'OVER',
    'OVER 5.5',
    5.5,
    -110,
    'HIGH',
    0.72,
    0.55,
    0.52,
    0.03,
    '{}',
    1.0,
    10.0,
    0.25,
    '2026-04-17T23:00:00.000Z',
    '2026-04-17T15:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO potd_bankroll (
      id, event_date, event_type, play_id, card_id,
      amount_before, amount_change, amount_after, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'official-ledger-1',
    '2026-04-17',
    'play_posted',
    'official-play-1',
    'official-card-1',
    10,
    0,
    10,
    'seed',
    '2026-04-17T15:00:00.000Z',
  );
  db.close();
}

describe('settleShadowCandidates', () => {
  let dataModule;

  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';
    process.env.POTD_SHADOW_VIRTUAL_STAKE_UNITS = '1.0';

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
    delete process.env.POTD_SHADOW_VIRTUAL_STAKE_UNITS;
    try {
      dataModule.closeDatabase();
    } catch {
      // best effort
    }
  });

  test('settles MONEYLINE, SPREAD, and TOTAL candidates from final scores', async () => {
    seedShadowCandidate({
      game_id: 'shadow-ml',
      candidate_identity_key: 'NHL|shadow-ml|MONEYLINE|HOME|NA',
      market_type: 'MONEYLINE',
      selection: 'HOME',
      selection_label: 'Boston Bruins',
      line: null,
      price: -120,
    });
    seedShadowCandidate({
      game_id: 'shadow-spread',
      candidate_identity_key: 'NHL|shadow-spread|SPREAD|AWAY|1.500',
      market_type: 'SPREAD',
      selection: 'AWAY',
      selection_label: 'Toronto Maple Leafs +1.5',
      line: 1.5,
      price: -110,
    });
    seedShadowCandidate({
      game_id: 'shadow-total',
      candidate_identity_key: 'NHL|shadow-total|TOTAL|OVER|5.500',
      market_type: 'TOTAL',
      selection: 'OVER',
      selection_label: 'OVER 5.5',
      line: 5.5,
      price: -105,
    });

    seedFinalGameResult({ gameId: 'shadow-ml', home: 4, away: 2 });
    seedFinalGameResult({ gameId: 'shadow-spread', home: 3, away: 2 });
    seedFinalGameResult({ gameId: 'shadow-total', home: 4, away: 3 });

    const { settleShadowCandidates } = require('../settle-shadow-candidates');
    const result = await settleShadowCandidates({ jobKey: 'shadow|settle|markets' });

    expect(result.success).toBe(true);
    expect(result.settled).toBe(3);
    expect(result.win).toBe(3);
    expect(result.loss).toBe(0);
    expect(result.push).toBe(0);

    const rows = readRows(
      `SELECT market_type, status, result, virtual_stake_units, pnl_units
       FROM potd_shadow_results
       ORDER BY market_type ASC`,
    );
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.status).toBe('settled');
      expect(row.result).toBe('win');
      expect(row.virtual_stake_units).toBe(1);
      expect(row.pnl_units).not.toBeNull();
    });
  });

  test('is idempotent and does not duplicate settled shadow results', async () => {
    seedShadowCandidate({
      game_id: 'shadow-idempotent',
      candidate_identity_key: 'NHL|shadow-idempotent|TOTAL|UNDER|5.500',
      selection: 'UNDER',
      selection_label: 'UNDER 5.5',
      market_type: 'TOTAL',
      line: 5.5,
      price: -110,
    });
    seedFinalGameResult({ gameId: 'shadow-idempotent', home: 2, away: 2 });

    const { settleShadowCandidates } = require('../settle-shadow-candidates');
    const first = await settleShadowCandidates({ jobKey: 'shadow|idempotent|1' });
    const second = await settleShadowCandidates({ jobKey: 'shadow|idempotent|2' });

    expect(first.success).toBe(true);
    expect(first.settled).toBe(1);
    expect(second.success).toBe(true);
    expect(second.settled).toBe(0);

    const rows = readRows(`SELECT * FROM potd_shadow_results`);
    expect(rows).toHaveLength(1);
  });

  test('marks row pending when final game result is missing', async () => {
    seedShadowCandidate({
      game_id: 'shadow-pending',
      candidate_identity_key: 'NHL|shadow-pending|TOTAL|OVER|5.500',
      market_type: 'TOTAL',
      selection: 'OVER',
      line: 5.5,
      price: -110,
    });

    const { settleShadowCandidates } = require('../settle-shadow-candidates');
    const result = await settleShadowCandidates({ jobKey: 'shadow|pending' });

    expect(result.success).toBe(true);
    expect(result.pending).toBe(1);
    expect(result.settled).toBe(0);

    const [row] = readRows(
      `SELECT status, result FROM potd_shadow_results WHERE candidate_identity_key = ?`,
      ['NHL|shadow-pending|TOTAL|OVER|5.500'],
    );
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
  });

  test('does not write to potd_plays or potd_bankroll', async () => {
    seedOfficialPotdRows();
    seedShadowCandidate({
      game_id: 'shadow-safe',
      candidate_identity_key: 'NHL|shadow-safe|TOTAL|OVER|5.500',
      market_type: 'TOTAL',
      selection: 'OVER',
      line: 5.5,
      price: -110,
    });
    seedFinalGameResult({ gameId: 'shadow-safe', home: 3, away: 2 });

    const before = {
      plays: readRows(`SELECT COUNT(*) AS c FROM potd_plays`)[0].c,
      bankroll: readRows(`SELECT COUNT(*) AS c FROM potd_bankroll`)[0].c,
    };

    const { settleShadowCandidates } = require('../settle-shadow-candidates');
    const result = await settleShadowCandidates({ jobKey: 'shadow|no-official-writes' });
    expect(result.success).toBe(true);

    const after = {
      plays: readRows(`SELECT COUNT(*) AS c FROM potd_plays`)[0].c,
      bankroll: readRows(`SELECT COUNT(*) AS c FROM potd_bankroll`)[0].c,
    };

    expect(after).toEqual(before);
  });
});
