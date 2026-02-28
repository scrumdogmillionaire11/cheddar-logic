-- Migration: Create card_results table
-- Purpose: Track settlement status + P&L for each generated card

CREATE TABLE card_results (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  card_type TEXT NOT NULL,
  recommended_bet_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  settled_at TEXT,
  pnl_units REAL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (card_id) REFERENCES card_payloads(id),
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_card_results_game_id ON card_results(game_id);
CREATE INDEX idx_card_results_status ON card_results(status);
CREATE INDEX idx_card_results_sport ON card_results(sport);
CREATE INDEX idx_card_results_settled_at ON card_results(settled_at);
