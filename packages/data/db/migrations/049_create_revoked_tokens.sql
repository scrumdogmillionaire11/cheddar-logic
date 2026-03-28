-- Migration 049: JWT revocation persistence
-- Replaces in-memory Set in jwt.ts with a persistent table.
-- jti is the JWT ID claim (unique per token). expires_at is Unix epoch seconds
-- matching the token's exp claim — used by prune to bound table growth.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        TEXT    PRIMARY KEY,
  revoked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
  ON revoked_tokens (expires_at);
