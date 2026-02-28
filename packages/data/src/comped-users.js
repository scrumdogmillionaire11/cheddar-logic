'use strict';

const crypto = require('crypto');
const { normalizeEmail, parseFlags, USER_ROLE, USER_STATUS } = require('./auth');

const ALLOWED_FLAGS = new Set(['COMPED', 'AMBASSADOR']);

function makeId() {
  return crypto.randomBytes(16).toString('hex');
}

function normalizeFlag(flag) {
  const normalized = String(flag || '').trim().toUpperCase();
  if (!ALLOWED_FLAGS.has(normalized)) {
    throw new Error(`Invalid flag "${flag}". Use COMPED or AMBASSADOR.`);
  }
  return normalized;
}

function ensureCompedUser(db, { email, flag = 'COMPED', now } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Email is required.');
  }

  const normalizedFlag = normalizeFlag(flag);
  const nowIso = now || new Date().toISOString();

  const existingUser = db.prepare(
    'SELECT id, flags, role, user_status FROM users WHERE email = ?'
  ).get(normalizedEmail);

  let userId = existingUser ? existingUser.id : null;
  let createdUser = false;
  let updatedFlags = false;

  if (!existingUser) {
    userId = makeId();
    db.prepare(
      `INSERT INTO users (id, email, role, user_status, flags, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      normalizedEmail,
      USER_ROLE.FREE_ACCOUNT,
      USER_STATUS.ACTIVE,
      JSON.stringify([normalizedFlag]),
      nowIso
    );
    createdUser = true;
    updatedFlags = true;
  } else {
    const flags = parseFlags(existingUser.flags);
    if (!flags.includes(normalizedFlag)) {
      flags.push(normalizedFlag);
      db.prepare('UPDATE users SET flags = ? WHERE id = ?').run(
        JSON.stringify(flags),
        userId
      );
      updatedFlags = true;
    }
  }

  const existingSubscription = db.prepare(
    'SELECT id FROM subscriptions WHERE user_id = ?'
  ).get(userId);

  let createdSubscription = false;

  if (!existingSubscription) {
    db.prepare(
      `INSERT INTO subscriptions
        (id, user_id, plan_id, status, metadata, created_at, updated_at)
       VALUES (?, ?, 'free', 'NONE', '{}', ?, ?)`
    ).run(makeId(), userId, nowIso, nowIso);
    createdSubscription = true;
  }

  return {
    email: normalizedEmail,
    userId,
    flag: normalizedFlag,
    createdUser,
    updatedFlags,
    createdSubscription,
  };
}

module.exports = {
  ensureCompedUser,
  normalizeFlag,
  ALLOWED_FLAGS,
};
