-- Migration 068: Add is_primary flag to card_results
-- Purpose: Mark only the latest card_result per (game_id, card_type, recommended_bet_type)
-- as primary. Downstream queries filter on is_primary=1 to eliminate 1.7-2.1x dup inflation.
-- WI-0843

ALTER TABLE card_results ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1;

-- Demote all but the latest row per unique market to is_primary=0.
-- "Latest" = MAX(created_at); tie-break by MAX(id) for determinism.
UPDATE card_results
SET is_primary = 0
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY game_id, card_type, recommended_bet_type
             ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM card_results
  ) ranked
  WHERE rn = 1
);

CREATE INDEX IF NOT EXISTS idx_card_results_is_primary
  ON card_results(is_primary);
