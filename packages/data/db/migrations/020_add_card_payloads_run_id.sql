-- Migration: Add run_id to card_payloads for snapshot publishing

ALTER TABLE card_payloads ADD COLUMN run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_card_payloads_run_id
  ON card_payloads(run_id);

UPDATE card_payloads
SET run_id = 'bootstrap-initial'
WHERE run_id IS NULL;

INSERT OR IGNORE INTO run_state (id, current_run_id, updated_at)
VALUES ('singleton', NULL, CURRENT_TIMESTAMP);

UPDATE run_state
SET current_run_id = 'bootstrap-initial', updated_at = CURRENT_TIMESTAMP
WHERE id = 'singleton' AND (current_run_id IS NULL OR TRIM(current_run_id) = '');
