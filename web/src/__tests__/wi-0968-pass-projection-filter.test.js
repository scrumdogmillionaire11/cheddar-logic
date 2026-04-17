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

assert.ok(
  sharedSource.includes('export function isActionableProjectionPlay('),
  'legacy shared projection actionable helper should remain available for non-provider callers',
);

assert.ok(
  contextSource.includes('createProjectionFilterCard(game, play1p)') &&
    contextSource.includes("evaluateCardFilter(filterCard, f, 'projections')"),
  'CardsPageContext must use the canonical card predicate when building projectionItems',
);

assert.ok(
  !listSource.includes('.filter(({ play }) => isActionableProjectionPlay(play))'),
  'CardsList must not apply a second projection actionability filter after provider filtering',
);

console.log('✅ WI-0968 PASS projection filter regression test passed');
