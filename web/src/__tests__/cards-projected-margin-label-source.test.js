/*
 * Verifies spread projected sentence copy includes explicit HOME/AWAY direction.
 * Run: node web/src/__tests__/cards-projected-margin-label-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('Projected margin labeling source-contract checks');

assert(
  cardsPageSource.includes("marketType === 'SPREAD' || marketType === 'PUCKLINE'"),
  'spread projected sentence should branch spread/puckline markets',
);

assert(
  cardsPageSource.includes('formatProjectedMarginDirectional') &&
    cardsPageSource.includes('return projectedMargin >= 0') &&
    cardsPageSource.includes('projectedMargin.toFixed(1)'),
  'spread projected formatter should preserve signed directional output',
);

assert(
  /formatProjectedSentence\(\s*projectedValue,\s*marketLine,\s*primaryReasonCode,\s*effectiveEdgePct,\s*marketType,\s*projectedMargin,\s*\)/m.test(
    cardsPageSource,
  ),
  'projected sentence call should pass marketType and projectedMargin context',
);

assert(
  cardsPageSource.includes('Model spread (home):') &&
    cardsPageSource.includes('Delta:'),
  'spread details should include model-vs-market delta context',
);

console.log('Projected margin labeling source-contract checks passed');
