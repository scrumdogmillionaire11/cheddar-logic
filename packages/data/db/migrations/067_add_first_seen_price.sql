-- Migration 067: add first_seen_price column to card_payloads
-- first_seen_price (REAL, nullable) records the locked price at first INSERT.
-- It is written once on card creation and never overwritten on upsert,
-- making the original opening-line pick price durable for true CLV measurement.
ALTER TABLE card_payloads ADD COLUMN first_seen_price REAL;
