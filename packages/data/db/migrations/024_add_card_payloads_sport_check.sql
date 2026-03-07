-- Migration: Add CHECK constraint for card_payloads.sport values

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

ALTER TABLE card_payloads RENAME TO card_payloads_old;

CREATE TABLE card_payloads (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('NBA', 'NHL', 'NCAAM', 'SOCCER', 'MLB', 'NFL', 'FPL')),
  card_type TEXT NOT NULL,
  card_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  payload_data TEXT NOT NULL,
  model_output_ids TEXT,
  metadata TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  run_id TEXT,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

INSERT INTO card_payloads (
  id, game_id, sport, card_type, card_title, created_at,
  expires_at, payload_data, model_output_ids, metadata, updated_at, run_id
)
SELECT
  id, game_id, sport, card_type, card_title, created_at,
  expires_at, payload_data, model_output_ids, metadata, updated_at, run_id
FROM card_payloads_old;

DROP TABLE card_payloads_old;

CREATE INDEX idx_card_payloads_game_id ON card_payloads(game_id);
CREATE INDEX idx_card_payloads_sport ON card_payloads(sport);
CREATE INDEX idx_card_payloads_card_type ON card_payloads(card_type);
CREATE INDEX idx_card_payloads_created_at ON card_payloads(created_at DESC);
CREATE INDEX idx_card_payloads_game_type ON card_payloads(game_id, card_type);
CREATE INDEX idx_card_payloads_expires_at ON card_payloads(expires_at);
CREATE INDEX idx_card_payloads_run_id ON card_payloads(run_id);

COMMIT;

PRAGMA foreign_keys = ON;
