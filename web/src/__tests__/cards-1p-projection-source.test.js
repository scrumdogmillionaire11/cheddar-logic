/*
 * Verifies NHL 1P projection display wiring remains intact after totals-source priority updates:
 * 1) API normalization maps expected_1p_total into projectedTotal
 * 2) Cards UI keeps nhl-pace-1p as the 1P source
 * 3) Cards UI totals resolver exists without changing 1P source contract
 *
 * Run: node web/src/__tests__/cards-1p-projection-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const gamesRoutePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const cardsRoutePath = path.resolve(__dirname, '../../src/app/api/cards/route.ts');
const cardsByGameRoutePath = path.resolve(__dirname, '../../src/app/api/cards/[gameId]/route.ts');
const cardsGameCardPath = path.resolve(__dirname, '../../src/components/cards/GameCardItem.tsx');
const cardsSharedPath = path.resolve(__dirname, '../../src/components/cards/shared.ts');
const transformPath = path.resolve(__dirname, '../../src/lib/game-card/transform.ts');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const cardsRouteSource = fs.readFileSync(cardsRoutePath, 'utf8');
const cardsByGameRouteSource = fs.readFileSync(cardsByGameRoutePath, 'utf8');
const cardsPageSource =
  fs.readFileSync(cardsGameCardPath, 'utf8') +
  '\n' +
  fs.readFileSync(cardsSharedPath, 'utf8');
const transformSource = fs.readFileSync(transformPath, 'utf8');

console.log('🧪 NHL 1P projection source contract tests');

assert(
  gamesRouteSource.includes('driverInputs?.expected_1p_total'),
  '/api/games should map driverInputs.expected_1p_total for 1P projection display',
);

assert(
  gamesRouteSource.includes('driverInputs?.projection_final') &&
    gamesRouteSource.includes('driverInputs?.classification'),
  '/api/games should map projection_final and classification from 1P driver inputs',
);

assert(
  cardsRouteSource.includes('meta.model_endpoint = null;') &&
    cardsByGameRouteSource.includes('meta.model_endpoint = null;'),
  '/api/cards routes should preserve legacy model_endpoint metadata compatibility when absent',
);

assert(
  cardsRouteSource.includes('/api/models/*') &&
    cardsByGameRouteSource.includes('/api/models/*'),
  '/api/cards route comments should keep legacy endpoint families marked as deprecated references',
);

assert(
  cardsPageSource.includes("cardType === 'nhl-pace-1p'"),
  'cards UI should reference nhl-pace-1p cards',
);

assert(
  cardsPageSource.includes('resolvePrimaryTotalProjectionPlay'),
  'cards UI should include total projection resolver while preserving 1P source behavior',
);

assert(
  cardsPageSource.includes('1P projection') &&
    cardsPageSource.includes('1P call') &&
    cardsPageSource.includes('Goalie context'),
  'cards UI should render dedicated 1P projection context row with pass-first fields',
);

assert(
  transformSource.includes('PASS_NO_ACTIONABLE_PLAY'),
  'transform should label evidence-only/no-play states as no actionable play, not driver-load failure',
);

// WI-0511: verify unclassified_no_play_pipeline fallback is fully replaced
assert(
  !transformSource.includes("'fetch_failure:unclassified_no_play_pipeline'"),
  'WI-0511: transform must not emit generic unclassified_no_play_pipeline fallback token',
);

assert(
  transformSource.includes("'fetch_failure:play_producer_no_output'"),
  'WI-0511: transform must use play_producer_no_output for play-producer-present but no-output case',
);

assert(
  transformSource.includes("'FIRST_PERIOD_NO_PROJECTION'"),
  'WI-0511: FIRST_PERIOD_NO_PROJECTION must be in explicit-no-edge recognition set so 1P PASS cards are not unclassified',
);

assert(
  transformSource.includes("'WATCHDOG'"),
  'WI-0511: WATCHDOG fragment must be in fetch-failure recognition set',
);

assert(
  transformSource.includes("'GOALIE'"),
  'WI-0511: GOALIE fragment must be in fetch-failure recognition set',
);

// WI-0377 additions: wave-1 canonical math sourcing contracts

assert(
  gamesRouteSource.includes('normalizedDecisionV2?.fair_prob') ||
    gamesRouteSource.includes('decision_v2?.fair_prob'),
  '/api/games normalizedPFair cascade must prefer decision_v2.fair_prob for wave-1 plays',
);

assert(
  gamesRouteSource.includes("period?: string | null;") ||
    gamesRouteSource.includes("period?: string"),
  '/api/games Play interface must include period field on market_context.wager for 1P cards',
);

assert(
  cardsPageSource.includes('!decisionV2 && totalFallbackDecision') ||
    cardsPageSource.includes('!decisionV2 &&\n') ||
    cardsPageSource.includes('!decisionV2 && livePrice'),
  'cards UI resolvedDecisionV2 must not substitute another play\'s decision_v2 when primary play already has one',
);

assert(
  cardsPageSource.includes("!decisionV2 && livePrice != null"),
  'cards UI resolvedImpliedProb must guard live-price inference behind !decisionV2 check for wave-1 plays',
);

console.log('✅ NHL 1P projection source contract tests passed');
