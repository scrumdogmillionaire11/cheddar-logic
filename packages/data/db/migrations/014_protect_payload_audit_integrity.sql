-- Migration: Protect payload/result referential integrity
-- Purpose: Block accidental deletion of payloads that are still referenced by card_results.

CREATE TRIGGER IF NOT EXISTS trg_block_card_payload_delete_when_referenced
BEFORE DELETE ON card_payloads
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM card_results
  WHERE card_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete card_payloads row referenced by card_results');
END;
