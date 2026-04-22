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
  const originalEnableRbac = process.env.ENABLE_RBAC;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_RBAC;

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

    delete process.env.ENABLE_RBAC;
    assertUnauthorized('/api/cards');

    console.log('✅ WI-1124 default-deny entitlement checks passed');
  } finally {
    if (originalEnableRbac === undefined) {
      delete process.env.ENABLE_RBAC;
    } else {
      process.env.ENABLE_RBAC = originalEnableRbac;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
}

run();
