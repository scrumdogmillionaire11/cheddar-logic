const {
  generateNHLMarketCallCards,
  buildNhlModelSnapshot,
  applyNhlSettlementMarketContext,
  applyNhlDriverContextMetadata,
  attachNhlDriverContextToRawData,
  buildDualRunRecord,
  applyExecutionGateToNhlCard,
  applyCanonicalNhlTotalsStatus,
  applyNhlGoalieExecutionStatusGuard,
  deriveNhlUncertaintyHoldReasonCodes,
  applyNhlUncertaintyHold,
  isHardProjectionInputBlock,
} = require('../run_nhl_model');
const { finalizeDecisionFields } = require('../../utils/decision-publisher');
const { validateCardPayload } = require('@cheddar-logic/data');

function loadResolveThresholdProfile() {
  jest.resetModules();
  return require('@cheddar-logic/models').resolveThresholdProfile;
}

function buildBaseOddsSnapshot() {
  return {
    game_time_utc: '2026-03-11T00:00:00.000Z',
    home_team: 'Home Team',
    away_team: 'Away Team',
    h2h_home: -130,
    h2h_away: 115,
    spread_home: -1.5,
    spread_away: 1.5,
    spread_price_home: -110,
    spread_price_away: -110,
    total: 6.5,
    total_price_over: -112,
    total_price_under: -108,
    captured_at: '2026-03-10T18:00:00.000Z',
  };
}

function buildBaseDecisions() {
  return {
    TOTAL: {
      status: 'WATCH',
      best_candidate: { side: 'OVER', line: 6.5 },
      edge: 0.02,
      edge_points: 0.4,
      p_fair: 0.53,
      p_implied: 0.5,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      drivers: [],
      score: 0.25,
      net: 0.25,
      conflict: 0.1,
      coverage: 0.75,
      reasoning: 'Totals edge',
      projection: {
        projected_total: 6.9,
      },
    },
    SPREAD: {
      status: 'PASS',
      best_candidate: { side: 'HOME', line: -1.5 },
      drivers: [],
      score: 0.1,
      net: 0.1,
      conflict: 0.1,
      coverage: 0.5,
      reasoning: 'No spread edge',
      projection: {
        projected_margin: 0.8,
      },
    },
    ML: {
      status: 'FIRE',
      best_candidate: { side: 'AWAY', price: 115 },
      edge: 0.034,
      p_fair: 0.499,
      p_implied: 0.465,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      drivers: [
        {
          driverKey: 'powerRating',
          weight: 0.5,
          signal: 0.35,
          eligible: true,
        },
      ],
      score: 0.52,
      net: 0.61,
      conflict: 0.07,
      coverage: 0.79,
      reasoning: 'Away side carries the strongest edge.',
      projection: {
        projected_margin: -0.9,
        win_prob_home: 0.501,
      },
    },
  };
}

function buildPaceResult(overrides = {}) {
  return {
    homeExpected: 2.85,
    awayExpected: 2.6,
    expectedTotal: 5.45,
    rawTotalModel: 5.5,
    regressedTotalModel: 5.47,
    modifierBreakdown: {
      base_5v5_total: 5.01,
      special_teams_delta: 0.12,
      home_ice_delta: 0.08,
      rest_delta: -0.04,
      goalie_delta_raw: -0.3,
      goalie_delta_applied: -0.18,
      raw_modifier_total: -0.14,
      capped_modifier_total: -0.14,
      modifier_cap_applied: false,
    },
    homeGoalieCertainty: 'CONFIRMED',
    awayGoalieCertainty: 'EXPECTED',
    homeAdjustmentTrust: 'FULL',
    awayAdjustmentTrust: 'DEGRADED',
    official_eligible: true,
    first_period_model: {
      classification: 'PASS',
      reason_codes: ['NHL_1P_PASS_DEAD_ZONE'],
    },
    ...overrides,
  };
}

describe('run_nhl_model market call generation', () => {
  afterEach(() => {
    process.env.ENABLE_MARKET_THRESHOLDS_V2 = 'false';
  });

  test('threshold profile defaults stay baseline-equivalent when flag is off', () => {
    process.env.ENABLE_MARKET_THRESHOLDS_V2 = 'false';

    const resolveThresholdProfile = loadResolveThresholdProfile();

    const profile = resolveThresholdProfile({
      sport: 'NBA',
      marketType: 'SPREAD',
    });

    expect(profile.source).toBe('default');
    expect(profile.support).toEqual({ play: 0.65, lean: 0.5 });
    expect(profile.edge).toEqual({ play_edge_min: 0.06, lean_edge_min: 0.03 });
  });

  test('threshold profile routes by sport+market only when flag is on', () => {
    process.env.ENABLE_MARKET_THRESHOLDS_V2 = 'true';

    const resolveThresholdProfile = loadResolveThresholdProfile();

    const mapped = resolveThresholdProfile({
      sport: 'NBA',
      marketType: 'SPREAD',
    });
    const fallback = resolveThresholdProfile({
      sport: 'SOCCER',
      marketType: 'DOUBLE_CHANCE',
    });

    expect(mapped.source).toBe('sport_market_v2');
    expect(mapped.support.play).toBe(0.68);
    expect(mapped.edge.play_edge_min).toBe(0.07);

    expect(fallback.source).toBe('default');
    expect(fallback.support).toEqual({ play: 0.6, lean: 0.45 });
    expect(fallback.edge).toEqual({ play_edge_min: 0.06, lean_edge_min: 0.03 });
  });

  test('emits nhl-moneyline-call with canonical payload fields', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const mlCard = cards.find((card) => card.cardType === 'nhl-moneyline-call');

    expect(mlCard).toBeDefined();
    expect(mlCard.payloadData.kind).toBe('PLAY');
    expect(mlCard.payloadData.market_type).toBe('MONEYLINE');
    expect(mlCard.payloadData.selection).toEqual({
      side: 'AWAY',
      team: 'Away Team',
    });
    expect(mlCard.payloadData.price).toBe(115);
    expect(mlCard.payloadData.reason_codes).toEqual(expect.any(Array));
    expect(mlCard.payloadData.pricing_trace).toMatchObject({
      called_market_type: 'ML',
      called_side: 'AWAY',
      called_price: 115,
      price_source: 'odds_snapshot',
    });
    expect(mlCard.payloadData.market_context).toMatchObject({
      market_type: 'MONEYLINE',
      selection_side: 'AWAY',
      selection_team: 'Away Team',
      wager: {
        called_line: null,
        called_price: 115,
        line_source: null,
        price_source: 'odds_snapshot',
      },
    });
  });

  test('buildNhlModelSnapshot freezes nested totals-call audit payloads', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();
    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const totalCard = cards.find((card) => card.cardType === 'nhl-totals-call');
    totalCard.payloadData.execution_status = 'PROJECTION_ONLY';
    totalCard.payloadData.consistency = {
      pace_tier: 'MID',
      event_env: 'INDOOR',
      total_bias: 'OK',
    };

    const snapshot = buildNhlModelSnapshot({
      paceResult: buildPaceResult(),
      payload: totalCard.payloadData,
      sigmaTotal: 1.8,
    });
    totalCard.payloadData._model_snapshot = snapshot;
    totalCard.payloadData.nhl_goalie_certainty_pair = 'CONFIRMED/EXPECTED';

    expect(totalCard.payloadData._model_snapshot).toMatchObject({
      sigma_total: 1.8,
      consistency: {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
      },
    });
    expect(totalCard.payloadData.nhl_goalie_certainty_pair).toBe(
      'CONFIRMED/EXPECTED',
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modifierBreakdown)).toBe(true);
    expect(Object.isFrozen(snapshot.first_period_model)).toBe(true);
    expect(Object.isFrozen(snapshot.consistency)).toBe(true);
    expect(() => {
      'use strict';
      snapshot.consistency.total_bias = 'BAD';
    }).toThrow();
  });

  test('buildNhlModelSnapshot rejects unknown-goalie totals payloads that remain EXECUTABLE', () => {
    const payload = {
      game_id: 'nhl-test-game',
      market_type: 'TOTAL',
      execution_status: 'EXECUTABLE',
      consistency: {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
      },
    };

    expect(() =>
      buildNhlModelSnapshot({
        paceResult: buildPaceResult({
          homeGoalieCertainty: 'UNKNOWN',
          homeAdjustmentTrust: 'NEUTRALIZED',
        }),
        payload,
        sigmaTotal: 1.8,
      }),
    ).toThrow(/\[INVARIANT_BREACH\]\[LEVEL=CRITICAL\]/);
  });

  test('goalie execution guard no longer marks nhl-totals-call cards as PROJECTION_ONLY', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();
    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const totalsCard = cards.find((card) => card.cardType === 'nhl-totals-call');

    expect(totalsCard).toBeDefined();
    const statusBeforeGuard = totalsCard.payloadData.execution_status;

    applyNhlGoalieExecutionStatusGuard(
      totalsCard,
      buildPaceResult({ homeGoalieCertainty: 'UNKNOWN' }),
    );

    expect(totalsCard.payloadData.execution_status).toBe(statusBeforeGuard);
    expect(totalsCard.payloadData.execution_status).not.toBe('PROJECTION_ONLY');
  });

  test('canonical totals status now resets non-PASS cards to EXECUTABLE', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();
    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const totalsCard = cards.find((card) => card.cardType === 'nhl-totals-call');

    expect(totalsCard).toBeDefined();
    totalsCard.payloadData.execution_status = 'PROJECTION_ONLY';
    totalsCard.payloadData.selection = { side: 'OVER' };
    totalsCard.payloadData.projection = { total: 7.4 };
    totalsCard.payloadData.line = 6.0;
    totalsCard.payloadData.reason_codes = [];
    totalsCard.payloadData.blocked_reason_code = null;

    applyCanonicalNhlTotalsStatus(totalsCard, {
      homeGoalieState: { starter_state: 'CONFIRMED' },
      awayGoalieState: { starter_state: 'CONFIRMED' },
      uncertaintyHoldReasonCodes: [],
    });

    expect(totalsCard.payloadData.classification).not.toBe('PASS');
    expect(totalsCard.payloadData.execution_status).toBe('EXECUTABLE');
  });

  test('pace snapshot cards still receive PROJECTION_ONLY from goalie execution guard', () => {
    const paceCard = {
      cardType: 'nhl-pace-totals',
      payloadData: { execution_status: 'EXECUTABLE' },
    };

    applyNhlGoalieExecutionStatusGuard(
      paceCard,
      buildPaceResult({ homeGoalieCertainty: 'UNKNOWN' }),
    );

    expect(paceCard.payloadData.execution_status).toBe('PROJECTION_ONLY');
  });

  test('does not emit nhl-moneyline-call when candidate price is unavailable', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      h2h_away: null,
    };
    const marketDecisions = buildBaseDecisions();

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const mlCard = cards.find((card) => card.cardType === 'nhl-moneyline-call');

    expect(mlCard).toBeUndefined();
  });

  test('nhl-moneyline-call backfills model_prob from projection win_prob_home when p_fair is null', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = {
      ...buildBaseDecisions(),
      ML: {
        ...buildBaseDecisions().ML,
        p_fair: null,
        projection: {
          ...buildBaseDecisions().ML.projection,
          win_prob_home: 0.62,
        },
      },
    };

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const mlCard = cards.find((card) => card.cardType === 'nhl-moneyline-call');

    expect(mlCard).toBeDefined();
    expect(mlCard.payloadData.selection.side).toBe('AWAY');
    expect(mlCard.payloadData.model_prob).toBeCloseTo(0.38, 4);
    expect(mlCard.payloadData.p_fair).toBeCloseTo(0.38, 4);
  });

  test('finalizeDecisionFields resolves priced decision_v2 for live-odds nhl-moneyline-call', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      buildBaseDecisions(),
      oddsSnapshot,
    );
    const mlCard = cards.find((card) => card.cardType === 'nhl-moneyline-call');

    expect(mlCard).toBeDefined();

    finalizeDecisionFields(mlCard.payloadData, { oddsSnapshot });

    expect(mlCard.payloadData.decision_v2).toBeDefined();
    expect(mlCard.payloadData.decision_v2.sharp_price_status).not.toBe('UNPRICED');
    expect(mlCard.payloadData.execution_status).not.toBe('PROJECTION_ONLY');
  });

  test('legacy mode emits all actionable market cards while preserving orchestration metadata', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
      { useOrchestratedMarket: false },
    );

    expect(cards.map((card) => card.cardType).sort()).toEqual([
      'nhl-moneyline-call',
      'nhl-totals-call',
    ]);

    cards.forEach((card) => {
      expect(card.payloadData.expression_choice).toMatchObject({
        chosen_market: 'ML',
        status: 'FIRE',
      });
      expect(card.payloadData.market_narrative).toMatchObject({
        orchestration: 'Rule 1: status',
      });
      expect(validateCardPayload(card.cardType, card.payloadData).success).toBe(
        true,
      );
    });
  });

  test('orchestrated mode emits exactly one chosen market card per game', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
      { useOrchestratedMarket: true },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].cardType).toBe('nhl-moneyline-call');
    expect(cards[0].payloadData.expression_choice).toMatchObject({
      chosen_market: 'ML',
      pick: 'Away 115',
      status: 'FIRE',
      chosen: {
        market: 'ML',
        side: 'AWAY',
        status: 'FIRE',
        score: 0.52,
        net: 0.61,
        conflict: 0.07,
        edge: 0.034,
      },
    });
    expect(cards[0].payloadData.market_narrative).toMatchObject({
      chosen_story: 'ML leads on rule 1: status.',
      orchestration: 'Rule 1: status',
    });
    expect(validateCardPayload(cards[0].cardType, cards[0].payloadData)).toEqual(
      { success: true, errors: [] },
    );
  });

  test('execution gate annotates executable NHL market-call cards that clear the veto', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const mlCard = {
      payloadData: {
        execution_status: 'EXECUTABLE',
        edge: 0.11,
        confidence: 0.74,
        model_status: 'MODEL_OK',
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        pass_reason_code: null,
        reason_codes: [],
        decision_v2: {
          official_status: 'PLAY',
        },
      },
    };
    const nowMs = new Date(oddsSnapshot.captured_at).getTime() + 120_000;

    const result = applyExecutionGateToNhlCard(mlCard, {
      oddsSnapshot,
      nowMs,
    });

    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(false);
    expect(mlCard.payloadData.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: true,
      model_status: 'MODEL_OK',
      snapshot_age_ms: 120_000,
    });
  });

  test('execution gate demotes blocked NHL market-call cards to PASS and rewrites decision_v2 consistently', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const mlCard = {
      payloadData: {
        execution_status: 'EXECUTABLE',
        edge: 0.055,
        confidence: 0.74,
        model_status: 'MODEL_OK',
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
        pass_reason_code: null,
        reason_codes: [],
        decision_v2: {
          official_status: 'PLAY',
        },
      },
    };
    const nowMs = new Date(oddsSnapshot.captured_at).getTime() + 120_000;
    const decisionStatusBeforeGate =
      mlCard.payloadData.decision_v2?.official_status ?? null;

    const result = applyExecutionGateToNhlCard(mlCard, {
      oddsSnapshot,
      nowMs,
    });

    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(true);
    expect(mlCard.payloadData.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: false,
      snapshot_age_ms: 120_000,
    });
    expect(
      mlCard.payloadData.execution_gate.blocked_by.some((reason) =>
        reason.startsWith('NET_EDGE_INSUFFICIENT:'),
      ),
    ).toBe(true);
    expect(mlCard.payloadData.classification).toBe('PASS');
    expect(mlCard.payloadData.action).toBe('PASS');
    expect(mlCard.payloadData.status).toBe('PASS');
    expect(mlCard.payloadData.execution_status).toBe('BLOCKED');
    expect(mlCard.payloadData.pass_reason_code).toBe(
      'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
    );
    expect(mlCard.payloadData.decision_v2?.official_status).toBe('PASS');
  });

  test('execution gate tags projection-only NHL cards with explicit early-exit reason metadata', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const mlCard = {
      payloadData: {
        execution_status: 'PROJECTION_ONLY',
        model_status: 'MODEL_OK',
        status: 'WATCH',
        action: 'HOLD',
        classification: 'LEAN',
        pass_reason_code: 'PROJECTION_ONLY_EXCLUSION',
        reason_codes: ['PROJECTION_ONLY_EXCLUSION'],
      },
    };
    const nowMs = new Date(oddsSnapshot.captured_at).getTime() + 120_000;

    const result = applyExecutionGateToNhlCard(mlCard, {
      oddsSnapshot,
      nowMs,
    });

    expect(result.evaluated).toBe(false);
    expect(result.blocked).toBe(false);
    expect(mlCard.payloadData.execution_gate).toMatchObject({
      evaluated: false,
      blocked_by: ['PROJECTION_ONLY_EXCLUSION'],
      snapshot_age_ms: 120_000,
      drop_reason: {
        drop_reason_code: 'PROJECTION_ONLY_EXCLUSION',
        drop_reason_layer: 'worker_gate',
      },
    });
  });

  test('emits 1P period odds context fields for nhl-pace-1p cards', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      total_1p: 1.5,
      total_1p_price_over: -124,
      total_1p_price_under: 102,
    };

    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        status: 'FIRE',
        classification: 'OVER',
        odds_context: {
          total: 6.5,
          total_price_over: -112,
          total_price_under: -108,
        },
        driver: {
          inputs: {
            market_1p_total: 1.5,
          },
        },
      },
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    expect(card.payloadData.kind).toBe('PLAY');
    expect(card.payloadData.selection).toEqual({ side: 'OVER' });
    expect(card.payloadData.period).toBe('1P');
    expect(card.payloadData.market_context).toMatchObject({
      market_type: 'FIRST_PERIOD',
      period: '1P',
      wager: {
        period: '1P',
      },
    });
    expect(card.payloadData.odds_context).toMatchObject({
      total_1p: 1.5,
      total_price_over_1p: -124,
      total_price_under_1p: 102,
    });
    expect(card.payloadData.price).toBe(-124);
    expect(card.payloadData.price_source).toBe('odds_snapshot');
    expect(card.payloadData.pricing_trace).toMatchObject({
      called_market_type: 'FIRST_PERIOD',
      called_side: 'OVER',
      called_line: 1.5,
      called_price: -124,
      period: '1P',
    });
    expect(card.payloadData.market_context?.wager?.called_price).toBe(-124);
  });

  test('forces nhl-pace-1p to EVIDENCE when 1P side price is unavailable', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      total_1p: 1.5,
      total_1p_price_over: null,
      total_1p_price_under: null,
    };

    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        status: 'WATCH',
        classification: 'OVER',
        odds_context: {
          total: 6.5,
          total_price_over: -112,
          total_price_under: -108,
        },
        driver: {
          inputs: {
            market_1p_total: 1.5,
          },
        },
      },
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    expect(card.payloadData.market_type).toBe('FIRST_PERIOD');
    expect(card.payloadData.period).toBe('1P');
    expect(card.payloadData.selection).toEqual({ side: 'OVER' });
    expect(card.payloadData.price).toBeNull();
    expect(card.payloadData.kind).toBe('EVIDENCE');
    expect(card.payloadData.nhl_1p_decision).toMatchObject({
      projection: {
        exists: true,
        side: 'OVER',
      },
      execution: {
        market_available: true,
        price_available: false,
        is_executable: false,
        execution_reason: 'PRICE_UNAVAILABLE',
      },
      surfaced_status: 'SLIGHT EDGE',
      surfaced_reason_code: 'FIRST_PERIOD_PRICE_UNAVAILABLE',
    });
    expect(card.payloadData.pass_reason_code).toBeNull();
    expect(card.payloadData.action).toBe('HOLD');
    expect(card.payloadData.status).toBe('WATCH');
  });

  test('marks true no-projection 1P payloads as PASS with FIRST_PERIOD_NO_PROJECTION', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      total_1p: null,
      total_1p_price_over: null,
      total_1p_price_under: null,
    };

    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        status: 'WATCH',
        classification: 'PASS',
        prediction: 'PASS',
        selection: null,
        driver: { inputs: {} },
      },
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    expect(card.payloadData.nhl_1p_decision).toMatchObject({
      projection: {
        exists: false,
        side: null,
      },
      execution: {
        market_available: false,
        price_available: false,
        is_executable: false,
      },
      surfaced_status: 'PASS',
      surfaced_reason_code: 'FIRST_PERIOD_NO_PROJECTION',
    });
    expect(card.payloadData.pass_reason_code).toBe('FIRST_PERIOD_NO_PROJECTION');
    expect(card.payloadData.action).toBe('PASS');
  });

  test('adds NHL driver context metadata with sourced special-teams and shot fields', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      raw_data: {
        pp_home_pct: 24.1,
        pk_home_pct: 82.4,
        pp_away_pct: 18.7,
        pk_away_pct: 79.9,
        xgf_home_pct: 54.2,
        xgf_away_pct: 48.1,
      },
    };
    oddsSnapshot.raw_data = attachNhlDriverContextToRawData(oddsSnapshot.raw_data);

    const card = { payloadData: {} };
    applyNhlDriverContextMetadata(card, oddsSnapshot);

    expect(card.payloadData.nhl_driver_context).toMatchObject({
      enrichment_version: 'nhl-driver-context-v1',
      special_teams: {
        status: 'ok',
        available: true,
        pp_pk_delta: expect.any(Number),
        missing_inputs: [],
      },
      shot_environment: {
        status: 'ok',
        available: true,
        delta: 6.1,
        missing_inputs: [],
        proxy_metric: 'goals_share_pct',
      },
    });
  });

  // WI-0503: dual-run record shape
  describe('buildDualRunRecord (WI-0503 dual-run log)', () => {
    test('emits [DUAL_RUN] JSON line with required fields for all three markets', () => {
      const oddsSnapshot = buildBaseOddsSnapshot();
      const marketDecisions = buildBaseDecisions();
      const expressionChoice = {
        chosen_market: 'ML',
        why_this_market: 'Rule 1: status',
        rejected: [
          { market: 'TOTAL', rejection_reason: 'LOWER_STATUS' },
          { market: 'SPREAD', rejection_reason: 'PASS' },
        ],
      };

      const record = buildDualRunRecord(
        'nhl-test-game-001',
        oddsSnapshot,
        marketDecisions,
        expressionChoice,
      );

      expect(record).not.toBeNull();
      expect(record.game_id).toBe('nhl-test-game-001');
      expect(record.matchup).toBe('Away Team @ Home Team');
      expect(record.chosen_market).toBe('ML');
      expect(record.why_this_market).toBe('Rule 1: status');
      expect(record.markets).toHaveLength(3);
      expect(record.markets.map((m) => m.market)).toEqual(['TOTAL', 'SPREAD', 'ML']);
      record.markets.forEach((m) => {
        expect(m).toMatchObject({
          market: expect.stringMatching(/^(TOTAL|SPREAD|ML)$/),
          status: expect.any(String),
          score: expect.any(Number),
        });
      });
      expect(record.rejected).toMatchObject({
        TOTAL: 'LOWER_STATUS',
        SPREAD: 'PASS',
      });
    });

    test('returns null when expressionChoice is null', () => {
      const record = buildDualRunRecord(
        'nhl-test-game-002',
        buildBaseOddsSnapshot(),
        buildBaseDecisions(),
        null,
      );
      expect(record).toBeNull();
    });

    test('[DUAL_RUN] log line is valid parseable JSON', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const record = buildDualRunRecord(
        'nhl-test-game-003',
        buildBaseOddsSnapshot(),
        buildBaseDecisions(),
        {
          chosen_market: 'TOTAL',
          why_this_market: 'Rule 2: score gap',
          rejected: [],
        },
      );
      const logLine = `[DUAL_RUN] ${JSON.stringify(record)}`;
      console.log(logLine);

      const calls = logSpy.mock.calls.map((c) => c[0]);
      const dualRunLine = calls.find((c) => c.startsWith('[DUAL_RUN] '));
      expect(dualRunLine).toBeDefined();
      const parsed = JSON.parse(dualRunLine.replace('[DUAL_RUN] ', ''));
      expect(parsed).toMatchObject({
        game_id: 'nhl-test-game-003',
        chosen_market: 'TOTAL',
        why_this_market: 'Rule 2: score gap',
        markets: expect.any(Array),
      });
      logSpy.mockRestore();
    });
  });

  test('flags missing xGF and exposes proxy availability in NHL driver context metadata', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      raw_data: {
        espn_metrics: {
          home: { metrics: { avgGoalsFor: 3.3, avgGoalsAgainst: 2.8 } },
          away: { metrics: { avgGoalsFor: 2.9, avgGoalsAgainst: 3.1 } },
        },
      },
    };
    oddsSnapshot.raw_data = attachNhlDriverContextToRawData(oddsSnapshot.raw_data);

    const card = { payloadData: {} };
    applyNhlDriverContextMetadata(card, oddsSnapshot);

    expect(card.payloadData.nhl_driver_context).toMatchObject({
      shot_environment: {
        status: 'missing',
        available: false,
        delta: null,
        missing_inputs: ['xgf_home_pct', 'xgf_away_pct'],
        proxy_available: true,
        proxy_metric: 'goals_share_pct',
      },
      special_teams: {
        status: 'missing',
        available: false,
      },
    });
    expect(card.payloadData.nhl_driver_context.shot_environment.proxy_delta).toEqual(
      expect.any(Number),
    );
  });

  describe('isHardProjectionInputBlock', () => {
    test('returns true when all four core projection inputs are missing', () => {
      expect(
        isHardProjectionInputBlock({
          missing_inputs: [
            'home_avg_goals_for',
            'away_avg_goals_for',
            'home_avg_goals_against',
            'away_avg_goals_against',
          ],
        }),
      ).toBe(true);
    });

    test('returns false when only partial inputs are missing', () => {
      expect(
        isHardProjectionInputBlock({
          missing_inputs: ['home_avg_goals_for', 'away_avg_goals_for'],
        }),
      ).toBe(false);
    });
  });

  describe('uncertainty HOLD gating (WI-0932)', () => {
    test('derives goalie and injury HOLD reason codes deterministically', () => {
      const reasonCodes = deriveNhlUncertaintyHoldReasonCodes({
        homeGoalieState: { starter_state: 'UNKNOWN' },
        awayGoalieState: { starter_state: 'CONFIRMED' },
        availabilityGate: {
          missingFlags: ['key_player_out'],
          uncertainFlags: ['key_player_uncertain'],
        },
      });

      expect(reasonCodes).toEqual([
        'GATE_GOALIE_UNCONFIRMED',
        'BLOCK_INJURY_RISK',
      ]);
    });

    test('applies HOLD-equivalent payload state without converting to PASS', () => {
      const card = {
        payloadData: {
          action: 'FIRE',
          status: 'FIRE',
          classification: 'BASE',
          execution_status: 'EXECUTABLE',
          reason_codes: ['EDGE_CLEAR'],
          pass_reason_code: null,
          decision_v2: {
            official_status: 'PLAY',
            watchdog_status: 'OK',
            watchdog_reason_codes: [],
          },
        },
      };

      const changed = applyNhlUncertaintyHold(card, ['GATE_GOALIE_UNCONFIRMED']);

      expect(changed).toBe(true);
      expect(card.payloadData.action).toBe('HOLD');
      expect(card.payloadData.status).toBe('WATCH');
      expect(card.payloadData.classification).toBe('LEAN');
      expect(card.payloadData.pass_reason_code).toBeNull();
      expect(card.payloadData.gate_reason).toBe('GATE_GOALIE_UNCONFIRMED');
      expect(card.payloadData.reason_codes).toContain('GATE_GOALIE_UNCONFIRMED');
      expect(card.payloadData.decision_v2.official_status).toBe('LEAN');
      expect(card.payloadData.decision_v2.watchdog_status).toBe('CAUTION');
      expect(card.payloadData.decision_v2.watchdog_reason_codes).toContain('GOALIE_UNCONFIRMED');
    });
  });

  // TD-01 parity assertions: spread-call and moneyline-call must have canonical
  // decision_v2 stamped at construction so publish pipeline has consistent
  // initial state and no undefined action/classification can be persisted.
  describe('TD-01: initial canonical decision_v2 stamp on spread-call and moneyline-call', () => {
    test('nhl-spread-call payload has action, classification, and decision_v2 at construction', () => {
      const oddsSnapshot = buildBaseOddsSnapshot();
      const marketDecisions = {
        ...buildBaseDecisions(),
        SPREAD: {
          status: 'WATCH',
          best_candidate: { side: 'HOME', line: -1.5 },
          edge: 0.04,
          p_fair: 0.54,
          p_implied: 0.5,
          line_source: 'odds_snapshot',
          price_source: 'odds_snapshot',
          drivers: [],
          score: 0.3,
          net: 0.3,
          conflict: 0.1,
          coverage: 0.7,
          reasoning: 'Spread edge',
          projection: { projected_margin: 1.2 },
        },
      };

      const cards = generateNHLMarketCallCards('nhl-test-spread', marketDecisions, oddsSnapshot);
      const spreadCard = cards.find((c) => c.cardType === 'nhl-spread-call');

      expect(spreadCard).toBeDefined();
      // action and classification must never be undefined at construction
      expect(spreadCard.payloadData.action).toBeDefined();
      expect(['FIRE', 'HOLD', 'PASS']).toContain(spreadCard.payloadData.action);
      expect(spreadCard.payloadData.classification).toBeDefined();
      expect(['BASE', 'LEAN', 'PASS']).toContain(spreadCard.payloadData.classification);
      // decision_v2 must be stamped at construction with official_status
      expect(spreadCard.payloadData.decision_v2).toBeDefined();
      expect(['PLAY', 'LEAN', 'PASS']).toContain(spreadCard.payloadData.decision_v2.official_status);
      // action and decision_v2.official_status must be internally consistent
      const action = spreadCard.payloadData.action;
      const officialStatus = spreadCard.payloadData.decision_v2.official_status;
      if (action === 'FIRE') expect(officialStatus).toBe('PLAY');
      if (action === 'HOLD') expect(['LEAN']).toContain(officialStatus);
      if (action === 'PASS') expect(officialStatus).toBe('PASS');
    });

    test('nhl-moneyline-call payload has action, classification, and decision_v2 at construction', () => {
      const oddsSnapshot = buildBaseOddsSnapshot();
      const marketDecisions = buildBaseDecisions(); // ML.status = 'FIRE'

      const cards = generateNHLMarketCallCards('nhl-test-ml', marketDecisions, oddsSnapshot);
      const mlCard = cards.find((c) => c.cardType === 'nhl-moneyline-call');

      expect(mlCard).toBeDefined();
      expect(mlCard.payloadData.action).toBeDefined();
      expect(['FIRE', 'HOLD', 'PASS']).toContain(mlCard.payloadData.action);
      expect(mlCard.payloadData.classification).toBeDefined();
      expect(['BASE', 'LEAN', 'PASS']).toContain(mlCard.payloadData.classification);
      expect(mlCard.payloadData.decision_v2).toBeDefined();
      expect(['PLAY', 'LEAN', 'PASS']).toContain(mlCard.payloadData.decision_v2.official_status);
      // FIRE → PLAY consistency
      expect(mlCard.payloadData.action).toBe('FIRE');
      expect(mlCard.payloadData.decision_v2.official_status).toBe('PLAY');
    });

    test('nhl-moneyline-call WATCH maps to LEAN initial status', () => {
      const oddsSnapshot = buildBaseOddsSnapshot();
      const marketDecisions = {
        ...buildBaseDecisions(),
        ML: {
          ...buildBaseDecisions().ML,
          status: 'WATCH',
        },
      };

      const cards = generateNHLMarketCallCards('nhl-test-ml-watch', marketDecisions, oddsSnapshot);
      const mlCard = cards.find((c) => c.cardType === 'nhl-moneyline-call');

      expect(mlCard).toBeDefined();
      expect(mlCard.payloadData.action).toBe('HOLD');
      expect(mlCard.payloadData.classification).toBe('LEAN');
      expect(mlCard.payloadData.decision_v2.official_status).toBe('LEAN');
    });
  });

  // TD-02 parity: no-odds-mode override must stamp NO_ODDS_MODE_LEAN reason code
  describe('TD-02: no-odds-mode reason code on market-call override', () => {
    test('applyNhlUncertaintyHold stamps reason code and does not leave reason_codes empty', () => {
      const card = {
        cardType: 'nhl-moneyline-call',
        payloadData: {
          action: 'FIRE',
          status: 'FIRE',
          classification: 'BASE',
          execution_status: 'EXECUTABLE',
          reason_codes: [],
          pass_reason_code: null,
          decision_v2: { official_status: 'PLAY', watchdog_reason_codes: [] },
        },
      };

      applyNhlUncertaintyHold(card, ['GATE_GOALIE_UNCONFIRMED']);

      // After uncertainty hold, reason_codes must be non-empty and decision_v2 must agree
      expect(card.payloadData.reason_codes.length).toBeGreaterThan(0);
      expect(card.payloadData.decision_v2.official_status).toBe('LEAN');
      expect(card.payloadData.classification).toBe('LEAN');
      expect(card.payloadData.action).toBe('HOLD');
    });
  });
});
