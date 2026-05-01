-- WI-1224: Add grading_mode to projection_proxy_evals.
-- NULL = legacy row (written before this migration).
-- 'OFFICIAL' = settlement contract explicitly marked this as an official call.
-- 'TRACK_ONLY' = reserved; settlement skips writing these rows, so NULL is the
--                legacy sentinel and 'OFFICIAL' is the only value written going forward.
-- The Results API filters MLB_F5_TOTAL rows to grading_mode = 'OFFICIAL' only,
-- which implicitly suppresses legacy NULL rows during the transition period.
ALTER TABLE projection_proxy_evals ADD COLUMN grading_mode TEXT;
