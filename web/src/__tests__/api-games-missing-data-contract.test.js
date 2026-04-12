/*
 * Verifies /api/games and transform preserve precise missing-data root causes.
 * Run (from repo root): cd web && node --import tsx/esm src/__tests__/api-games-missing-data-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { selectAuthoritativeTruePlay } from '../lib/games/route-handler.js';
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

// ── Behavioral: fixture-level authority determinism ──────────────────────────

function makePlay(id, officialStatus, edgeDeltaPct, supportScore = 0.5, createdAt = '2026-04-11T14:00:00.000Z') {
  return {
    source_card_id: id,
    cardType: 'mlb-total-call',
    cardTitle: 'Model total',
    prediction: 'OVER',
    confidence: 0.71,
    tier: 'BEST',
    reasoning: 'test',
    evPassed: true,
    driverKey: `driver-${id}`,
    projectedTotal: null,
    edge: edgeDeltaPct,
    kind: 'PLAY',
    created_at: createdAt,
    decision_v2: {
      official_status: officialStatus,
      edge_delta_pct: edgeDeltaPct,
      support_score: supportScore,
    },
  };
}

// 1. Active-run path: PLAY status rank beats higher edge LEAN candidate
{
  const winner = selectAuthoritativeTruePlay([
    makePlay('lean-high-edge', 'LEAN', 0.12),
    makePlay('play-low-edge', 'PLAY', 0.03),
  ]);
  assert.strictEqual(winner?.source_card_id, 'play-low-edge',
    'active-run: PLAY must outrank LEAN regardless of edge');
  assert.strictEqual(winner?.true_play_authority_source, 'CARD_PAYLOADS_DECISION_V2',
    'active-run: winning play must carry ADR-0003 authority metadata');
}

// 2. No-active-run path: same selector, same winner, EVIDENCE rows excluded
{
  const evidencePlay = { ...makePlay('evidence-high', 'PLAY', 0.99), kind: 'EVIDENCE' };
  const winner = selectAuthoritativeTruePlay([
    evidencePlay,
    makePlay('play-normal', 'PLAY', 0.06),
  ]);
  assert.strictEqual(winner?.source_card_id, 'play-normal',
    'no-active-run: EVIDENCE kind must be excluded from true_play authority');
}

// 3. Replay stability: calling selector twice with identical plays returns same winner
{
  const plays = [
    makePlay('alpha', 'PLAY', 0.08, 0.7),
    makePlay('beta',  'PLAY', 0.05, 0.9),
  ];
  const first  = selectAuthoritativeTruePlay(plays);
  const second = selectAuthoritativeTruePlay(plays);
  assert.strictEqual(first?.source_card_id, second?.source_card_id,
    'replay-stability: same inputs must produce same winner on repeated calls');
  assert.strictEqual(first?.source_card_id, 'alpha',
    'replay-stability: higher edge_delta_pct wins when status is equal');
}

// 4. PASS-only set returns null — no phantom true_play after a settlement sweep
{
  const winner = selectAuthoritativeTruePlay([makePlay('pass-card', 'PASS', 0.15)]);
  assert.strictEqual(winner, null,
    'settlement sweep: PASS-only eligible set must return null, not a phantom true_play');
}

console.log('✅ API games missing-data contract tests passed');
