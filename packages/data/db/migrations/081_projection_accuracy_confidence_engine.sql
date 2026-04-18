ALTER TABLE projection_accuracy_evals ADD COLUMN market_type TEXT;
ALTER TABLE projection_accuracy_evals ADD COLUMN player_or_game_id TEXT;
ALTER TABLE projection_accuracy_evals ADD COLUMN projection_raw REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN synthetic_line REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN synthetic_rule TEXT NOT NULL DEFAULT 'nearest_half';
ALTER TABLE projection_accuracy_evals ADD COLUMN synthetic_direction TEXT;
ALTER TABLE projection_accuracy_evals ADD COLUMN direction_strength TEXT;
ALTER TABLE projection_accuracy_evals ADD COLUMN projection_confidence INTEGER;
ALTER TABLE projection_accuracy_evals ADD COLUMN market_trust_status TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA';
ALTER TABLE projection_accuracy_evals ADD COLUMN failure_flags TEXT;
ALTER TABLE projection_accuracy_evals ADD COLUMN actual REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN abs_error REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN signed_error REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN expected_over_prob REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN expected_direction_prob REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN calibration_bucket TEXT;

ALTER TABLE projection_accuracy_line_evals ADD COLUMN line REAL;
ALTER TABLE projection_accuracy_line_evals ADD COLUMN expected_over_prob REAL;
ALTER TABLE projection_accuracy_line_evals ADD COLUMN expected_direction_prob REAL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_projection_accuracy_line_evals_card_line
  ON projection_accuracy_line_evals(card_id, eval_line);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_evals_market_type
  ON projection_accuracy_evals(market_type, captured_at);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_evals_confidence
  ON projection_accuracy_evals(market_family, confidence_band, grade_status);
