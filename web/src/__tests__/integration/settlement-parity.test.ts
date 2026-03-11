/*
 * Settlement parity source contract test
 *
 * Ensures /api/results remains display-log backed and emits explicit
 * settlement coverage metadata/headers for ops reconciliation.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

const resultsRoutePath = path.join(
  repoRoot,
  'web/src/app/api/results/route.ts',
);
const resultsRouteSource = fs.readFileSync(resultsRoutePath, 'utf8');

console.log('🧪 Settlement parity source contract tests');

assert.ok(
  resultsRouteSource.includes(
    'INNER JOIN card_display_log cdl ON cr.card_id = cdl.pick_id',
  ),
  '/api/results must stay joined to card_display_log so API output remains frontend-display scoped',
);

assert.ok(
  resultsRouteSource.includes("response.headers.set('X-Settlement-Coverage'"),
  '/api/results must emit X-Settlement-Coverage header',
);

assert.ok(
  resultsRouteSource.includes('displayedFinal') &&
    resultsRouteSource.includes('settledFinalDisplayed') &&
    resultsRouteSource.includes('missingFinalDisplayed'),
  '/api/results meta must include displayed/final settlement coverage counters',
);

assert.ok(
  resultsRouteSource.includes('finalDisplayedMissingResults') === false,
  'worker-only diagnostics must not leak into /api/results payload names',
);

console.log('✅ Settlement parity source contract tests passed');
