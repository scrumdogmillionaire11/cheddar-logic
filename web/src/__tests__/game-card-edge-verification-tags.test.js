/*
 * Verifies edge-verification tag/transform behavior stays explicit and non-ambiguous.
 * Run: node web/src/__tests__/game-card-edge-verification-tags.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const tagsPath = path.resolve(__dirname, '../../src/lib/game-card/tags.ts');
const tagsSource = fs.readFileSync(tagsPath, 'utf8');

const transformPath = path.resolve(__dirname, '../../src/lib/game-card/transform.ts');
const transformSource = fs.readFileSync(transformPath, 'utf8');

const routePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const routeSource = fs.readFileSync(routePath, 'utf8');

const cardsPageClientPath = path.resolve(__dirname, '../../src/components/cards-page-client.tsx');
const cardsPageClientSource = fs.readFileSync(cardsPageClientPath, 'utf8');

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
  transformSource.includes('const edgeVerificationBlocked = hasEdgeVerificationSignals({'),
  'transform should detect wave-1 verification state via shared helper',
);

assert(
  transformSource.includes("'BLOCKED_BET_VERIFICATION_REQUIRED'"),
  'transform should preserve blocked-bet verification reason in wave-1 mapping',
);

assert(
  transformSource.includes('code: EDGE_SANITY_GATE_CODE,'),
  'transform should add edge-verification blocking gate for wave-1 cards',
);

assert(
  transformSource.includes("pick = `${pickWithContext} (Verification Required)`;"),
  'transform should preserve side/market pick context when verification blocks bet',
);

assert(
  transformSource.includes('`$\{wave1PickText\} (Verification Required)`'),
  'transform should preserve side/market pick context for wave-1 verification cards',
);

assert(
  routeSource.includes("sharpStatusRaw === 'PENDING_VERIFICATION'"),
  'games route should preserve PENDING_VERIFICATION sharp price status',
);

assert(
  cardsPageClientSource.includes("if (status === 'PENDING_VERIFICATION')"),
  'cards page should format PENDING_VERIFICATION explicitly',
);

assert(
  cardsPageClientSource.includes("return 'Priced, pending verification';"),
  'cards page should describe verification pricing as trusted with caution, not unpriced',
);

console.log('✅ Game card edge-verification tags source tests passed');
