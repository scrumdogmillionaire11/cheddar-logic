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
  const cardsRoute = await read('../app/api/cards/route.ts');
  const cardsByGameRoute = await read('../app/api/cards/[gameId]/route.ts');
  const resultsRoute = await read('../app/api/results/route.ts');
  const securityIndex = await read('../lib/api-security/index.ts');

  assert.ok(
    securityIndex.includes('export function addSecurityHeaders('),
    'api-security index must export addSecurityHeaders helper',
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

  assert.ok(
    cardsRoute.includes('finalizeApiResponse('),
    '/api/cards route must finalize responses',
  );
  assert.ok(
    cardsByGameRoute.includes('finalizeApiResponse('),
    '/api/cards/[gameId] route must finalize responses',
  );
  assert.ok(
    resultsRoute.includes('finalizeApiResponse('),
    '/api/results route must finalize responses',
  );

  assert.ok(
    resultsRoute.includes("ENABLE_WITHOUT_ODDS_MODE === 'true'") &&
      resultsRoute.includes('return finalizeApiResponse(response, request);'),
    '/api/results early success exit must also be finalized',
  );

  console.log('✅ API rate-limit/security header finalization contract passed');
}

run().catch((error) => {
  console.error('❌ API rate-limit/security header finalization contract failed');
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
