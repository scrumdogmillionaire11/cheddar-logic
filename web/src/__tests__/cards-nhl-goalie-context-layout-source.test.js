/*
 * Verifies NHL 1P Market Math renders goalie context on a separate line.
 * Run: node web/src/__tests__/cards-nhl-goalie-context-layout-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('NHL goalie context layout source-contract checks');

assert(
  cardsPageSource.includes('hasOnePeriodTotalContext') &&
    cardsPageSource.includes('1P projection') &&
    cardsPageSource.includes('1P Call'),
  'NHL 1P market math block should render projection and call context',
);

assert(
  cardsPageSource.includes('className="mt-2 space-y-1"'),
  'NHL 1P market math should use stacked rows for goalie context readability',
);

assert(
  /1P Call[\s\S]*?<\/div>\s*<div className="text-xs font-mono text-cloud\/60">\s*Goalie context/m.test(
    cardsPageSource,
  ),
  'Goalie context should render on a new line below projection/call row',
);

assert(
  cardsPageSource.includes('Status') && cardsPageSource.includes('goalieContextStatuses.join'),
  'Goalie status should remain visible in the goalie context line',
);

console.log('NHL goalie context layout source-contract checks passed');
