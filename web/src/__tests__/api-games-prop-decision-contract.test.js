/*
 * Route source contract for NHL props decision-first payload fields.
 * Run: node web/src/__tests__/api-games-prop-decision-contract.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const routeSource = fs.readFileSync(
  path.resolve('web/src/lib/games/route-handler.ts'),
  'utf8',
);

const requiredFields = [
  'verdict',
  'lean_side',
  'line',
  'display_price',
  'projection',
  'line_delta',
  'fair_prob',
  'implied_prob',
  'prob_edge_pp',
  'ev',
  'l5_mean',
  'l5_trend',
  'why',
  'flags',
];

for (const field of requiredFields) {
  assert(
    routeSource.includes(`${field}:`),
    `Expected /api/games route to expose prop_decision.${field}`,
  );
}

assert(
  routeSource.includes('(payload as Record<string, unknown>).prop_decision') &&
    routeSource.includes('payloadPlay?.prop_decision'),
  'Expected /api/games route to read prop_decision from both top-level and play payloads',
);

assert(
  routeSource.includes('prop_decision: normalizedPropDecision'),
  'Expected /api/games route to publish normalized prop_decision',
);

assert(
  routeSource.includes('prop_display_state?: \'PLAY\' | \'WATCH\' | \'PROJECTION_ONLY\';') &&
    routeSource.includes('rawPropDisplayState') &&
    routeSource.includes('prop_display_state: normalizedPropDisplayState'),
  'Expected /api/games route to preserve prop_display_state for projection-first prop rows',
);

assert(
  routeSource.includes("'nhl-player-blk'"),
  'Expected /api/games route to include nhl-player-blk in the NHL prop contract path',
);

assert(
  routeSource.includes("cardRow.card_type === 'mlb-pitcher-k'") &&
    routeSource.includes("play.canonical_market_key === 'pitcher_strikeouts'"),
  'Expected /api/games route to keep MLB pitcher-K dedupe scoped to pitcher_strikeouts rows, not every MLB PROP row',
);

assert(
  routeSource.includes('market_bookmaker?: string | null;') &&
    routeSource.includes('(payload as Record<string, unknown>).market_bookmaker') &&
    routeSource.includes('payloadPlay?.market_bookmaker') &&
    routeSource.includes('market_bookmaker: normalizedMarketBookmaker'),
  'Expected /api/games route to preserve market_bookmaker from payload normalization through emitted play rows',
);

console.log('✅ API games prop decision contract test passed');
