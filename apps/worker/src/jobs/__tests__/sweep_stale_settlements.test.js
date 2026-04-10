'use strict';

/**
 * Tests for sweep_stale_settlements.js
 *
 * WI-0842: Voids card_results rows stuck pending because their games
 * (final/cancelled/postponed) will never produce a game_results row.
 */

const Database = require('better-sqlite3');
const { sweepStaleSettlements } = require('../sweep_stale_settlements');

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE games (
      game_id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      home_team TEXT,
      away_team TEXT,
      game_time_utc TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE card_results (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE,
      game_id TEXT NOT NULL,
      sport TEXT NOT NULL DEFAULT 'NBA',
      card_type TEXT NOT NULL DEFAULT 'nba-model-output',
      recommended_bet_type TEXT NOT NULL DEFAULT 'MONEYLINE',
      market_key TEXT,
      market_type TEXT,
      selection TEXT,
      line REAL,
      locked_price REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      settled_at TEXT,
      pnl_units REAL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE game_results (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

function insertGame(db, { gameId, status, createdAt }) {
  db.prepare(`
    INSERT INTO games (game_id, sport, home_team, away_team, game_time_utc, status, created_at)
    VALUES (?, 'NBA', 'Team A', 'Team B', '2026-01-01T00:00:00Z', ?, ?)
  `).run(gameId, status, createdAt ?? new Date().toISOString());
}

function insertCardResult(db, { id, cardId, gameId, createdAt, result = null, status = 'pending' }) {
  db.prepare(`
    INSERT INTO card_results (id, card_id, game_id, result, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, cardId, gameId, result, status, createdAt ?? new Date().toISOString());
}

function insertGameResult(db, { gameId }) {
  db.prepare(`
    INSERT INTO game_results (id, game_id, status) VALUES (?, ?, 'final')
  `).run(`gr-${gameId}`, gameId);
}

// Past time: 72 hours ago (well past grace period)
const OLD_TIME = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
// Recent time: 12 hours ago (within grace period)
const RECENT_TIME = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

describe('sweepStaleSettlements', () => {
  test('Test 1: voids 3 final-game cards with no game_results, created >48h ago', () => {
    const db = createTestDb();

    insertGame(db, { gameId: 'game-1', status: 'final' });
    insertGame(db, { gameId: 'game-2', status: 'cancelled' });
    insertGame(db, { gameId: 'game-3', status: 'postponed' });

    insertCardResult(db, { id: 'cr-1', cardId: 'card-1', gameId: 'game-1', createdAt: OLD_TIME });
    insertCardResult(db, { id: 'cr-2', cardId: 'card-2', gameId: 'game-2', createdAt: OLD_TIME });
    insertCardResult(db, { id: 'cr-3', cardId: 'card-3', gameId: 'game-3', createdAt: OLD_TIME });

    const result = sweepStaleSettlements(db);

    expect(result.count).toBe(3);
    expect(result.dryRun).toBe(false);
    expect(result.voided).toHaveLength(3);
    expect(result.voided).toContain('cr-1');
    expect(result.voided).toContain('cr-2');
    expect(result.voided).toContain('cr-3');

    // Verify DB writes
    const rows = db.prepare('SELECT id, result, status, pnl_units FROM card_results').all();
    for (const row of rows) {
      expect(row.result).toBe('void');
      expect(row.status).toBe('settled');
      expect(row.pnl_units).toBe(0);
    }
  });

  test('Test 2: does NOT void upcoming-game cards (status=scheduled), no game_results', () => {
    const db = createTestDb();

    insertGame(db, { gameId: 'game-sched', status: 'scheduled' });
    insertCardResult(db, { id: 'cr-sched', cardId: 'card-sched', gameId: 'game-sched', createdAt: OLD_TIME });

    const result = sweepStaleSettlements(db);

    expect(result.count).toBe(0);
    expect(result.voided).toHaveLength(0);

    const row = db.prepare('SELECT status, result FROM card_results WHERE id=?').get('cr-sched');
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
  });

  test('Test 3: does NOT void final-game card created <48h ago (grace period)', () => {
    const db = createTestDb();

    insertGame(db, { gameId: 'game-recent', status: 'final' });
    insertCardResult(db, { id: 'cr-recent', cardId: 'card-recent', gameId: 'game-recent', createdAt: RECENT_TIME });

    const result = sweepStaleSettlements(db);

    expect(result.count).toBe(0);
    expect(result.voided).toHaveLength(0);

    const row = db.prepare('SELECT status, result FROM card_results WHERE id=?').get('cr-recent');
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
  });

  test('Test 4: dryRun=true returns count=3 but does NOT write to DB', () => {
    const db = createTestDb();

    insertGame(db, { gameId: 'game-dry-1', status: 'final' });
    insertGame(db, { gameId: 'game-dry-2', status: 'cancelled' });
    insertGame(db, { gameId: 'game-dry-3', status: 'postponed' });

    insertCardResult(db, { id: 'cr-dry-1', cardId: 'card-dry-1', gameId: 'game-dry-1', createdAt: OLD_TIME });
    insertCardResult(db, { id: 'cr-dry-2', cardId: 'card-dry-2', gameId: 'game-dry-2', createdAt: OLD_TIME });
    insertCardResult(db, { id: 'cr-dry-3', cardId: 'card-dry-3', gameId: 'game-dry-3', createdAt: OLD_TIME });

    const result = sweepStaleSettlements(db, { dryRun: true });

    expect(result.count).toBe(3);
    expect(result.dryRun).toBe(true);
    expect(result.voided).toHaveLength(0);

    // No DB writes — all rows still pending
    const rows = db.prepare('SELECT status, result FROM card_results').all();
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.result).toBeNull();
    }
  });
});
