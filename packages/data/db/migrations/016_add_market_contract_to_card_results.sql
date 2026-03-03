-- Migration: Add canonical locked market fields to card_results
-- Purpose:
-- 1) Persist canonical market identity per locked play (market_key)
-- 2) Persist exact locked settlement inputs (market_type, selection, line, locked_price)
-- 3) Prevent game-level-only settlement routing

ALTER TABLE card_results ADD COLUMN market_key TEXT;
ALTER TABLE card_results ADD COLUMN market_type TEXT;
ALTER TABLE card_results ADD COLUMN selection TEXT;
ALTER TABLE card_results ADD COLUMN line REAL;
ALTER TABLE card_results ADD COLUMN locked_price INTEGER;

CREATE INDEX IF NOT EXISTS idx_card_results_market_key ON card_results(market_key);
CREATE INDEX IF NOT EXISTS idx_card_results_market_type ON card_results(market_type);
