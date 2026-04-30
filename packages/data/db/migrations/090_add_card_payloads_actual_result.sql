-- Migration 090: Add actual_result to card_payloads for projection settlement

ALTER TABLE card_payloads ADD COLUMN actual_result TEXT;
