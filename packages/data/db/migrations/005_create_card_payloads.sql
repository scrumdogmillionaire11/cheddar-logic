-- Migration: Create card_payloads table
-- Purpose: Store rendered card payloads (web-ready data for display)
-- Each row is a card ready to be served to the frontend
-- One game can have multiple cards (CLV analysis, pick recommendation, line movement, etc)

CREATE TABLE card_payloads (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  card_type TEXT NOT NULL,
  card_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  payload_data TEXT NOT NULL,
  model_output_ids TEXT,
  metadata TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_card_payloads_game_id ON card_payloads(game_id);
CREATE INDEX idx_card_payloads_sport ON card_payloads(sport);
CREATE INDEX idx_card_payloads_card_type ON card_payloads(card_type);
CREATE INDEX idx_card_payloads_created_at ON card_payloads(created_at DESC);
CREATE INDEX idx_card_payloads_game_type ON card_payloads(game_id, card_type);
CREATE INDEX idx_card_payloads_expires_at ON card_payloads(expires_at);
