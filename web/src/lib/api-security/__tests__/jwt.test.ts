/**
 * JWT test suite — WI-0559 (RFC parity) + WI-0560 (fail-closed prod guard)
 * Runner: node --experimental-strip-types web/src/lib/api-security/__tests__/jwt.test.ts
 */

import * as crypto from 'crypto';
import { createAccessToken, verifyToken } from '../jwt.ts';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ---- Task 1: WI-0559 — RFC parity tests ----

describe('WI-0559: createSignature RFC parity', () => {
  test('Test 1: createAccessToken produces a signature matching crypto digest("base64url")', () => {
    // Generate a token with a known secret
    const originalEnv = process.env.AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'test-secret-for-parity-check';
    process.env.NODE_ENV = 'development';

    try {
      const token = createAccessToken({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'FREE_ACCOUNT',
        subscription_status: 'NONE',
      });

      const parts = token.split('.');
      assert.equal(parts.length, 3, 'Token must have 3 parts');

      const [encodedHeader, encodedPayload, signature] = parts;

      // Compute expected signature using direct base64url from HMAC
      const message = `${encodedHeader}.${encodedPayload}`;
      const expectedSignature = crypto
        .createHmac('sha256', 'test-secret-for-parity-check')
        .update(message)
        .digest('base64url');

      assert.equal(
        signature,
        expectedSignature,
        'Signature must match crypto.createHmac().digest("base64url") — binary roundtrip corruption indicates WI-0559 bug is present',
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });

  test('Test 2: verifyToken accepts a token produced by createAccessToken', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'test-secret-for-verify';
    process.env.NODE_ENV = 'development';

    try {
      const token = createAccessToken({
        userId: 'user-456',
        email: 'verify@example.com',
        role: 'PAID',
        subscription_status: 'ACTIVE',
      });

      const decoded = verifyToken(token);
      assert.notEqual(decoded, null, 'verifyToken must return non-null for a valid token');
      assert.equal(decoded!.userId, 'user-456');
      assert.equal(decoded!.email, 'verify@example.com');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });

  test('Test 3: verifyToken rejects a tampered token', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'test-secret-tamper';
    process.env.NODE_ENV = 'development';

    try {
      const token = createAccessToken({
        userId: 'user-789',
        email: 'tamper@example.com',
        role: 'FREE_ACCOUNT',
        subscription_status: 'NONE',
      });

      // Tamper the signature (last segment)
      const parts = token.split('.');
      const tamperedSig = parts[2].slice(0, -1) + (parts[2].endsWith('a') ? 'b' : 'a');
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

      const result = verifyToken(tamperedToken);
      assert.equal(result, null, 'verifyToken must return null for tampered token');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });

  test('Test 4: verifyToken returns null for an expired token', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'test-secret-expiry';
    process.env.NODE_ENV = 'development';

    try {
      // Manually build an expired token
      const secret = 'test-secret-expiry';
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = Buffer.from(
        JSON.stringify({
          userId: 'user-expired',
          email: 'expired@example.com',
          role: 'FREE_ACCOUNT',
          subscription_status: 'NONE',
          iat: Math.floor(Date.now() / 1000) - 3600,
          exp: Math.floor(Date.now() / 1000) - 1800, // expired 30 min ago
        }),
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const message = `${header}.${payload}`;
      const signature = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('base64url');

      const expiredToken = `${message}.${signature}`;
      const result = verifyToken(expiredToken);
      assert.equal(result, null, 'verifyToken must return null for expired token');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });
});

// ---- Task 2: WI-0560 — Fail-closed prod guard tests ----

describe('WI-0560: getAuthSecret fail-closed in production', () => {
  test('Test 5: NODE_ENV=production + no AUTH_SECRET → createAccessToken throws AUTH_SECRET_MISCONFIGURED', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalCheddar = process.env.CHEDDAR_AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    delete process.env.AUTH_SECRET;
    delete process.env.CHEDDAR_AUTH_SECRET;
    process.env.NODE_ENV = 'production';

    try {
      assert.throws(
        () =>
          createAccessToken({
            userId: 'u1',
            email: 'e@e.com',
            role: 'FREE_ACCOUNT',
            subscription_status: 'NONE',
          }),
        (err: Error) => {
          assert.ok(
            err.message.includes('AUTH_SECRET_MISCONFIGURED'),
            `Expected AUTH_SECRET_MISCONFIGURED in error message, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalCheddar === undefined) {
        delete process.env.CHEDDAR_AUTH_SECRET;
      } else {
        process.env.CHEDDAR_AUTH_SECRET = originalCheddar;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });

  test('Test 6: NODE_ENV=production + AUTH_SECRET=dev-auth-secret-change-me → throws AUTH_SECRET_MISCONFIGURED', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'dev-auth-secret-change-me';
    process.env.NODE_ENV = 'production';

    try {
      assert.throws(
        () =>
          createAccessToken({
            userId: 'u2',
            email: 'e2@e.com',
            role: 'FREE_ACCOUNT',
            subscription_status: 'NONE',
          }),
        (err: Error) => {
          assert.ok(
            err.message.includes('AUTH_SECRET_MISCONFIGURED'),
            `Expected AUTH_SECRET_MISCONFIGURED in error message, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });

  test('Test 7: NODE_ENV=production + real AUTH_SECRET → createAccessToken succeeds', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'a-real-strong-secret-value-for-prod';
    process.env.NODE_ENV = 'production';

    try {
      const token = createAccessToken({
        userId: 'u3',
        email: 'prod@example.com',
        role: 'PAID',
        subscription_status: 'ACTIVE',
      });
      assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Must return valid 3-part JWT');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });

  test('Test 8: NODE_ENV=development + no AUTH_SECRET → createAccessToken does NOT throw', () => {
    const originalEnv = process.env.AUTH_SECRET;
    const originalCheddar = process.env.CHEDDAR_AUTH_SECRET;
    const originalNode = process.env.NODE_ENV;
    delete process.env.AUTH_SECRET;
    delete process.env.CHEDDAR_AUTH_SECRET;
    process.env.NODE_ENV = 'development';

    try {
      // Should not throw — dev mode uses default with warning only
      const token = createAccessToken({
        userId: 'u4',
        email: 'dev@example.com',
        role: 'FREE_ACCOUNT',
        subscription_status: 'NONE',
      });
      assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Must return valid 3-part JWT in dev');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalEnv;
      }
      if (originalCheddar === undefined) {
        delete process.env.CHEDDAR_AUTH_SECRET;
      } else {
        process.env.CHEDDAR_AUTH_SECRET = originalCheddar;
      }
      if (originalNode === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNode;
      }
    }
  });
});
