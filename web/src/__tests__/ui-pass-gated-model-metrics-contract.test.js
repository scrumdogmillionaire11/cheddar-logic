/*
 * Regression guard for PASS-gated model metrics visibility.
 * Run: node web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('web/src/components/cards/GameCardItem.tsx');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 PASS-gated model metrics contract tests');

assert(
  source.includes('finalMarketDecision') && source.includes('displayDecisionResolved'),
  'GameCardItem should derive visible decision from canonical final market decision when present',
);

assert(
  source.includes("visibleDecision === 'PASS'") && source.includes('surfacedReason'),
  'PASS rendering should surface reason-first copy from canonical contract',
);

assert(
  !source.includes('Model direction:') && !source.includes('Pricing Status:'),
  'Primary PASS details must not show legacy model direction or pricing status labels',
);

assert(
  source.includes('modelContextAllowed') && source.includes("showMathDetails =\n    visibleDecision !== 'PASS'"),
  'Model math/details should be gated when surfaced decision is PASS or model context is disallowed',
);

assert(
  source.includes('showInternalModelContext') && source.includes('Model context (internal)'),
  'SLIGHT EDGE verification-gated cards should only expose model fields under explicit internal labeling',
);

console.log('✅ PASS-gated model metrics contract tests passed');
