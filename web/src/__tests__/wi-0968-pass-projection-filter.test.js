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
  'shared projection actionable helper should be defined',
);

assert.ok(
  contextSource.includes('if (!isActionableProjectionPlay(play1p))'),
  'CardsPageContext must use shared projection actionable helper when building projectionItems',
);

assert.ok(
  listSource.includes('.filter(({ play }) => isActionableProjectionPlay(play))'),
  'CardsList must use shared projection actionable helper as render-time defense-in-depth',
);

console.log('✅ WI-0968 PASS projection filter regression test passed');
