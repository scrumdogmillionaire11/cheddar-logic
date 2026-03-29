/*
 * Verifies props-mode default filtering keeps PASS-backed prop rows visible.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filtersSource = fs.readFileSync(
  path.resolve('web/src/lib/game-card/filters.ts'),
  'utf8',
);
const presetsSource = fs.readFileSync(
  path.resolve('web/src/lib/game-card/presets.ts'),
  'utf8',
);
const cardsPageSource = fs.readFileSync(
  path.resolve('web/src/components/cards/shared.ts'),
  'utf8',
);

console.log('🧪 Props filter defaults contract source tests');

assert(
  filtersSource.includes('export const DEFAULT_PROPS_FILTERS') &&
    filtersSource.includes("statuses: ['FIRE', 'WATCH', 'PASS']"),
  'props mode defaults should include PASS so NO PLAY / PROJECTION rows are visible by default',
);

assert(
  presetsSource.includes('props_shots') &&
    presetsSource.includes('props_points') &&
    presetsSource.includes('...DEFAULT_FILTERS_BY_MODE.props') &&
    presetsSource.includes("statuses: FIRE_WATCH"),
  'props presets should inherit PASS-inclusive defaults unless they explicitly opt into actionable-only statuses',
);

assert(
  cardsPageSource.includes("viewMode !== 'game'") &&
    cardsPageSource.includes("return 'PASS';") &&
    cardsPageSource.includes('filters.statuses.includes(mapPropStatusToExpression(row.status))'),
  'props filtering should keep PASS-mapped prop rows when PASS is present and lifecycle status stripping must stay game-mode-only',
);

console.log('✅ Props filter defaults contract source tests passed');
