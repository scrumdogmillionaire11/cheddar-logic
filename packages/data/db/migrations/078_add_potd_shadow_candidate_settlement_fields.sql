-- Migration 078: add gradeable settlement fields to potd_shadow_candidates
-- selection is canonical: HOME/AWAY/OVER/UNDER.
-- candidate_identity_key provides stable per-candidate identity for daily idempotent upserts.
ALTER TABLE potd_shadow_candidates ADD COLUMN selection TEXT;
ALTER TABLE potd_shadow_candidates ADD COLUMN game_time_utc TEXT;
ALTER TABLE potd_shadow_candidates ADD COLUMN candidate_identity_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_potd_shadow_play_date_identity
  ON potd_shadow_candidates(play_date, candidate_identity_key);
