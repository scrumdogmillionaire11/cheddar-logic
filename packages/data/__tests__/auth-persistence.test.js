/**
 * Auth Persistence Regression Tests
 * 
 * These tests prevent the specific regression where:
 * - Users login successfully but get signed out 5 minutes later
 * - Login doesn't persist across requests
 * - Sessions vanish from database
 * - Cookies work initially but fail later
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  initDb,
  getDatabase,
  closeDatabase,
} = require('../src/db');
const {
  createAccessToken,
  hashTokenHmac,
  randomToken,
  timingSafeEqualHex,
  verifySignedPayload,
  addMsIso,
  hasEntitlement,
  RESOURCE,
} = require('../src/auth');

describe('Auth Persistence Regression Tests', () => {
  let tempDir;
  let dbPath;

  beforeEach(async () => {
    // Create unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-persist-test-'));
    dbPath = path.join(tempDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    
    await initDb();
    
    // Run migrations
    const db = getDatabase();
    const migrations = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'FREE_ACCOUNT',
        user_status TEXT DEFAULT 'ACTIVE',
        flags TEXT DEFAULT '[]',
        ambassador_expires_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        plan_id TEXT DEFAULT 'free',
        status TEXT DEFAULT 'NONE',
        trial_ends_at TEXT,
        current_period_end TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS auth_magic_links (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    ];
    
    migrations.forEach(sql => db.exec(sql));
    closeDatabase();
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch (e) {
      // ignore
    }
    
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('REGRESSION: session persists to disk after creation', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const email = 'persist-test@example.com';
    const nowIso = new Date().toISOString();
    
    // Create user
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, email, 'ADMIN', 'ACTIVE', '[]', nowIso);
    
    // Create subscription
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'premium', 'ACTIVE', nowIso, nowIso);
    
    // Create session
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Verify file exists on disk
    expect(fs.existsSync(dbPath)).toBe(true);
    const stats = fs.statSync(dbPath);
    expect(stats.size).toBeGreaterThan(0);
    
    // Reload database from disk
    await initDb();
    const db2 = getDatabase();
    
    const user = db2.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    expect(user).toBeTruthy();
    expect(user.email).toBe(email);
    
    const session = db2.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(session).toBeTruthy();
    expect(session.user_id).toBe(userId);
    
    const subscription = db2.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
    expect(subscription).toBeTruthy();
    expect(subscription.status).toBe('ACTIVE');
    
    closeDatabase();
  });

  test('REGRESSION: magic link verification creates persistent session', async () => {
    await initDb();
    const db = getDatabase();
    
    const email = 'magic-persist@example.com';
    const tokenId = crypto.randomUUID();
    const code = randomToken(32);
    const tokenHash = hashTokenHmac(code);
    const expiresAt = addMsIso(15 * 60 * 1000);
    
    // Create magic link
    db.prepare(
      'INSERT INTO auth_magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(tokenId, email, tokenHash, expiresAt);
    
    closeDatabase();
    
    // Simulate magic link verification (new DB connection)
    await initDb();
    const db2 = getDatabase();
    const nowIso = new Date().toISOString();
    
    const record = db2.prepare('SELECT * FROM auth_magic_links WHERE id = ?').get(tokenId);
    expect(record).toBeTruthy();
    
    // Verify token hash
    const providedHash = hashTokenHmac(code);
    expect(timingSafeEqualHex(record.token_hash, providedHash)).toBe(true);
    
    // Mark as used
    db2.prepare('UPDATE auth_magic_links SET used_at = ? WHERE id = ?').run(nowIso, tokenId);
    
    // Create user
    const userId = crypto.randomUUID();
    db2.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, email, 'FREE_ACCOUNT', 'ACTIVE', '[]', nowIso, nowIso);
    
    // Create subscription
    db2.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'free', 'NONE', nowIso, nowIso);
    
    // Create session
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    
    db2.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Verify persistence across new connection
    await initDb();
    const db3 = getDatabase();
    
    const persistedUser = db3.prepare('SELECT * FROM users WHERE email = ?').get(email);
    expect(persistedUser).toBeTruthy();
    expect(persistedUser.id).toBe(userId);
    
    const persistedSession = db3.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId);
    expect(persistedSession).toBeTruthy();
    expect(persistedSession.id).toBe(sessionId);
    
    const usedLink = db3.prepare('SELECT * FROM auth_magic_links WHERE id = ?').get(tokenId);
    expect(usedLink.used_at).toBeTruthy();
    
    closeDatabase();
  });

  test('REGRESSION: access token validation works after session creation', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const email = 'token-valid@example.com';
    const nowIso = new Date().toISOString();
    
    // Create user with ADMIN role
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, email, 'ADMIN', 'ACTIVE', '[]', nowIso);
    
    // Create premium subscription
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'premium', 'ACTIVE', nowIso, nowIso);
    
    // Create session
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Create access token
    const accessToken = createAccessToken({
      userId,
      role: 'ADMIN',
      flags: [],
      sessionId,
    }, 24 * 60 * 60 * 1000);
    
    // Verify token works in new connection
    await initDb();
    const db2 = getDatabase();
    
    const payload = verifySignedPayload(accessToken);
    expect(payload).toBeTruthy();
    expect(payload.sub).toBe(userId);
    expect(payload.sid).toBe(sessionId);
    
    // Verify session exists
    const session = db2.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(session).toBeTruthy();
    expect(session.revoked_at).toBeNull();
    
    // Verify user context
    const userContext = db2.prepare(
      `SELECT u.id, u.email, u.role, u.user_status, u.flags,
              s.status AS subscription_status
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = ?`
    ).get(userId);
    
    expect(userContext).toBeTruthy();
    expect(userContext.role).toBe('ADMIN');
    expect(userContext.subscription_status).toBe('ACTIVE');
    
    // Verify entitlement
    expect(hasEntitlement(userContext, RESOURCE.CHEDDAR_BOARD)).toBe(true);
    
    closeDatabase();
  });

  test('REGRESSION: refresh token survives database reload', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    const nowIso = new Date().toISOString();
    
    // Create user
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'refresh-persist@example.com', 'PAID', 'ACTIVE', '[]', nowIso);
    
    // Create subscription
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'premium', 'ACTIVE', nowIso, nowIso);
    
    // Create session
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Simulate refresh request (new DB connection)
    await initDb();
    const db2 = getDatabase();
    
    const providedHash = hashTokenHmac(refreshToken);
    const session = db2.prepare(
      'SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.role, u.flags FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = ?'
    ).get(providedHash);
    
    expect(session).toBeTruthy();
    expect(session.user_id).toBe(userId);
    expect(session.revoked_at).toBeNull();
    expect(new Date(session.expires_at) > new Date()).toBe(true);
    
    // Update last_seen_at
    db2.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso, session.id);
    
    closeDatabase();
    
    // Verify update persisted
    await initDb();
    const db3 = getDatabase();
    
    const updatedSession = db3.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(updatedSession.last_seen_at).toBe(nowIso);
    
    closeDatabase();
  });

  test('REGRESSION: multiple sessions for same user persist independently', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    
    // Create user
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'multi-session@example.com', 'ADMIN', 'ACTIVE', '[]', nowIso);
    
    // Create subscription
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'premium', 'ACTIVE', nowIso, nowIso);
    
    // Create 3 sessions (desktop, mobile, tablet)
    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const sessionId = crypto.randomUUID();
      const refreshToken = randomToken(32);
      const refreshTokenHash = hashTokenHmac(refreshToken);
      
      db.prepare(
        'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000), `Device-${i}`);
      
      sessions.push({ sessionId, refreshToken, refreshTokenHash });
    }
    
    closeDatabase();
    
    // Verify all sessions persisted
    await initDb();
    const db2 = getDatabase();
    
    const persistedSessions = db2.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at').all(userId);
    expect(persistedSessions).toHaveLength(3);
    expect(persistedSessions[0].user_agent).toBe('Device-0');
    expect(persistedSessions[1].user_agent).toBe('Device-1');
    expect(persistedSessions[2].user_agent).toBe('Device-2');
    
    // Revoke one session
    db2.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(nowIso, sessions[1].sessionId);
    
    closeDatabase();
    
    // Verify revocation persisted, others still active
    await initDb();
    const db3 = getDatabase();
    
    const activeSessions = db3.prepare('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL').all(userId);
    expect(activeSessions).toHaveLength(2);
    expect(activeSessions.map(s => s.id)).not.toContain(sessions[1].sessionId);
    
    const revokedSession = db3.prepare('SELECT * FROM sessions WHERE id = ?').get(sessions[1].sessionId);
    expect(revokedSession.revoked_at).toBe(nowIso);
    
    closeDatabase();
  });

  test('REGRESSION: session expiry check survives database reload', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    
    // Create user
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'expiry-check@example.com', 'PAID', 'ACTIVE', '[]', nowIso);
    
    // Create subscription
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'premium', 'ACTIVE', nowIso, nowIso);
    
    // Create expired session (1 hour ago)
    const expiredSessionId = crypto.randomUUID();
    const expiredRefreshToken = randomToken(32);
    const expiredExpiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(expiredSessionId, userId, hashTokenHmac(expiredRefreshToken), expiredExpiresAt);
    
    // Create valid session (30 days from now)
    const validSessionId = crypto.randomUUID();
    const validRefreshToken = randomToken(32);
    const validExpiresAt = addMsIso(30 * 24 * 60 * 60 * 1000);
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(validSessionId, userId, hashTokenHmac(validRefreshToken), validExpiresAt);
    
    closeDatabase();
    
    // Verify expiry logic after reload
    await initDb();
    const db2 = getDatabase();
    
    const expiredSession = db2.prepare('SELECT * FROM sessions WHERE id = ?').get(expiredSessionId);
    expect(new Date(expiredSession.expires_at) < new Date()).toBe(true);
    
    const validSession = db2.prepare('SELECT * FROM sessions WHERE id = ?').get(validSessionId);
    expect(new Date(validSession.expires_at) > new Date()).toBe(true);
    
    closeDatabase();
  });

  test('REGRESSION: user role change persists and affects entitlement', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    
    // Create FREE_ACCOUNT user
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'role-change@example.com', 'FREE_ACCOUNT', 'ACTIVE', '[]', nowIso);
    
    // Create NONE subscription
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'free', 'NONE', nowIso, nowIso);
    
    closeDatabase();
    
    // Verify no entitlement
    await initDb();
    let db2 = getDatabase();
    
    let userContext = db2.prepare(
      'SELECT u.*, s.status AS subscription_status FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE u.id = ?'
    ).get(userId);
    
    expect(hasEntitlement(userContext, RESOURCE.CHEDDAR_BOARD)).toBe(false);
    
    // Upgrade to ADMIN
    db2.prepare('UPDATE users SET role = ? WHERE id = ?').run('ADMIN', userId);
    
    closeDatabase();
    
    // Verify entitlement after upgrade persists
    await initDb();
    const db3 = getDatabase();
    
    userContext = db3.prepare(
      'SELECT u.*, s.status AS subscription_status FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE u.id = ?'
    ).get(userId);
    
    expect(userContext.role).toBe('ADMIN');
    expect(hasEntitlement(userContext, RESOURCE.CHEDDAR_BOARD)).toBe(true);
    
    closeDatabase();
  });

  test('REGRESSION: large batch of users persists correctly', async () => {
    await initDb();
    const db = getDatabase();
    
    const testPrefix = `batch-${Date.now()}`;
    
    // Add 50 users with unique prefix
    for (let i = 0; i < 50; i++) {
      const userId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      
      db.prepare(
        'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, `${testPrefix}-${i}@example.com`, 'FREE_ACCOUNT', 'ACTIVE', '[]', nowIso);
    }
    
    closeDatabase();
    
    // Verify users persisted after reload
    await initDb();
    const db2 = getDatabase();
    
    const count = db2.prepare(`SELECT COUNT(*) as count FROM users WHERE email LIKE ?`).get(`${testPrefix}%`);
    expect(count.count).toBe(50);
    
    // Verify we can query specific users
    const firstUser = db2.prepare('SELECT * FROM users WHERE email = ?').get(`${testPrefix}-0@example.com`);
    expect(firstUser).toBeTruthy();
    expect(firstUser.role).toBe('FREE_ACCOUNT');
    
    const lastUser = db2.prepare('SELECT * FROM users WHERE email = ?').get(`${testPrefix}-49@example.com`);
    expect(lastUser).toBeTruthy();
    
    closeDatabase();
  });
});
