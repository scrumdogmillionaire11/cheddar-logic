-- Migration: Create model_outputs table
-- Purpose: Store inference outputs from sport models (NHL, NBA, FPL)
-- Each row is a point-in-time model prediction for a game

CREATE TABLE model_outputs (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prediction_type TEXT NOT NULL,
  predicted_at TEXT NOT NULL,
  confidence REAL,
  output_data TEXT NOT NULL,
  odds_snapshot_id TEXT,
  job_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(game_id),
  FOREIGN KEY (odds_snapshot_id) REFERENCES odds_snapshots(id),
  FOREIGN KEY (job_run_id) REFERENCES job_runs(id)
);

CREATE INDEX idx_model_outputs_game_id ON model_outputs(game_id);
CREATE INDEX idx_model_outputs_sport ON model_outputs(sport);
CREATE INDEX idx_model_outputs_model_name ON model_outputs(model_name);
CREATE INDEX idx_model_outputs_predicted_at ON model_outputs(predicted_at);
CREATE INDEX idx_model_outputs_game_model ON model_outputs(game_id, model_name, predicted_at DESC);
