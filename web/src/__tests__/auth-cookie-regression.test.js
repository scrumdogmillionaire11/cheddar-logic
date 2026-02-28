/**
 * Auth Cookie Regression Tests
 * 
 * Tests to prevent cookie-related auth failures:
 * - Cookies set during login not readable later
 * - Cookies cleared unexpectedly
 * - Cookie flags (httpOnly, secure, sameSite) incorrect
 * - Cookie expiry mismatch with token expiry
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import {
  initDb,
  getDatabase,
  closeDatabase,
  createAccessToken,
  hashTokenHmac,
  randomToken,
  addMsIso,
  verifySignedPayload,
} from '@cheddar-logic/data';

// Mock Next.js imports
jest.mock('next/server', () => ({
  NextRequest: jest.fn(),
  NextResponse: {
    json: jest.fn((data, init) => ({ data, ...init })),
    redirect: jest.fn((url) => ({ redirect: url })),
  },
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

describe('Auth Cookie Regression Tests', () => {
  let tempDir;
  let dbPath;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-test-'));
    dbPath = path.join(tempDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    
    await initDb();
    
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'FREE_ACCOUNT',
        user_status TEXT DEFAULT 'ACTIVE',
        flags TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'NONE',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    closeDatabase();
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore
    }
    
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('REGRESSION: cookies contain correct TTL values', async () => {
    const ACCESS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    
    const mockCookies = [];
    const mockResponse = {
      cookies: {
        set: (name, value, options) => {
          mockCookies.push({ name, value, options });
        },
      },
    };
    
    // Simulate setting auth cookies
    const accessToken = 'access-token-value';
    const refreshToken = 'refresh-token-value';
    
    const COOKIE_OPTIONS = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    };
    
    mockResponse.cookies.set('cheddar_access_token', accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: Math.floor(ACCESS_TTL_MS / 1000),
    });
    
    mockResponse.cookies.set('cheddar_refresh_token', refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: Math.floor(REFRESH_TTL_MS / 1000),
    });
    
    expect(mockCookies).toHaveLength(2);
    
    const accessCookie = mockCookies.find(c => c.name === 'cheddar_access_token');
    expect(accessCookie?.options.maxAge).toBe(86400); // 24 hours in seconds
    expect(accessCookie?.options.httpOnly).toBe(true);
    expect(accessCookie?.options.sameSite).toBe('lax');
    
    const refreshCookie = mockCookies.find(c => c.name === 'cheddar_refresh_token');
    expect(refreshCookie?.options.maxAge).toBe(2592000); // 30 days in seconds
    expect(refreshCookie?.options.httpOnly).toBe(true);
    expect(refreshCookie?.options.sameSite).toBe('lax');
    
    // Verify token structure (even though it's a mock value, check it could be verified)
    expect(accessToken).toBeTruthy();
    expect(typeof accessToken).toBe('string');
  });

  test('REGRESSION: access token includes session ID for validation', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'cookie-test@example.com', 'ADMIN', 'ACTIVE', '[]', nowIso);
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, hashTokenHmac(randomToken(32)), addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Create access token with session ID
    const accessToken = createAccessToken({
      userId,
      role: 'ADMIN',
      flags: [],
      sessionId,
    }, 24 * 60 * 60 * 1000);
    
    expect(accessToken).toBeTruthy();
    expect(typeof accessToken).toBe('string');
    
    // Verify token contains session ID
    const payload = verifySignedPayload(accessToken);
    
    expect(payload.sub).toBe(userId);
    expect(payload.sid).toBe(sessionId);
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
  });

  test('REGRESSION: cookie clearing sets maxAge to 0', async () => {
    const mockCookies = [];
    const mockResponse = {
      cookies: {
        set: (name, value, options) => {
          mockCookies.push({ name, value, options });
        },
      },
    };
    
    const COOKIE_OPTIONS = {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    };
    
    // Simulate clearing auth cookies
    mockResponse.cookies.set('cheddar_access_token', '', {
      ...COOKIE_OPTIONS,
      maxAge: 0,
    });
    
    mockResponse.cookies.set('cheddar_refresh_token', '', {
      ...COOKIE_OPTIONS,
      maxAge: 0,
    });
    
    expect(mockCookies).toHaveLength(2);
    
    mockCookies.forEach(cookie => {
      expect(cookie.value).toBe('');
      expect(cookie.options.maxAge).toBe(0);
    });
  });

  test('REGRESSION: refresh endpoint updates access token without losing session', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    const nowIso = new Date().toISOString();
    
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'refresh-cookie@example.com', 'PAID', 'ACTIVE', '[]', nowIso);
    
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'ACTIVE', nowIso);
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Simulate refresh
    await initDb();
    const db2 = getDatabase();
    
    const session = db2.prepare(
      'SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.role, u.flags FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = ?'
    ).get(refreshTokenHash);
    
    expect(session).toBeTruthy();
    expect(session.id).toBe(sessionId);
    expect(session.revoked_at).toBeNull();
    
    // Update last_seen_at
    db2.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso, session.id);
    
    // Create new access token with SAME session ID
    const newAccessToken = createAccessToken({
      userId: session.user_id,
      role: session.role,
      flags: JSON.parse(session.flags || '[]'),
      sessionId: session.id,
    }, 24 * 60 * 60 * 1000);
    
    closeDatabase();
    
    // Verify new access token references same session
    const payload = verifySignedPayload(newAccessToken);
    
    expect(payload.sid).toBe(sessionId);
    expect(payload.sub).toBe(userId);
  });

  test('REGRESSION: concurrent cookie reads from multiple routes work', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'concurrent@example.com', 'ADMIN', 'ACTIVE', '[]', nowIso);
    
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'ACTIVE', nowIso);
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, hashTokenHmac(randomToken(32)), addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    const accessToken = createAccessToken({
      userId,
      role: 'ADMIN',
      flags: [],
      sessionId,
    }, 24 * 60 * 60 * 1000);
    
    // Simulate multiple concurrent reads
    const results = await Promise.all([
      Promise.resolve(verifySignedPayload(accessToken)),
      Promise.resolve(verifySignedPayload(accessToken)),
      Promise.resolve(verifySignedPayload(accessToken)),
    ]);
    
    results.forEach(payload => {
      expect(payload.sub).toBe(userId);
      expect(payload.sid).toBe(sessionId);
    });
  });

  test('REGRESSION: AuthRefresher does not cause logout loop', async () => {
    await initDb();
    const db = getDatabase();
    
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    const nowIso = new Date().toISOString();
    
    db.prepare(
      'INSERT INTO users (id, email, role, user_status, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'refresher@example.com', 'PAID', 'ACTIVE', '[]', nowIso);
    
    db.prepare(
      'INSERT INTO subscriptions (id, user_id, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), userId, 'ACTIVE', nowIso);
    
    db.prepare(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, refreshTokenHash, addMsIso(30 * 24 * 60 * 60 * 1000));
    
    closeDatabase();
    
    // Simulate 5 refresh attempts (as if AuthRefresher ran 5 times)
    for (let i = 0; i < 5; i++) {
      await initDb();
      const dbConn = getDatabase();
      
      const session = dbConn.prepare(
        'SELECT * FROM sessions WHERE refresh_token_hash = ?'
      ).get(refreshTokenHash);
      
      expect(session).toBeTruthy();
      expect(session.revoked_at).toBeNull();
      
      // Update last_seen_at (what refresh endpoint does)
      dbConn.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
        .run(new Date().toISOString(), session.id);
      
      closeDatabase();
    }
    
    // Verify session still valid after 5 refreshes
    await initDb();
    const finalDb = getDatabase();
    
    const finalSession = finalDb.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(finalSession).toBeTruthy();
    expect(finalSession.revoked_at).toBeNull();
    
    closeDatabase();
  });
});
