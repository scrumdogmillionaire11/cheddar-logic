/*
 * Direct contract checks for canonical quick-filter preset helpers.
 * Run: node --import tsx/esm web/src/__tests__/preset-helpers.test.js
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_GAME_FILTERS,
  DEFAULT_PROJECTIONS_FILTERS,
  resetFilters,
} from '../lib/game-card/filters.ts';
import { getPreset } from '../lib/game-card/presets.ts';
import {
  buildPresetFilters,
  doesPresetMatchFilters,
  getActivePresetId,
  togglePresetFilters,
} from '../lib/game-card/preset-helpers.ts';

console.log('🧪 Preset helper contract tests');

const fixedNow = new Date('2026-04-17T18:00:00.000Z');
const fourHoursLater = '2026-04-17T22:00:00.000Z';

const bestOnly = buildPresetFilters('game', 'best_only');
assert.deepEqual(bestOnly.statuses, ['FIRE']);
assert.equal(bestOnly.sortMode, 'start_time');

const resetAfterSecondClick = togglePresetFilters('game', bestOnly, 'best_only');
assert.deepEqual(
  resetAfterSecondClick,
  resetFilters('game'),
  're-clicking an active preset should reset to mode defaults',
);

const reorderedFullSlate = {
  ...buildPresetFilters('game', 'full_slate'),
  statuses: ['PASS', 'WATCH', 'FIRE'],
  markets: ['TOTAL', 'ML', 'SPREAD'],
};
assert.equal(
  doesPresetMatchFilters('game', reorderedFullSlate, getPreset('game', 'full_slate')),
  true,
  'preset active matching should be order-insensitive for arrays',
);

const watchNext4h = buildPresetFilters('game', 'watch_next_4h', { now: fixedNow });
assert.equal(watchNext4h.timeWindow, 'custom');
assert.deepEqual(watchNext4h.statuses, ['WATCH']);
assert.deepEqual(watchNext4h.customTimeRange, {
  start: fixedNow.toISOString(),
  end: fourHoursLater,
});
assert.equal(
  getActivePresetId('game', watchNext4h),
  'watch_next_4h',
  'rolling watch_next_4h matching should use duration, not exact timestamps',
);

const projectedActive = buildPresetFilters('projections', 'proj_active');
assert.deepEqual(projectedActive.statuses, ['FIRE', 'WATCH']);
assert.deepEqual(projectedActive.cardTypes, DEFAULT_PROJECTIONS_FILTERS.cardTypes);

const propsBest = buildPresetFilters('props', 'props_best');
const propsBestWithHiddenDefaultNoise = {
  ...propsBest,
  lineBands: ['hidden-ui-field'],
};
assert.equal(
  doesPresetMatchFilters(
    'props',
    propsBestWithHiddenDefaultNoise,
    getPreset('props', 'props_best'),
  ),
  true,
  'preset matching should ignore hidden props fields not rendered in quick filters',
);

assert.deepEqual(
  togglePresetFilters('game', DEFAULT_GAME_FILTERS, 'unknown-preset'),
  resetFilters('game'),
  'unknown presets should fail closed to mode defaults',
);

console.log('✅ Preset helper contract tests passed');
