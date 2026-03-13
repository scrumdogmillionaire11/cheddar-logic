/*
 * Verifies total projection source wiring and redundant-model suppression:
 * 1) /api/games maps driverInputs.expected_total into projected-total recovery
 * 2) Cards UI prefers full-game totals-call cards before evidence projections
 * 3) Cards UI keeps NHL pace totals + NBA total-projection fallbacks
 * 4) Cards UI suppresses redundant "Model:" line when canonical projection matches
 *
 * Run: node web/src/__tests__/cards-total-projection-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const gamesRoutePath = path.resolve('web/src/app/api/games/route.ts');
const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');

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
  cardsPageSource.includes('isRedundantModelLine') &&
    cardsPageSource.includes('if (isRedundantModelLine) return null;'),
  'cards UI should suppress redundant Model line when it matches canonical total projection',
);

assert(
  cardsPageSource.includes('resolveProjectedValueForMarketContext') &&
    cardsPageSource.includes(
      "selectionSide === 'AWAY' ? projectedMargin : -1 * projectedMargin",
    ),
  'cards UI should map spread projections into the selected market side context before percent math',
);

assert(
  cardsPageSource.includes('totalProjectionDisplayPlay'),
  'cards UI should use resolved totalProjectionDisplayPlay in header rendering',
);

console.log('✅ total projection source contract tests passed');
