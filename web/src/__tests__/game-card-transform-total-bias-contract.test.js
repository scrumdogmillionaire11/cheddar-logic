/*
 * Verifies totals consistency gating contract in transform.ts.
 * Run: npm --prefix web run test:transform:total-bias
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/lib/game-card/transform.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Transform total_bias contract source tests');

assert(
  source.includes("const totalBias = game.consistency?.total_bias") || source.includes("const totalBias = game.consistency?.total_bias ??"),
  'transform should read consistency.total_bias from game payload'
);

assert(
  source.includes("resolvedMarketType === 'TOTAL' && totalBias !== 'OK'"),
  'transform should hard-block totals when total_bias is not OK'
);

assert(
  source.includes("reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');"),
  'transform should attach PASS_TOTAL_INSUFFICIENT_DATA when totals are blocked'
);

assert(
  source.includes("tags.push('CONSISTENCY_BLOCK_TOTALS');"),
  'transform should add CONSISTENCY_BLOCK_TOTALS tag when totals are blocked'
);

assert(
  source.includes("status: forcedPass || (resolvedMarketType === 'TOTAL' && totalBias !== 'OK') ? 'PASS' : status"),
  'transform should force PASS status for blocked totals'
);

console.log('✅ Transform total_bias contract source tests passed');
