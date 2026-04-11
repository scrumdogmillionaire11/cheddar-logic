-- Migration 073: add nullable reasoning column to potd_plays
-- Reasoning is a deterministic human-readable rationale string generated at
-- POTD publish time from scored-candidate facts (edge, win prob, line value).
-- Pre-migration rows read as NULL, which is safe for all callers.

ALTER TABLE potd_plays ADD COLUMN reasoning TEXT;
