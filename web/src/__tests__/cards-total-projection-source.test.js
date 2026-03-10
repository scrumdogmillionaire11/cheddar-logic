/*
 * Verifies NHL total projection source wiring:
 * 1) /api/games maps driverInputs.expected_total into projected-total recovery
 * 2) Cards UI resolves NHL totals from nhl-totals-call first
 * 3) Cards UI keeps nhl-pace-totals as fallback
 *
 * Run: node web/src/__tests__/cards-total-projection-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const gamesRoutePath = path.resolve('web/src/app/api/games/route.ts');
const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('🧪 NHL total projection source contract tests');

assert(
  gamesRouteSource.includes('driverInputs?.expected_total'),
  '/api/games should map driverInputs.expected_total for projected total normalization',
);

assert(
  cardsPageSource.includes('function resolvePrimaryTotalProjectionPlay('),
  'cards UI should define a total projection source resolver',
);

assert(
  cardsPageSource.includes("play.cardType === 'nhl-totals-call'"),
  'cards UI should prioritize nhl-totals-call for NHL total projection display',
);

assert(
  cardsPageSource.includes("play.cardType === 'nhl-pace-totals'"),
  'cards UI should keep nhl-pace-totals as NHL total projection fallback',
);

assert(
  cardsPageSource.includes('totalProjectionDisplayPlay'),
  'cards UI should use resolved totalProjectionDisplayPlay in header rendering',
);

console.log('✅ NHL total projection source contract tests passed');
