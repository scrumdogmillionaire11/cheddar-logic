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
  'filters.ts should read market from card.play first'
);

assert(
  source.includes("if (playMarket && playMarket !== 'NONE')"),
  'filters.ts should short-circuit market filtering on play.market'
);

assert(
  source.includes('return card.drivers.some(d => filters.markets.includes(d.market));'),
  'filters.ts should keep driver-market fallback when play is missing'
);

assert(
  source.includes('let status: ExpressionStatus = card.play?.status || card.expressionChoice?.status || \'PASS\';'),
  'filters.ts should use play.status before expressionChoice/driver-derived status'
);

console.log('✅ Play-first filter source tests passed');