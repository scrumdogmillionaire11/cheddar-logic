/*
 * WI-0968 regression: PASS projection rows must not leak into projections mode.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());

const sharedSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/shared.ts'),
  'utf8',
);
const contextSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/CardsPageContext.tsx'),
  'utf8',
);
const listSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/CardsList.tsx'),
  'utf8',
);
const cardsApiSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/app/api/cards/route.ts'),
  'utf8',
);

assert.ok(
  sharedSource.includes('export function isActionableProjectionPlay('),
  'legacy shared projection actionable helper should remain available for non-provider callers',
);

assert.ok(
  contextSource.includes('createProjectionFilterCard(game, anchorPlay)') &&
    contextSource.includes("evaluateCardFilter(filterCard, f, 'projections')"),
  'CardsPageContext must use the canonical card predicate when building projectionItems',
);

assert.ok(
  contextSource.includes('const actionableProjectionPlays = projectionPlays.filter(') &&
    contextSource.includes('hasActionableProjectionCall') &&
    contextSource.includes('if (actionableProjectionPlays.length === 0) continue;'),
  'CardsPageContext must fail closed by filtering PASS/non-actionable projection plays before ProjectionCard rendering',
);

assert.ok(
  cardsApiSource.includes('isProjectionSurfaceType &&') &&
    cardsApiSource.includes('!hasActionableProjectionCall(normalizedPayload)') &&
    cardsApiSource.includes('return [];'),
  '/api/cards must exclude PASS/non-actionable projection-surface payload rows before response serialization',
);

assert.ok(
  !listSource.includes('.filter(({ play }) => isActionableProjectionPlay(play))'),
  'CardsList must not apply a second projection actionability filter after provider filtering',
);

console.log('✅ WI-0968 PASS projection filter regression test passed');
