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
    cardsPageSource.includes(
      "return `${favoredSide} by ${Math.abs(projectedMargin).toFixed(1)}`;",
    ),
  'spread projected formatter should include HOME/AWAY and absolute margin',
);

assert(
  /formatProjectedSentence\(\s*projectedValue,\s*marketLineValue,\s*primaryReasonCode,\s*effectiveEdgePct,\s*marketType,\s*projectedMargin,\s*\)/m.test(
    cardsPageSource,
  ),
  'projected sentence call should pass marketType and projectedMargin context',
);

assert(
  cardsPageSource.includes('Margin math (HOME - AWAY)'),
  'Market Math spread row should include explicit HOME - AWAY sign math',
);

console.log('Projected margin labeling source-contract checks passed');
