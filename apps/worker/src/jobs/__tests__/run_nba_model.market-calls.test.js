/**
 * Unit tests: generateNBAMarketCallCards edge gate (WI-0550)
 *
 * Verifies that nba-spread-call cards are only emitted when edge > 0.02.
 */

const {
  generateNBAMarketCallCards,
  applyMarketIntelligenceModifier,
  applyNbaFeatureTimelinessGuardToCards,
} = require('../run_nba_model');

// Minimal valid oddsSnapshot — all fields required for spread card emission
const baseOdds = {
  home_team: 'LAL',
  away_team: 'GSW',
  game_time_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  spread_home: -4.5,
  spread_away: 4.5,
  spread_price_home: -110,
  spread_price_away: -110,
  h2h_home: -180,
  h2h_away: 155,
  total: 224.5,
  total_price_over: -110,
  total_price_under: -110,
  captured_at: new Date().toISOString(),
};

function makeSpreadDecision(edge, status = 'FIRE', overrides = {}) {
  return {
    status,
    edge,
    edge_points: edge != null ? edge * 10 : null,
    best_candidate: { side: 'HOME', line: -4.5 },
    drivers: [],
    reasoning: 'test reasoning',
    score: 0.7,
    net: 0.6,
    conflict: 0.1,
    coverage: 0.8,
    p_fair: 0.58,
    p_implied: 0.52,
    projection: { projected_margin: 5 },
    line_source: 'odds_snapshot',
    price_source: 'odds_snapshot',
    ...overrides,
  };
}

describe('applyMarketIntelligenceModifier', () => {
  test('SHARP_VS_PUBLIC applies a 0.85 conflict multiplier', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.8,
      sharpDivergence: 'SHARP_VS_PUBLIC',
      splitsDivergence: null,
      edge: 0.06,
    });

    expect(result.adjustedConfidence).toBeCloseTo(0.68);
    expect(result.multiplier).toBe(0.85);
    expect(result.reasonCodes).toEqual(['SHARP_VS_MODEL_CONFLICT']);
  });

  test('PUBLIC_TRAP_RISK applies a 0.88 multiplier for public-heavy low edge', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.8,
      sharpDivergence: null,
      splitsDivergence: 'PUBLIC_HEAVY_HOME',
      edge: 0.03,
    });

    expect(result.adjustedConfidence).toBeCloseTo(0.704);
    expect(result.multiplier).toBe(0.88);
    expect(result.reasonCodes).toEqual(['PUBLIC_TRAP_RISK']);
  });

  test('SHARP_CONFIRMATION boosts confidence but caps at 0.90', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.89,
      sharpDivergence: 'SHARP_ALIGNED',
      splitsDivergence: null,
      edge: 0.08,
    });

    expect(result).toEqual({
      adjustedConfidence: 0.90,
      multiplier: 1.05,
      reasonCodes: ['SHARP_CONFIRMATION'],
    });
  });

  test('combined risk signals use the single most conservative multiplier', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.8,
      sharpDivergence: 'SHARP_VS_PUBLIC',
      splitsDivergence: 'PUBLIC_HEAVY_HOME',
      edge: 0.03,
    });

    expect(result.adjustedConfidence).toBe(0.68);
    expect(result.adjustedConfidence).not.toBeCloseTo(0.8 * 0.85 * 0.88);
    expect(result.multiplier).toBe(0.85);
    expect(result.reasonCodes).toEqual(['SHARP_VS_MODEL_CONFLICT']);
  });

  test('risk beats alignment when public trap and sharp confirmation both apply', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.8,
      sharpDivergence: 'SHARP_ALIGNED',
      splitsDivergence: 'PUBLIC_HEAVY_AWAY',
      edge: 0.03,
    });

    expect(result.adjustedConfidence).toBeCloseTo(0.704);
    expect(result.multiplier).toBe(0.88);
    expect(result.reasonCodes).toEqual(['PUBLIC_TRAP_RISK']);
  });

  test('no market intelligence signals keep confidence and empty reasons', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.72,
      sharpDivergence: null,
      splitsDivergence: null,
      edge: 0.06,
    });

    expect(result).toEqual({
      adjustedConfidence: 0.72,
      multiplier: 1.0,
      reasonCodes: [],
    });
  });

  test('risk multiplier cannot push adjusted confidence below 0.45', () => {
    const result = applyMarketIntelligenceModifier({
      baseConfidence: 0.5,
      sharpDivergence: 'SHARP_VS_PUBLIC',
      splitsDivergence: null,
      edge: 0.06,
    });

    expect(result.adjustedConfidence).toBe(0.45);
    expect(result.multiplier).toBe(0.85);
  });
});

describe('generateNBAMarketCallCards — spread edge gate', () => {
  test('RED: negative edge (-0.25) with FIRE status emits no spread card', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(-0.25, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(0);
  });

  test('RED: edge exactly at threshold (0.02) with FIRE status emits no spread card', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(0.02, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(0);
  });

  test('GREEN: positive edge (0.08) with FIRE status emits a spread card', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(0.08, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(1);
    expect(spreadCards[0].payloadData.edge_pct).toBe(0.08);
    expect(spreadCards[0].payloadData.kind).toBe('PLAY');
  });

  test('GREEN: null edge with FIRE status emits a spread card (null not filtered)', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(null, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(1);
  });

  test('market intelligence stamp adjusts only confidence and confidence-derived tier', () => {
    const decision = makeSpreadDecision(0.08, 'FIRE', { conflict: 0 });
    const unmodifiedCard = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(0.08, 'FIRE', { conflict: 0 }) },
      { ...baseOdds, raw_data: {} },
    ).find((c) => c.cardType === 'nba-spread-call');
    const modifiedCard = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: decision },
      {
        ...baseOdds,
        raw_data: {
          sharp_divergence: 'SHARP_VS_PUBLIC',
          splits_divergence: 'PUBLIC_HEAVY_HOME',
        },
      },
    ).find((c) => c.cardType === 'nba-spread-call');

    expect(unmodifiedCard.payloadData.raw_data.market_intel_modifier).toEqual({
      multiplier: 1.0,
      reason_codes: [],
    });
    expect(modifiedCard.payloadData.raw_data.market_intel_modifier).toEqual({
      multiplier: 0.85,
      reason_codes: ['SHARP_VS_MODEL_CONFLICT'],
    });
    expect(modifiedCard.payloadData.confidence).toBeCloseTo(
      unmodifiedCard.payloadData.confidence * 0.85,
    );
    expect(unmodifiedCard.payloadData.tier).toBe('BEST');
    expect(modifiedCard.payloadData.tier).toBe('WATCH');
    expect(modifiedCard.payloadData.edge).toBe(decision.edge);
    expect(modifiedCard.payloadData.p_fair).toBe(decision.p_fair);
    expect(modifiedCard.payloadData.ev_passed).toBe(true);
    expect(modifiedCard.payloadData.recommended_bet_type).toBe('spread');
  });
});

function buildExecutableNbaCard() {
  return {
    cardType: 'nba-spread-call',
    payloadData: {
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      execution_status: 'EXECUTABLE',
      ev_passed: true,
      actionable: true,
      publish_ready: true,
      reason_codes: ['EDGE_FOUND'],
      decision_v2: {
        official_status: 'PLAY',
        primary_reason_code: 'EDGE_FOUND',
      },
      _publish_state: {
        publish_ready: true,
        emit_allowed: true,
        execution_status: 'EXECUTABLE',
      },
    },
  };
}

describe('NBA feature timeliness guard', () => {
  const betPlacedAt = '2026-04-06T17:00:00Z';

  test('future-dated tracked feature timestamp blocks actionable output', () => {
    const card = buildExecutableNbaCard();
    const outcome = applyNbaFeatureTimelinessGuardToCards([card], {
      gameId: 'nba-feature-leak',
      betPlacedAt,
      rawData: {
        pace_anchor_total: 223.4,
        feature_timestamps: {
          pace_anchor_total: '2026-04-06T19:00:00Z',
        },
      },
    });

    expect(outcome).toMatchObject({ evaluated: true, blockedCount: 1 });
    expect(card.payloadData).toMatchObject({
      execution_status: 'BLOCKED',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      pass_reason_code: 'PASS_FEATURE_TIMESTAMP_LEAK',
      ev_passed: false,
      actionable: false,
      publish_ready: false,
      decision_v2: {
        official_status: 'PASS',
        primary_reason_code: 'PASS_EXECUTION_GATE_BLOCKED',
      },
    });
    expect(card.payloadData.feature_timeliness.violations).toEqual([
      {
        field: 'pace_anchor_total',
        available_at: '2026-04-06T19:00:00Z',
        bet_placed_at: betPlacedAt,
      },
    ]);
  });

  test('clean tracked feature timestamp preserves executable state', () => {
    const card = buildExecutableNbaCard();
    const outcome = applyNbaFeatureTimelinessGuardToCards([card], {
      gameId: 'nba-clean',
      betPlacedAt,
      rawData: {
        pace_anchor_total: 223.4,
        feature_timestamps: {
          pace_anchor_total: '2026-04-06T16:59:00Z',
        },
      },
    });

    expect(outcome).toMatchObject({ evaluated: true, blockedCount: 0 });
    expect(card.payloadData).toMatchObject({
      execution_status: 'EXECUTABLE',
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
    });
    expect(card.payloadData.feature_timeliness.ok).toBe(true);
  });

  test('null tracked timestamp remains fail-open and is represented in diagnostics', () => {
    const card = buildExecutableNbaCard();
    const outcome = applyNbaFeatureTimelinessGuardToCards([card], {
      gameId: 'nba-null',
      betPlacedAt,
      rawData: {
        feature_timestamps: {
          pace_anchor_total: null,
        },
      },
    });

    expect(outcome).toMatchObject({ evaluated: true, blockedCount: 0 });
    expect(card.payloadData.execution_status).toBe('EXECUTABLE');
    expect(card.payloadData.feature_timeliness.missing).toContainEqual({
      field: 'pace_anchor_total',
      available_at: null,
      bet_placed_at: betPlacedAt,
    });
  });
});
