import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import {
  requireEntitlementForRequest,
  RESOURCE,
} from '../lib/api-security/auth.ts';
import { createAccessToken } from '../lib/api-security/jwt.ts';

function buildRequest(pathname, authHeader) {
  const headers = new Headers();
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: 'GET',
    headers,
  });
}

function assertUnauthorized(pathname, authHeader) {
  const request = buildRequest(pathname, authHeader);
  const result = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
  assert.equal(result.ok, false, `${pathname} should fail without valid auth`);
  assert.equal(result.status, 401, `${pathname} should return 401`);
}

function run() {
  const originalEnableApiAuth = process.env.ENABLE_API_AUTH;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_API_AUTH;

    // Default behavior: auth wall is disabled until rollout flag is enabled.
    const publicRequest = buildRequest('/api/cards');
    const publicAccess = requireEntitlementForRequest(
      publicRequest,
      RESOURCE.CHEDDAR_BOARD,
    );
    assert.equal(publicAccess.ok, true, 'default should allow without auth');
    assert.equal(publicAccess.status, 200, 'default should return 200');

    process.env.ENABLE_API_AUTH = 'true';

    assertUnauthorized('/api/cards');
    assertUnauthorized('/api/cards/game-123');
    assertUnauthorized('/api/games');
    assertUnauthorized('/api/cards', 'Bearer invalid.jwt.token');

    const token = createAccessToken({
      userId: 'wi-1124-user',
      email: 'wi1124@example.com',
      role: 'PAID',
      subscription_status: 'ACTIVE',
    });
    const validRequest = buildRequest('/api/cards', `Bearer ${token}`);
    const allowed = requireEntitlementForRequest(
      validRequest,
      RESOURCE.CHEDDAR_BOARD,
    );
    assert.equal(allowed.ok, true, 'valid token should be accepted');
    assert.equal(allowed.status, 200, 'valid token should return 200');

    process.env.ENABLE_API_AUTH = 'false';
    const disabledAgainRequest = buildRequest('/api/cards');
    const disabledAgain = requireEntitlementForRequest(
      disabledAgainRequest,
      RESOURCE.CHEDDAR_BOARD,
    );
    assert.equal(
      disabledAgain.ok,
      true,
      'auth wall disabled should allow after toggle-off',
    );
    assert.equal(disabledAgain.status, 200, 'toggle-off should return 200');

    console.log('✅ API auth feature-flag gating checks passed');
  } finally {
    if (originalEnableApiAuth === undefined) {
      delete process.env.ENABLE_API_AUTH;
    } else {
      process.env.ENABLE_API_AUTH = originalEnableApiAuth;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
}

run();
