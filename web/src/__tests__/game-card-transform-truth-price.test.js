/*
 * Verifies truth-vs-price contract behavior in transform.ts source.
 * Run: npm --prefix web run test:transform:truth-price
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/lib/game-card/transform.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Transform truth/price contract source tests');

assert(
  source.includes('lean:') && source.includes('truthStatus:') && source.includes('betAction:'),
  'transform should emit both truth (lean/truthStatus) and price (betAction) fields'
);

assert(
  source.includes('const edge = impliedProb !== undefined ? modelProb - impliedProb : undefined;'),
  'transform should compute edge from model probability vs implied probability'
);

assert(
  source.includes("if (betAction === 'NO_PLAY') {") && source.includes("pick = 'NO PLAY';"),
  'transform should force NO PLAY when price gate blocks action'
);

console.log('✅ Transform truth/price contract source tests passed');
