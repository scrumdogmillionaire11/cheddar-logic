-- Migration: Create game_results table
-- Purpose: Store final scores and settlement-ready game outcomes

CREATE TABLE game_results (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL UNIQUE,
  sport TEXT NOT NULL,
  final_score_home INTEGER,
  final_score_away INTEGER,
  status TEXT NOT NULL DEFAULT 'in_progress',
  result_source TEXT NOT NULL,
  settled_at TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_game_results_game_id ON game_results(game_id);
CREATE INDEX idx_game_results_sport ON game_results(sport);
CREATE INDEX idx_game_results_status ON game_results(status);
CREATE INDEX idx_game_results_settled_at ON game_results(settled_at);

-- Status values: 'in_progress' | 'final' | 'cancelled' | 'postponed'
-- Result source values: 'primary_api' | 'backup_scraper' | 'manual'
