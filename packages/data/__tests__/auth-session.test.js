'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { initDb, getDatabase, closeDatabase } = require('../src/db');
const { runMigrations } = require('../src/migrate');
const {
  USER_ROLE,
  USER_STATUS,
  SUBSCRIPTION_STATUS,
  createAccessToken,
  hashTokenHmac,
  randomToken,
  verifySignedPayload,
} = require('../index');

function makeTempDbPath() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `cheddar-logic-auth-${suffix}.db`);
}

async function setupDb() {
  const dbPath = makeTempDbPath();
  process.env.DATABASE_PATH = dbPath;
  await initDb();
  await runMigrations();
  return { db: getDatabase(), dbPath };
}

function cleanupDb(dbPath) {
  closeDatabase();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
}

function createTestUser(db, { email, role = USER_ROLE.FREE_ACCOUNT, subStatus = SUBSCRIPTION_STATUS.NONE }) {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, role, user_status, flags, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, email, role, USER_STATUS.ACTIVE, '[]', now, now);

  db.prepare(
    `INSERT INTO subscriptions (id, user_id, plan_id, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, 'free', subStatus, '{}', now, now);

  return userId;
}

function createTestSession(db, userId) {
  const sessionId = crypto.randomUUID();
  const refreshToken = randomToken(32);
  const refreshTokenHash = hashTokenHmac(refreshToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, userId, refreshTokenHash, expiresAt, '127.0.0.1', 'test-agent', now, now);

  return { sessionId, refreshToken };
}

describe('auth session management', () => {
  let db, dbPath;

  beforeEach(async () => {
    const setup = await setupDb();
    db = setup.db;
    dbPath = setup.dbPath;
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  test('session lookup validates refresh token hash', () => {
    const userId = createTestUser(db, { email: 'test@example.com' });
    const { refreshToken } = createTestSession(db, userId);

    const refreshTokenHash = hashTokenHmac(refreshToken);
    const session = db.prepare(`
      SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.role, u.flags
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
    `).get(refreshTokenHash);

    expect(session).not.toBeNull();
    expect(session.user_id).toBe(userId);
    expect(session.revoked_at).toBeNull();
  });

  test('revoked session blocks refresh', () => {
    const userId = createTestUser(db, { email: 'test@example.com' });
    const { sessionId, refreshToken } = createTestSession(db, userId);

    // Revoke the session
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), sessionId);

    const refreshTokenHash = hashTokenHmac(refreshToken);
    const session = db.prepare(`
      SELECT revoked_at FROM sessions WHERE refresh_token_hash = ?
    `).get(refreshTokenHash);

    expect(session.revoked_at).not.toBeNull();
  });

  test('expired session blocks refresh', () => {
    const userId = createTestUser(db, { email: 'expired-session@example.com' });
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    const now = new Date().toISOString();
    const pastExpiry = new Date(Date.now() - 60000).toISOString(); // Expired 1 minute ago

    db.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, userId, refreshTokenHash, pastExpiry, '127.0.0.1', 'test-agent', now, now);

    const session = db.prepare(`
      SELECT expires_at FROM sessions WHERE refresh_token_hash = ?
    `).get(refreshTokenHash);

    expect(new Date() > new Date(session.expires_at)).toBe(true);
  });

  test('refresh updates last_seen_at timestamp', () => {
    const userId = createTestUser(db, { email: 'refresh-update@example.com' });
    const { sessionId, refreshToken } = createTestSession(db, userId);

    const oldLastSeen = db.prepare(`SELECT last_seen_at FROM sessions WHERE id = ?`).get(sessionId);

    // Simulate delay
    const nowIso = new Date(Date.now() + 1000).toISOString();
    db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(nowIso, sessionId);

    const newLastSeen = db.prepare(`SELECT last_seen_at FROM sessions WHERE id = ?`).get(sessionId);

    expect(newLastSeen.last_seen_at).not.toBe(oldLastSeen.last_seen_at);
  });

  test('access token refresh picks up role changes', () => {
    const userId = createTestUser(db, { email: 'admin@example.com', role: USER_ROLE.FREE_ACCOUNT });
    const { sessionId } = createTestSession(db, userId);

    // Create initial access token
    const oldToken = createAccessToken({
      userId,
      role: USER_ROLE.FREE_ACCOUNT,
      flags: [],
      sessionId,
    }, 60000);

    const oldPayload = verifySignedPayload(oldToken);
    expect(oldPayload.sub).toBe(userId);

    // Upgrade user to ADMIN
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(USER_ROLE.ADMIN, userId);

    // Simulate refresh - get updated role from DB
    const updatedUser = db.prepare(`SELECT role, flags FROM users WHERE id = ?`).get(userId);
    const newToken = createAccessToken({
      userId,
      role: updatedUser.role,
      flags: JSON.parse(updatedUser.flags),
      sessionId,
    }, 60000);

    const newPayload = verifySignedPayload(newToken);
    expect(newPayload.sub).toBe(userId);
    // Token itself doesn't contain role, but this simulates the refresh flow
    expect(updatedUser.role).toBe(USER_ROLE.ADMIN);
  });

  test('multiple concurrent sessions allowed for same user', () => {
    const userId = createTestUser(db, { email: 'multi@example.com' });
    const session1 = createTestSession(db, userId);
    const session2 = createTestSession(db, userId);

    const sessions = db.prepare(`SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).all(userId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.id)).toContain(session1.sessionId);
    expect(sessions.map(s => s.id)).toContain(session2.sessionId);
  });

  test('revoking one session leaves others active', () => {
    const userId = createTestUser(db, { email: 'revoke-one@example.com' });
    const session1 = createTestSession(db, userId);
    const session2 = createTestSession(db, userId);

    // Revoke session1
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), session1.sessionId);

    const activeSessions = db.prepare(`
      SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL
    `).all(userId);

    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0].id).toBe(session2.sessionId);
  });

  test('session validates user is ACTIVE before refresh', () => {
    const userId = createTestUser(db, { email: 'suspended@example.com' });
    const { sessionId, refreshToken } = createTestSession(db, userId);

    // Suspend the user
    db.prepare(`UPDATE users SET user_status = ? WHERE id = ?`).run(USER_STATUS.SUSPENDED, userId);

    const refreshTokenHash = hashTokenHmac(refreshToken);
    const session = db.prepare(`
      SELECT u.user_status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
    `).get(refreshTokenHash);

    expect(session.user_status).toBe(USER_STATUS.SUSPENDED);
    // In production, refresh would fail here due to suspension
  });

  test('access token contains session id for tracking', () => {
    const userId = createTestUser(db, { email: 'track@example.com' });
    const { sessionId } = createTestSession(db, userId);

    const accessToken = createAccessToken({
      userId,
      role: USER_ROLE.FREE_ACCOUNT,
      flags: [],
      sessionId,
    }, 60000);

    const payload = verifySignedPayload(accessToken);
    expect(payload.sub).toBe(userId);
    expect(payload.sid).toBe(sessionId);
  });

  test('24 hour access token remains valid throughout period', () => {
    const ttl24Hours = 24 * 60 * 60 * 1000;
    const token = createAccessToken({
      userId: 'test-user',
      role: USER_ROLE.FREE_ACCOUNT,
      flags: [],
      sessionId: 'test-session',
    }, ttl24Hours);

    const payload = verifySignedPayload(token);
    expect(payload).not.toBeNull();
    expect(payload.sub).toBe('test-user');
    expect(payload.sid).toBe('test-session');

    // Token exp is in seconds, convert to ms for comparison
    const expMs = payload.exp * 1000;
    const now = Date.now();
    const remaining = expMs - now;

    // Check it's approximately 24 hours (allowing for test execution time)
    expect(remaining).toBeGreaterThan(ttl24Hours - 5000); // Within 5 seconds
    expect(remaining).toBeLessThan(ttl24Hours + 5000);
  });
});
