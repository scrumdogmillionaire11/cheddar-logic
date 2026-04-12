/*
 * Verifies /api/games and transform preserve precise missing-data root causes.
 * Run: node web/src/__tests__/api-games-missing-data-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const gamesRoutePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const gamesRouteHandlerPath = path.resolve(
  __dirname,
  '../../src/lib/games/route-handler.ts',
);
const cardsPagePath = path.resolve(__dirname, '../../src/components/cards/CardsPageContext.tsx');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const gamesRouteHandlerSource = fs.readFileSync(gamesRouteHandlerPath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('🧪 API games missing-data contract tests');

assert(
  gamesRouteSource.includes("export { GET } from '@/lib/games/route-handler';"),
  '/api/games route.ts should delegate to the shared route-handler implementation',
);

assert(
  gamesRouteHandlerSource.includes('FROM odds_ingest_failures') &&
    gamesRouteHandlerSource.includes('hasOdds || hasPlays || hasIngestFailure'),
  '/api/games should preserve recent ingest-failure rows instead of dropping all no-odds/no-play games',
);

assert(
  gamesRouteHandlerSource.includes('ingest_failure_reason_code') &&
    gamesRouteHandlerSource.includes('ingest_failure_reason_detail'),
  '/api/games should expose ingest failure metadata for downstream classification',
);

assert(
  cardsPageSource.includes("codes.includes('MISSING_DATA_TEAM_MAPPING')") &&
    cardsPageSource.includes("codes.includes('MISSING_DATA_PROJECTION_INPUTS')"),
  'cards diagnostics buckets should recognize mapping and projection-input failures explicitly',
);

// Duplicate-game dedup contract
assert(
  gamesRouteHandlerSource.includes('deduplicatedRows') &&
    gamesRouteHandlerSource.includes('byMatchup') &&
    gamesRouteHandlerSource.includes('odds_captured_at'),
  '/api/games should deduplicate same-matchup rows, keeping the one with latest odds',
);

assert(
  gamesRouteHandlerSource.includes('deduped_count'),
  '/api/games debug metadata should expose how many duplicate rows were collapsed',
);

assert(
  gamesRouteHandlerSource.includes('selectAuthoritativeTruePlay(plays)') &&
    gamesRouteHandlerSource.includes('truePlayMap.set(canonicalGameId, authoritativePlay)'),
  '/api/games should build true_play from a single authoritative selector path',
);

assert(
  gamesRouteHandlerSource.includes(
    'card_display_log remains historical/analytics',
  ) && !gamesRouteHandlerSource.includes('FROM card_display_log'),
  '/api/games true_play authority should not query card_display_log as a live authority source',
);

assert(
  gamesRouteHandlerSource.includes('if (activeRunIds.length > 0)') &&
    gamesRouteHandlerSource.includes('const missingGameIds = allQueryableIds.filter(') &&
    gamesRouteHandlerSource.includes('buildCardsSql(missingGameIds, \'\')'),
  '/api/games should use the same authority selector in active-run and no-active-run coverage paths',
);

console.log('✅ API games missing-data contract tests passed');
