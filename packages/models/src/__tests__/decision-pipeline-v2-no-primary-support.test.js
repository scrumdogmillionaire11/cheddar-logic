'use strict';

/**
 * Tests for WI-1226: hasPrimarySupport pre-flight in buildDecisionV2
 *
 * Verifies that a payload with no active drivers:
 *   - produces sharp_price_status='NO_SUPPORT' (not 'UNPRICED')
 *   - routes terminal_reason_family to EDGE_INSUFFICIENT (not PRICING_UNAVAILABLE)
 *   - produces primary_reason_code='NO_PRIMARY_SUPPORT'
 *   - produces official_status='PASS'
 *
 * And that a payload WITH drivers is unaffected.
 */

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();

function buildNhlMlPayload(overrides = {}) {
  return {
    kind: 'PLAY',
    sport: 'NHL',
    market_type: 'MONEYLINE',
    model_prob: 0.58,
    price: -120,
    selection: { side: 'HOME' },
    driver: {
      key: null,
      score: 0.5,
      inputs: {
        pace_tier: 'MEDIUM',
        event_env: 'NEUTRAL',
        event_direction_tag: 'HOME',
        vol_env: 'MEDIUM',
        total_bias: 'NONE',
      },
    },
    drivers_active: [],
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      h2h_home: -120,
      h2h_away: 100,
    },
    ...overrides,
  };
}

describe('NO_PRIMARY_SUPPORT pre-flight (WI-1226)', () => {
  let buildDecisionV2;

  beforeEach(() => {
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  describe('when hasPrimarySupport is false (drivers_used=[], driver.key=null)', () => {
    it('produces terminal_reason_family=EDGE_INSUFFICIENT, not PRICING_UNAVAILABLE', () => {
      const payload = buildNhlMlPayload();
      const result = buildDecisionV2(payload);

      expect(result).toBeDefined();
      expect(result.canonical_envelope_v2.terminal_reason_family).toBe('EDGE_INSUFFICIENT');
    });

    it('produces official_status=PASS', () => {
      const result = buildDecisionV2(buildNhlMlPayload());
      expect(result.official_status).toBe('PASS');
    });

    it('produces primary_reason_code=NO_PRIMARY_SUPPORT', () => {
      const result = buildDecisionV2(buildNhlMlPayload());
      expect(result.primary_reason_code).toBe('NO_PRIMARY_SUPPORT');
    });

    it('produces sharp_price_status=NO_SUPPORT', () => {
      const result = buildDecisionV2(buildNhlMlPayload());
      expect(result.sharp_price_status).toBe('NO_SUPPORT');
    });

    it('includes NO_PRIMARY_SUPPORT in price_reason_codes', () => {
      const result = buildDecisionV2(buildNhlMlPayload());
      expect(result.price_reason_codes).toContain('NO_PRIMARY_SUPPORT');
    });
  });

  describe('when hasPrimarySupport is true (drivers_used populated)', () => {
    it('routes normally through classifyPrice — terminal family is not EDGE_INSUFFICIENT from NO_SUPPORT', () => {
      const payload = buildNhlMlPayload({
        drivers_active: ['pace_model'],
        driver: {
          key: 'pace_model',
          score: 0.6,
          inputs: {
            pace_tier: 'MEDIUM',
            event_env: 'NEUTRAL',
            event_direction_tag: 'HOME',
            vol_env: 'MEDIUM',
            total_bias: 'NONE',
          },
        },
      });

      const result = buildDecisionV2(payload);

      expect(result).toBeDefined();
      expect(result.sharp_price_status).not.toBe('NO_SUPPORT');
      expect(result.price_reason_codes).not.toContain('NO_PRIMARY_SUPPORT');
    });
  });
});
