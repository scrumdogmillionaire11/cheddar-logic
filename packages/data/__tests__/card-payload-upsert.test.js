'use strict';
// WI-0812 Task 2+3: upsert + migration 062 SQL behavior tests
const Database = require('better-sqlite3');

// INSERT OR IGNORE + UPDATE pattern (WI-0812): SQLite partial indexes are not
// recognized by ON CONFLICT(col) in DML — use two-statement upsert instead.
const INSERT_SQL = 'INSERT OR IGNORE INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, expires_at, payload_data, model_output_ids, metadata, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const UPDATE_CALL_SQL = "UPDATE card_payloads SET payload_data = ?, run_id = ?, created_at = ?, expires_at = ? WHERE game_id = ? AND card_type = ? AND card_type LIKE '%-call' AND NOT EXISTS (SELECT 1 FROM card_results WHERE card_id = card_payloads.id AND status = 'settled')";
const INSERT_RESULT_SQL = 'INSERT OR IGNORE INTO card_results (id, card_id, game_id, sport, card_type, recommended_bet_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE card_payloads (\n  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, sport TEXT NOT NULL,\n  card_type TEXT NOT NULL, card_title TEXT NOT NULL, created_at TEXT NOT NULL,\n  expires_at TEXT, payload_data TEXT NOT NULL, model_output_ids TEXT,\n  metadata TEXT, run_id TEXT\n);\nCREATE TABLE card_results (\n  id TEXT PRIMARY KEY, card_id TEXT NOT NULL, game_id TEXT NOT NULL,\n  sport TEXT NOT NULL, card_type TEXT NOT NULL, recommended_bet_type TEXT NOT NULL,\n  status TEXT NOT NULL, created_at TEXT NOT NULL,\n  FOREIGN KEY (card_id) REFERENCES card_payloads(id)\n);\nCREATE UNIQUE INDEX IF NOT EXISTS uq_card_payloads_call_per_game\n  ON card_payloads(game_id, card_type)\n  WHERE card_type LIKE '%-call';");
  return db;
}

const GAME_ID = "game-nba-2026-04-07-bos-mia";
const NOW  = '2026-04-07T01:00:00.000Z';
const NOW2 = '2026-04-07T01:30:00.000Z';
const CID  = "card-nba-totals-call-game-nba-2026-04-07-bos-mia";

describe('insertCardPayload upsert behavior — WI-0812 Task 2', () => {
  let db;
  beforeEach(() => { db = buildDb(); });
  afterEach(() => { db.close(); });

  function upsert(overrides = {}) {
    const d = { id: CID, gameId: GAME_ID, sport: 'nba', cardType: 'nba-totals-call',
      cardTitle: 'BOS vs MIA Totals', createdAt: NOW, expiresAt: null,
      pj: JSON.stringify({ version: 1 }), runId: 'run-1' };
    const v = Object.assign({}, d, overrides);
    db.prepare(INSERT_SQL).run(v.id, v.gameId, v.sport, v.cardType, v.cardTitle, v.createdAt, v.expiresAt, v.pj, null, null, v.runId);
    db.prepare(UPDATE_CALL_SQL).run(v.pj, v.runId, v.createdAt, v.expiresAt, v.gameId, v.cardType);
  }
  function result(cid, status) {
    db.prepare(INSERT_RESULT_SQL).run('card-result-' + cid, cid, GAME_ID, 'nba', 'nba-totals-call', 'TOTAL', status, NOW);
  }

  it('new call card inserts successfully', () => {
    upsert(); const row = db.prepare('SELECT * FROM card_payloads WHERE game_id = ?').get(GAME_ID);
    expect(row).toBeDefined(); expect(row.card_type).toBe('nba-totals-call');
  });

  it('same call card re-insert updates payload_data, no second row', () => {
    upsert({ pj: JSON.stringify({ version: 1 }), runId: 'run-1' });
    upsert({ pj: JSON.stringify({ version: 2 }), runId: 'run-2', createdAt: NOW2 });
    const rows = db.prepare('SELECT * FROM card_payloads WHERE game_id = ?').all(GAME_ID);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_data).version).toBe(2);
    expect(rows[0].run_id).toBe('run-2');
  });

  it('settled call card blocks upsert — payload_data unchanged', () => {
    upsert({ pj: JSON.stringify({ version: 1 }), runId: 'run-1' });
    result(CID, 'settled');
    upsert({ pj: JSON.stringify({ version: 99 }), runId: 'run-99' });
    const rows = db.prepare('SELECT * FROM card_payloads WHERE game_id = ?').all(GAME_ID);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_data).version).toBe(1);
    expect(rows[0].run_id).toBe('run-1');
  });

  it('driver card (non-call) — both inserts create separate rows', () => {
    const plain = db.prepare('INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    plain.run('driver-aaa', GAME_ID, 'nba', 'nba-driver', 'D', NOW, '{}');
    plain.run('driver-bbb', GAME_ID, 'nba', 'nba-driver', 'D', NOW2, '{}');
    const rows = db.prepare("SELECT * FROM card_payloads WHERE game_id = ? AND card_type = 'nba-driver'").all(GAME_ID);
    expect(rows).toHaveLength(2);
  });

  it('re-insert produces exactly one card_results row (INSERT OR IGNORE)', () => {
    upsert();
    result(CID, 'pending');
    result(CID, 'pending');
    expect(db.prepare('SELECT * FROM card_results WHERE card_id = ?').all(CID)).toHaveLength(1);
  });

  it('uq_card_payloads_call_per_game partial index exists', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_card_payloads_call_per_game'").get();
    expect(idx).toBeDefined(); expect(idx.name).toBe('uq_card_payloads_call_per_game');
  });
});

describe('migration 062 — deduplication SQL', () => {
  it('removes non-canonical call-card rows and their card_results', () => {
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = OFF');
    db2.exec("CREATE TABLE card_payloads (id TEXT PRIMARY KEY, game_id TEXT, card_type TEXT, card_title TEXT, sport TEXT, created_at TEXT, payload_data TEXT);\nCREATE TABLE card_results (id TEXT PRIMARY KEY, card_id TEXT, status TEXT);");
    const ins = (id, ts) => db2.prepare('INSERT INTO card_payloads VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'game1', 'nba-totals-call', 'T', 'nba', ts, '{}');
    ins('card-aaa', '2026-01-01T00:00:00Z');
    ins('card-bbb', '2026-01-01T00:30:00Z');
    ins('card-ccc', '2026-01-01T01:00:00Z');
    db2.prepare('INSERT INTO card_results VALUES (?, ?, ?)').run('res-bbb', 'card-bbb', 'pending');
    db2.prepare('INSERT INTO card_results VALUES (?, ?, ?)').run('res-ccc', 'card-ccc', 'settled');
    db2.exec("DELETE FROM card_results WHERE card_id IN (\n  SELECT cp.id FROM card_payloads cp WHERE cp.card_type LIKE '%-call'\n  AND cp.id != (\n    SELECT cp2.id FROM card_payloads cp2\n    WHERE cp2.game_id = cp.game_id AND cp2.card_type = cp.card_type AND cp2.card_type LIKE '%-call'\n    ORDER BY cp2.created_at ASC LIMIT 1\n  )\n);\nDELETE FROM card_payloads WHERE card_type LIKE '%-call'\nAND id != (\n  SELECT cp2.id FROM card_payloads cp2\n  WHERE cp2.game_id = card_payloads.game_id AND cp2.card_type = card_payloads.card_type AND cp2.card_type LIKE '%-call'\n  ORDER BY cp2.created_at ASC LIMIT 1\n);");
    const rem = db2.prepare('SELECT * FROM card_payloads').all();
    expect(rem).toHaveLength(1); expect(rem[0].id).toBe('card-aaa');
    const remR = db2.prepare('SELECT * FROM card_results').all();
    expect(remR).toHaveLength(0);
    db2.close();
  });
});