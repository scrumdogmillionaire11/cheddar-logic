const crypto = require('crypto');
const {
  DEFAULT_REFRESH_TOKEN_TTL_MS,
  getDatabase,
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} = require('./connection');
const {
  addMsIso,
  hashTokenHmac,
  randomToken,
} = require('../auth');

// ---- WI-0608: JWT revocation persistence ----

/**
 * Insert a revoked token record.
 * Uses INSERT OR IGNORE so duplicate revocations are silently no-ops.
 * @param {string} jti - JWT ID claim (unique per token)
 * @param {number} expiresAt - Unix epoch seconds matching the token's exp claim
 */
function insertRevokedToken(jti, expiresAt) {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO revoked_tokens (jti, revoked_at, expires_at)
     VALUES (?, strftime('%s','now'), ?)`,
  ).run(jti, expiresAt);
}

/**
 * Check if a token has been revoked.
 * @param {string} jti - JWT ID claim
 * @returns {boolean} true if the jti exists in the revoked_tokens table
 */
function isTokenRevoked(jti) {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1 FROM revoked_tokens WHERE jti = ? LIMIT 1`,
  ).get(jti);
  return !!row;
}

/**
 * Remove expired revocation records to bound table growth.
 * Deletes rows whose expires_at is in the past (< current epoch).
 * @returns {number} number of rows deleted
 */
function pruneExpiredRevokedTokens() {
  const db = getDatabase();
  const info = db.prepare(
    `DELETE FROM revoked_tokens WHERE expires_at < strftime('%s','now')`,
  ).run();
  return info.changes;
}

function getRefreshTokenTtlMs() {
  const parsed = Number.parseInt(process.env.AUTH_REFRESH_TTL_MS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_REFRESH_TOKEN_TTL_MS;
}

function hashRefreshToken(token) {
  if (!token || typeof token !== 'string') return null;
  return hashTokenHmac(token);
}

/**
 * Issue a refresh token backed by the canonical sessions table.
 * Returns the plaintext token once; only its HMAC is persisted.
 *
 * @param {string} userId
 * @param {{ expiresAt?: string, ipAddress?: string | null, userAgent?: string | null }} [options]
 * @returns {{ token: string, sessionId: string, expiresAt: string }}
 */
function issueRefreshToken(userId, options = {}) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('issueRefreshToken requires a non-empty userId');
  }

  const db = getDatabase();
  const token = randomToken(32);
  const tokenHash = hashRefreshToken(token);
  const sessionId = crypto.randomUUID();
  const expiresAt =
    typeof options.expiresAt === 'string' && options.expiresAt.trim()
      ? options.expiresAt
      : addMsIso(getRefreshTokenTtlMs());

  db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    tokenHash,
    expiresAt,
    options.ipAddress ?? null,
    options.userAgent ?? null,
  );

  return { token, sessionId, expiresAt };
}

/**
 * Revoke a refresh token by marking its backing session row as revoked.
 * Uses the existing sessions table instead of duplicating refresh-token state.
 *
 * @param {string} token
 * @returns {boolean} true when an active session was revoked
 */
function revokeRefreshToken(token) {
  const tokenHash = hashRefreshToken(token);
  if (!tokenHash) return false;

  const db = getDatabase();
  const info = db.prepare(
    `UPDATE sessions
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
     WHERE refresh_token_hash = ?
       AND revoked_at IS NULL`,
  ).run(tokenHash);

  return info.changes > 0;
}

/**
 * Validate a refresh token against the canonical sessions table.
 *
 * @param {string} token
 * @returns {boolean} true when the token exists, is unrevoked, and unexpired
 */
function isRefreshTokenValid(token) {
  const tokenHash = hashRefreshToken(token);
  if (!tokenHash) return false;

  let db = null;
  try {
    db = getDatabaseReadOnly();
    const row = db.prepare(
      `SELECT expires_at, revoked_at
       FROM sessions
       WHERE refresh_token_hash = ?
       LIMIT 1`,
    ).get(tokenHash);

    if (!row || row.revoked_at) {
      return false;
    }

    const expiresAt = new Date(row.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      return false;
    }

    return expiresAt.getTime() > Date.now();
  } catch {
    return false;
  } finally {
    closeReadOnlyInstance(db);
  }
}

module.exports = {
  insertRevokedToken,
  isTokenRevoked,
  pruneExpiredRevokedTokens,
  issueRefreshToken,
  revokeRefreshToken,
  isRefreshTokenValid,
};
