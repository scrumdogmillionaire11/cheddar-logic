/*
 * API error redaction regression contract (WI-1127)
 *
 * Verifies scoped API routes do not leak raw exception messages
 * and require correlation IDs for client-facing error payloads.
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

  const sources = [
    ['cards', cardsRoute],
    ['cards/[gameId]', cardsByGameRoute],
    ['results', resultsRoute],
  ];

  for (const [name, source] of sources) {
    assert.ok(
      source.includes('createOpaqueErrorResponse('),
      `${name}: must use createOpaqueErrorResponse for client-facing errors`,
    );
    assert.ok(
      source.includes('Internal server error'),
      `${name}: must return opaque Internal server error message`,
    );
    assert.ok(
      source.includes('createCorrelationId('),
      `${name}: must generate correlation id for server logs`,
    );

    assert.ok(
      !source.includes('error instanceof Error ? error.message'),
      `${name}: must not return raw Error.message`,
    );
    assert.ok(
      !source.includes('errorMessage = error.message'),
      `${name}: must not expose raw error.message`,
    );
  }

  assert.ok(
    securityIndex.includes('correlationId: createCorrelationId()'),
    'performSecurityChecks responses must include correlationId',
  );
  assert.ok(
    securityIndex.includes('createOpaqueErrorResponse(') &&
      securityIndex.includes('correlationId,'),
    'shared opaque error helper must include correlationId in response payload',
  );

  console.log('✅ API error redaction regression contract passed');
}

run().catch((error) => {
  console.error('❌ API error redaction regression contract failed');
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
