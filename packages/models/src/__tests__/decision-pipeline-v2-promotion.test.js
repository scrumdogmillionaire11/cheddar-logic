'use strict';

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();

function baseConsistency(directionTag = 'FAVOR_OVER') {
  return {
    pace_tier: 'HIGH',
    event_env: 'INDOOR',
    event_direction_tag: directionTag,
    vol_env: 'STABLE',
    total_bias: 'OK',
  };
}

function buildMoneylinePayload({
  sport = 'NHL',
  side = 'HOME',
  price = -110,
  oppositePrice = 100,
  modelProb = 0.64,
  support = 0.5,
  conflict = 0.1,
  overrides = {},
} = {}) {
  const oddsContext = side === 'HOME'
    ? { h2h_home: price, h2h_away: oppositePrice }
    : { h2h_home: oppositePrice, h2h_away: price };

  return {
    kind: 'PLAY',
    sport,
    market_type: 'MONEYLINE',
    selection: { side },
    prediction: side,
    price,
    model_prob: modelProb,
    driver: {
      key: 'moneyline_signal',
      score: support,
      inputs: {
        conflict,
      },
    },
    drivers_active: ['moneyline_signal'],
    consistency: baseConsistency(`FAVOR_${side}`),
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      ...oddsContext,
    },
    reason_codes: [],
    ...overrides,
  };
}

function buildTotalPayload({
  sport = 'NBA',
  side = 'OVER',
  line = 220.5,
  price = -110,
  modelProb = 0.64,
  support = 0.5,
  conflict = 0.1,
  overrides = {},
} = {}) {
  return {
    kind: 'PLAY',
    sport,
    market_type: 'TOTAL',
    selection: { side },
    prediction: side,
    line,
    price,
    model_prob: modelProb,
    driver: {
      key: 'total_signal',
      score: support,
      inputs: {
        conflict,
      },
    },
    drivers_active: ['total_signal'],
    consistency: baseConsistency(`FAVOR_${side}`),
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      total: line,
      total_price_over: side === 'OVER' ? price : -110,
      total_price_under: side === 'UNDER' ? price : -110,
    },
    reason_codes: [],
    ...overrides,
  };
}

describe('high-end lean promotion registry', () => {
  const {
    PROMOTION_MARKET_THRESHOLDS_V2,
    resolvePromotionProfile,
  } = require('../decision-pipeline-v2-edge-config');

  test('has explicit promotion profiles for all approved markets only', () => {
    expect(Object.keys(PROMOTION_MARKET_THRESHOLDS_V2).sort()).toEqual([
      'MLB:MONEYLINE',
      'MLB:TOTAL',
      'NBA:SPREAD',
      'NBA:TOTAL',
      'NHL:MONEYLINE',
      'NHL:TOTAL',
    ]);
  });

  test('returns null for unsupported markets', () => {
    expect(resolvePromotionProfile({ sport: 'NHL', marketType: 'PUCKLINE' })).toBeNull();
    expect(resolvePromotionProfile({ sport: 'NBA', marketType: 'MONEYLINE' })).toBeNull();
  });
});

describe('maybePromoteHighEndLean', () => {
  const {
    maybePromoteHighEndLean,
  } = require('../decision-pipeline-v2');

  test('promotes clean qualifying LEAN and stamps reason metadata', () => {
    const result = maybePromoteHighEndLean({
      officialStatus: 'LEAN',
      sport: 'NHL',
      marketType: 'MONEYLINE',
      sharpPriceStatus: 'CHEDDAR',
      supportScore: 0.36,
      edgePct: 0.11,
      watchdogStatus: 'OK',
      watchdogReasonCodes: [],
      priceReasonCodes: ['EDGE_CLEAR'],
      exactWagerValid: true,
      proxyUsed: false,
      proxyCapped: false,
      sigmaSource: 'computed',
    });

    expect(result.officialStatus).toBe('PLAY');
    expect(result.promotedFrom).toBe('LEAN');
    expect(result.promotionReasonCode).toBe('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.priceReasonCodes).toContain('HIGH_END_SLIGHT_EDGE_PROMOTION');
  });

  test('does not promote low-support slight edge', () => {
    const result = maybePromoteHighEndLean({
      officialStatus: 'LEAN',
      sport: 'NHL',
      marketType: 'MONEYLINE',
      sharpPriceStatus: 'CHEDDAR',
      supportScore: 0.29,
      edgePct: 0.11,
      watchdogStatus: 'OK',
      watchdogReasonCodes: [],
      priceReasonCodes: ['EDGE_CLEAR'],
      exactWagerValid: true,
      proxyUsed: false,
      proxyCapped: false,
      sigmaSource: 'computed',
    });

    expect(result.officialStatus).toBe('LEAN');
    expect(result.promotedFrom).toBeNull();
    expect(result.promotionReasonCode).toBeNull();
    expect(result.priceReasonCodes).not.toContain('HIGH_END_SLIGHT_EDGE_PROMOTION');
  });

  test('does not promote when blocking reasons are present', () => {
    const result = maybePromoteHighEndLean({
      officialStatus: 'LEAN',
      sport: 'NBA',
      marketType: 'TOTAL',
      sharpPriceStatus: 'CHEDDAR',
      supportScore: 0.45,
      edgePct: 0.08,
      watchdogStatus: 'OK',
      watchdogReasonCodes: [],
      priceReasonCodes: ['EDGE_CLEAR', 'PLAY_REQUIRES_FRESH_MARKET'],
      exactWagerValid: true,
      proxyUsed: false,
      proxyCapped: false,
      sigmaSource: 'computed',
    });

    expect(result.officialStatus).toBe('LEAN');
    expect(result.promotionReasonCode).toBeNull();
  });
});

describe('buildDecisionV2 high-end lean promotion integration', () => {
  afterEach(() => {
    jest.resetModules();
    delete process.env.QUARANTINE_NBA_TOTAL;
  });

  test('promotes clean NHL moneyline LEAN to PLAY with promotion metadata', () => {
    const { buildDecisionV2 } = require('../decision-pipeline-v2');
    const result = buildDecisionV2(buildMoneylinePayload());

    expect(result.official_status).toBe('PLAY');
    expect(result.promoted_from).toBe('LEAN');
    expect(result.promotion_reason_code).toBe('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.primary_reason_code).toBe('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.price_reason_codes).toContain('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.canonical_envelope_v2.reason_codes).toContain(
      'HIGH_END_SLIGHT_EDGE_PROMOTION',
    );
  });

  test('heavy-favorite demoter overrides promoted PLAY but retains promotion metadata', () => {
    const { buildDecisionV2 } = require('../decision-pipeline-v2');
    const result = buildDecisionV2(
      buildMoneylinePayload({
        sport: 'NHL',
        price: -300,
        oppositePrice: 240,
        modelProb: 0.83,
        support: 0.5,
      }),
    );

    expect(result.official_status).toBe('LEAN');
    expect(result.promoted_from).toBe('LEAN');
    expect(result.promotion_reason_code).toBe('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.primary_reason_code).toBe('HEAVY_FAVORITE_PRICE_CAP');
    expect(result.price_reason_codes).toContain('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.price_reason_codes).toContain('HEAVY_FAVORITE_PRICE_CAP');
  });

  test('NBA total quarantine still demotes a promoted PLAY when enabled', () => {
    jest.resetModules();
    process.env.QUARANTINE_NBA_TOTAL = 'true';
    const { buildDecisionV2 } = require('../decision-pipeline-v2');
    const result = buildDecisionV2(
      buildTotalPayload({
        sport: 'NBA',
        support: 0.5,
      }),
    );

    expect(result.official_status).toBe('LEAN');
    expect(result.promoted_from).toBe('LEAN');
    expect(result.promotion_reason_code).toBe('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.primary_reason_code).toBe('NBA_TOTAL_QUARANTINE_DEMOTE');
    expect(result.price_reason_codes).toContain('HIGH_END_SLIGHT_EDGE_PROMOTION');
    expect(result.price_reason_codes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  test('does not promote fallback-sigma LEAN candidate', () => {
    const { buildDecisionV2 } = require('../decision-pipeline-v2');
    const result = buildDecisionV2(
      buildTotalPayload({
        sport: 'NHL',
        support: 0.6,
        modelProb: 0.64,
      }),
      { sigmaOverride: { margin: 7, total: 10, sigma_source: 'fallback' } },
    );

    expect(result.official_status).toBe('LEAN');
    expect(result.promoted_from).toBeUndefined();
    expect(result.promotion_reason_code).toBeUndefined();
    expect(result.price_reason_codes).toContain('SIGMA_FALLBACK_DEGRADED');
    expect(result.price_reason_codes).not.toContain('HIGH_END_SLIGHT_EDGE_PROMOTION');
  });
});
