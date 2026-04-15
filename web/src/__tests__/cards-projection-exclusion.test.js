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

console.log('🧪 Cards projection exclusion source tests');

for (const [label, source] of [
  ['/api/cards', apiCardsSource],
  ['/api/cards/[gameId]', apiCardsByGameSource],
]) {
  assert.ok(
    source.includes('buildBettingSurfacePayloadPredicate(') &&
      source.includes("$.decision_basis_meta.decision_basis") &&
      source.includes("$.basis") &&
      source.includes("$.execution_status") &&
      source.includes("$.prop_display_state") &&
      source.includes("$.market_context.wager.line_source") &&
      source.includes("$.prop_decision.projection_source") &&
      source.includes('!isBettingSurfacePayload(normalizedPayload)'),
    `${label} should hard-filter projection-only JSON payloads in SQL and response serialization`,
  );
}

assert.ok(
  apiGamesSource.includes('function isProjectionOnlyPlayPayload(play: Play): boolean') &&
    apiGamesSource.includes("play.basis === 'PROJECTION_ONLY'") &&
    apiGamesSource.includes("play.execution_status === 'PROJECTION_ONLY'") &&
    apiGamesSource.includes("play.prop_display_state === 'PROJECTION_ONLY'") &&
    apiGamesSource.includes("projectionSource === 'SYNTHETIC_FALLBACK'") &&
    apiGamesSource.includes('const isProjectionSurfaceCardType =') &&
    apiGamesSource.includes("cardRow.card_type === 'mlb-f5'") &&
    apiGamesSource.includes(
      'if (isProjectionOnlyPlayPayload(play) && !isPropMarket && !isProjectionSurfaceCardType) {',
    ) &&
    apiGamesSource.includes('continue;'),
  '/api/games should strip generic projection-only rows while preserving designated projection-surface card types',
);

assert.ok(
  apiGamesSource.includes('const isProjectionSurfaceCardType =') &&
    !apiGamesSource.includes("cardRow.card_type === 'nhl-moneyline-call'") &&
    !apiGamesSource.includes("cardRow.card_type === 'nhl-totals-call'") &&
    apiGamesSource.includes(
      'if (isProjectionOnlyPlayPayload(play) && !isPropMarket && !isProjectionSurfaceCardType) {',
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

console.log('✅ Cards projection exclusion source tests passed');
