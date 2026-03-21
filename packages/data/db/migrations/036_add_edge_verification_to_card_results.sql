-- Migration: Add edge verification fields to card_results
-- Purpose:
-- 1) Persist sharp_price_status so settlement outcomes can be segmented by edge verification gate
-- 2) Persist primary_reason_code to identify why a play was blocked/downgraded
-- 3) Persist edge_pct to enable edge-size vs outcome correlation analysis

ALTER TABLE card_results ADD COLUMN sharp_price_status TEXT;
ALTER TABLE card_results ADD COLUMN primary_reason_code TEXT;
ALTER TABLE card_results ADD COLUMN edge_pct REAL;

CREATE INDEX IF NOT EXISTS idx_card_results_sharp_price_status ON card_results(sharp_price_status);
