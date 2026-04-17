/*
 * Source-contract checks for cards quick-filter shell integration.
 * Run: node web/src/__tests__/cards-quick-filter-ui.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());
const filterPanelSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/filter-panel.tsx'),
  'utf8',
);
const cardsShellSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/components/cards/index.tsx'),
  'utf8',
);
const helperSource = fs.readFileSync(
  path.join(repoRoot, 'web/src/lib/game-card/preset-helpers.ts'),
  'utf8',
);

console.log('🧪 Cards quick-filter UI contract tests');

assert.ok(
  filterPanelSource.includes("from '@/lib/game-card/preset-helpers'"),
  'FilterPanel should consume canonical preset helper module',
);
assert.ok(
  filterPanelSource.includes('togglePresetFilters(viewMode, filters, presetId)'),
  'preset clicks should route through canonical toggle/reset helper',
);
assert.ok(
  filterPanelSource.includes('doesPresetMatchFilters(viewMode, filters, preset)'),
  'active preset state should route through canonical matching helper',
);
assert.ok(
  !filterPanelSource.includes('doesPresetMatchCurrentFilters'),
  'FilterPanel should not retain component-local preset matching logic',
);
assert.ok(
  !filterPanelSource.includes('getWatchNext4hRange'),
  'rolling preset window construction should not live in FilterPanel',
);

assert.ok(
  filterPanelSource.includes("{viewMode !== 'projections' &&"),
  'projection mode should continue hiding non-projection quick controls',
);
assert.ok(
  filterPanelSource.includes("viewMode === 'props'") &&
    filterPanelSource.includes('Quick Prop Markets'),
  'props mode should continue exposing prop-specific quick controls',
);
assert.ok(
  filterPanelSource.includes("viewMode === 'game'") &&
    filterPanelSource.includes('Minimum Tier'),
  'game mode should continue exposing game-line-only controls',
);

assert.ok(
  cardsShellSource.includes('activeCount={activeFilterCount}'),
  'cards shell should pass active-filter count into the quick-filter panel',
);
assert.ok(
  cardsShellSource.includes('onReset={onResetFilters}'),
  'cards shell should keep reset behavior wired to provider reset action',
);

assert.ok(
  helperSource.includes('togglePresetFilters') &&
    helperSource.includes('return resetFilters(mode)'),
  'canonical helper should own re-click reset behavior',
);

console.log('✅ Cards quick-filter UI contract tests passed');
