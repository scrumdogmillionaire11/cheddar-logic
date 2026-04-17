'use strict';

const {
  evaluateExecution,
  evaluateMlbExecution,
} = require('../execution-gate');

describe('evaluateExecution', () => {
  test('passes when all execution gates clear', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(true);
    expect(result.reason).toBe('ALL_GATES_PASSED');
    expect(result.netEdge).toBeCloseTo(0.05, 6);
    expect(result.blocked_by).toEqual([]);
  });

  test('blocks when model status is not MODEL_OK', () => {
    const result = evaluateExecution({
      modelStatus: 'NO_BET',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('MODEL_STATUS_NO_BET');
  });

  test('blocks when net edge is below threshold', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.05,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.netEdge).toBeCloseTo(0, 6);
    expect(result.blocked_by).toContain('NET_EDGE_INSUFFICIENT:0.0000');
  });

  test('blocks stale snapshots', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 6 * 60 * 1000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('STALE_SNAPSHOT:360s');
  });

  test('blocks when confidence is below 0.55 threshold', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.549,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('CONFIDENCE_BELOW_THRESHOLD:0.549');
  });

  // DEGRADED coupling test: input-gate caps DEGRADED confidence at 0.55.
  // The execution floor must be <=0.55 so DEGRADED plays surface as WATCH-tier.
  // If this test breaks, input-gate.js DEGRADED_CONSTRAINTS.MAX_CONFIDENCE and
  // the execution-gate default minConfidence are out of sync — fix both together.
  test('allows DEGRADED play at confidence=0.55 (DEGRADED cap) through execution gate', () => {
    const result = evaluateExecution({
      modelStatus: 'DEGRADED',
      rawEdge: 0.1,
      confidence: 0.55,
      snapshotAgeMs: 30_000,
    });

    // MODEL_STATUS_DEGRADED blocks the gate — but confidence alone should NOT
    // add a CONFIDENCE_BELOW_THRESHOLD block, so the only blocker is the model
    // status. Callers that allow DEGRADED plays through model-status gating
    // will not be double-blocked on confidence.
    expect(result.blocked_by).not.toContain('CONFIDENCE_BELOW_THRESHOLD:0.550');
    expect(result.blocked_by).toContain('MODEL_STATUS_DEGRADED');
  });

  test('blocks mixed-book line/price source mismatches before executable status', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
      lineSource: 'draftkings',
      priceSource: 'fanduel',
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain(
      'MIXED_BOOK_SOURCE_MISMATCH:draftkings->fanduel',
    );
    expect(result.drop_reason).toMatchObject({
      drop_reason_code: 'MIXED_BOOK_INTEGRITY_GATE',
      drop_reason_layer: 'worker_gate',
    });
  });

  // ========== BOUNDARY TESTS: THREE-TIER FRESHNESS LOGIC (WI-0950) ==========
  // Tests verify cadence-aligned freshness contract with 60m cadence, 1.25x grace, 120m hardMax

  describe('three-tier freshness logic (WI-0950)', () => {
    // Helper: create execution params with specified age and sport
    function executionWithAge(ageMs, sport = 'mlb') {
      return {
        modelStatus: 'MODEL_OK',
        rawEdge: 0.1,
        confidence: 0.75,
        snapshotAgeMs: ageMs,
        sport,
      };
    }

    // FRESH TIER: 0 to 60 minutes (fully trusted, always pass)
    test('FRESH tier: 30 seconds should PASS', () => {
      const result = evaluateExecution(executionWithAge(30 * 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('FRESH');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
    });

    test('FRESH tier: 30 minutes should PASS', () => {
      const result = evaluateExecution(executionWithAge(30 * 60 * 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('FRESH');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
    });

    // STALE_VALID TIER: 60 to 120 minutes (anti-silencing allows pass if allowStaleIfNoNewOdds=true)
    test('STALE_VALID: exactly at 60m cadence boundary should be FRESH (upper bound)', () => {
      const result = evaluateExecution(executionWithAge(60 * 60 * 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('FRESH');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
    });

    test('STALE_VALID: just over cadence (60m 1s) should PASS', () => {
      const result = evaluateExecution(executionWithAge(60 * 60 * 1000 + 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('STALE_VALID');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
    });

    test('STALE_VALID: at grace boundary (75m) should PASS', () => {
      const result = evaluateExecution(executionWithAge(75 * 60 * 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('STALE_VALID');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
    });

    test('STALE_VALID: beyond grace but under hardMax (90m) should PASS per anti-silencing', () => {
      const result = evaluateExecution(executionWithAge(90 * 60 * 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('STALE_VALID');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
      expect(result.freshness_decision.reason).not.toContain('block');
    });

    test('STALE_VALID: at hardMax boundary (120m) should PASS', () => {
      const result = evaluateExecution(executionWithAge(120 * 60 * 1000));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.tier).toBe('STALE_VALID');
      expect(result.freshness_decision.blocked_by_freshness).toBe(false);
    });

    // EXPIRED TIER: beyond 120 minutes (always block)
    test('EXPIRED: just over hardMax (121m) should FAIL', () => {
      const result = evaluateExecution(executionWithAge(121 * 60 * 1000));
      expect(result.shouldBet).toBe(false);
      expect(result.freshness_decision.tier).toBe('EXPIRED');
      expect(result.freshness_decision.blocked_by_freshness).toBe(true);
      expect(result.blocked_by).toContainEqual(
        expect.stringContaining('STALE_SNAPSHOT:EXPIRED_HARDMAX'),
      );
    });

    test('EXPIRED: clearly stale (130m) should FAIL', () => {
      const result = evaluateExecution(executionWithAge(130 * 60 * 1000));
      expect(result.shouldBet).toBe(false);
      expect(result.freshness_decision.tier).toBe('EXPIRED');
      expect(result.freshness_decision.blocked_by_freshness).toBe(true);
      expect(result.blocked_by).toContainEqual(
        expect.stringContaining('STALE_SNAPSHOT:EXPIRED_HARDMAX'),
      );
    });

    // Sport-specific contract test
    test('contract applies per-sport defaults (NHL)', () => {
      const result = evaluateExecution(executionWithAge(90 * 60 * 1000, 'nhl'));
      expect(result.shouldBet).toBe(true);
      expect(result.freshness_decision.sport).toBe('nhl');
      expect(result.freshness_decision.tier).toBe('STALE_VALID');
    });
  });
});

describe('evaluateMlbExecution', () => {
  test('centralized MLB full-game ML policy allows high-edge low-confidence row and marks lean downgrade', () => {
    const payload = {
      sport: 'MLB',
      card_type: 'mlb-full-game-ml',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      period: null,
      edge: 0.061,
      confidence: 0.5,
      model_status: 'MODEL_OK',
      reason_codes: ['SOFT_WEAK_DRIVER_SUPPORT'],
    };

    const result = evaluateMlbExecution(payload, {
      modelStatus: 'MODEL_OK',
      rawEdge: payload.edge,
      confidence: payload.confidence,
      snapshotAgeMs: 30_000,
      sport: payload.sport,
      recommendedBetType: payload.recommended_bet_type,
      marketType: payload.market_type,
      period: payload.period,
      cardType: payload.card_type,
    });

    expect(result.gateShouldBet).toBe(true);
    expect(result.gateBlockedBy).toEqual([]);
    expect(result.downgradeHighEdgeToLean).toBe(true);
  });

  test('centralized MLB policy can override soft confidence/net-edge blockers for large-edge full-game ML rows', () => {
    const payload = {
      sport: 'MLB',
      card_type: 'mlb-full-game-ml',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      edge: 0.08,
      confidence: 0.4,
      model_status: 'MODEL_OK',
      reason_codes: [],
    };

    const result = evaluateMlbExecution(payload, {
      modelStatus: 'MODEL_OK',
      rawEdge: payload.edge,
      confidence: payload.confidence,
      snapshotAgeMs: 30_000,
      sport: payload.sport,
      recommendedBetType: payload.recommended_bet_type,
      marketType: payload.market_type,
      cardType: payload.card_type,
    });

    expect(result.gateResult.shouldBet).toBe(false);
    expect(result.applyHighEdgeOverride).toBe(true);
    expect(result.gateShouldBet).toBe(true);
    expect(result.gateBlockedBy).toEqual([]);
  });

  test('mlb full-game ML override does not bypass non-positive net edge', () => {
    const payload = {
      sport: 'MLB',
      card_type: 'mlb-full-game-ml',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      edge: 0.08,
      confidence: 0.4,
      model_status: 'MODEL_OK',
      reason_codes: [],
    };

    const result = evaluateMlbExecution(payload, {
      modelStatus: 'MODEL_OK',
      rawEdge: payload.edge,
      confidence: payload.confidence,
      snapshotAgeMs: 30_000,
      sport: payload.sport,
      recommendedBetType: payload.recommended_bet_type,
      marketType: payload.market_type,
      cardType: payload.card_type,
      vigCost: 0.09,
      slippageCost: 0.005,
    });

    expect(result.gateResult.netEdge).toBeLessThanOrEqual(0);
    expect(result.gateResult.shouldBet).toBe(false);
    expect(result.applyHighEdgeOverride).toBe(false);
    expect(result.gateShouldBet).toBe(false);
    expect(result.gateBlockedBy).toContainEqual(
      expect.stringContaining('NET_EDGE_INSUFFICIENT'),
    );
  });

  test('non-MLB rows are unaffected by MLB override policy', () => {
    const payload = {
      sport: 'NBA',
      card_type: 'nba-moneyline-call',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      edge: 0.08,
      confidence: 0.4,
      model_status: 'MODEL_OK',
      reason_codes: [],
    };

    const result = evaluateMlbExecution(payload, {
      modelStatus: 'MODEL_OK',
      rawEdge: payload.edge,
      confidence: payload.confidence,
      snapshotAgeMs: 30_000,
      sport: payload.sport,
      recommendedBetType: payload.recommended_bet_type,
      marketType: payload.market_type,
      cardType: payload.card_type,
    });

    expect(result.applyHighEdgeOverride).toBe(false);
    expect(result.downgradeHighEdgeToLean).toBe(false);
    expect(result.gateShouldBet).toBe(false);
    expect(result.gateBlockedBy).toContain('CONFIDENCE_BELOW_THRESHOLD:0.400');
  });
});

