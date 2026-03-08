/*
 * Verifies UI contract for evidence visibility when no official play exists.
 * Run: npm --prefix web run test:ui:evidence
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/components/cards-page-client.tsx');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 UI degraded-data contract source tests');

assert(
  source.includes('Analysis unavailable (drivers missing).'),
  'cards page should render an explicit degraded-analysis message when drivers are unavailable',
);

assert(
  !source.includes('Evidence ({card.evidence?.length})'),
  'cards page should not render the legacy Evidence section in the main card body',
);

assert(
  source.includes("const getStatusBadge = (status: 'PLAY' | 'LEAN' | 'PASS')"),
  'cards page badge contract should only allow PLAY/LEAN/PASS labels',
);

assert(
  source.includes('PASS Breakdown') &&
    source.includes('Model Lean Indicators') &&
    source.includes('Sharp Verdict:'),
  'cards page should show PASS diagnostics and model lean indicators in v2',
);

console.log('✅ UI degraded-data contract source tests passed');
