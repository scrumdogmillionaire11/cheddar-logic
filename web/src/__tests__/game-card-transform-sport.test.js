/*
 * Verifies sport normalization behavior in transform.ts source.
 * Run: npm --prefix web run test:transform:sport
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/lib/game-card/transform.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Transform sport normalization source tests');

assert(
  source.includes("return 'UNKNOWN';"),
  'normalizeSport should preserve unknown sports as UNKNOWN'
);

assert(
  source.includes("const initialTags = normalizedSport === 'UNKNOWN' ? ['unknown_sport'] : [];"),
  'transform should add unknown_sport tag for unknown sports'
);

assert(
  !source.includes("// Default fallback\n  return 'NHL';"),
  'normalizeSport must not coerce unknown sports to NHL'
);

console.log('✅ Transform sport normalization source tests passed');