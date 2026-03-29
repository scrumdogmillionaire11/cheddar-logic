import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWave1DecisionFields,
  inferMarketFromCardType,
  isWave1EligibleRow,
  normalizeDecisionV2,
} from './market-inference';

test('market-inference smoke', () => {
  assert.equal(inferMarketFromCardType('nhl-pace-1p'), 'FIRST_PERIOD');
  assert.equal(isWave1EligibleRow('NHL', 'PLAY', 'TOTAL'), true);

  const decision = normalizeDecisionV2({
    direction: 'OVER',
    support_score: 2,
    conflict_score: 0,
    drivers_used: ['pace'],
    driver_reasons: ['edge'],
    watchdog_status: 'OK',
    watchdog_reason_codes: [],
    missing_data: { missing_fields: [], source_attempts: [], severity: 'INFO' },
    consistency: {
      pace_tier: 'FAST',
      event_env: 'OK',
      event_direction_tag: 'OVER',
      vol_env: 'OK',
      total_bias: 'OK',
    },
    fair_prob: 0.56,
    implied_prob: 0.5,
    edge_pct: 0.06,
    sharp_price_status: 'CHEDDAR',
    price_reason_codes: [],
    official_status: 'PLAY',
    play_tier: 'GOOD',
    primary_reason_code: 'EDGE_FOUND',
    pipeline_version: 'v2',
    decided_at: '2026-03-29T00:00:00.000Z',
  });

  assert.ok(decision);
  const play: {
    decision_v2: NonNullable<typeof decision>;
    action?: 'FIRE' | 'HOLD' | 'PASS';
    status?: 'FIRE' | 'WATCH' | 'PASS';
    classification?: 'BASE' | 'LEAN' | 'PASS';
    pass_reason_code?: string | null;
  } = { decision_v2: decision, action: 'PASS' };
  applyWave1DecisionFields(play);
  assert.equal(play.action, 'FIRE');
  assert.equal(play.status, 'FIRE');
});
