/*
 * Boundary tests for isNflSeason() seasonal gate helper.
 * Run: node web/src/__tests__/season-gates.test.js
 */

import assert from 'node:assert/strict';
import { isNflSeason } from '../lib/game-card/season-gates.ts';

// Aug → false (off-season)
assert.equal(isNflSeason(new Date(2026, 7, 15)), false, 'August should be off-season');
// Sep → true (in-season)
assert.equal(isNflSeason(new Date(2026, 8, 1)), true, 'September should be in-season');
// Jan → true (in-season)
assert.equal(isNflSeason(new Date(2026, 0, 15)), true, 'January should be in-season');
// Feb → true (in-season)
assert.equal(isNflSeason(new Date(2026, 1, 28)), true, 'February should be in-season');
// Mar → false (off-season)
assert.equal(isNflSeason(new Date(2026, 2, 1)), false, 'March should be off-season');

console.log('season-gates: all assertions passed');
