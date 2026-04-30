/*
 * Contract test: NHL 1P rows survive the projection-results surfacing pipeline.
 *
 * Run: node --import tsx/esm web/src/__tests__/nhl-1p-projection-surfacing.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECTION_RESULTS_PAGE_FAMILIES,
  PROJECTION_RESULTS_FAMILY_OPTIONS,
  PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES,
  PROJECTION_RESULTS_SUPPORTED_FAMILY_SET,
} from '../lib/results/projection-results-contract.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('nhl-1p-projection-surfacing: running');

// ── 1. NHL_1P_TOTAL is a first-class page family ──────────────────────────────

assert.ok(
  PROJECTION_RESULTS_PAGE_FAMILIES.includes('NHL_1P_TOTAL'),
  'NHL_1P_TOTAL must be in PROJECTION_RESULTS_PAGE_FAMILIES',
);

// ── 2. Family pills include an NHL 1P option that maps to NHL_1P_TOTAL ────────

const nhl1pOption = PROJECTION_RESULTS_FAMILY_OPTIONS.find(
  (opt) => opt.id === 'NHL_1P',
);
assert.ok(nhl1pOption, 'FAMILY_OPTIONS must include an NHL_1P pill');
assert.ok(
  nhl1pOption.families.includes('NHL_1P_TOTAL'),
  'NHL_1P pill must list NHL_1P_TOTAL in its families array',
);

// ── 3. NHL_1P_TOTAL passes the supported-family gate ─────────────────────────

assert.ok(
  PROJECTION_RESULTS_SUPPORTED_FAMILY_SET.has('NHL_1P_TOTAL'),
  'NHL_1P_TOTAL must be in SUPPORTED_FAMILY_SET',
);

// ── 4. Alias tokens normalize to NHL_1P_TOTAL ─────────────────────────────────

assert.strictEqual(
  PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES['NHL_1P_OU'],
  'NHL_1P_TOTAL',
  'NHL_1P_OU alias must resolve to NHL_1P_TOTAL',
);
assert.strictEqual(
  PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES['NHL_1P_O/U'],
  'NHL_1P_TOTAL',
  'NHL_1P_O/U alias must resolve to NHL_1P_TOTAL',
);

// ── 5. Unsupported player-stat families are excluded ─────────────────────────

const unsupportedFamilies = [
  'NHL_PLAYER_SHOTS',
  'NHL_PLAYER_SHOTS_1P',
  'NHL_PLAYER_BLOCKS',
  'NBA_TOTAL',
  'MLB_PITCHER_K',
];
for (const family of unsupportedFamilies) {
  assert.ok(
    !PROJECTION_RESULTS_SUPPORTED_FAMILY_SET.has(family),
    `${family} must NOT be in SUPPORTED_FAMILY_SET — it is not a results-page family`,
  );
  assert.ok(
    !PROJECTION_RESULTS_PAGE_FAMILIES.includes(family),
    `${family} must NOT be in PROJECTION_RESULTS_PAGE_FAMILIES`,
  );
}

// ── 6. Route source consumes the shared contract ─────────────────────────────

const routeSource = fs.readFileSync(
  path.join(__dirname, '../app/api/results/projection-settled/route.ts'),
  'utf8',
);
assert.ok(
  routeSource.includes("from '@/lib/results/projection-results-contract'"),
  'projection-settled route must import from the shared projection-results-contract module',
);
assert.ok(
  routeSource.includes('PROJECTION_RESULTS_PAGE_FAMILIES'),
  'projection-settled route must use PROJECTION_RESULTS_PAGE_FAMILIES for its family allowlist',
);
assert.ok(
  routeSource.includes('requestedFamily') && routeSource.includes('queryFamilies'),
  'projection-settled route must support ?family query param for server-side family scoping',
);

// ── 7. Client source consumes the shared contract ────────────────────────────

const clientSource = fs.readFileSync(
  path.join(__dirname, '../components/results/ProjectionAccuracyClient.tsx'),
  'utf8',
);
assert.ok(
  clientSource.includes("from '@/lib/results/projection-results-contract'"),
  'ProjectionAccuracyClient must import from the shared projection-results-contract module',
);
assert.ok(
  !clientSource.includes("const FAMILY_OPTIONS"),
  'ProjectionAccuracyClient must not define FAMILY_OPTIONS locally — it should import from the contract',
);
assert.ok(
  !clientSource.includes("const FAMILY_TOKEN_ALIASES"),
  'ProjectionAccuracyClient must not define FAMILY_TOKEN_ALIASES locally — it should import from the contract',
);
assert.ok(
  !clientSource.includes("const SUPPORTED_FAMILY_SET"),
  'ProjectionAccuracyClient must not define SUPPORTED_FAMILY_SET locally — it should import from the contract',
);

console.log('nhl-1p-projection-surfacing: all assertions passed');
