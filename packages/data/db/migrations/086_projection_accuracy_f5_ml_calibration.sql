ALTER TABLE projection_accuracy_evals ADD COLUMN win_probability REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN edge_pp REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN brier_score REAL;
ALTER TABLE projection_accuracy_evals ADD COLUMN tracking_role TEXT;
ALTER TABLE projection_accuracy_evals ADD COLUMN expected_outcome_label TEXT;

ALTER TABLE projection_accuracy_line_evals ADD COLUMN edge_pp REAL;
ALTER TABLE projection_accuracy_line_evals ADD COLUMN brier_score REAL;
ALTER TABLE projection_accuracy_line_evals ADD COLUMN tracking_role TEXT;
ALTER TABLE projection_accuracy_line_evals ADD COLUMN expected_outcome_label TEXT;

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_evals_f5_ml
  ON projection_accuracy_evals(market_family, tracking_role, grade_status);
