/*
 * Verifies both /api/cards endpoints share a canonical eligibility layer.
 * Run: node web/src/__tests__/api-cards-eligibility-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const cardsRoute = fs.readFileSync(path.join(repoRoot, 'web/src/app/api/cards/route.ts'), 'utf8');
const cardsGameRoute = fs.readFileSync(path.join(repoRoot, 'web/src/app/api/cards/[gameId]/route.ts'), 'utf8');
const querySource = fs.readFileSync(path.join(repoRoot, 'web/src/lib/cards/query.ts'), 'utf8');
const payloadSource = fs.readFileSync(path.join(repoRoot, 'web/src/lib/cards/payload-classifier.ts'), 'utf8');
const projectionSource = fs.readFileSync(path.join(repoRoot, 'web/src/lib/games/projection-surface.ts'), 'utf8');

console.log('🧪 Cards eligibility contract tests');

// 1. nhl-player-shots must be in the projection surface allowlist
assert.ok(
  projectionSource.includes("'nhl-player-shots'"),
  'projection-surface.ts must include nhl-player-shots in the allowlist',
);

// 2. ACTIVE_EXCLUDED_STATUSES must be canonical — exported from query.ts, not defined in route files
assert.ok(
  querySource.includes('export const ACTIVE_EXCLUDED_STATUSES'),
  'query.ts must export ACTIVE_EXCLUDED_STATUSES as the canonical source',
);
assert.ok(
  !cardsRoute.includes("const ACTIVE_EXCLUDED_STATUSES = ["),
  '/api/cards must not define ACTIVE_EXCLUDED_STATUSES locally — import from query.ts',
);
assert.ok(
  !cardsGameRoute.includes("const ACTIVE_EXCLUDED_STATUSES = ["),
  '/api/cards/[gameId] must not define ACTIVE_EXCLUDED_STATUSES locally — import from query.ts',
);

// 3. Both routes must use ACTIVE_EXCLUDED_STATUSES (from query.ts import)
assert.ok(
  cardsRoute.includes('ACTIVE_EXCLUDED_STATUSES'),
  '/api/cards must reference ACTIVE_EXCLUDED_STATUSES from the canonical query.ts export',
);
assert.ok(
  cardsGameRoute.includes('ACTIVE_EXCLUDED_STATUSES'),
  '/api/cards/[gameId] must reference ACTIVE_EXCLUDED_STATUSES from the canonical query.ts export',
);

// 4. Both routes must delegate projection-surface decisions to the canonical shared function
assert.ok(
  cardsRoute.includes('isProjectionSurfaceCardType(') &&
    cardsGameRoute.includes('isProjectionSurfaceCardType('),
  'Both cards routes must delegate projection-surface decisions to isProjectionSurfaceCardType',
);

// 5. Both routes must use the canonical payload eligibility gate
assert.ok(
  cardsRoute.includes('isBettingSurfacePayload(') &&
    cardsGameRoute.includes('isBettingSurfacePayload('),
  'Both cards routes must use isBettingSurfacePayload from payload-classifier.ts',
);

// 6. Both routes must use the canonical SQL payload predicate
assert.ok(
  cardsRoute.includes('buildBettingSurfacePayloadPredicate(') &&
    cardsGameRoute.includes('buildBettingSurfacePayloadPredicate('),
  'Both cards routes must use buildBettingSurfacePayloadPredicate for SQL-layer filtering',
);

// 7. getBettingSurfacePayloadDropReason must be the canonical drop-reason export
assert.ok(
  payloadSource.includes('export function getBettingSurfacePayloadDropReason('),
  'payload-classifier.ts must export getBettingSurfacePayloadDropReason as the canonical drop-reason function',
);

// 8. The [gameId] route must not read NEXT_PUBLIC_ env var — server-only route
assert.ok(
  !cardsGameRoute.includes('NEXT_PUBLIC_ENABLE_CARDS_LIFECYCLE_PARITY'),
  '/api/cards/[gameId] must not read NEXT_PUBLIC_ENABLE_CARDS_LIFECYCLE_PARITY — server-only route must use ENABLE_CARDS_LIFECYCLE_PARITY',
);

// 9. Both routes must use the same lifecycle mode resolver
assert.ok(
  cardsRoute.includes('resolveLifecycleMode(') &&
    cardsGameRoute.includes('resolveLifecycleMode('),
  'Both cards routes must use resolveLifecycleMode from query.ts',
);

console.log('✅ Cards eligibility contract tests passed');
