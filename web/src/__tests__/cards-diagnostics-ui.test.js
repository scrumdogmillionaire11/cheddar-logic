/*
 * Source-contract checks for cards diagnostics UI separation.
 * Run: node web/src/__tests__/cards-diagnostics-ui.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());
const headerSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/cards/CardsHeader.tsx'),
  'utf8',
);
const panelSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/cards/SportDiagnosticsPanel.tsx'),
  'utf8',
);
const listSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/cards/CardsList.tsx'),
  'utf8',
);
const contextSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/cards/CardsPageContext.tsx'),
  'utf8',
);
const filterPanelSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/filter-panel.tsx'),
  'utf8',
);

console.log('🧪 Cards diagnostics UI contract tests');

assert.ok(
  contextSource.includes("process.env.NODE_ENV !== 'production'") &&
    contextSource.includes('NEXT_PUBLIC_ENABLE_CARDS_DIAGNOSTICS'),
  'diagnostics should remain gated away from production/default cards flow',
);
assert.ok(
  headerSource.includes('<details') &&
    headerSource.includes('Debug diagnostics workflow'),
  'header diagnostics should be presented as a collapsible debug workflow',
);
assert.ok(
  !headerSource.includes('Guardrails: edge verification'),
  'header should not expose guardrail diagnostics as primary quick-filter text',
);
assert.ok(
  panelSource.includes('Debug diagnostics workflow') &&
    panelSource.includes('onBucketClick'),
  'blocked-card diagnostics should be in the debug workflow and stay clickable',
);
assert.ok(
  listSource.includes('Debug diagnostics filter:') &&
    listSource.includes("diagnosticsEnabled && viewMode === 'game'"),
  'diagnostic bucket filtering should be clearly separate from primary quick filters',
);
assert.ok(
  !filterPanelSource.includes('diagnostic') &&
    !filterPanelSource.includes('Diagnostics'),
  'FilterPanel should not own diagnostics workflow controls',
);

console.log('✅ Cards diagnostics UI contract tests passed');
