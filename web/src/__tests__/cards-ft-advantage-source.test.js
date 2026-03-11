/*
 * Source-contract checks for NCAAM FT advantage callout on cards.
 * Run: node src/__tests__/cards-ft-advantage-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const cardsPagePath = fs.existsSync(
  path.resolve('src/components/cards-page-client.tsx'),
)
  ? path.resolve('src/components/cards-page-client.tsx')
  : path.resolve('web/src/components/cards-page-client.tsx');

const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('NCAAM FT advantage source-contract checks');

assert(
  cardsPageSource.includes("driver.cardType === 'ncaam-ft-trend'"),
  'cards-page-client must scan for ncaam-ft-trend driver',
);
assert(
  cardsPageSource.includes("driver.cardType === 'ncaam-ft-spread'"),
  'cards-page-client must keep legacy ncaam-ft-spread support',
);
assert(
  cardsPageSource.includes('FT Advantage:'),
  'cards-page-client must render FT Advantage label in Why section',
);
assert(
  cardsPageSource.includes('formatFtTrendInsight('),
  'cards-page-client must format FT trend insight text',
);

console.log('NCAAM FT advantage source-contract checks passed');
