/*
 * Verifies total projection source wiring and redundant-model suppression:
 * 1) /api/games maps driverInputs.expected_total into projected-total recovery
 * 2) Cards UI prefers full-game totals-call cards before evidence projections
 * 3) Cards UI keeps NHL pace totals + NBA total-projection fallbacks
 * 4) Cards UI suppresses redundant "Model:" line when canonical projection matches
 * 5) NHL cards use one normalized total projection in visible UI copy
 * 6) Model lean indicators are collapsible
 *
 * Run: node web/src/__tests__/cards-total-projection-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const gamesRoutePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const cardsPagePath = path.resolve(__dirname, '../../src/components/cards-page-client.tsx');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('🧪 total projection source contract tests');

assert(
  gamesRouteSource.includes('driverInputs?.expected_total'),
  '/api/games should map driverInputs.expected_total for projected total normalization',
);

assert(
  gamesRouteSource.includes('const missingGameIds = allQueryableIds.filter('),
  '/api/games should fallback per missing game_id when active runs are partial',
);

assert(
  gamesRouteSource.includes('fallbackRows.length > 0'),
  '/api/games should merge fallback card rows to prevent driver-loss degradation',
);

assert(
  gamesRouteSource.includes('TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD') &&
    gamesRouteSource.includes('emitTotalProjectionDriftWarnings'),
  '/api/games should include non-blocking total projection drift warnings for canonical vs fallback plays',
);

assert(
  gamesRouteSource.includes('/api/models/*') &&
    gamesRouteSource.includes('/api/betting/projections') &&
    gamesRouteSource.includes('/api/soccer/slate'),
  '/api/games contract comments should keep legacy endpoint families marked as deprecated references',
);

assert(
  gamesRouteSource.includes("'nba-model-output'") &&
    gamesRouteSource.includes("'nhl-welcome-home'"),
  '/api/games card-type contract should keep legacy evidence aliases for compatibility rows',
);

assert(
  cardsPageSource.includes('function resolvePrimaryTotalProjectionPlay('),
  'cards UI should define a total projection source resolver',
);

assert(
  cardsPageSource.includes("cardType.includes('totals-call')"),
  'cards UI should prioritize full-game totals-call card types for total projection display',
);

assert(
  cardsPageSource.includes("play.cardType === 'nhl-pace-totals'"),
  'cards UI should keep nhl-pace-totals as NHL total projection fallback',
);

assert(
  cardsPageSource.includes("play.cardType === 'nba-total-projection'"),
  'cards UI should keep nba-total-projection as NBA fallback when totals-call is unavailable',
);

assert(
  cardsPageSource.includes('const contextLine1 =') &&
    cardsPageSource.includes('projectedSentence ||'),
  'cards UI should drive visible context through compact market-aware context line selection',
);

assert(
  cardsPageSource.includes('resolveProjectedValueForMarketContext') &&
    cardsPageSource.includes(
      "selectionSide === 'AWAY' ? projectedMargin : -1 * projectedMargin",
    ),
  'cards UI should map spread projections into the selected market side context before percent math',
);

assert(
  cardsPageSource.includes('const projectedTotal =') &&
    cardsPageSource.includes('typeof nhlDecisionProjectionPlay?.projectedTotal') &&
    cardsPageSource.includes('typeof displayPlay.projectedTotal === \'number\''),
  'cards UI should keep deterministic projectedTotal fallback order for visible context',
);

assert(
  !cardsPageSource.includes('Decision (Anchored)') &&
    !cardsPageSource.includes('Projected total (raw pace)'),
  'cards UI should avoid raw/anchored jargon in visible projection labels',
);

assert(
  cardsPageSource.includes('<details') &&
    cardsPageSource.includes('Details') &&
    !cardsPageSource.includes('Model Lean Indicators') &&
    !cardsPageSource.includes('Market Math'),
  'cards UI should consolidate advanced content into a single Details drawer',
);

console.log('✅ total projection source contract tests passed');
