import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import {
  addMsIso,
  hasEntitlement,
  createAccessToken,
  getDatabase,
  hashTokenHmac,
  normalizeEmail,
  parseFlags,
  randomToken,
  timingSafeEqualHex,
  verifySignedPayload,
} from '@cheddar-logic/data';

export const ACCESS_COOKIE_NAME = 'cheddar_access_token';
export const REFRESH_COOKIE_NAME = 'cheddar_refresh_token';

const MAGIC_LINK_TTL_MS = Number(process.env.AUTH_MAGIC_LINK_TTL_MS || 15 * 60 * 1000);
const ACCESS_TTL_MS = Number(process.env.AUTH_ACCESS_TTL_MS || 24 * 60 * 60 * 1000);
const REFRESH_TTL_MS = Number(process.env.AUTH_REFRESH_TTL_MS || 30 * 24 * 60 * 60 * 1000);

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

type TokenPayload = {
  sub?: string;
  sid?: string;
};

export type AuthenticatedUserContext = {
  id: string;
  email: string;
  role: string;
  user_status: string;
  flags: string;
  ambassador_expires_at: string | null;
  subscription_status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

/**
 * DEV ONLY: Creates a bypass user for easier local development
 * Set DEV_BYPASS_AUTH_EMAIL env var to enable
 */
function getDevBypassUser(): AuthenticatedUserContext | null {
  if (process.env.NODE_ENV === 'production') return null;
  
  const bypassEmail = process.env.DEV_BYPASS_AUTH_EMAIL;
  if (!bypassEmail) return null;

  return {
    id: 'dev-bypass-user',
    email: bypassEmail,
    role: 'ADMIN',
    user_status: 'ACTIVE',
    flags: '[]',
    ambassador_expires_at: null,
    subscription_status: 'ACTIVE',
    trial_ends_at: null,
    current_period_end: null,
  };
}

export function getUserContextFromAccessToken(
  accessToken: string | null | undefined,
): AuthenticatedUserContext | null {
  // DEV ONLY: Bypass auth if configured
  const devUser = getDevBypassUser();
  if (devUser) return devUser;

  if (!accessToken) return null;

  const payload = verifySignedPayload(accessToken) as TokenPayload | null;
  if (!payload?.sub || !payload?.sid) return null;

  const db = getDatabase();
  const nowIso = new Date().toISOString();

  const session = db
    .prepare(`
      SELECT id, revoked_at, expires_at
      FROM sessions
      WHERE id = ? AND user_id = ?
    `)
    .get(payload.sid, payload.sub) as
    | {
        id: string;
        revoked_at: string | null;
        expires_at: string;
      }
    | null;

  if (!session || session.revoked_at) {
    return null;
  }

  if (new Date(nowIso) >= new Date(session.expires_at)) {
    return null;
  }

  const userContext = db
    .prepare(
      `SELECT
        u.id,
        u.email,
        u.role,
        u.user_status,
        u.flags,
        u.ambassador_expires_at,
        s.status AS subscription_status,
        s.trial_ends_at,
        s.current_period_end
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = ?`
    )
    .get(payload.sub) as AuthenticatedUserContext | null;

  if (!userContext) return null;

  return {
    ...userContext,
    subscription_status: userContext.subscription_status || 'NONE',
  };
}

export function getAccessTokenAuthResult(
  accessToken: string | null | undefined,
  resource: string,
) {
  const user = getUserContextFromAccessToken(accessToken);
  const isAuthenticated = Boolean(user);
  const isEntitled = Boolean(user && hasEntitlement(user, resource));

  return {
    user,
    isAuthenticated,
    isEntitled,
  };
}

export function requireEntitlementForRequest(request: NextRequest, resource: string) {
  const accessToken = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
  const auth = getAccessTokenAuthResult(accessToken, resource);

  if (!auth.isAuthenticated) {
    return {
      ok: false,
      status: 401,
      error: 'Authentication required',
      auth,
    };
  }

  if (!auth.isEntitled) {
    return {
      ok: false,
      status: 403,
      error: 'Entitlement required',
      auth,
    };
  }

  return {
    ok: true,
    status: 200,
    auth,
  };
}

function getIpAddress(request: NextRequest) {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || null;
  }
  return request.headers.get('x-real-ip') || null;
}

export function sanitizeNextPath(nextParam: string | null | undefined) {
  if (!nextParam) return '/cards';
  if (!nextParam.startsWith('/')) return '/cards';
  if (nextParam.startsWith('//')) return '/cards';
  return nextParam;
}

export function setAuthCookies(response: NextResponse, accessToken: string, refreshToken: string) {
  response.cookies.set(ACCESS_COOKIE_NAME, accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: Math.floor(ACCESS_TTL_MS / 1000),
  });

  response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, {
    ...COOKIE_OPTIONS,
    maxAge: Math.floor(REFRESH_TTL_MS / 1000),
  });
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE_NAME, '', {
    ...COOKIE_OPTIONS,
    maxAge: 0,
  });
  response.cookies.set(REFRESH_COOKIE_NAME, '', {
    ...COOKIE_OPTIONS,
    maxAge: 0,
  });
}

export function createMagicLinkRecord(request: NextRequest, emailInput: string, nextPathInput?: string | null) {
  const db = getDatabase();
  const email = normalizeEmail(emailInput);
  const nextPath = sanitizeNextPath(nextPathInput);
  const id = crypto.randomUUID();
  const code = randomToken(32);
  const tokenHash = hashTokenHmac(code);
  const expiresAt = addMsIso(MAGIC_LINK_TTL_MS);
  const ipAddress = getIpAddress(request);
  const userAgent = request.headers.get('user-agent');

  db.prepare(
    `INSERT INTO auth_magic_links (id, email, token_hash, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email, tokenHash, expiresAt, ipAddress, userAgent);

  const baseUrl = process.env.NEXT_PUBLIC_PUBLIC_DOMAIN || request.nextUrl.origin;
  const url = new URL('/auth/verify', baseUrl);
  url.searchParams.set('token', id);
  url.searchParams.set('code', code);
  url.searchParams.set('next', nextPath);

  return {
    id,
    email,
    nextPath,
    expiresAt,
    magicLink: url.toString(),
  };
}

export function consumeMagicLinkAndCreateSession(
  request: NextRequest,
  tokenId: string,
  code: string,
) {
  const db = getDatabase();
  const nowIso = new Date().toISOString();

  const record = db
    .prepare(`SELECT id, email, token_hash, expires_at, used_at FROM auth_magic_links WHERE id = ?`)
    .get(tokenId) as
    | {
        id: string;
        email: string;
        token_hash: string;
        expires_at: string;
        used_at: string | null;
      }
    | null;

  if (!record) {
    throw new Error('Invalid link');
  }

  if (new Date(nowIso) > new Date(record.expires_at)) {
    throw new Error('Link expired');
  }

  const providedHash = hashTokenHmac(code);
  if (!timingSafeEqualHex(record.token_hash, providedHash)) {
    throw new Error('Invalid link');
  }

  // If link was already used, check if it was recent and a session exists
  // This handles browser prefetch, double-clicks, etc.
  if (record.used_at) {
    const usedAt = new Date(record.used_at);
    const now = new Date(nowIso);
    const secondsSinceUse = (now.getTime() - usedAt.getTime()) / 1000;
    
    // If link was used in the last 60 seconds, check for valid session
    if (secondsSinceUse < 60) {
      const existingUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(record.email) as
        | { id: string }
        | null;
      
      if (existingUser) {
        // Check for a recent valid session
        const recentSession = db
          .prepare(
            `SELECT id, refresh_token_hash, expires_at 
             FROM sessions 
             WHERE user_id = ? 
               AND revoked_at IS NULL 
               AND expires_at > ?
             ORDER BY created_at DESC 
             LIMIT 1`
          )
          .get(existingUser.id, nowIso) as
          | { id: string; refresh_token_hash: string; expires_at: string }
          | null;
        
        if (recentSession) {
          console.log('[Auth] Link already used but valid session exists (idempotent behavior)');
          
          // Create new tokens for this request (we don't have the old refresh token)
          const refreshToken = randomToken(32);
          const refreshTokenHash = hashTokenHmac(refreshToken);
          const sessionId = crypto.randomUUID();

          db.prepare(
            `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            sessionId,
            existingUser.id,
            refreshTokenHash,
            addMsIso(REFRESH_TTL_MS),
            getIpAddress(request),
            request.headers.get('user-agent')
          );

          const userContext = db
            .prepare(
              `SELECT
                u.id,
                u.email,
                u.role,
                u.user_status,
                u.flags,
                u.ambassador_expires_at,
                s.status AS subscription_status,
                s.trial_ends_at,
                s.current_period_end
               FROM users u
               LEFT JOIN subscriptions s ON s.user_id = u.id
               WHERE u.id = ?`
            )
            .get(existingUser.id) as {
            id: string;
            email: string;
            role: string;
            user_status: string;
            flags: string;
            ambassador_expires_at: string | null;
            subscription_status: string | null;
            trial_ends_at: string | null;
            current_period_end: string | null;
          };

          const accessToken = createAccessToken({
            userId: userContext.id,
            role: userContext.role,
            flags: parseFlags(userContext.flags),
            sessionId,
          }, ACCESS_TTL_MS);

          return {
            user: userContext,
            sessionId,
            accessToken,
            refreshToken,
          };
        }
      }
    }
    
    // Link was used too long ago or no valid session - reject
    throw new Error('Link expired or already used');
  }

  try {
    db.exec('BEGIN TRANSACTION');

    db
      .prepare(
        `UPDATE auth_magic_links
         SET used_at = ?
         WHERE id = ? AND used_at IS NULL AND expires_at >= ?`
      )
      .run(nowIso, tokenId, nowIso);

    const verification = db
      .prepare(`SELECT used_at FROM auth_magic_links WHERE id = ?`)
      .get(tokenId) as { used_at: string | null } | null;

    if (!verification || !verification.used_at) {
      throw new Error('Link expired or already used');
    }

    const existingUser = db.prepare(`SELECT * FROM users WHERE email = ?`).get(record.email) as
      | {
          id: string;
          role: string;
          flags: string;
          user_status: string;
          ambassador_expires_at: string | null;
        }
      | null;

    let userId = existingUser?.id;
    if (!userId) {
      userId = crypto.randomUUID();
      
      // DEV: Grant COMPED access automatically in development for easier testing
      const devFlags = process.env.NODE_ENV === 'production' ? '[]' : '["COMPED"]';
      
      db.prepare(
        `INSERT INTO users (id, email, role, user_status, flags, created_at, last_login_at)
         VALUES (?, ?, 'FREE_ACCOUNT', 'ACTIVE', ?, ?, ?)`
      ).run(userId, record.email, devFlags, nowIso, nowIso);
    } else {
      db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowIso, userId);
    }

    const existingSubscription = db
      .prepare(`SELECT id FROM subscriptions WHERE user_id = ?`)
      .get(userId) as { id: string } | null;

    if (!existingSubscription) {
      db.prepare(
        `INSERT INTO subscriptions (id, user_id, plan_id, status, metadata, created_at, updated_at)
         VALUES (?, ?, 'free', 'NONE', '{}', ?, ?)`
      ).run(crypto.randomUUID(), userId, nowIso, nowIso);
    }

    const refreshToken = randomToken(32);
    const refreshTokenHash = hashTokenHmac(refreshToken);
    const sessionId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      userId,
      refreshTokenHash,
      addMsIso(REFRESH_TTL_MS),
      getIpAddress(request),
      request.headers.get('user-agent')
    );

    const userContext = db
      .prepare(
        `SELECT
          u.id,
          u.email,
          u.role,
          u.user_status,
          u.flags,
          u.ambassador_expires_at,
          s.status AS subscription_status,
          s.trial_ends_at,
          s.current_period_end
         FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
         WHERE u.id = ?`
      )
      .get(userId) as {
      id: string;
      email: string;
      role: string;
      user_status: string;
      flags: string;
      ambassador_expires_at: string | null;
      subscription_status: string | null;
      trial_ends_at: string | null;
      current_period_end: string | null;
    };

    const accessToken = createAccessToken({
      userId: userContext.id,
      role: userContext.role,
      flags: parseFlags(userContext.flags),
      sessionId,
    }, ACCESS_TTL_MS);

    try {
      db.exec('COMMIT');
    } catch (commitError) {
      if (!String(commitError).includes('no transaction is active')) {
        throw commitError;
      }
    }

    return {
      user: userContext,
      sessionId,
      accessToken,
      refreshToken,
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      if (!String(rollbackError).includes('no transaction is active')) {
        // no-op
      }
    }
    throw error;
  }
}

export function refreshAccessTokenFromRefreshToken(refreshToken: string) {
  const db = getDatabase();
  const refreshTokenHash = hashTokenHmac(refreshToken);
  const nowIso = new Date().toISOString();

  const session = db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at,
              u.role, u.flags
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = ?`
    )
    .get(refreshTokenHash) as
    | {
        id: string;
        user_id: string;
        expires_at: string;
        revoked_at: string | null;
        role: string;
        flags: string;
      }
    | null;

  if (!session || session.revoked_at) {
    return null;
  }

  if (new Date(nowIso) >= new Date(session.expires_at)) {
    return null;
  }

  // Update last_seen_at
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(nowIso, session.id);

  const accessToken = createAccessToken(
    {
      userId: session.user_id,
      role: session.role,
      flags: parseFlags(session.flags),
      sessionId: session.id,
    },
    ACCESS_TTL_MS,
  );

  return {
    accessToken,
    refreshToken, // Return same refresh token
  };
}

export function revokeSessionByRefreshToken(refreshToken: string | undefined | null) {
  if (!refreshToken) return 0;
  const db = getDatabase();
  const refreshTokenHash = hashTokenHmac(refreshToken);
  const nowIso = new Date().toISOString();

  const result = db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE refresh_token_hash = ? AND revoked_at IS NULL`)
    .run(nowIso, refreshTokenHash);

  return result?.changes || 0;
}
