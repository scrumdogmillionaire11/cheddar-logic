/*
 * Verifies edge-verification tag/transform behavior stays explicit and non-ambiguous.
 * Run: node web/src/__tests__/game-card-edge-verification-tags.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const tagsPath = path.resolve('web/src/lib/game-card/tags.ts');
const tagsSource = fs.readFileSync(tagsPath, 'utf8');

const transformPath = path.resolve('web/src/lib/game-card/transform.ts');
const transformSource = fs.readFileSync(transformPath, 'utf8');

console.log('🧪 Game card edge-verification tags source tests');

assert(
  tagsSource.includes("import { hasEdgeVerificationSignals } from '../play-decision/decision-logic';"),
  'tags.ts should use shared edge verification helper import',
);

assert(
  tagsSource.includes('return hasEdgeVerificationSignals(card.play);'),
  'hasEdgeVerification should delegate to shared helper',
);

assert(
  transformSource.includes("reasonCodesUnique.push('DOWNGRADED_EDGE_SANITY_NON_TOTAL');"),
  'transform should explicitly mark downgraded edge-sanity outcomes',
);

assert(
  transformSource.includes("reasonCodesUnique.push('BLOCKED_BET_VERIFICATION_REQUIRED');"),
  'transform should add blocked-bet verification reason code',
);

assert(
  transformSource.includes("pick = `${pickWithContext} (Verification Required)`;"),
  'transform should preserve side/market pick context when verification blocks bet',
);

console.log('✅ Game card edge-verification tags source tests passed');
