/*
 * Source-contract checks for NCAAM FT trend quick preset.
 * Run: node src/__tests__/filters-ncaam-ft-trend-preset.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const presetsPath = fs.existsSync(path.resolve('src/lib/game-card/presets.ts'))
  ? path.resolve('src/lib/game-card/presets.ts')
  : path.resolve('web/src/lib/game-card/presets.ts');

const presetsSource = fs.readFileSync(presetsPath, 'utf8');

console.log('NCAAM FT trend preset source-contract checks');

assert(
  presetsSource.includes("id: 'ncaam_ft_trend'"),
  'presets.ts must define ncaam_ft_trend preset',
);
assert(
  presetsSource.includes("sports: ['NCAAM']"),
  'ncaam_ft_trend preset must scope to NCAAM',
);
assert(
  presetsSource.includes("markets: ['SPREAD']"),
  'ncaam_ft_trend preset must scope to spread market',
);
assert(
  presetsSource.includes("cardTypes: ['ncaam-ft-trend', 'ncaam-ft-spread']"),
  'ncaam_ft_trend preset must target FT trend card types',
);
assert(
  presetsSource.includes('statuses: FIRE_WATCH'),
  'ncaam_ft_trend preset must keep actionable statuses',
);

console.log('NCAAM FT trend preset source-contract checks passed');
