/*
 * Verifies projection-only rows are excluded from betting card surfaces.
 * Run: npm --prefix web run test:cards:projection-exclusion
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const apiCardsSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/app/api/cards/route.ts'),
  'utf8',
);
const apiCardsByGameSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/app/api/cards/[gameId]/route.ts'),
  'utf8',
);
const apiGamesSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/lib/games/route-handler.ts'),
  'utf8',
);
const transformSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/lib/game-card/transform/index.ts'),
  'utf8',
);
const modeTabsSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/CardsModeTabs.tsx'),
  'utf8',
);
const cardsPageContextSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/CardsPageContext.tsx'),
  'utf8',
);
const cardsSharedSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/shared.ts'),
  'utf8',
);
const gameCardItemSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/GameCardItem.tsx'),
  'utf8',
);
const cardsQuerySource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/lib/cards/query.ts'),
  'utf8',
);
const payloadClassifierSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/lib/cards/payload-classifier.ts'),
  'utf8',
);
const projectionSurfaceSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/lib/games/projection-surface.ts'),
  'utf8',
);

console.log('🧪 Cards projection exclusion source tests');

for (const [label, source] of [
  ['/api/cards', apiCardsSource],
  ['/api/cards/[gameId]', apiCardsByGameSource],
]) {
  const cardsReadContractSource = [
    source,
    cardsQuerySource,
    payloadClassifierSource,
  ].join('\n');
  assert.ok(
    cardsReadContractSource.includes('buildBettingSurfacePayloadPredicate(') &&
      cardsReadContractSource.includes("$.decision_basis_meta.decision_basis") &&
      cardsReadContractSource.includes("$.basis") &&
      cardsReadContractSource.includes("$.execution_status") &&
      cardsReadContractSource.includes("$.prop_display_state") &&
      cardsReadContractSource.includes("$.market_context.wager.line_source") &&
      cardsReadContractSource.includes("$.prop_decision.projection_source") &&
      cardsReadContractSource.includes('!isBettingSurfacePayload(normalizedPayload)'),
    `${label} should hard-filter projection-only JSON payloads in SQL and response serialization`,
  );
}

assert.ok(
  payloadClassifierSource.includes('getBettingSurfacePayloadDropReason') &&
    payloadClassifierSource.includes('PROJECTION_ONLY_BASIS') &&
    payloadClassifierSource.includes('PROJECTION_ONLY_EXECUTION_STATUS') &&
    payloadClassifierSource.includes('PROJECTION_ONLY_LINE_SOURCE') &&
    payloadClassifierSource.includes('SYNTHETIC_FALLBACK_PROJECTION_SOURCE') &&
    payloadClassifierSource.includes(
      'return getBettingSurfacePayloadDropReason(payload) === null;',
    ),
  'payload classifier should expose reason-coded projection-only drops without changing visibility predicate semantics',
);

assert.ok(
  apiCardsSource.includes('buildCardsDropDiagnostics') &&
    apiCardsSource.includes("searchParams.has('_diag')") &&
    apiCardsSource.includes('by_reason') &&
    apiCardsSource.includes('by_card_type') &&
    apiCardsSource.includes('PROJECTION_ONLY_LINE_SOURCE') &&
    apiCardsSource.includes('SYNTHETIC_FALLBACK_PROJECTION_SOURCE'),
  '/api/cards should expose internal _diag drop-reason counters for projection-only exclusions',
);

assert.ok(
  apiGamesSource.includes('function isProjectionOnlyPlayPayload(play: Play): boolean') &&
    apiGamesSource.includes("play.basis === 'PROJECTION_ONLY'") &&
    apiGamesSource.includes("play.execution_status === 'PROJECTION_ONLY'") &&
    apiGamesSource.includes("play.prop_display_state === 'PROJECTION_ONLY'") &&
    apiGamesSource.includes("projectionSource === 'SYNTHETIC_FALLBACK'") &&
    apiGamesSource.includes('const isProjectionSurfaceType =') &&
    apiGamesSource.includes('isProjectionSurfaceCardType(cardRow.card_type)') &&
    projectionSurfaceSource.includes("'mlb-f5'") &&
    apiGamesSource.includes(
      'if (isProjectionOnlyPlayPayload(play) && !isPropMarket && !isProjectionSurfaceType) {',
    ) &&
    apiGamesSource.includes('continue;'),
  '/api/games should strip generic projection-only rows while preserving designated projection-surface card types',
);

assert.ok(
  apiGamesSource.includes('const isProjectionSurfaceType =') &&
    !apiGamesSource.includes("cardRow.card_type === 'nhl-moneyline-call'") &&
    !apiGamesSource.includes("cardRow.card_type === 'nhl-totals-call'") &&
    apiGamesSource.includes(
      'if (isProjectionOnlyPlayPayload(play) && !isPropMarket && !isProjectionSurfaceType) {',
    ),
  '/api/games should allow NHL ML/totals through when EXECUTABLE and only drop them when explicitly PROJECTION_ONLY',
);

assert.ok(
  transformSource.includes('function isProjectionOnlyCardPlay(play: ApiPlay): boolean') &&
    transformSource.includes('!isProjectionOnlyCardPlay(game.true_play)') &&
    transformSource.includes('!isProjectionOnlyCardPlay(play) &&') &&
    transformSource.includes('if (play.market_type !== \'PROP\') continue;') &&
    transformSource.includes('if (isProjectionOnlyPropPlay(play, propDecision)) {') &&
    transformSource.includes('shouldExcludeProjectionOnlyGameSurface(game)') &&
    transformSource.includes('isRenderableGameSurfacePlay(game, play)'),
  'card transforms should exclude projection-only rows from game-line and player-props surfaces',
);

assert.ok(
  modeTabsSource.includes('Game Props') &&
    modeTabsSource.includes("onModeChange('projections')"),
  '/cards mode tabs should expose Game Props as a dedicated projection surface',
);

assert.ok(
  cardsPageContextSource.includes("modeParam === 'projections'"),
  '/cards should support projections mode via URL param',
);

assert.ok(
  cardsSharedSource.includes('export function isActionableProjectionPlay(') &&
    cardsSharedSource.includes("decision_v2?: {") &&
    cardsSharedSource.includes("signal === 'PASS' || signal === 'HOLD' || signal === 'WATCH'"),
  'projection play actionability helper must reject PASS/HOLD/WATCH using decision_v2 + status/action signals',
);

assert.ok(
  gameCardItemSource.includes("const baseDriverLine =") &&
    gameCardItemSource.includes("visibleDecision === 'PASS'") &&
    gameCardItemSource.includes("const hasDriverDetails =") &&
    gameCardItemSource.includes("visibleDecision !== 'PASS' &&") &&
    gameCardItemSource.includes("visibleDecision !== 'PASS' && <MarketSignalPills pills={deriveMarketSignals(card)} />"),
  'PASS cards must suppress driver and market-signal internals in GameCardItem',
);

console.log('✅ Cards projection exclusion source tests passed');
