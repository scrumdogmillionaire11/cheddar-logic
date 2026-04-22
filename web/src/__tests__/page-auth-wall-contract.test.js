import assert from 'node:assert/strict';

import {
  PUBLIC_ROUTES,
  isPublicRoute,
} from '../lib/api-security/config.ts';

function run() {
  assert.equal(
    isPublicRoute('/wedge'),
    true,
    '/wedge must be explicitly marked public',
  );

  assert.equal(
    isPublicRoute('/fpl'),
    true,
    '/fpl must be explicitly marked public',
  );

  assert.equal(
    isPublicRoute('/admin'),
    false,
    'non-allowlisted routes must not be public',
  );

  const disallowedPrefixes = ['/api/cards', '/api/games'];
  for (const route of PUBLIC_ROUTES) {
    const isApiRoute = disallowedPrefixes.some((prefix) =>
      route.startsWith(prefix),
    );
    assert.equal(
      isApiRoute,
      false,
      `PUBLIC_ROUTES must not include protected API route ${route}`,
    );
  }

  console.log('✅ WI-1124 public route contract checks passed');
}

run();
