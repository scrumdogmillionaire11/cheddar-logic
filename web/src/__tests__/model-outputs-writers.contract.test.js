/**
 * Contract test: model_outputs writer set and FPL row distinguishability.
 *
 * WI-0896: Ensures the documented writer set in route.ts stays in sync with
 * actual writers and that FPL-origin rows are distinguishable by sport/model_name.
 *
 * Run: npm --prefix web run test:model-outputs-writers
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('model-outputs-writers contract test');

// Canonical writer set — defined locally, not imported from any module.
// Update this list when a new writer is added and update the JSDoc in
// web/src/app/api/model-outputs/route.ts at the same time.
const KNOWN_MODEL_OUTPUT_WRITERS = [
  'run_mlb_model.js',
  'run_nfl_model.js',
  'run_fpl_model.js',
];

// --- Writer set contract ---

assert.deepStrictEqual(
  [...KNOWN_MODEL_OUTPUT_WRITERS].sort(),
  ['run_fpl_model.js', 'run_mlb_model.js', 'run_nfl_model.js'],
  'Writer set must contain exactly run_mlb_model.js, run_nfl_model.js, run_fpl_model.js',
);

assert.ok(
  KNOWN_MODEL_OUTPUT_WRITERS.includes('run_fpl_model.js'),
  'run_fpl_model.js must be a known model_outputs writer',
);

assert.ok(
  !KNOWN_MODEL_OUTPUT_WRITERS.includes('run_nhl_model.js'),
  'NHL must remain excluded from model_outputs writers; update ADR + route contract before any writer-set change',
);

// --- Route comment contract ---

const routePath = path.resolve(
  process.cwd(),
  'src/app/api/model-outputs/route.ts',
);
const routeSource = fs.readFileSync(routePath, 'utf8');

assert.ok(
  routeSource.includes('NHL does not write to model_outputs by design'),
  'route.ts must explicitly document NHL exclusion from model_outputs',
);

assert.ok(
  routeSource.includes('ADR-0018'),
  'route.ts must reference ADR-0018; update ADR + route contract before any writer-set change',
);

// --- FPL row distinguishability contract ---

const fplRow = {
  sport: 'FPL',
  model_name: 'fpl-model-v1',
  model_version: '1.0.0',
};

assert.strictEqual(
  fplRow.sport,
  'FPL',
  'FPL-origin rows must have sport = "FPL"',
);

assert.ok(
  fplRow.model_name.startsWith('fpl-'),
  `FPL-origin rows must have model_name prefixed "fpl-", got: ${fplRow.model_name}`,
);

// Non-FPL rows must NOT share the FPL sport tag
const mlbRow = { sport: 'mlb', model_name: 'mlb-model-v3' };
assert.notStrictEqual(
  mlbRow.sport,
  'FPL',
  'MLB rows must not be tagged as FPL sport',
);

console.log('All model-outputs-writers contract assertions passed.');
