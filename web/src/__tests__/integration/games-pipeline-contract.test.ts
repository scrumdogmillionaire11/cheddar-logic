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
const resultsRoutePath = path.join(repoRoot, 'web/src/app/api/results/route.ts');
const transformPath = path.join(repoRoot, 'web/src/lib/game-card/transform.ts');
const cardsPath = path.join(
  repoRoot,
  'web/src/components/cards-page-client.tsx',
);
const resultsPagePath = path.join(repoRoot, 'web/src/app/results/page.tsx');
const displayVerdictPath = path.join(
  repoRoot,
  'web/src/lib/game-card/display-verdict.ts',
);

const routeSource = fs.readFileSync(routePath, 'utf8');
const resultsRouteSource = fs.readFileSync(resultsRoutePath, 'utf8');
const transformSource = fs.readFileSync(transformPath, 'utf8');
const cardsSource = fs.readFileSync(cardsPath, 'utf8');
const resultsPageSource = fs.readFileSync(resultsPagePath, 'utf8');
const displayVerdictSource = fs.readFileSync(displayVerdictPath, 'utf8');

console.log('🧪 Games pipeline v2 source contract tests');

assert.ok(
  routeSource.includes('if (wave1Eligible) {') &&
    routeSource.includes('if (!play.decision_v2) {') &&
    routeSource.includes('applyWave1DecisionFields(play);') &&
    routeSource.includes('true_play: truePlayMap.get(row.game_id) ?? null'),
  'API route must require decision_v2 for wave-1 and map verdict fields from worker output',
);

assert.ok(
  !routeSource.includes('repair_applied') &&
    !routeSource.includes('repair_rule_id') &&
    !routeSource.includes('repair_stats:'),
  'API route must not expose legacy repair metadata',
);

assert.ok(
  resultsRouteSource.includes('cdl.id AS display_log_id') &&
    resultsRouteSource.includes('cdl.displayed_at AS displayed_at') &&
    resultsRouteSource.includes('PARTITION BY') &&
    resultsRouteSource.includes('game_id,') &&
    resultsRouteSource.includes("COALESCE(market_type, '')") &&
    resultsRouteSource.includes("COALESCE(selection, '')") &&
    resultsRouteSource.includes('COALESCE(confidence_pct, -1.0) DESC') &&
    resultsRouteSource.includes(
      "datetime(COALESCE(displayed_at, settled_at, '1970-01-01T00:00:00Z')) DESC",
    ),
  'results route dedupe must partition by game/market signature and rank by canonical display-log lineage timestamp',
);

assert.ok(
  resultsPageSource.includes('Game Sides & Totals') &&
    resultsPageSource.includes('1P Totals') &&
    resultsPageSource.includes('Player Shots Props'),
  'results page must render same-page segment sections for game, 1P total, and player shots props',
);

assert.ok(
  transformSource.includes('selectWave1DecisionCandidate(') &&
    transformSource.includes('game.true_play') &&
    transformSource.includes('decisionV2.official_status') &&
    transformSource.includes('decision_v2: effectiveDecisionV2'),
  'transform must use worker decision_v2 as wave-1 decision source of truth',
);

assert.ok(
  cardsSource.includes('const canonicalTruePlay = originalGame?.true_play;') &&
    cardsSource.includes('const inferredDecision =') &&
    cardsSource.includes('resolvedDecisionV2?.official_status') &&
    cardsSource.includes('const displayDecision =') &&
    cardsSource.includes('const contextLine1 =') &&
    cardsSource.includes('const contextLine2 =') &&
    cardsSource.includes('const hasDetails =') &&
    cardsSource.includes('Details') &&
    !cardsSource.includes('Model Lean Indicators') &&
    !cardsSource.includes('Market Math') &&
    cardsSource.includes('getDisplayVerdict') &&
    cardsSource.includes('formatProjectedSentence'),
  'cards UI must preserve canonical PLAY/LEAN/PASS statuses internally',
);

assert.ok(
  displayVerdictSource.includes("label: 'SLIGHT EDGE'") &&
    displayVerdictSource.includes('Fresh Cheddar') &&
    displayVerdictSource.includes('Mild Cheddar') &&
    displayVerdictSource.includes('Cottage Cheese'),
  'display verdict mapping must provide human-friendly labels and brand sublabels',
);

assert.ok(
  !cardsSource.includes("'HOLD/WATCH'") &&
    !cardsSource.includes('FIRE/HOLD/WATCH rendering paths'),
  'cards UI should not contain legacy verdict rendering labels',
);

assert.ok(
  routeSource.includes("'PROP'") &&
    routeSource.includes('WAVE1_MARKETS') &&
    routeSource.includes("'MONEYLINE'") &&
    routeSource.includes("'SPREAD'") &&
    routeSource.includes("'FIRST_PERIOD'"),
  'WAVE1_MARKETS must include PROP alongside existing market keys so V2 can override V1 for player prop cards (WI-0580)',
);

console.log('✅ Games pipeline v2 source contract tests passed');
