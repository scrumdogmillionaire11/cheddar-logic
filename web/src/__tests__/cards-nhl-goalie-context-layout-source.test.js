/*
 * Verifies NHL 1P details include goalie context and call metadata.
 * Run: node web/src/__tests__/cards-nhl-goalie-context-layout-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const cardsPagePath = path.resolve(__dirname, '../../src/components/cards-page-client.tsx');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('NHL goalie context details source-contract checks');

assert(
  cardsPageSource.includes('hasOnePeriodTotalContext') &&
    cardsPageSource.includes('1P projection:') &&
    cardsPageSource.includes('1P call:'),
  'NHL 1P details should render projection and call context',
);

assert(
  cardsPageSource.includes('Details') &&
    cardsPageSource.includes('Goalie context:'),
  'NHL goalie context should live in the consolidated Details drawer',
);

assert(
  /1P call:[\s\S]*?Goalie context:/m.test(
    cardsPageSource,
  ),
  'Goalie context should render alongside 1P projection/call context in details',
);

assert(
  cardsPageSource.includes('Status:') &&
    cardsPageSource.includes('goalieContextStatuses.join'),
  'Goalie status should remain visible in details context',
);

console.log('NHL goalie context details source-contract checks passed');
