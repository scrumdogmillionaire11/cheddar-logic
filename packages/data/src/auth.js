'use strict';

const crypto = require('crypto');

const USER_ROLE = {
  FREE_ACCOUNT: 'FREE_ACCOUNT',
  PAID: 'PAID',
  ADMIN: 'ADMIN'
};

const USER_STATUS = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED'
};

const SUBSCRIPTION_STATUS = {
  NONE: 'NONE',
  TRIAL: 'TRIAL',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED'
};

const RESOURCE = {
  CHEDDAR_BOARD: 'CHEDDAR_BOARD',
  FPL_SAGE: 'FPL_SAGE',
  ADMIN_PANEL: 'ADMIN_PANEL'
};

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.CHEDDAR_AUTH_SECRET || 'dev-auth-secret-change-me';
}

function hashTokenHmac(token, secret = getAuthSecret()) {
  return crypto.createHmac('sha256', secret).update(String(token)).digest('hex');
}

function timingSafeEqualHex(leftHex, rightHex) {
  if (!leftHex || !rightHex) return false;
  const left = Buffer.from(String(leftHex), 'hex');
  const right = Buffer.from(String(rightHex), 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function addMsIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function parseFlags(flags) {
  if (Array.isArray(flags)) return flags;
  if (!flags) return [];
  try {
    const parsed = JSON.parse(flags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasEntitlement(userContext, resource, now = new Date()) {
  if (!userContext) return false;

  const role = userContext.role || USER_ROLE.FREE_ACCOUNT;
  const userStatus = userContext.user_status || USER_STATUS.ACTIVE;
  const flags = parseFlags(userContext.flags);
  const subscriptionStatus = userContext.subscription_status || SUBSCRIPTION_STATUS.NONE;
  const trialEndsAt = toDate(userContext.trial_ends_at);
  const currentPeriodEnd = toDate(userContext.current_period_end);
  const ambassadorExpiresAt = toDate(userContext.ambassador_expires_at);

  if (userStatus === USER_STATUS.SUSPENDED) return false;
  if (role === USER_ROLE.ADMIN) return true;
  if (resource === RESOURCE.ADMIN_PANEL) return false;

  if (flags.includes('COMPED')) {
    return resource === RESOURCE.CHEDDAR_BOARD || resource === RESOURCE.FPL_SAGE;
  }

  if (flags.includes('AMBASSADOR')) {
    if (!ambassadorExpiresAt || now < ambassadorExpiresAt) {
      return resource === RESOURCE.CHEDDAR_BOARD || resource === RESOURCE.FPL_SAGE;
    }
  }

  if (role === USER_ROLE.PAID && (subscriptionStatus === SUBSCRIPTION_STATUS.TRIAL || subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE)) {
    if (subscriptionStatus === SUBSCRIPTION_STATUS.TRIAL) {
      return Boolean(trialEndsAt && now < trialEndsAt);
    }
    if (subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE) {
      return Boolean(currentPeriodEnd && now < currentPeriodEnd);
    }
  }

  return false;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payloadObject, secret = getAuthSecret()) {
  const payloadJson = JSON.stringify(payloadObject);
  const encodedPayload = toBase64Url(payloadJson);
  const signature = hashTokenHmac(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function verifySignedPayload(token, secret = getAuthSecret()) {
  if (!token || typeof token !== 'string') return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expected = hashTokenHmac(encodedPayload, secret);
  if (!timingSafeEqualHex(expected, signature)) return null;

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload.exp || Date.now() >= Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function createAccessToken({ userId, role, flags, sessionId }, ttlMs = 15 * 60 * 1000) {
  return signPayload({
    sub: userId,
    role: role || USER_ROLE.FREE_ACCOUNT,
    flags: Array.isArray(flags) ? flags : parseFlags(flags),
    sid: sessionId,
    exp: Date.now() + ttlMs
  });
}

module.exports = {
  USER_ROLE,
  USER_STATUS,
  SUBSCRIPTION_STATUS,
  RESOURCE,
  normalizeEmail,
  hashTokenHmac,
  timingSafeEqualHex,
  randomToken,
  addMsIso,
  parseFlags,
  hasEntitlement,
  createAccessToken,
  verifySignedPayload
};
