-- Migration: Normalize card_payloads sport casing

UPDATE card_payloads
SET sport = UPPER(sport)
WHERE sport IS NOT NULL
  AND sport != UPPER(sport);
