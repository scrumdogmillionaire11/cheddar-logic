/*
 * Cross-layer contract regression guard for worker -> validator -> API -> UI.
 *
 * This test is intentionally source-contract oriented so it can catch drift
 * in canonical decision precedence and totals consistency blocking semantics.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');
const transformPath = path.join(repoRoot, 'web/src/lib/game-card/transform.ts');
const routePath = path.join(repoRoot, 'web/src/app/api/games/route.ts');
const fixtureDir = path.join(
  repoRoot,
  'apps/worker/src/__tests__/fixtures/pipeline-card-payload',
);

const transformSource = fs.readFileSync(transformPath, 'utf8');
const routeSource = fs.readFileSync(routePath, 'utf8');

const nhlFixture = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, 'nhl-watch-total-low-coverage.json'), 'utf8'),
);
const nbaFixture = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, 'nba-watch-total-low-coverage.json'), 'utf8'),
);
const ncaamFixture = JSON.parse(
  fs.readFileSync(
    path.join(fixtureDir, 'ncaam-pass-unrepairable-legacy.json'),
    'utf8',
  ),
);

console.log('🧪 Games pipeline contract source tests');

assert.ok(
  routeSource.includes('const resolvedAction: Play[\'action\'] | undefined =') &&
    routeSource.includes('normalizedAction ??') &&
    routeSource.includes('actionFromClassification(normalizedClassification)') &&
    routeSource.includes('statusFromAction(resolvedAction) ?? normalizedStatus'),
  'API route should enforce action-first canonical precedence with controlled fallback',
);

assert.ok(
  routeSource.includes("'PASS_UNREPAIRABLE_LEGACY'") &&
    routeSource.includes("'LEGACY_TITLE_INFERENCE_USED'"),
  'API route should emit explicit legacy reason codes (no silent repair)',
);

assert.ok(
  transformSource.includes("resolvedMarketType === 'TOTAL' &&") &&
    transformSource.includes("totalBias !== 'OK'") &&
    transformSource.includes("totalBias !== 'UNKNOWN'"),
  'UI transform should only block totals on explicit non-OK consistency states',
);

assert.strictEqual(nhlFixture.sport, 'NHL', 'NHL fixture should exist');
assert.strictEqual(nbaFixture.sport, 'NBA', 'NBA fixture should exist');
assert.strictEqual(ncaamFixture.sport, 'NCAAM', 'NCAAM fixture should exist');

assert.strictEqual(nhlFixture.decision.status, 'WATCH');
assert.strictEqual(nbaFixture.decision.status, 'WATCH');
assert.ok(nhlFixture.decision.coverage < 0.45);
assert.ok(nbaFixture.decision.coverage < 0.45);

assert.strictEqual(ncaamFixture.legacy_play.action, 'PASS');
assert.strictEqual(ncaamFixture.legacy_play.market_type, 'INFO');
assert.ok(
  ncaamFixture.legacy_play.reason_codes.includes('PASS_UNREPAIRABLE_LEGACY'),
);

console.log('✅ Games pipeline contract source tests passed');
