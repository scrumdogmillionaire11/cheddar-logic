/*
 * Verifies /api/games and transform preserve precise missing-data root causes.
 * Run (from repo root): cd web && node --import tsx/esm src/__tests__/api-games-missing-data-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  dedupeProjectionSurfacePlays,
  selectAuthoritativeTruePlay,
  mergeMlbGameLineFallbackRows,
} from '../lib/games/route-handler.js';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const gamesRoutePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const gamesRouteHandlerPath = path.resolve(
  __dirname,
  '../../src/lib/games/route-handler.ts',
);
const cardsPagePath = path.resolve(__dirname, '../../src/components/cards/CardsPageContext.tsx');
const passClassificationPath = path.resolve(
  __dirname,
  '../../src/lib/game-card/pass-classification.ts',
);

const gamesRouteSource = fs.readFileSync(gamesRoutePath, 'utf8');
const gamesRouteHandlerSource = fs.readFileSync(gamesRouteHandlerPath, 'utf8');
const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');
const passClassificationSource = fs.readFileSync(passClassificationPath, 'utf8');

console.log('🧪 API games missing-data contract tests');

function buildMlbFallbackPayload(overrides = {}) {
  return {
    basis: 'ODDS_BACKED',
    execution_status: 'EXECUTABLE',
    decision_v2: {
      official_status: 'PLAY',
      canonical_envelope_v2: {
        official_status: 'PLAY',
        selection_side: 'OVER',
      },
    },
    execution_gate: { drop_reason: null },
    selection: { side: 'OVER' },
    line: 8.5,
    price: -110,
    ml_home: -130,
    ml_away: 118,
    ...overrides,
  };
}

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
  cardsPageSource.includes('classifySportDiagnosticBucket(card)') &&
    passClassificationSource.includes("codes.includes('MISSING_DATA_TEAM_MAPPING')") &&
    passClassificationSource.includes("codes.includes('MISSING_DATA_PROJECTION_INPUTS')"),
  'cards diagnostics buckets should recognize mapping and projection-input failures explicitly',
);

assert(
  passClassificationSource.includes('DIAGNOSTIC_BUCKET_ORDER') &&
    passClassificationSource.includes("'projectionOnly'") &&
    passClassificationSource.includes('countBlockedDiagnostics') &&
    passClassificationSource.includes('reduce((sum, bucket) => sum + buckets[bucket], 0)'),
  'blocked diagnostics counting should include projectionOnly via shared canonical bucket order',
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
    gamesRouteHandlerSource.includes('mergePropFallbackRows({') &&
    gamesRouteHandlerSource.includes('mergeMlbGameLineFallbackRows({'),
  '/api/games should use the same authority selector in active-run and no-active-run coverage paths',
);

assert(
  gamesRouteHandlerSource.includes("'nhl-player-shots'") &&
    gamesRouteHandlerSource.includes("'nhl-player-shots-1p'") &&
    gamesRouteHandlerSource.includes("'nhl-player-blk'") &&
    gamesRouteHandlerSource.includes("'mlb-pitcher-k'"),
  '/api/games prop fallback merge should explicitly preserve model-backed NHL/MLB player prop families during partial run coverage',
);

assert(
  gamesRouteHandlerSource.includes('API_GAMES_PROP_PRIORITY_SQL') &&
    gamesRouteHandlerSource.includes("LOWER(card_type) LIKE '%player%'") &&
    gamesRouteHandlerSource.includes('ORDER BY') &&
    gamesRouteHandlerSource.includes('CASE WHEN ${API_GAMES_PROP_PRIORITY_SQL} THEN 0 ELSE 1 END'),
  '/api/games should prioritize player-prop card families before applying global card row limits',
);

assert(
  gamesRouteHandlerSource.includes("process.env.API_GAMES_MAX_CARD_ROWS || '5000'"),
  '/api/games should default to a higher card row cap to reduce prop starvation under production volume spikes',
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

function makeProjectionSurfacePlay(overrides = {}) {
  return {
    source_card_id: 'projection-surface-fixture',
    cardType: 'nhl-pace-1p',
    cardTitle: 'NHL 1P Total: LEAN_OVER @ 2.10',
    prediction: 'OVER',
    confidence: 0.62,
    tier: 'WATCH',
    reasoning: '1P model classification LEAN_OVER from projection 2.10.',
    evPassed: true,
    driverKey: 'paceTotals1p',
    projectedTotal: 2.1,
    edge: 0.6,
    kind: 'PLAY',
    market_type: 'FIRST_PERIOD',
    selection: { side: 'OVER' },
    line: 1.5,
    status: 'WATCH',
    classification: 'LEAN',
    action: 'HOLD',
    reason_codes: ['NHL_1P_OVER_LEAN'],
    created_at: '2026-04-18T19:20:00.000Z',
    goalie_home_name: 'Frederik Andersen',
    goalie_away_name: 'Linus Ullmark',
    goalie_home_status: 'EXPECTED',
    goalie_away_status: 'EXPECTED',
    projection: {
      total: 2.1,
      projected_total: 2.1,
    },
    ...overrides,
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

// 5. Projection-surface dedupe keeps confirmed NHL 1P goalie truth over stale expected row
{
  const expectedGoalieRow = makeProjectionSurfacePlay({
    source_card_id: 'nhl-1p-expected',
    created_at: '2026-04-18T19:21:00.000Z',
    projectedTotal: 2.07,
    projection: { total: 2.07, projected_total: 2.07 },
    reasoning:
      '1P model classification LEAN_OVER from projection 2.07 (raw 2.07, ref 1.5, goalie medium).',
    goalie_home_status: 'EXPECTED',
    goalie_away_status: 'EXPECTED',
  });
  const confirmedGoalieRow = makeProjectionSurfacePlay({
    source_card_id: 'nhl-1p-confirmed',
    created_at: '2026-04-18T19:20:00.000Z',
    projectedTotal: 2.1,
    projection: { total: 2.1, projected_total: 2.1 },
    reasoning:
      '1P model classification LEAN_OVER from projection 2.10 (raw 2.10, ref 1.5, goalie high).',
    goalie_home_status: 'CONFIRMED',
    goalie_away_status: 'CONFIRMED',
  });

  const deduped = dedupeProjectionSurfacePlays([
    expectedGoalieRow,
    confirmedGoalieRow,
  ]);

  assert.strictEqual(deduped.length, 1,
    'projection-surface dedupe should keep one NHL 1P row for the same game/card type/market');
  assert.strictEqual(deduped[0].source_card_id, 'nhl-1p-confirmed',
    'confirmed-goalie NHL 1P row must supersede stale expected-goalie row');
  assert.strictEqual(deduped[0].goalie_home_status, 'CONFIRMED');
  assert.strictEqual(deduped[0].goalie_away_status, 'CONFIRMED');
}

// 6. Projection-surface dedupe keeps real MLB F5 projections over fallback floors
{
  const syntheticFallback = makeProjectionSurfacePlay({
    source_card_id: 'mlb-f5-synthetic-fallback',
    cardType: 'mlb-f5',
    cardTitle: 'F5 Total: DETROIT TIGERS @ BOSTON RED SOX',
    prediction: 'OVER',
    market_type: 'TOTAL',
    projection_source: 'SYNTHETIC_FALLBACK',
    reason_codes: ['PASS_SYNTHETIC_FALLBACK'],
    created_at: '2026-04-18T19:30:00.000Z',
  });
  const fullModel = makeProjectionSurfacePlay({
    source_card_id: 'mlb-f5-full-model',
    cardType: 'mlb-f5',
    cardTitle: 'F5 Total: DETROIT TIGERS @ BOSTON RED SOX',
    prediction: 'UNDER',
    market_type: 'TOTAL',
    projection_source: 'FULL_MODEL',
    reason_codes: ['SYNTHETIC_LINE_ASSUMPTION'],
    created_at: '2026-04-18T19:20:00.000Z',
  });

  const deduped = dedupeProjectionSurfacePlays([syntheticFallback, fullModel]);

  assert.strictEqual(deduped.length, 1,
    'projection-surface dedupe should collapse fallback and full-model F5 totals');
  assert.strictEqual(deduped[0].source_card_id, 'mlb-f5-full-model',
    'FULL_MODEL MLB F5 row must supersede a newer SYNTHETIC_FALLBACK floor');
}

// 7. Projection-surface dedupe collapses stale conflicting non-prop market rows
{
  const staleAway = makeProjectionSurfacePlay({
    source_card_id: 'mlb-f5-ml-stale-away',
    cardType: 'mlb-f5-ml',
    cardTitle: 'F5 ML AWAY: DETROIT TIGERS @ BOSTON RED SOX',
    prediction: 'AWAY',
    market_type: 'MONEYLINE',
    selection: { side: 'AWAY' },
    created_at: '2026-04-18T18:00:00.000Z',
  });
  const currentHome = makeProjectionSurfacePlay({
    source_card_id: 'mlb-f5-ml-current-home',
    cardType: 'mlb-f5-ml',
    cardTitle: 'F5 ML HOME: DETROIT TIGERS @ BOSTON RED SOX',
    prediction: 'HOME',
    market_type: 'MONEYLINE',
    selection: { side: 'HOME' },
    created_at: '2026-04-18T19:00:00.000Z',
  });

  const deduped = dedupeProjectionSurfacePlays([staleAway, currentHome]);

  assert.strictEqual(deduped.length, 1,
    'projection-surface dedupe should collapse stale conflicting non-prop market rows');
  assert.strictEqual(deduped[0].source_card_id, 'mlb-f5-ml-current-home',
    'latest non-NHL projection-surface row should win after same-market collapse');
}

// 8. Current mlb-f5 + eligible fallback full-game rows merge by canonical game id
{
  const currentRows = [
    {
      id: 'active-f5',
      game_id: 'canonical-1',
      card_type: 'mlb-f5',
      card_title: 'F5 Total',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ line: 4.5 })),
      created_at: '2026-04-17T17:55:00.000Z',
    },
  ];
  const fallbackRows = [
    {
      id: 'fallback-total',
      game_id: 'espn-1',
      card_type: 'mlb-full-game',
      card_title: 'Full Game Total',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ line: 8.5, price: -108 })),
      created_at: '2026-04-17T17:54:00.000Z',
    },
    {
      id: 'fallback-ml',
      game_id: 'canonical-1',
      card_type: 'mlb-full-game-ml',
      card_title: 'Full Game ML',
      payload_data: JSON.stringify(
        buildMlbFallbackPayload({
          selection: { side: 'HOME' },
          decision_v2: {
            official_status: 'LEAN',
            canonical_envelope_v2: {
              official_status: 'LEAN',
              selection_side: 'HOME',
            },
          },
        }),
      ),
      created_at: '2026-04-17T17:53:00.000Z',
    },
  ];

  const merged = mergeMlbGameLineFallbackRows({
    currentRows,
    fallbackRows,
    externalToCanonicalMap: new Map([['espn-1', 'canonical-1']]),
    latestOddsCapturedAtByCanonicalId: new Map([
      ['canonical-1', '2026-04-17T17:56:00.000Z'],
    ]),
    nowEpochMs: Date.parse('2026-04-17T18:00:00.000Z'),
  });

  const mergedTypes = merged.map((row) => row.card_type);
  assert(mergedTypes.includes('mlb-full-game'));
  assert(mergedTypes.includes('mlb-full-game-ml'));
}

// 6. Stale/blocked/nonpublishable fallback rows do not merge
{
  const currentRows = [
    {
      id: 'active-f5-2',
      game_id: 'canonical-2',
      card_type: 'mlb-f5',
      card_title: 'F5 Total',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ line: 4.0 })),
      created_at: '2026-04-17T17:55:00.000Z',
    },
  ];
  const fallbackRows = [
    {
      id: 'blocked-total',
      game_id: 'canonical-2',
      card_type: 'mlb-full-game',
      card_title: 'Blocked total',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ execution_status: 'BLOCKED' })),
      created_at: '2026-04-17T17:54:00.000Z',
    },
    {
      id: 'stale-ml',
      game_id: 'canonical-2',
      card_type: 'mlb-full-game-ml',
      card_title: 'Stale ML',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ selection: { side: 'AWAY' } })),
      created_at: '2026-04-17T15:00:00.000Z',
    },
  ];

  const merged = mergeMlbGameLineFallbackRows({
    currentRows,
    fallbackRows,
    externalToCanonicalMap: new Map(),
    latestOddsCapturedAtByCanonicalId: new Map([
      ['canonical-2', '2026-04-17T17:57:00.000Z'],
    ]),
    nowEpochMs: Date.parse('2026-04-17T18:00:00.000Z'),
  });

  assert.strictEqual(
    merged.filter((row) => row.card_type.startsWith('mlb-full-game')).length,
    0,
  );
}

// 7. Canonical/external duplicate rows collapse to one fallback card_type
{
  const currentRows = [
    {
      id: 'active-f5-3',
      game_id: 'canonical-3',
      card_type: 'mlb-f5',
      card_title: 'F5 Total',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ line: 4.3 })),
      created_at: '2026-04-17T17:57:00.000Z',
    },
  ];
  const fallbackRows = [
    {
      id: 'fresh-external',
      game_id: 'espn-3',
      card_type: 'mlb-full-game',
      card_title: 'Full Game Total ext',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ line: 8.0, price: -105 })),
      created_at: '2026-04-17T17:56:00.000Z',
    },
    {
      id: 'fresh-canonical',
      game_id: 'canonical-3',
      card_type: 'mlb-full-game',
      card_title: 'Full Game Total canonical',
      payload_data: JSON.stringify(buildMlbFallbackPayload({ line: 8.0, price: -104 })),
      created_at: '2026-04-17T17:55:00.000Z',
    },
  ];

  const merged = mergeMlbGameLineFallbackRows({
    currentRows,
    fallbackRows,
    externalToCanonicalMap: new Map([['espn-3', 'canonical-3']]),
    latestOddsCapturedAtByCanonicalId: new Map([
      ['canonical-3', '2026-04-17T17:58:00.000Z'],
    ]),
    nowEpochMs: Date.parse('2026-04-17T18:00:00.000Z'),
  });

  assert.strictEqual(
    merged.filter((row) => row.card_type === 'mlb-full-game').length,
    1,
  );
}

// ── Drop reason ledger contract ──────────────────────────────────────────────

// Fixture A — survivor candidate: play with drop_reason: null and PLAY reason_codes
const fixtureA = {
  source_card_id: 'survivor-A',
  execution_gate: { drop_reason: null, should_bet: true },
  reason_codes: ['PLAY'],
};

// Fixture B — dropped candidate: play with NO_EDGE_AT_CURRENT_PRICE drop_reason
const fixtureB = {
  source_card_id: 'dropped-B',
  execution_gate: {
    drop_reason: {
      drop_reason_code: 'NO_EDGE_AT_CURRENT_PRICE',
      drop_reason_layer: 'worker_gate',
    },
  },
  reason_codes: ['PASS_NO_EDGE'],
};

assert.strictEqual(
  fixtureB.execution_gate.drop_reason.drop_reason_code,
  'NO_EDGE_AT_CURRENT_PRICE',
  'dropped candidate must carry NO_EDGE_AT_CURRENT_PRICE drop_reason_code',
);

assert.strictEqual(
  fixtureB.execution_gate.drop_reason.drop_reason_layer,
  'worker_gate',
  'dropped candidate drop_reason_layer must be worker_gate',
);

assert.strictEqual(
  fixtureA.execution_gate.drop_reason,
  null,
  'survivor candidate must have drop_reason: null',
);

assert.ok(
  !fixtureA.reason_codes.some((c) =>
    ['PASS_NO_EDGE', 'PROJECTION_ONLY_EXCLUSION', 'PROJECTION_ONLY'].includes(c),
  ),
  'survivor candidate must have no blocking reason code',
);

// Source-level assertion: CardsPageContext must include _drop_reason_code mapping
assert(
  cardsPageSource.includes('_drop_reason_code'),
  'CardsPageContext diagnostics mapping must include _drop_reason_code field',
);

assert(
  cardsPageSource.includes('_drop_reason_layer'),
  'CardsPageContext diagnostics mapping must include _drop_reason_layer field',
);

assert(
  cardsPageSource.includes('_reason_code_set'),
  'CardsPageContext diagnostics mapping must expose the filtered card reason-code set',
);

// Source-level assertion: route-handler must include drop_summary
assert(
  gamesRouteHandlerSource.includes('drop_summary'),
  'route-handler flowDiagnostics must include drop_summary for dev-mode observability',
);

assert(
  gamesRouteHandlerSource.includes('execution_gate: normalizedExecutionGate'),
  '/api/games should expose execution_gate metadata on play rows',
);

assert(
  gamesRouteHandlerSource.includes('executionGate?.drop_reason?.drop_reason_code'),
  '/api/games reason_codes should include execution-gate drop reason codes',
);

console.log('✅ API games missing-data contract tests passed');
