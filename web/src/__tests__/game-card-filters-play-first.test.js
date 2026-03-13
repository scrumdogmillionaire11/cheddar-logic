/*
 * Verifies play-first filter behavior in filters.ts source.
 * Run: npm --prefix web run test:filters:play-first
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/lib/game-card/filters.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Play-first filter source tests');

assert(
  source.includes('const playMarket = card.play?.market;'),
  'filters.ts should read market from card.play first',
);

assert(
  /if\s*\(\s*playMarket\s*&&\s*playMarket\s*!==\s*'NONE'\s*&&\s*filters\.markets\.includes\(playMarket\)\s*\)/.test(
    source,
  ),
  'filters.ts should short-circuit market filtering on play.market',
);

assert(
  /return\s+card\.drivers\.some\(\(d\)\s*=>\s*filters\.markets\.includes\(d\.market\)\);/.test(
    source,
  ),
  'filters.ts should keep driver-market fallback when play is missing',
);

assert(
  source.includes('const displayAction = getPlayDisplayAction(card.play);') &&
    source.includes("if (!displayAction || displayAction === 'PASS')"),
  'filters.ts should derive status from play display action before legacy fallbacks',
);

console.log('✅ Play-first filter source tests passed');
