/*
 * Contract checks for shared projection-surface card types.
 * Run: node --import tsx/esm web/src/__tests__/projection-surface-contract.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECTION_SURFACE_CARD_TYPES,
  PROJECTION_SURFACE_CARD_TYPES_SQL,
  isProjectionSurfaceCardType,
} from '../lib/games/projection-surface.ts';
import { DEFAULT_PROJECTIONS_FILTERS } from '../lib/game-card/filters.ts';

console.log('🧪 Projection-surface contract tests');

assert.deepEqual(PROJECTION_SURFACE_CARD_TYPES, [
  'nhl-pace-1p',
  'mlb-f5',
  'mlb-f5-ml',
  'mlb-full-game',
  'mlb-full-game-ml',
  'mlb-pitcher-k',
]);

assert.equal(isProjectionSurfaceCardType('mlb-f5'), true);
assert.equal(isProjectionSurfaceCardType('MLB-F5-ML'), true);
assert.equal(isProjectionSurfaceCardType('mlb-full-game'), true);
assert.equal(isProjectionSurfaceCardType('mlb-pitcher-k'), true);
assert.equal(isProjectionSurfaceCardType('nba-total-projection'), false);

for (const cardType of PROJECTION_SURFACE_CARD_TYPES) {
  assert.ok(
    PROJECTION_SURFACE_CARD_TYPES_SQL.includes(`'${cardType}'`),
    `SQL list should include ${cardType}`,
  );
}

assert.deepEqual(
  DEFAULT_PROJECTIONS_FILTERS.cardTypes,
  PROJECTION_SURFACE_CARD_TYPES,
  'Projection filter defaults must use full shared projection-surface contract',
);

const testsDir = path.dirname(new URL(import.meta.url).pathname);
const cardsRouteSource = fs.readFileSync(
  path.resolve(testsDir, '../app/api/cards/route.ts'),
  'utf8',
);
const cardsGameSource = fs.readFileSync(
  path.resolve(testsDir, '../app/api/cards/[gameId]/route.ts'),
  'utf8',
);
const gamesHandlerSource = fs.readFileSync(
  path.resolve(testsDir, '../lib/games/route-handler.ts'),
  'utf8',
);

assert.ok(
  cardsRouteSource.includes('PROJECTION_SURFACE_CARD_TYPES_SQL') &&
    cardsRouteSource.includes('isProjectionSurfaceCardType('),
  'Cards route must consume shared projection-surface contract',
);
assert.ok(
  cardsGameSource.includes('PROJECTION_SURFACE_CARD_TYPES_SQL') &&
    cardsGameSource.includes('isProjectionSurfaceCardType('),
  'Per-game cards route must consume shared projection-surface contract',
);
assert.ok(
  gamesHandlerSource.includes("import { isProjectionSurfaceCardType } from '@/lib/games/projection-surface'"),
  'Games route handler must consume shared projection-surface helper',
);

console.log('✅ Projection-surface contract tests passed');
