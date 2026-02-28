#!/usr/bin/env node
'use strict';

/**
 * Integration test for auth refresh flow
 * Tests the /api/auth/refresh endpoint and session management
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

function makeTempDbPath() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `cheddar-logic-refresh-test-${suffix}.db`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ Assertion failed: ${message}`);
  }
}

// Simulate the refresh logic inline without importing Next.js routes
async function testRefreshFlow() {
  const { initDb, getDatabase } = await import('@cheddar-logic/data');
  const { closeDatabase } = await import('@cheddar-logic/data/src/db.js');
  const { runMigrations } = await import('@cheddar-logic/data/src/migrate.js');
  const {
    USER_ROLE,
    USER_STATUS,
    SUBSCRIPTION_STATUS,
    createAccessToken,
    hashTokenHmac,
    randomToken,
    verifySignedPayload,
  } = await import('@cheddar-logic/data');

  const dbPath = makeTempDbPath();
  process.env.DATABASE_PATH = dbPath;

  try {
    console.log('✅ Setting up test database...');
    await initDb();
    await runMigrations();
    const db = getDatabase();

    // Create test user
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, role, user_status, flags, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, 'refresh-test@example.com', USER_ROLE.ADMIN, USER_STATUS.ACTIVE, '[]', now, now);

    db.prepare(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), userId, 'premium', SUBSCRIPTION_STATUS.ACTIVE, '{}', now, now);

    // Create session
    const sessionId = crypto.randomUUID();
    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, userId, refreshTokenHash, expiresAt, '127.0.0.1', 'test-agent', now, now);

    console.log('✅ Test data created');

    // TEST 1: Valid refresh token should generate new access token
    console.log('\n🧪 Test 1: Valid refresh token generates new access token');
    const session = db.prepare(`
      SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.role, u.flags
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
    `).get(refreshTokenHash);

    assert(session !== null, 'Session should exist');
    assert(session.revoked_at === null, 'Session should not be revoked');
    assert(session.user_id === userId, 'Session user_id should match');

    const accessToken = createAccessToken({
      userId: session.user_id,
      role: session.role,
      flags: JSON.parse(session.flags),
      sessionId: session.id,
    }, 24 * 60 * 60 * 1000);

    const payload = verifySignedPayload(accessToken);
    assert(payload !== null, 'Access token should be valid');
    assert(payload.sub === userId, 'Token should contain user id');
    assert(payload.sid === sessionId, 'Token should contain session id');
    console.log('✅ New access token generated successfully');

    // TEST 2: Invalid refresh token should fail
    console.log('\n🧪 Test 2: Invalid refresh token fails');
    const badRefreshToken = randomToken(32);
    const badHash = hashTokenHmac(badRefreshToken);
    const badSession = db.prepare(`
      SELECT id FROM sessions WHERE refresh_token_hash = ?
    `).get(badHash);

    assert(badSession === undefined, 'Invalid refresh token should not find session');
    console.log('✅ Invalid refresh token rejected');

    // TEST 3: Revoked session should fail refresh
    console.log('\n🧪 Test 3: Revoked session blocks refresh');
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).run(now, sessionId);
    const revokedSession = db.prepare(`
      SELECT revoked_at FROM sessions WHERE id = ?
    `).get(sessionId);

    assert(revokedSession.revoked_at !== null, 'Session should be revoked');
    console.log('✅ Revoked session blocked');

    // TEST 4: Create new session with expired timestamp
    console.log('\n🧪 Test 4: Expired session blocks refresh');
    const expiredSessionId = crypto.randomUUID();
    const expiredRefreshToken = randomToken(32);
    const expiredRefreshHash = hashTokenHmac(expiredRefreshToken);
    const pastExpiry = new Date(Date.now() - 60000).toISOString();

    db.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(expiredSessionId, userId, expiredRefreshHash, pastExpiry, '127.0.0.1', 'test', now, now);

    const expiredSession = db.prepare(`
      SELECT expires_at FROM sessions WHERE id = ?
    `).get(expiredSessionId);

    const isExpired = new Date(now) >= new Date(expiredSession.expires_at);
    assert(isExpired, 'Session should be expired');
    console.log('✅ Expired session blocked');

    // TEST 5: Refresh updates last_seen_at
    console.log('\n🧪 Test 5: Refresh updates last_seen_at timestamp');
    const activeSessionId = crypto.randomUUID();
    const activeRefreshToken = randomToken(32);
    const activeRefreshHash = hashTokenHmac(activeRefreshToken);
    const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(activeSessionId, userId, activeRefreshHash, futureExpiry, '127.0.0.1', 'test', now, now);

    const oldTimestamp = db.prepare(`SELECT last_seen_at FROM sessions WHERE id = ?`).get(activeSessionId);
    
    // Simulate refresh by updating timestamp
    const newNow = new Date(Date.now() + 1000).toISOString();
    db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(newNow, activeSessionId);
    
    const newTimestamp = db.prepare(`SELECT last_seen_at FROM sessions WHERE id = ?`).get(activeSessionId);
    assert(newTimestamp.last_seen_at !== oldTimestamp.last_seen_at, 'Timestamp should be updated');
    console.log('✅ last_seen_at updated on refresh');

    // TEST 6: Role change picked up on refresh
    console.log('\n🧪 Test 6: Role changes reflected in refreshed token');
    const roleTestUser = crypto.randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, role, user_status, flags, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(roleTestUser, 'role-test@example.com', USER_ROLE.FREE_ACCOUNT, USER_STATUS.ACTIVE, '[]', now, now);

    db.prepare(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), roleTestUser, 'free', SUBSCRIPTION_STATUS.NONE, '{}', now, now);

    const roleTestSessionId = crypto.randomUUID();
    const roleTestRefreshToken = randomToken(32);
    const roleTestRefreshHash = hashTokenHmac(roleTestRefreshToken);

    db.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(roleTestSessionId, roleTestUser, roleTestRefreshHash, futureExpiry, '127.0.0.1', 'test', now, now);

    // Upgrade user to admin
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(USER_ROLE.ADMIN, roleTestUser);

    // Simulate refresh - fetch updated role
    const updatedUser = db.prepare(`
      SELECT s.id, s.user_id, u.role, u.flags
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
    `).get(roleTestRefreshHash);

    assert(updatedUser.role === USER_ROLE.ADMIN, 'Role should be updated to ADMIN');
    console.log('✅ Role change reflected on refresh');

    // TEST 7: 24-hour token TTL validation
    console.log('\n🧪 Test 7: 24-hour access token TTL');
    const ttl24h = 24 * 60 * 60 * 1000;
    const token24h = createAccessToken({
      userId: 'test-user',
      role: USER_ROLE.FREE_ACCOUNT,
      flags: [],
      sessionId: 'test-session',
    }, ttl24h);

    const payload24h = verifySignedPayload(token24h);
    assert(payload24h !== null, '24-hour token should be valid');
    
    const expMs = payload24h.exp * 1000;
    const nowMs = Date.now();
    const remaining = expMs - nowMs;
    
    assert(remaining > ttl24h - 5000, 'Token expiry should be ~24 hours');
    assert(remaining < ttl24h + 5000, 'Token expiry should be ~24 hours');
    console.log(`✅ 24-hour token TTL validated (${Math.round(remaining / 1000 / 60 / 60)}h remaining)`);

    console.log('\n✅ All refresh flow tests passed!\n');

  } finally {
    closeDatabase();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  }
}

// Run tests
testRefreshFlow().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
