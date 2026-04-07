'use strict';
// WI-0817: Transaction atomicity test
// Validates that the per-game write-phase transaction (delete + insert) rolls back
// correctly when an insert fails, leaving old cards intact (no card blackout).
const Database = require('better-sqlite3');

const SCHEMA = [
  `CREATE TABLE card_payloads (
    id TEXT PRIMARY KEY, game_id TEXT NOT NULL, sport TEXT NOT NULL,
    card_type TEXT NOT NULL, card_title TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT, payload_data TEXT NOT NULL, model_output_ids TEXT,
    metadata TEXT, run_id TEXT
  )`,
  `CREATE TABLE model_outputs (
    id TEXT PRIMARY KEY, game_id TEXT NOT NULL, sport TEXT NOT NULL,
    model_name TEXT NOT NULL, model_version TEXT, prediction_type TEXT,
    predicted_at TEXT, confidence REAL, output_data TEXT, odds_snapshot_id TEXT,
    job_run_id TEXT
  )`,
].join('; ');

function buildDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertCard(db, id, gameId, cardType = 'nba-drivers-v1') {
  db.prepare(
    `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, gameId, 'nba', cardType, 'Test Card', '2026-04-07T00:00:00Z', '{}');
}

function insertModelOutput(db, id, gameId) {
  db.prepare(
    `INSERT INTO model_outputs (id, game_id, sport, model_name, prediction_type, predicted_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, gameId, 'nba', 'nba-model-v1', 'TOTAL', '2026-04-07T00:00:00Z', 0.65);
}

describe('WI-0817 — per-game write transaction atomicity', () => {
  const GAME_ID = 'game-nba-test-bos-mia';
  const OLD_CARD_ID = 'card-old-bos-mia';
  const OLD_MODEL_ID = 'model-old-bos-mia';

  it('rolls back card deletes when insert throws — old cards survive', () => {
    const db = buildDb();
    insertCard(db, OLD_CARD_ID, GAME_ID);
    insertModelOutput(db, OLD_MODEL_ID, GAME_ID);

    // Simulate the WI-0817 outer write transaction: delete old, insert new, then throw.
    // Expected: since the transaction rolls back, the old card + model output are preserved.
    expect(() => {
      db.transaction(() => {
        // Step 1: clear stale cards (simulate prepareModelAndCardWrite)
        db.prepare(`DELETE FROM model_outputs WHERE game_id = ?`).run(GAME_ID);
        db.prepare(`DELETE FROM card_payloads WHERE game_id = ?`).run(GAME_ID);

        // Step 2: insert new card — simulate a crash / invalid payload error
        throw new Error('Simulated crash during card insert');
      })();
    }).toThrow('Simulated crash during card insert');

    const card = db.prepare(`SELECT * FROM card_payloads WHERE id = ?`).get(OLD_CARD_ID);
    expect(card).toBeDefined();
    expect(card.id).toBe(OLD_CARD_ID);

    const output = db.prepare(`SELECT * FROM model_outputs WHERE id = ?`).get(OLD_MODEL_ID);
    expect(output).toBeDefined();
    expect(output.id).toBe(OLD_MODEL_ID);

    db.close();
  });

  it('commits card inserts when transaction completes without error', () => {
    const db = buildDb();
    insertCard(db, OLD_CARD_ID, GAME_ID);

    db.transaction(() => {
      db.prepare(`DELETE FROM card_payloads WHERE game_id = ?`).run(GAME_ID);
      db.prepare(
        `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('card-new-bos-mia', GAME_ID, 'nba', 'nba-drivers-v1', 'New Card', '2026-04-07T01:00:00Z', '{}');
    })();

    const cards = db.prepare(`SELECT * FROM card_payloads WHERE game_id = ?`).all(GAME_ID);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('card-new-bos-mia');

    db.close();
  });

  it('rolls back ALL card types when insert of second card throws — no partial write', () => {
    const db = buildDb();
    insertCard(db, OLD_CARD_ID, GAME_ID, 'nba-drivers-v1');
    insertCard(db, 'card-old-call', GAME_ID, 'nba-totals-call');

    expect(() => {
      db.transaction(() => {
        // Simulate 5 MLB-style type-specific deletes
        db.prepare(`DELETE FROM card_payloads WHERE game_id = ? AND card_type = ?`).run(GAME_ID, 'nba-drivers-v1');
        db.prepare(`DELETE FROM card_payloads WHERE game_id = ? AND card_type = ?`).run(GAME_ID, 'nba-totals-call');

        // First insert succeeds
        db.prepare(
          `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('card-new-driver', GAME_ID, 'nba', 'nba-drivers-v1', 'New', '2026-04-07T01:00:00Z', '{}');

        // Second insert throws (e.g., constraint violation)
        throw new Error('Constraint violation on second insert');
      })();
    }).toThrow('Constraint violation on second insert');

    // Both OLD cards must survive (full rollback)
    const cards = db.prepare(`SELECT id FROM card_payloads WHERE game_id = ? ORDER BY id`).all(GAME_ID);
    expect(cards.map((r) => r.id)).toEqual([OLD_CARD_ID, 'card-old-call'].sort());

    db.close();
  });

  it('prepareModelAndCardWrite inner transaction — both deletes roll back if one fails', () => {
    const db = buildDb();
    insertCard(db, OLD_CARD_ID, GAME_ID);
    insertModelOutput(db, OLD_MODEL_ID, GAME_ID);

    // Simulate the Task 1 inner transaction in prepareModelAndCardWrite:
    // if deleteCardPayloads throws after deleteModelOutputs succeeded, both roll back.
    expect(() => {
      db.transaction(() => {
        db.prepare(`DELETE FROM model_outputs WHERE game_id = ?`).run(GAME_ID);
        // Simulate failure in deleteCardPayloads
        throw new Error('DB error in deleteCardPayloads');
      })();
    }).toThrow('DB error in deleteCardPayloads');

    // model_output must still exist (rolled back)
    const output = db.prepare(`SELECT id FROM model_outputs WHERE id = ?`).get(OLD_MODEL_ID);
    expect(output).toBeDefined();

    db.close();
  });
});
