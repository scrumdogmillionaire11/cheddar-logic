-- Migration 062: Deduplicate market-call card_payloads and enforce uniqueness
-- Root cause: buildMarketCallCard used a random UUID suffix, causing every
-- 30-min model run to insert a fresh card for the same game+market.
--
-- Strategy:
--   1. For each (game_id, card_type) group among %-call cards:
--      - Identify the canonical row = earliest created_at (most historical context)
--      - Delete all card_results rows that reference non-canonical duplicates
--      - Delete the non-canonical card_payload rows
--   2. Add a partial UNIQUE INDEX so this can never re-accumulate.
--
-- Safe to run multiple times (idempotent via IF NOT EXISTS on index).
--
-- IMPORTANT: Run this migration BEFORE deploying the insertCardPayload upsert
-- code change. The partial UNIQUE INDEX must exist before the UPDATE statement
-- in insertCardPayload can correctly enforce one-call-card-per-game-market.
-- Verify after: SELECT name FROM sqlite_master WHERE type=
--   'index' AND name='uq_card_payloads_call_per_game';

-- Step 1a: Delete card_results rows for non-canonical call-card duplicates.
-- Non-canonical = not the earliest-created row for that (game_id, card_type) pair.
DELETE FROM card_results
WHERE card_id IN (
  SELECT cp.id
  FROM card_payloads cp
  WHERE cp.card_type LIKE '%-call'
    AND cp.id != (
      SELECT cp2.id
      FROM card_payloads cp2
      WHERE cp2.game_id   = cp.game_id
        AND cp2.card_type = cp.card_type
        AND cp2.card_type LIKE '%-call'
      ORDER BY cp2.created_at ASC
      LIMIT 1
    )
);

-- Step 1b: Delete the non-canonical card_payload rows themselves.
DELETE FROM card_payloads
WHERE card_type LIKE '%-call'
  AND id != (
    SELECT cp2.id
    FROM card_payloads cp2
    WHERE cp2.game_id   = card_payloads.game_id
      AND cp2.card_type = card_payloads.card_type
      AND cp2.card_type LIKE '%-call'
    ORDER BY cp2.created_at ASC
    LIMIT 1
  );

-- Step 2: Add partial UNIQUE INDEX — enforces one call card per game+market
-- going forward. Partial (WHERE LIKE %-call) so driver cards are unaffected.
-- This index is also required for insertCardPayload UPDATE WHERE to be unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_payloads_call_per_game
  ON card_payloads(game_id, card_type)
  WHERE card_type LIKE '%-call';
