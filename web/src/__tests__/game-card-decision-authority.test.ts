/*
 * Verifies stored decision_v2 official_status remains authoritative in the web transform.
 * Run: node --import tsx/esm web/src/__tests__/game-card-decision-authority.test.ts
 */

import assert from 'node:assert';

import { transformToGameCard } from '../lib/game-card/transform/index';

type OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';

function buildGame(officialStatus?: OfficialStatus, edge = 0.04) {
  const play = {
    cardType: 'mlb-total-call',
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
          direction: 'OVER',
          fair_prob: 0.56,
          implied_prob: 0.52,
          edge_pct: edge,
          edge_delta_pct: edge,
          play_tier: officialStatus === 'PASS' ? 'BAD' : officialStatus === 'LEAN' ? 'OK' : 'GOOD',
          support_score: 0.67,
          conflict_score: 0.12,
          primary_reason_code: officialStatus === 'PASS' ? 'NO_EDGE' : 'EDGE_CLEAR',
          watchdog_status: 'OK',
          watchdog_reason_codes: [],
          price_reason_codes: [],
          missing_data: { missing_fields: [] },
          consistency: { total_bias: 'OK' },
          pricing_trace: { line_source: 'odds_snapshot', price_source: 'odds_snapshot' },
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

console.log('🧪 Game card decision authority tests');

{
  const card = transformToGameCard(buildGame('PASS', 0.04));
  assert.strictEqual(card.play?.action, 'PASS');
  assert.strictEqual(card.play?.status, 'PASS');
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

console.log('✅ Game card decision authority tests passed');
