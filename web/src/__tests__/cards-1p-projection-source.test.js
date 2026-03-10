/*
 * Verifies NHL 1P projection display wiring remains intact:
 * 1) API normalization maps expected_1p_total into projectedTotal
 * 2) Cards UI renders explicit 1P projection context row
 *
 * Run: node web/src/__tests__/cards-1p-projection-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const gamesRoutePath = path.resolve('web/src/app/api/games/route.ts');
const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('🧪 NHL 1P projection source contract tests');

assert(
  gamesRouteSource.includes('driverInputs?.expected_1p_total'),
  '/api/games should map driverInputs.expected_1p_total for 1P projection display',
);

assert(
  cardsPageSource.includes("cardType === 'nhl-pace-1p'"),
  'cards UI should reference nhl-pace-1p cards',
);

assert(
  cardsPageSource.includes('1P projection') &&
    cardsPageSource.includes('Ref line') &&
    cardsPageSource.includes('Delta'),
  'cards UI should render dedicated 1P projection context row',
);

console.log('✅ NHL 1P projection source contract tests passed');
