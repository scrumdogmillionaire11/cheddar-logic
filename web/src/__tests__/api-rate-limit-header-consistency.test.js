/*
 * API rate-limit and security-header finalization contract (WI-1127)
 *
 * Verifies scoped routes consistently finalize responses through shared
 * api-security helpers so rate-limit + security headers are applied across
 * success and error exits.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';

async function read(relativePath) {
  return fs.readFile(new URL(relativePath, import.meta.url), 'utf8');
}

async function run() {
  const authTokenRoute = await read('../app/api/auth/token/route.ts');
  const cardsRoute = await read('../app/api/cards/route.ts');
  const cardsByGameRoute = await read('../app/api/cards/[gameId]/route.ts');
  const resultsRoute = await read('../app/api/results/route.ts');
  const modelOutputsRoute = await read('../app/api/model-outputs/route.ts');
  const performanceRoute = await read('../app/api/performance/route.ts');
  const securityIndex = await read('../lib/api-security/index.ts');
  const rateLimiterSource = await read('../lib/api-security/rate-limiter.ts');

  assert.ok(
    securityIndex.includes('export function addSecurityHeaders('),
    'api-security index must export addSecurityHeaders helper',
  );
  assert.ok(
    securityIndex.includes("export * from './rate-limiter'"),
    'api-security index must re-export rate limiter utilities',
  );
  assert.ok(
    securityIndex.includes('export function finalizeApiResponse(') &&
      securityIndex.includes('addSecurityHeaders(addRateLimitHeaders(response, request))'),
    'finalizeApiResponse must apply both security and rate-limit headers',
  );

  assert.ok(
    securityIndex.includes('error: finalizeApiResponse(response, request)'),
    'performSecurityChecks error responses must be finalized for consistent headers',
  );

  const routeContracts = [
    ['/api/auth/token', authTokenRoute],
    ['/api/cards', cardsRoute],
    ['/api/cards/[gameId]', cardsByGameRoute],
    ['/api/results', resultsRoute],
    ['/api/model-outputs', modelOutputsRoute],
    ['/api/performance', performanceRoute],
  ];

  for (const [routeName, routeSource] of routeContracts) {
    assert.ok(
      routeSource.includes('performSecurityChecks('),
      `${routeName} route must consume performSecurityChecks`,
    );
    assert.ok(
      routeSource.includes('finalizeApiResponse(') ||
        routeSource.includes('addRateLimitHeaders('),
      `${routeName} route must apply shared rate-limit headers`,
    );
  }

  assert.ok(
    resultsRoute.includes("ENABLE_WITHOUT_ODDS_MODE === 'true'") &&
      resultsRoute.includes('return finalizeApiResponse(response, request);'),
    '/api/results early success exit must also be finalized',
  );

  for (const headerName of [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
  ]) {
    assert.ok(
      rateLimiterSource.includes(headerName),
      `${headerName} response header must remain published`,
    );
  }
  assert.ok(
    rateLimiterSource.includes('Math.ceil(result.resetTime / 1000).toString()'),
    'X-RateLimit-Reset must remain epoch seconds derived from resetTime',
  );
  assert.ok(
    securityIndex.includes("response.headers.set('Retry-After', retryAfterSeconds.toString())"),
    '429 responses must continue publishing Retry-After seconds',
  );

  console.log('✅ API rate-limit/security header finalization contract passed');
}

run().catch((error) => {
  console.error('❌ API rate-limit/security header finalization contract failed');
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
