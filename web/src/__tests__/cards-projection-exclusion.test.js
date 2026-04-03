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
    apiGamesSource.includes('if (isProjectionOnlyPlayPayload(play)) {') &&
    apiGamesSource.includes('continue;'),
  '/api/games should strip projection-only play payloads before cards transforms consume them',
);

assert.ok(
  transformSource.includes('function isProjectionOnlyCardPlay(play: ApiPlay): boolean') &&
    transformSource.includes('!isProjectionOnlyCardPlay(game.true_play)') &&
    transformSource.includes('!isProjectionOnlyCardPlay(play) &&') &&
    transformSource.includes("(p) => p.market_type === 'PROP' && !isProjectionOnlyPropPlay(p, p.prop_decision)"),
  'card transforms should exclude projection-only rows from game-line and player-props surfaces',
);

assert.ok(
  !modeTabsSource.includes('Game Props') &&
    !modeTabsSource.includes("onModeChange('projections')"),
  '/cards mode tabs should not expose a projection-only betting surface',
);

assert.ok(
  !cardsPageContextSource.includes("modeParam === 'projections'") &&
    cardsPageContextSource.includes("const safeNextMode = nextMode === 'projections' ? 'game' : nextMode;"),
  '/cards should normalize projection mode requests back to game mode',
);

console.log('✅ Cards projection exclusion source tests passed');
