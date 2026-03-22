/*
 * Source-contract checks for NHL Totals preset projection behavior.
 * Run: node src/__tests__/filters-nhl-totals-preset.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const presetsPath = fs.existsSync(path.resolve('src/lib/game-card/presets.ts'))
  ? path.resolve('src/lib/game-card/presets.ts')
  : path.resolve(__dirname, '../../src/lib/game-card/presets.ts');
const filtersPath = fs.existsSync(path.resolve('src/lib/game-card/filters.ts'))
  ? path.resolve('src/lib/game-card/filters.ts')
  : path.resolve(__dirname, '../../src/lib/game-card/filters.ts');

const presetsSource = fs.readFileSync(presetsPath, 'utf8');
const filtersSource = fs.readFileSync(filtersPath, 'utf8');

console.log('🧪 NHL totals preset source-contract checks');

assert(
  presetsSource.includes("id: 'nhl_totals'"),
  'presets.ts must define nhl_totals preset',
);
assert(
  presetsSource.includes('statuses: FIRE_WATCH_PASS'),
  'nhl_totals preset must include PASS rows',
);
assert(
  presetsSource.includes('onlyGamesWithPicks: false'),
  'nhl_totals preset must not gate on onlyGamesWithPicks',
);
assert(
  presetsSource.includes('requireTotalProjection: true'),
  'nhl_totals preset must require total projection context',
);
assert(
  filtersSource.includes('requireTotalProjection: boolean;'),
  'filters.ts must expose requireTotalProjection in game-mode filters',
);
assert(
  filtersSource.includes('function filterByTotalProjection('),
  'filters.ts must implement total projection predicate',
);
assert(
  filtersSource.includes(
    '.filter((card) => filterByTotalProjection(card, filters))',
  ),
  'game filter pipeline must enforce total projection predicate',
);

console.log('✅ NHL totals preset source-contract checks passed');
