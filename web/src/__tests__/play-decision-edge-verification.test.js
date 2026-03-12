/*
 * Verifies canonical edge-verification signal mapping in decision-logic.ts.
 * Run: node web/src/__tests__/play-decision-edge-verification.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('web/src/lib/play-decision/decision-logic.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Play decision edge-verification source tests');

assert(
  source.includes("export const EDGE_VERIFICATION_TAG = 'EDGE_VERIFICATION_REQUIRED';"),
  'decision-logic should export EDGE_VERIFICATION_TAG constant',
);

assert(
  source.includes('export function hasEdgeVerificationSignals('),
  'decision-logic should export hasEdgeVerificationSignals helper',
);

assert(
  source.includes("'BLOCKED_BET_VERIFICATION_REQUIRED'"),
  'decision-logic should treat blocked-bet verification as edge-verification signal',
);

assert(
  source.includes('EDGE_SANITY_GATE_CODE,'),
  'decision-logic should treat raw edge-sanity reason codes as edge-verification signals',
);

assert(
  source.includes('gate.code === EDGE_SANITY_GATE_CODE'),
  'decision-logic should treat EDGE_SANITY gate code as edge-verification signal',
);

console.log('✅ Play decision edge-verification source tests passed');
