/*
 * Cross-layer source contract guard for decision pipeline v2 hard cut.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

const routePath = path.join(repoRoot, 'web/src/app/api/games/route.ts');
const transformPath = path.join(repoRoot, 'web/src/lib/game-card/transform.ts');
const cardsPath = path.join(
  repoRoot,
  'web/src/components/cards-page-client.tsx',
);

const routeSource = fs.readFileSync(routePath, 'utf8');
const transformSource = fs.readFileSync(transformPath, 'utf8');
const cardsSource = fs.readFileSync(cardsPath, 'utf8');

console.log('🧪 Games pipeline v2 source contract tests');

assert.ok(
  routeSource.includes('if (wave1Eligible) {') &&
    routeSource.includes('if (!play.decision_v2) {') &&
    routeSource.includes('applyWave1DecisionFields(play);'),
  'API route must require decision_v2 for wave-1 and map verdict fields from worker output',
);

assert.ok(
  !routeSource.includes('repair_applied') &&
    !routeSource.includes('repair_rule_id') &&
    !routeSource.includes('repair_stats:'),
  'API route must not expose legacy repair metadata',
);

assert.ok(
  transformSource.includes('selectWave1DecisionCandidate(') &&
    transformSource.includes('decisionV2.official_status') &&
    transformSource.includes('decision_v2: decisionV2'),
  'transform must use worker decision_v2 as wave-1 decision source of truth',
);

assert.ok(
  cardsSource.includes("const getStatusBadge = (status: 'PLAY' | 'LEAN' | 'PASS')") &&
    cardsSource.includes('PASS Breakdown') &&
    cardsSource.includes('Model Lean Indicators'),
  'cards UI must render PLAY/LEAN/PASS and show PASS diagnostics',
);

assert.ok(
  !cardsSource.includes("'HOLD/WATCH'") && !cardsSource.includes('FIRE/HOLD/WATCH rendering paths'),
  'cards UI should not contain legacy verdict rendering labels',
);

console.log('✅ Games pipeline v2 source contract tests passed');
