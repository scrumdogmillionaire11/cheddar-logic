'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { initDb, getDatabase, closeDatabase } = require('../src/db');
const { runMigrations } = require('../src/migrate');
const { ensureCompedUser } = require('../src/comped-users');

function makeTempDbPath() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `cheddar-logic-comped-${suffix}.db`);
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

describe('ensureCompedUser', () => {
  test('creates user with COMPED flag and subscription', async () => {
    const { db, dbPath } = await setupDb();

    const result = ensureCompedUser(db, {
      email: 'User@Example.com',
      flag: 'COMPED',
      now: '2026-02-28T00:00:00.000Z',
    });

    const user = db.prepare('SELECT email, flags, role, user_status FROM users WHERE id = ?').get(result.userId);
    const subscription = db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(result.userId);

    expect(result.createdUser).toBe(true);
    expect(result.createdSubscription).toBe(true);
    expect(user.email).toBe('user@example.com');
    expect(JSON.parse(user.flags)).toEqual(['COMPED']);
    expect(user.role).toBe('FREE_ACCOUNT');
    expect(user.user_status).toBe('ACTIVE');
    expect(subscription.status).toBe('NONE');

    cleanupDb(dbPath);
  });

  test('adds AMBASSADOR flag to existing user without duplicating subscription', async () => {
    const { db, dbPath } = await setupDb();

    const userId = 'user-existing-1';
    db.prepare(
      `INSERT INTO users (id, email, role, user_status, flags, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      'ambassador@example.com',
      'PAID',
      'ACTIVE',
      '[]',
      '2026-02-27T00:00:00.000Z'
    );

    db.prepare(
      `INSERT INTO subscriptions
        (id, user_id, plan_id, status, metadata, created_at, updated_at)
       VALUES (?, ?, 'free', 'NONE', '{}', ?, ?)`
    ).run('sub-1', userId, '2026-02-27T00:00:00.000Z', '2026-02-27T00:00:00.000Z');

    const result = ensureCompedUser(db, {
      email: 'ambassador@example.com',
      flag: 'AMBASSADOR',
    });

    const user = db.prepare('SELECT flags, role FROM users WHERE id = ?').get(userId);
    const subscriptionCount = db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ?').get(userId);

    expect(result.createdUser).toBe(false);
    expect(result.createdSubscription).toBe(false);
    expect(JSON.parse(user.flags)).toEqual(['AMBASSADOR']);
    expect(user.role).toBe('PAID');
    expect(subscriptionCount.count).toBe(1);

    cleanupDb(dbPath);
  });
});
