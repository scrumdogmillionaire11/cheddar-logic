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
  source.includes('const inferredDecision =') &&
    source.includes('resolvedDecisionV2?.official_status'),
  'cards page should preserve canonical PLAY/LEAN/PASS internal statuses',
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

// Projected sentence implementation exists
assert(
  source.includes('formatProjectedSentence') &&
    source.includes('Model:'),
  'cards page should include simplified projected sentence for default edge display',
);

// Single Details drawer replaces standalone technical sections
assert(
  source.includes('<details') &&
    source.includes('Details') &&
    !source.includes('Market Math') &&
    !source.includes('Model Lean Indicators'),
  'cards page should use one Details drawer and avoid standalone Market Math / Model Lean sections',
);

// Context block should stay compact and optional sections should be conditionally rendered
assert(
  source.includes('contextLine1') &&
    source.includes('contextLine2') &&
    source.includes('{contextLine2 && (') &&
    source.includes('{hasDetails && ('),
  'cards page should keep compact context lines and suppress optional sections when empty',
);

// Visible hierarchy should stay decision-first and compact (header -> bet -> context).
assert(
  source.includes('visibleBetText') &&
    source.includes('contextLine1') &&
    source.includes('{contextLine2 && (') &&
    !source.includes('Odds unavailable'),
  'cards page should keep visible primary blocks compact and avoid extra empty visible sections',
);

// Bet/action content must render before Details content.
const betLineIndex = source.indexOf('visibleBetText');
const detailsSummaryIndex = source.indexOf('Details');
assert(
  betLineIndex !== -1 &&
    detailsSummaryIndex !== -1 &&
    betLineIndex < detailsSummaryIndex,
  'cards page should render the bet/action line before Details content',
);

console.log('✅ UI degraded-data contract source tests passed');
