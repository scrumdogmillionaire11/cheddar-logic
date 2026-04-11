-- Migration 074: add confidence_multiplier to potd_plays
-- Nullable REAL column; pre-existing rows default to NULL (no back-fill needed).
ALTER TABLE potd_plays ADD COLUMN confidence_multiplier REAL;
