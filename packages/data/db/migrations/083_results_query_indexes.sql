-- Migration: Add targeted indexes for /api/results hot query paths
-- WI-1042: Improves worst-case query plan for dedupe/join paths without
-- schema changes. All statements are idempotent (IF NOT EXISTS).

-- Composite covering index for the main settled-rows filter + card_id join.
-- Replaces sequential scan of card_results when status='settled' is combined
-- with the INNER JOIN on card_display_log.pick_id = cr.card_id.
CREATE INDEX IF NOT EXISTS idx_card_results_status_card_id
  ON card_results (status, card_id);

-- Composite for settlement coverage queries that filter by status + game_id.
CREATE INDEX IF NOT EXISTS idx_card_results_status_game_id
  ON card_results (status, game_id);

-- Composite for the display_log_ranked window function, which partitions by
-- pick_id and orders by displayed_at DESC. pick_id is UNIQUE so each partition
-- has one row, but the planner benefits from the covering index when evaluating
-- the ROW_NUMBER() OVER (PARTITION BY pick_id ORDER BY displayed_at DESC) path.
CREATE INDEX IF NOT EXISTS idx_card_display_log_pick_displayed
  ON card_display_log (pick_id, displayed_at DESC);

-- Composite for the game_results join used in settlement coverage and
-- the displayedFinal count query (WHERE status='final' + game_id lookup).
CREATE INDEX IF NOT EXISTS idx_game_results_status_game_id
  ON game_results (status, game_id);
