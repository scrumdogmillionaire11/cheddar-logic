/*
 * Verifies stored decision_v2 official_status remains authoritative in the web transform.
 * Run: node --import tsx/esm web/src/__tests__/game-card-decision-authority.test.ts
 */


{
  const game = buildGame(undefined, 0.2);
  game.consistency = { total_bias: 'INSUFFICIENT_DATA' };
  game.plays = [
    {
      cardType: 'mlb-full-game',
      cardTitle: 'Full Game Total UNDER: KANSAS CITY ROYALS @ DETROIT TIGERS',
      prediction: 'UNDER' as const,
      confidence: 0.6,
      tier: 'WATCH' as const,
      reasoning: 'FG TOTAL DEGRADED_MODEL mean 6.23 vs line 8.5 edge -2.27',
      evPassed: true,
      driverKey: 'driver-native-total',
      edge: 0.28,
      edge_pct: 0.28,
      edge_points: -2.27,
      model_prob: 0.8,
      market_type: 'TOTAL' as const,
      selection: { side: 'UNDER', team: 'DETROIT TIGERS' },
      kind: 'PLAY' as const,
      line: 8.5,
      price: -105,
      status: 'WATCH' as const,
      classification: 'LEAN' as const,
      action: 'HOLD' as const,
      created_at: '2026-04-15T19:09:03.000Z',
      reason_codes: ['MODEL_DEGRADED_INPUTS'],
      consistency: {
        total_bias: 'OK' as const,
      },
    },
  ];
  game.true_play = game.plays[0];

  const card = transformToGameCard(game);
  assert.strictEqual(card.play?.action, 'HOLD');
  assert.strictEqual(card.play?.classification, 'LEAN');
  assert.ok(!card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA'));
}
import assert from 'node:assert';

import { transformToGameCard } from '../lib/game-card/transform/index';
import { selectAuthoritativeTruePlay } from '../lib/games/route-handler';

type OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';

function buildGame(officialStatus?: OfficialStatus, edge = 0.04) {
  const play = {
    cardType: 'mlb-full-game',
    cardTitle: 'Model total',
    prediction: 'OVER' as const,
    confidence: 0.72,
    tier: 'BEST' as const,
    reasoning: 'Projection edge on the over.',
    evPassed: true,
    driverKey: `driver-${officialStatus ?? 'fallback'}`,
    edge,
    model_prob: 0.56,
    market_type: 'TOTAL' as const,
    selection: { side: 'OVER', team: 'Roadrunners' },
    kind: 'PLAY' as const,
    line: 8.5,
    price: -110,
    status: 'FIRE' as const,
    classification: 'BASE' as const,
    action: 'FIRE' as const,
    created_at: '2026-04-11T14:00:00.000Z',
    decision_v2: officialStatus
      ? {
          official_status: officialStatus,
          direction: 'OVER' as const,
          fair_prob: 0.56,
          implied_prob: 0.52,
          edge_pct: edge,
          edge_delta_pct: edge,
          play_tier:
            officialStatus === 'PASS'
              ? ('BAD' as const)
              : officialStatus === 'LEAN'
                ? ('OK' as const)
                : ('GOOD' as const),
          support_score: 0.67,
          conflict_score: 0.12,
          drivers_used: ['total_projection'],
          driver_reasons: ['edge'],
          primary_reason_code: officialStatus === 'PASS' ? 'NO_EDGE' : 'EDGE_CLEAR',
          watchdog_status: 'OK' as const,
          watchdog_reason_codes: [],
          sharp_price_status: 'CHEDDAR' as const,
          price_reason_codes: [],
          missing_data: {
            missing_fields: [],
            source_attempts: [],
            severity: 'INFO' as const,
          },
          consistency: {
            pace_tier: 'NORMAL',
            event_env: 'NORMAL',
            event_direction_tag: 'NEUTRAL',
            vol_env: 'NORMAL',
            total_bias: 'OK',
          },
          pricing_trace: { line_source: 'odds_snapshot', price_source: 'odds_snapshot' },
          pipeline_version: 'v2' as const,
          decided_at: '2026-04-11T14:00:00.000Z',
        }
      : undefined,
  };

  return {
    id: `game-${officialStatus ?? 'fallback'}`,
    gameId: `game-${officialStatus ?? 'fallback'}`,
    sport: 'MLB',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    gameTimeUtc: '2026-04-11T19:00:00.000Z',
    status: 'scheduled',
    createdAt: '2026-04-11T14:00:00.000Z',
    odds: {
      h2hHome: -120,
      h2hAway: 105,
      total: 8.5,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-11T14:05:00.000Z',
    },
    plays: [play],
    true_play: play,
  };
}

function buildAuthorityCandidate(params: {
  id: string;
  status: OfficialStatus;
  edge: number;
  supportScore?: number;
  createdAt?: string;
}) {
  return {
    source_card_id: params.id,
    cardType: 'mlb-full-game',
    cardTitle: 'Model total',
    prediction: 'OVER' as const,
    confidence: 0.71,
    tier: 'BEST' as const,
    reasoning: 'Authority candidate',
    evPassed: true,
    driverKey: `driver-${params.id}`,
    projectedTotal: 8.7,
    edge: params.edge,
    kind: 'PLAY' as const,
    created_at: params.createdAt ?? '2026-04-11T14:00:00.000Z',
    decision_v2: {
      direction: 'OVER' as const,
      support_score: params.supportScore ?? 0.5,
      conflict_score: 0.1,
      drivers_used: ['total_projection'],
      driver_reasons: ['edge'],
      watchdog_status: 'OK' as const,
      watchdog_reason_codes: [],
      missing_data: {
        missing_fields: [],
        source_attempts: [],
        severity: 'INFO' as const,
      },
      consistency: {
        pace_tier: 'NORMAL',
        event_env: 'NORMAL',
        event_direction_tag: 'NEUTRAL',
        vol_env: 'NORMAL',
        total_bias: 'OK',
      },
      fair_prob: 0.57,
      implied_prob: 0.52,
      edge_pct: params.edge,
      edge_delta_pct: params.edge,
      edge_method: 'TOTAL_DELTA' as const,
      edge_line_delta: 0.5,
      edge_lean: 'OVER' as const,
      proxy_used: false,
      proxy_capped: false,
      exact_wager_valid: true,
      pricing_trace: {
        market_type: 'TOTAL',
        market_side: 'OVER',
        market_line: 8.5,
        market_price: -110,
        line_source: 'odds_snapshot',
        price_source: 'odds_snapshot',
      },
      sharp_price_status: 'CHEDDAR' as const,
      price_reason_codes: [],
      official_status: params.status,
      play_tier:
        params.status === 'PLAY'
          ? ('GOOD' as const)
          : params.status === 'LEAN'
            ? ('OK' as const)
            : ('BAD' as const),
      primary_reason_code: params.status === 'PASS' ? 'NO_EDGE' : 'EDGE_CLEAR',
      pipeline_version: 'v2' as const,
      decided_at: params.createdAt ?? '2026-04-11T14:00:00.000Z',
    },
  };
}

console.log('🧪 Game card decision authority tests');

{
  const card = transformToGameCard(buildGame('PASS', 0.04));
  assert.strictEqual(card.play?.action ?? 'PASS', 'PASS');
  assert.strictEqual(card.play?.status ?? 'PASS', 'PASS');
}

{
  const card = transformToGameCard(buildGame('LEAN', 0.07));
  assert.strictEqual(card.play?.action, 'HOLD');
  assert.strictEqual(card.play?.classification, 'LEAN');
}

{
  const card = transformToGameCard(buildGame(undefined, 0.06));
  const reasonSource = (card.play as { reason_source?: string } | undefined)?.reason_source;
  assert.strictEqual(reasonSource, 'NON_CANONICAL_RENDER_FALLBACK');
}

{
  const selected = selectAuthoritativeTruePlay([
    buildAuthorityCandidate({ id: 'lean-high-edge', status: 'LEAN', edge: 0.09, supportScore: 0.9 }),
    buildAuthorityCandidate({ id: 'play-lower-edge', status: 'PLAY', edge: 0.05, supportScore: 0.4 }),
  ]);
  assert.strictEqual(selected?.source_card_id, 'play-lower-edge');
}

{
  const selected = selectAuthoritativeTruePlay([
    buildAuthorityCandidate({ id: 'play-lower-edge', status: 'PLAY', edge: 0.05, supportScore: 0.4 }),
    buildAuthorityCandidate({ id: 'play-higher-edge', status: 'PLAY', edge: 0.08, supportScore: 0.2 }),
  ]);
  assert.strictEqual(selected?.source_card_id, 'play-higher-edge');
  assert.strictEqual(selected?.true_play_authority_source, 'CARD_PAYLOADS_DECISION_V2');
  assert.strictEqual(selected?.true_play_authority_version, 'ADR-0003');
}

{
  const selected = selectAuthoritativeTruePlay([
    buildAuthorityCandidate({ id: 'pass-only', status: 'PASS', edge: 0.12, supportScore: 0.8 }),
  ]);
  assert.strictEqual(selected, null);
}

{
  const moneylinePlay = {
    cardType: 'mlb-full-game-ml',
    cardTitle: 'Full Game ML: TORONTO BLUE JAYS @ MILWAUKEE BREWERS',
    prediction: 'HOME' as const,
    confidence: 0.5,
    tier: 'WATCH' as const,
    reasoning: 'Degraded ML edge',
    evPassed: true,
    driverKey: 'driver-moneyline',
    edge: 0.07,
    edge_pct: 0.07,
    model_prob: 0.57,
    market_type: 'MONEYLINE' as const,
    selection: { side: 'HOME' as const, team: 'MILWAUKEE BREWERS' },
    kind: 'PLAY' as const,
    price: 110,
    status: 'WATCH' as const,
    classification: 'LEAN' as const,
    action: 'HOLD' as const,
    created_at: '2026-04-15T19:09:03.000Z',
    reason_codes: ['FULL_GAME_ML_DEGRADED'],
  };
  const totalPlay = {
    cardType: 'mlb-full-game',
    cardTitle: 'Full Game Total UNDER: TORONTO BLUE JAYS @ MILWAUKEE BREWERS',
    prediction: 'UNDER' as const,
    confidence: 0.6,
    tier: 'WATCH' as const,
    reasoning: 'Stronger total edge',
    evPassed: true,
    driverKey: 'driver-total',
    edge: 0.18,
    edge_pct: 0.18,
    edge_points: -1.2,
    model_prob: 0.68,
    market_type: 'TOTAL' as const,
    selection: { side: 'UNDER' as const },
    kind: 'PLAY' as const,
    line: 7.5,
    price: -110,
    status: 'WATCH' as const,
    classification: 'LEAN' as const,
    action: 'HOLD' as const,
    created_at: '2026-04-15T19:09:04.000Z',
    reason_codes: ['MODEL_DEGRADED_INPUTS'],
  };
  const game = {
    ...buildGame(undefined, 0.06),
    homeTeam: 'MILWAUKEE BREWERS',
    awayTeam: 'TORONTO BLUE JAYS',
    plays: [moneylinePlay, totalPlay],
    true_play: moneylinePlay,
  };

  const card = transformToGameCard(game);
  assert.strictEqual(card.play?.market_type, 'MONEYLINE');
  assert.strictEqual(card.play?.action, 'HOLD');
  assert.strictEqual(card.play?.classification, 'LEAN');
  assert.match(card.play?.pick ?? '', /MILWAUKEE BREWERS ML \+110/);
}

console.log('✅ Game card decision authority tests passed');
