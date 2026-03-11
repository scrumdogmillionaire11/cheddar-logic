/*
 * Verifies NHL 1P projection display wiring remains intact after totals-source priority updates:
 * 1) API normalization maps expected_1p_total into projectedTotal
 * 2) Cards UI keeps nhl-pace-1p as the 1P source
 * 3) Cards UI totals resolver exists without changing 1P source contract
 *
 * Run: node web/src/__tests__/cards-1p-projection-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const gamesRoutePath = path.resolve('web/src/app/api/games/route.ts');
const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');
const transformPath = path.resolve('web/src/lib/game-card/transform.ts');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');
const transformSource = fs.readFileSync(transformPath, 'utf8');

console.log('🧪 NHL 1P projection source contract tests');

assert(
  gamesRouteSource.includes('driverInputs?.expected_1p_total'),
  '/api/games should map driverInputs.expected_1p_total for 1P projection display',
);

assert(
  gamesRouteSource.includes('driverInputs?.projection_final') &&
    gamesRouteSource.includes('driverInputs?.classification'),
  '/api/games should map projection_final and classification from 1P driver inputs',
);

assert(
  cardsPageSource.includes("cardType === 'nhl-pace-1p'"),
  'cards UI should reference nhl-pace-1p cards',
);

assert(
  cardsPageSource.includes('resolvePrimaryTotalProjectionPlay'),
  'cards UI should include total projection resolver while preserving 1P source behavior',
);

assert(
  cardsPageSource.includes('1P projection') &&
    cardsPageSource.includes('Classification') &&
    cardsPageSource.includes('Goalie context'),
  'cards UI should render dedicated 1P projection context row with pass-first fields',
);

assert(
  transformSource.includes('PASS_NO_ACTIONABLE_PLAY'),
  'transform should label evidence-only/no-play states as no actionable play, not driver-load failure',
);

console.log('✅ NHL 1P projection source contract tests passed');
