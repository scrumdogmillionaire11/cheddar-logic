/*
 * Verifies UI contract for evidence visibility when no official play exists.
 * Run: npm --prefix web run test:ui:evidence
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/components/cards-page-client.tsx');
const displayVerdictPath = path.resolve('src/lib/game-card/display-verdict.ts');
const source = fs.readFileSync(filePath, 'utf8');
const displayVerdictSource = fs.readFileSync(displayVerdictPath, 'utf8');

console.log('🧪 UI degraded-data contract source tests');

assert(
  source.includes('Analysis unavailable (drivers missing).'),
  'cards page should render an explicit degraded-analysis message when drivers are unavailable',
);

assert(
  !source.includes('Evidence({card.evidence?.length})'),
  'cards page should not render the legacy Evidence section in the main card body',
);

// Semantic guard: canonical internal status union remains unchanged
assert(
  source.includes("const getStatusBadge = (status: 'PLAY' | 'LEAN' | 'PASS')"),
  'cards page badge contract should preserve canonical PLAY/LEAN/PASS internal statuses',
);

// Display labels updated to human-friendly names
assert(
  displayVerdictSource.includes("label: 'SLIGHT EDGE'"),
  'display verdict mapping should map LEAN to SLIGHT EDGE label',
);

// Brand sublabels present in mapping
assert(
  displayVerdictSource.includes('Fresh Cheddar') &&
    displayVerdictSource.includes('Mild Cheddar') &&
    displayVerdictSource.includes('Cottage Cheese'),
  'display verdict mapping should include branded verdict sublabels',
);

// PASS diagnostics section present
assert(
  source.includes('PASS Breakdown'),
  'cards page should show PASS diagnostics section',
);

// Model Lean terminology replaced with Model Direction
assert(
  source.includes('Model Direction:') && !source.includes('Model Lean:'),
  'cards page should use Model Direction instead of Model Lean in diagnostics',
);

// Model Lean Indicators section heading stays technical (section label, not branded)
assert(
  source.includes('Model Lean Indicators'),
  'cards page section heading should remain as Model Lean Indicators',
);

// Projected sentence implementation exists
assert(
  source.includes('formatProjectedSentence') &&
    source.includes('Projected: '),
  'cards page should include simplified projected sentence for default edge display',
);

// Market Math section collapsed by default
assert(
  source.includes('<details') && source.includes('Market Math'),
  'cards page Market Math section should be collapsible (details element)',
);

console.log('✅ UI degraded-data contract source tests passed');

