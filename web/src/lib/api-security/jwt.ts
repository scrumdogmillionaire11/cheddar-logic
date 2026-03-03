/**
 * JWT Token Management
 * Handles token generation, validation, and claims
 */

import * as crypto from 'crypto';

export interface AuthToken {
  userId: string;
  email: string;
  role: 'ADMIN' | 'PAID' | 'FREE_ACCOUNT';
  subscription_status: 'NONE' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE';
  flags?: string[];
  iat: number; // issued at
  exp: number; // expiration
}

interface JWTHeader {
  alg: 'HS256';
  typ: 'JWT';
}

type JWTPayload = AuthToken;

const ALGORITHM = 'HS256';
const ACCESS_TOKEN_EXPIRES_IN = 15 * 60 * 1000; // 15 minutes

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.CHEDDAR_AUTH_SECRET;
  if (!secret || secret === 'dev-auth-secret-change-me') {
    console.warn('⚠️  WARNING: Using default AUTH_SECRET. This is insecure in production.');
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
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function createSignature(message: string, secret: string): string {
  return base64UrlEncode(
    crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest()
      .toString('binary')
  );
}

/**
 * Create an access token (short-lived JWT)
 */
export function createAccessToken(claims: Omit<AuthToken, 'iat' | 'exp'>): string {
  const secret = getAuthSecret();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + Math.floor(ACCESS_TOKEN_EXPIRES_IN / 1000);

  const header: JWTHeader = {
    alg: ALGORITHM,
    typ: 'JWT',
  };

  const payload: JWTPayload = {
    ...claims,
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
 * Create a refresh token (longer-lived, opaque)
 * In production, store refresh tokens in database or Redis
 * TODO: Implement token storage with userId tracking
 */
export function createRefreshToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  // TODO: Store in Redis/DB with expiration and userId
  return token;
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

    return payload;
  } catch (error) {
    console.error('[AUTH] Token verification failed:', error);
    return null;
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
export function extractTokenFromHeader(authHeader: string | null): string | null {
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
