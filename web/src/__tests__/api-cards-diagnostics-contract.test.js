/*
 * Verifies /api/cards diagnostics use canonical drop-reason codes from payload-classifier.ts.
 * Run: node web/src/__tests__/api-cards-diagnostics-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const cardsRoute = fs.readFileSync(path.join(repoRoot, 'web/src/app/api/cards/route.ts'), 'utf8');
const payloadSource = fs.readFileSync(path.join(repoRoot, 'web/src/lib/cards/payload-classifier.ts'), 'utf8');

console.log('🧪 Cards diagnostics contract tests');

// 1. Diagnostics must be opt-in via _diag param
assert.ok(
  cardsRoute.includes("searchParams.has('_diag')"),
  '/api/cards diagnostics must be opt-in via ?_diag query param',
);

// 2. Diagnostics must be conditionally included in the response
assert.ok(
  cardsRoute.includes('...(diagnostics ? { diagnostics } : {})'),
  '/api/cards diagnostics must be conditionally included, not always present',
);

// 3. Diagnostics must expose by_reason and by_card_type aggregations
assert.ok(
  cardsRoute.includes('by_reason') && cardsRoute.includes('by_card_type'),
  '/api/cards diagnostics must expose by_reason and by_card_type aggregations',
);

// 4. Canonical BettingSurfacePayloadDropReason codes must appear in CardsDropReasonCode
//    and in payload-classifier.ts — these are the unified eligibility reason codes
const canonicalReasonCodes = [
  'PROJECTION_ONLY_BASIS',
  'PROJECTION_ONLY_EXECUTION_STATUS',
  'PROJECTION_ONLY_LINE_SOURCE',
  'SYNTHETIC_FALLBACK_PROJECTION_SOURCE',
];
for (const code of canonicalReasonCodes) {
  assert.ok(
    cardsRoute.includes(`'${code}'`),
    `/api/cards CardsDropReasonCode must include canonical code '${code}' from payload-classifier.ts`,
  );
  assert.ok(
    payloadSource.includes(code),
    `payload-classifier.ts must define '${code}' as a canonical drop reason`,
  );
}

// 5. Diagnostics must delegate to getBettingSurfacePayloadDropReason for payload-based drops
assert.ok(
  cardsRoute.includes('getBettingSurfacePayloadDropReason('),
  '/api/cards diagnostics must delegate to getBettingSurfacePayloadDropReason from payload-classifier.ts',
);

// 6. Route-level drop reason codes for non-payload gates must be present in diagnostics
const routeReasonCodes = [
  'SPORT_EXCLUDED_FPL',
  'SPORT_EXCLUDED_NCAAM',
  'SETTLED_RESULT',
  'WELCOME_HOME_DISABLED',
  'LIFECYCLE_STATUS_EXCLUDED',
  'LIFECYCLE_NOT_STARTED_OR_MISSING_TIME',
  'RUN_SCOPE_EXCLUDED',
];
for (const code of routeReasonCodes) {
  assert.ok(
    cardsRoute.includes(`'${code}'`),
    `/api/cards must include route-level drop reason '${code}' in diagnostics`,
  );
}

// 7. Diagnostics aggregate counters must be present
assert.ok(
  cardsRoute.includes('total_evaluated') && cardsRoute.includes('returned_count'),
  '/api/cards diagnostics must expose total_evaluated and returned_count',
);

// 8. run_scope_fallback_applied must surface in diagnostics
assert.ok(
  cardsRoute.includes('run_scope_fallback_applied'),
  '/api/cards diagnostics must expose run_scope_fallback_applied flag',
);

// 9. Diagnostics function must exist and be called with canonical params
assert.ok(
  cardsRoute.includes('buildCardsDropDiagnostics(') &&
    cardsRoute.includes('function buildCardsDropDiagnostics('),
  '/api/cards must implement buildCardsDropDiagnostics using canonical reason codes',
);

console.log('✅ Cards diagnostics contract tests passed');
