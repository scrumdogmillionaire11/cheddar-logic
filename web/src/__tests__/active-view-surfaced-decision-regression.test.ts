import assert from 'node:assert';

import { getPlayDisplayAction } from '../lib/game-card/decision';
import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters';
import { enrichCards } from '../lib/game-card/tags';

function buildCard(sport: 'MLB' | 'NHL') {
  return {
    id: `card-${sport}`,
    gameId: `game-${sport}`,
    sport,
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    startTime: '2026-04-11T19:00:00.000Z',
    updatedAt: '2026-04-11T14:05:00.000Z',
    status: 'in_progress',
    markets: {
      ml: { home: -120, away: 105 },
      spread: { home: -1.5, away: 1.5 },
      total: { line: 8.5, over: -110, under: -110 },
    },
    play: {
      status: 'WATCH' as const,
      market: 'ML' as const,
      pick: 'Home Team ML -110',
      lean: 'Home Team',
      side: 'HOME' as const,
      truthStatus: 'MEDIUM' as const,
      truthStrength: 0.72,
      conflict: 0.12,
      valueStatus: 'OK' as const,
      betAction: 'BET' as const,
      priceFlags: [],
      updatedAt: '2026-04-11T14:05:00.000Z',
      whyCode: 'EDGE_CLEAR',
      whyText: 'Moneyline edge.',
      action: 'HOLD' as const,
      classification: 'LEAN' as const,
      market_type: 'MONEYLINE' as const,
      selection: { side: 'HOME' as const, team: 'Home Team' },
      execution_status: 'EXECUTABLE' as const,
      decision_v2: {
        official_status: 'PASS' as const,
        direction: 'HOME' as const,
        support_score: 0.67,
        conflict_score: 0.12,
        drivers_used: ['projection'],
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
        fair_prob: 0.56,
        implied_prob: 0.52,
        edge_pct: 0.06,
        edge_delta_pct: 0.06,
        sharp_price_status: 'CHEDDAR' as const,
        price_reason_codes: [],
        play_tier: 'OK' as const,
        primary_reason_code: 'EDGE_CLEAR',
        pipeline_version: 'v2' as const,
        decided_at: '2026-04-11T14:00:00.000Z',
      },
      final_market_decision: {
        surfaced_status: 'SLIGHT EDGE' as const,
        surfaced_reason: 'Still actionable after surfaced-decision override',
        model_strength: 'WATCH' as const,
        model_edge_pct: 0.06,
        fair_price: '-119',
        verification_state: 'VERIFIED' as const,
        certainty_state: 'CONFIRMED' as const,
        market_stable: true,
        line_verified: true,
        show_model_context: true,
      },
    },
    drivers: [],
    evidence: [],
    tags: [],
  };
}

for (const sport of ['MLB', 'NHL'] as const) {
  const card = buildCard(sport);
  assert.strictEqual(getPlayDisplayAction(card.play), 'HOLD');
  assert(enrichCards([card])[0].tags.includes('has_watch'));
  assert.strictEqual(
    applyFilters(
      [card],
      {
        ...DEFAULT_GAME_FILTERS,
        markets: [],
        statuses: ['FIRE', 'WATCH'],
        hasClearPlay: true,
      },
      'game',
    ).length,
    1,
  );
}

console.log('Active view surfaced decision regression passed');
