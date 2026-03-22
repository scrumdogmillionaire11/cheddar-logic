/*
 * Verifies /api/games and transform preserve precise missing-data root causes.
 * Run: node web/src/__tests__/api-games-missing-data-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const gamesRoutePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const transformPath = path.resolve(__dirname, '../../src/lib/game-card/transform.ts');
const cardsPagePath = path.resolve(__dirname, '../../src/components/cards-page-client.tsx');

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const transformSource = fs.readFileSync(transformPath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');

console.log('🧪 API games missing-data contract tests');

assert(
  gamesRouteSource.includes('FROM odds_ingest_failures') &&
    gamesRouteSource.includes('hasOdds || hasPlays || hasIngestFailure'),
  '/api/games should preserve recent ingest-failure rows instead of dropping all no-odds/no-play games',
);

assert(
  gamesRouteSource.includes('ingest_failure_reason_code') &&
    gamesRouteSource.includes('ingest_failure_reason_detail'),
  '/api/games should expose ingest failure metadata for downstream classification',
);

assert(
  transformSource.includes("game.ingest_failure_reason_code === 'TEAM_MAPPING_UNMAPPED'") &&
    transformSource.includes("'MISSING_DATA_TEAM_MAPPING'") &&
    transformSource.includes("'MISSING_DATA_PROJECTION_INPUTS'"),
  'transform should classify mapping and projection-input failures with specific reason codes',
);

assert(
  cardsPageSource.includes("codes.includes('MISSING_DATA_TEAM_MAPPING')") &&
    cardsPageSource.includes("codes.includes('MISSING_DATA_PROJECTION_INPUTS')"),
  'cards diagnostics buckets should recognize mapping and projection-input failures explicitly',
);

// Duplicate-game dedup contract
assert(
  gamesRouteSource.includes('deduplicatedRows') &&
    gamesRouteSource.includes('byMatchup') &&
    gamesRouteSource.includes('odds_captured_at'),
  '/api/games should deduplicate same-matchup rows, keeping the one with latest odds',
);

assert(
  gamesRouteSource.includes('deduped_count'),
  '/api/games debug metadata should expose how many duplicate rows were collapsed',
);

console.log('✅ API games missing-data contract tests passed');
