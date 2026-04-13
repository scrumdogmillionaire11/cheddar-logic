const {
  generateNHLMarketCallCards,
  buildNhlModelSnapshot,
  applyNhlSettlementMarketContext,
  applyNhlDriverContextMetadata,
  attachNhlDriverContextToRawData,
  buildDualRunRecord,
  applyExecutionGateToNhlCard,
} = require('../run_nhl_model');
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
});
