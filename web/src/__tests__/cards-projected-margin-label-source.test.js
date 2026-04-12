/*
 * Verifies spread projected sentence copy includes explicit HOME/AWAY direction.
 * Run: node web/src/__tests__/cards-projected-margin-label-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const cardsGameCardPath = path.resolve(__dirname, '../../src/components/cards/GameCardItem.tsx');
const cardsHelpersPath = path.resolve(__dirname, '../../src/components/cards/game-card-helpers.tsx');
const cardsPageSource =
  fs.readFileSync(cardsGameCardPath, 'utf8') +
  '\n' +
  fs.readFileSync(cardsHelpersPath, 'utf8');

console.log('Projected margin labeling source-contract checks');

assert(
  cardsPageSource.includes("marketType === 'SPREAD' || marketType === 'PUCKLINE'"),
  'spread projected sentence should branch spread/puckline markets',
);

assert(
  cardsPageSource.includes('formatProjectedMarginTeamFacing') &&
    cardsPageSource.includes('return `${favoredTeam} by ${Math.abs(projectedMargin).toFixed(1)}`;'),
  'spread projected formatter should render team-facing output',
);

assert(
  /formatProjectedSentence\(\s*projectedValue,\s*marketLine,\s*primaryReasonCode,\s*effectiveEdgePct,\s*marketType,\s*projectedMargin,\s*card\.homeTeam,\s*card\.awayTeam,\s*\)/m.test(
    cardsPageSource,
  ),
  'projected sentence call should pass marketType, projectedMargin, and matchup context',
);

assert(
  cardsPageSource.includes('Model spread (home):') &&
    cardsPageSource.includes('Delta:'),
  'spread details should include model-vs-market delta context',
);

console.log('Projected margin labeling source-contract checks passed');
