/**
 * JWT Token Management
 * Handles token generation, validation, and claims
 */

import * as crypto from 'crypto';
// @cheddar-logic/data is a CommonJS module; use default import + destructure for ESM compat
import cheddarData from '@cheddar-logic/data';
const {
  insertRevokedToken,
  isTokenRevoked,
  pruneExpiredRevokedTokens: pruneRevoked,
  issueRefreshToken,
  revokeRefreshToken: revokeStoredRefreshToken,
  isRefreshTokenValid: isStoredRefreshTokenValid,
} = cheddarData as {
  insertRevokedToken: (jti: string, expiresAt: number) => void;
  isTokenRevoked: (jti: string) => boolean;
  pruneExpiredRevokedTokens: () => number;
  issueRefreshToken: (
    userId: string,
    options?: {
      expiresAt?: string;
      ipAddress?: string | null;
      userAgent?: string | null;
    },
  ) => { token: string; sessionId: string; expiresAt: string };
  revokeRefreshToken: (token: string) => boolean;
  isRefreshTokenValid: (token: string) => boolean;
};

// Prune expired revocation records at module load (best-effort, non-fatal)
try { pruneRevoked(); } catch { /* non-fatal */ }

export interface AuthToken {
  userId: string;
  email: string;
  role: 'ADMIN' | 'PAID' | 'FREE_ACCOUNT';
  subscription_status: 'NONE' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE';
  flags?: string[];
  jti?: string; // JWT ID — used for revocation (WI-0608)
  iat: number; // issued at
  exp: number; // expiration
}

interface JWTHeader {
  alg: 'HS256';
  typ: 'JWT';
}

type JWTPayload = AuthToken;

export interface RefreshTokenOptions {
  userId: string;
  expiresAt?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const ALGORITHM = 'HS256';
const ACCESS_TOKEN_EXPIRES_IN = 15 * 60 * 1000; // 15 minutes

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.CHEDDAR_AUTH_SECRET;
  const isInsecure = !secret || secret === 'dev-auth-secret-change-me';
  if (isInsecure) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'AUTH_SECRET_MISCONFIGURED: AUTH_SECRET is missing or set to the insecure default. ' +
          'Set a strong AUTH_SECRET in your production environment variables.',
      );
    }
    console.warn(
      '⚠️  WARNING: Using default AUTH_SECRET. This is insecure in production.',
    );
  }
  return secret || 'dev-auth-secret-change-me';
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlDecode(data: string): string {
  const padded = data + '==='.slice((data.length + 3) % 4);
  return Buffer.from(
    padded.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString();
}

function createSignature(message: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('base64url');
}

/**
 * Create an access token (short-lived JWT)
 */
export function createAccessToken(
  claims: Omit<AuthToken, 'iat' | 'exp'>,
): string {
  const secret = getAuthSecret();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + Math.floor(ACCESS_TOKEN_EXPIRES_IN / 1000);

  const header: JWTHeader = {
    alg: ALGORITHM,
    typ: 'JWT',
  };

  const payload: JWTPayload = {
    ...claims,
    jti: crypto.randomUUID(),
    iat: now,
    exp: expiresAt,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;
  const signature = createSignature(message, secret);

  return `${message}.${signature}`;
}

/**
 * Create a refresh token (longer-lived, opaque) backed by the canonical
 * sessions table. Returns the plaintext token once; only a hash is persisted.
 */
export function createRefreshToken(
  options: RefreshTokenOptions | string,
): string {
  const normalizedOptions =
    typeof options === 'string' ? { userId: options } : options;

  if (!normalizedOptions?.userId) {
    throw new Error('createRefreshToken requires a userId');
  }

  return issueRefreshToken(normalizedOptions.userId, {
    expiresAt: normalizedOptions.expiresAt,
    ipAddress: normalizedOptions.ipAddress,
    userAgent: normalizedOptions.userAgent,
  }).token;
}

/**
 * Revoke a refresh token persisted in the sessions table.
 */
export function revokeRefreshToken(token: string): boolean {
  return revokeStoredRefreshToken(token);
}

/**
 * Check whether a refresh token still maps to an active, unexpired session.
 */
export function isRefreshTokenValid(token: string): boolean {
  return isStoredRefreshTokenValid(token);
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): AuthToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const secret = getAuthSecret();

    // Verify signature
    const message = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = createSignature(message, secret);

    if (!timingSafeEqual(signature, expectedSignature)) {
      return null;
    }

    // Decode and parse payload
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as JWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Token expired
    }

    // Check DB revocation (WI-0608)
    if (payload.jti && isTokenRevoked(payload.jti)) {
      return null; // Token explicitly revoked
    }

    return payload;
  } catch (error) {
    console.error('[AUTH] Token verification failed:', error);
    return null;
  }
}

/**
 * Revoke a token by inserting its jti into the persistent revoked_tokens table.
 * Decodes the token without signature verification (token may already be suspect).
 * Fails open on decode errors — an invalid token is not a security concern here.
 */
export function revokeToken(token: string): void {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return;
    const payload = JSON.parse(base64UrlDecode(parts[1])) as JWTPayload;
    if (payload.jti && payload.exp) {
      insertRevokedToken(payload.jti, payload.exp);
    }
  } catch {
    // fail-open on decode error — token is invalid anyway
  }
}

/**
 * Timing-safe string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  try {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) return false;
    return crypto.timingSafeEqual(bufferA, bufferB);
  } catch {
    return false;
  }
}

/**
 * Extract token from Authorization header
 */
export function extractTokenFromHeader(
  authHeader: string | null,
): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Check if token is nearing expiration (within 1 minute)
 */
export function isTokenExpiringSoon(token: AuthToken): boolean {
  const now = Math.floor(Date.now() / 1000);
  return token.exp - now < 60; // Less than 1 minute remaining
}
