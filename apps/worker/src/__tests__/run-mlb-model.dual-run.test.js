const { validateCardPayload } = require('@cheddar-logic/data');
const {
  computeMLBDriverCards,
  evaluateMlbGameMarkets,
} = require('../models/mlb-model');
const {
  buildMlbMarketAvailability,
  buildMlbF5OddsContext,
  MLB_PIPELINE_REASON_CODES,
  MIN_MLB_GAMES_FOR_RECAL,
} = require('../jobs/run_mlb_model');

function buildF5Snapshot(overrides = {}) {
  return {
    game_id: 'mlb-game-001',
    id: 'odds-row-001',
    home_team: 'Yankees',
    away_team: 'Red Sox',
    game_time_utc: '2026-03-28T23:05:00.000Z',
    captured_at: '2026-03-27T18:00:00.000Z',
    total: 8.5,
    total_price_over: -110,
    total_price_under: -110,
    total_f5: 4.5,
    total_price_over_f5: -112,
    total_price_under_f5: -108,
    raw_data: {
      mlb: {
        f5_line: 4.5,
        strikeout_lines: {
          home: 6.5,
          away: 6.5,
        },
        home_offense_profile: {
          wrc_plus_vs_lhp: 114,
          k_pct_vs_lhp: 0.21,
          iso_vs_lhp: 0.19,
        },
        away_offense_profile: {
          wrc_plus_vs_rhp: 99,
          k_pct_vs_rhp: 0.23,
          iso_vs_rhp: 0.17,
        },
        park_run_factor: 1.04,
        temp_f: 78,
        wind_mph: 8,
        wind_dir: 'OUT',
        home_pitcher: {
          era: 3.1,
          whip: 1.08,
          k_per_9: 9.8,
          recent_k_per_9: 10.1,
          recent_ip: 6.2,
          handedness: 'R',
          x_fip: 3.25,
          bb_pct: 0.07,
          hr_per_9: 0.92,
          season_k_pct: 0.28,
        },
        away_pitcher: {
          era: 3.4,
          whip: 1.11,
          k_per_9: 9.2,
          recent_k_per_9: 8.9,
          recent_ip: 6.0,
          handedness: 'L',
          x_fip: 3.65,
          bb_pct: 0.078,
          hr_per_9: 1.05,
          season_k_pct: 0.245,
        },
      },
    },
    ...overrides,
  };
}

function buildPitcherStatsRow(team) {
  return {
    team,
    updated_at: '2026-03-27T12:00:00.000Z',
    era: 3.2,
    whip: 1.09,
    recent_ip: 6.0,
    x_fip: 3.55,
    siera: null,
    bb_pct: 0.07,
    hr_per_9: 0.96,
    k_per_9: 9.7,
    recent_k_per_9: 9.9,
    season_starts: 5,
    handedness: 'R',
    days_since_last_start: 5,
    season_k_pct: 0.28,
    k_pct_last_4_starts: 0.29,
    k_pct_prior_4_starts: 0.27,
    role: 'starter',
  };
}

function buildSigmaGameRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    final_score_home: 4 + (i % 3),
    final_score_away: 3 + (i % 4),
  }));
}

function loadRunMlbModel({
  mode,
  gameDriverCards,
  pitcherKDriverCards,
  selection,
  snapshotOverrides = {},
  sigmaGameRows = null,
}) {
  jest.resetModules();

  if (mode) process.env.PITCHER_KS_MODEL_MODE = mode;
  else delete process.env.PITCHER_KS_MODEL_MODE;

  const insertCardPayload = jest.fn();
  const insertModelOutput = jest.fn();
  const prepareModelAndCardWrite = jest.fn();
  const runPerGameWriteTransaction = jest.fn((fn) => fn());
  const validateCardPayloadMock = jest.fn(() => ({ success: true, errors: [] }));
  const computeMLBDriverCardsMock = jest.fn(() => gameDriverCards);
  const computePitcherKDriverCardsMock = jest.fn(() => pitcherKDriverCards);
  const normalizeMarketType = (market) => {
    const map = {
      f5_total: 'F5_TOTAL',
      f5_ml: 'F5_ML',
      full_game_total: 'FULL_GAME_TOTAL',
      full_game_ml: 'FULL_GAME_ML',
    };
    return map[String(market || '').toLowerCase()] || String(market || 'UNKNOWN').toUpperCase();
  };

  const buildMockGameEval = (ctx = {}) => {
    if (selection && selection.status && Array.isArray(selection.market_results)) {
      return selection;
    }

    const gameId = ctx.game_id || 'mlb-game-001';
    const selectedDriver = selection?.selected_driver || null;

    const market_results = [];
    if (selectedDriver) {
      const official =
        selectedDriver.ev_threshold_passed === true ||
        selectedDriver.status === 'FIRE' ||
        selectedDriver.classification === 'BASE';

      market_results.push({
        game_id: gameId,
        sport: 'MLB',
        market_type: normalizeMarketType(selectedDriver.market),
        candidate_id: `${gameId}::${selectedDriver.market ?? 'unknown'}`,
        status: official ? 'QUALIFIED_OFFICIAL' : 'QUALIFIED_LEAN',
        reason_codes: Array.isArray(selectedDriver.reason_codes)
          ? selectedDriver.reason_codes
          : [],
      });
    }

    if (selection?.rejected && typeof selection.rejected === 'object') {
      Object.entries(selection.rejected).forEach(([market, reason]) => {
        market_results.push({
          game_id: gameId,
          sport: 'MLB',
          market_type: String(market || 'UNKNOWN').toUpperCase(),
          candidate_id: `${gameId}::${String(market || '').toLowerCase()}`,
          status: 'REJECTED_INPUTS',
          reason_codes: reason ? [String(reason)] : [],
        });
      });
    }

    const official_plays = market_results.filter((r) => r.status === 'QUALIFIED_OFFICIAL');
    const leans = market_results.filter((r) => r.status === 'QUALIFIED_LEAN');
    const rejected = market_results.filter(
      (r) => r.status !== 'QUALIFIED_OFFICIAL' && r.status !== 'QUALIFIED_LEAN',
    );

    const status = official_plays.length > 0
      ? 'HAS_OFFICIAL_PLAYS'
      : leans.length > 0
        ? 'LEANS_ONLY'
        : 'LEANS_ONLY';

    return {
      game_id: gameId,
      sport: 'MLB',
      status,
      market_results,
      official_plays,
      leans,
      rejected,
    };
  };

  const evaluateMlbGameMarketsMock = jest.fn((_driverCards, ctx) =>
    buildMockGameEval(ctx || {}),
  );
  const getDatabase = jest.fn(() => ({
    prepare: jest.fn((sql) => ({
      get: (...args) => {
        if (sql.includes('mlb_pitcher_stats')) {
          return args[0] === 'Yankees'
            ? buildPitcherStatsRow('Yankees')
            : buildPitcherStatsRow('Red Sox');
        }
        return null;
      },
      all: jest.fn(() => {
        if (sql.includes('game_results')) {
          return sigmaGameRows ?? [];
        }
        return [];
      }),
      run: jest.fn(),
    })),
  }));

  jest.doMock('@cheddar-logic/data', () => ({
    getDatabase,
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    setCurrentRunId: jest.fn(),
    getOddsSnapshots: jest.fn(),
    getOddsWithUpcomingGames: jest.fn(() => [buildF5Snapshot(snapshotOverrides)]),
    getLatestOdds: jest.fn(),
    insertModelOutput,
    insertCardPayload,
    prepareModelAndCardWrite,
    runPerGameWriteTransaction,
    validateCardPayload: validateCardPayloadMock,
    shouldRunJobKey: jest.fn(() => true),
    withDb: jest.fn(async (fn) => fn()),
    getPlayerPropLinesForGame: jest.fn(() => []),
    resolveSnapshotAge: jest.fn((snapshotRow, opts = {}) => {
      const nowMs = Number.isFinite(opts.nowMs)
        ? opts.nowMs
        : Date.parse('2026-03-27T19:00:00.000Z');
      const resolvedTimestamp =
        snapshotRow?.captured_at ??
        snapshotRow?.pulled_at ??
        snapshotRow?.updated_at ??
        new Date(nowMs).toISOString();
      const resolvedAgeMs = Math.max(0, nowMs - new Date(resolvedTimestamp).getTime());
      return {
        resolved_timestamp: new Date(resolvedTimestamp).toISOString(),
        resolved_age_ms: Number.isFinite(resolvedAgeMs) ? resolvedAgeMs : 0,
        source_field: snapshotRow?.captured_at
          ? 'captured_at'
          : snapshotRow?.pulled_at
            ? 'pulled_at'
            : snapshotRow?.updated_at
              ? 'updated_at'
              : 'now',
        status: 'VALID',
        fields_inspected: {},
        fallback_chain_executed: false,
        violations: [],
        diagnostic: {},
      };
    }),
    // WI-0840: dynamic league constants — return static fallback in tests
    computeMLBLeagueAverages: jest.fn(() => ({ kPct: 0.225, xfip: 4.3, bbPct: 0.085, source: 'static_2024', n: 0 })),
  }));

  jest.doMock('../models', () => ({
    getModel: jest.fn(() => ({})),
    computeMLBDriverCards: computeMLBDriverCardsMock,
    computePitcherKDriverCards: computePitcherKDriverCardsMock,
  }));

  jest.doMock('../models/mlb-model', () => ({
    evaluateMlbGameMarkets: evaluateMlbGameMarketsMock,
    projectF5ML: jest.fn(),
    // WI-0877: stub so computeSyntheticLineF5Driver can call the function
    projectTeamF5RunsAgainstStarter: jest.fn(() => ({ f5_runs: null, missing_inputs: ['stub'], degraded_inputs: [] })),
    // WI-0840: no-op in tests — static constants remain in effect
    setLeagueConstants: jest.fn(),
  }));

  jest.doMock('@cheddar-logic/adapters', () => ({
    f5LineFetcher: {
      fetchF5LineFromVsin: jest.fn(async () => null),
    },
  }));

  // Mock the odds config so MLB active:false in the real config doesn't force
  // withoutOddsMode=true on tests that expect odds-mode behavior.
  jest.doMock('@cheddar-logic/odds/src/config', () => ({
    SPORTS_CONFIG: { MLB: { active: true } },
    getActiveSports: () => ['MLB'],
  }));

  const moduleUnderTest = require('../jobs/run_mlb_model');
  return {
    ...moduleUnderTest,
    mocks: {
      insertCardPayload,
      insertModelOutput,
      prepareModelAndCardWrite,
      validateCardPayloadMock,
      computeMLBDriverCardsMock,
      computePitcherKDriverCardsMock,
      evaluateMlbGameMarketsMock,
    },
  };
}

describe('mlb dual-run helpers', () => {
  afterEach(() => {
    delete process.env.PITCHER_KS_MODEL_MODE;
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('computeMLBDriverCards returns F5 game candidates and evaluator accounts for F5 market', () => {
    const snapshot = buildF5Snapshot();

    const cards = computeMLBDriverCards(snapshot.game_id, snapshot);

    expect(cards).toHaveLength(1);
    expect(cards[0].market).toBe('f5_total');

    const gameEval = evaluateMlbGameMarkets(cards, { game_id: snapshot.game_id });
    expect(gameEval.status).toMatch(/HAS_OFFICIAL_PLAYS|SKIP_GAME_INPUT_FAILURE|SKIP_MARKET_NO_EDGE/);
    expect(gameEval.market_results.map((item) => item.market_type)).toContain('F5_TOTAL');
  });

  test('evaluator returns SKIP_MARKET_NO_EDGE when no game candidates exist', () => {
    const snapshot = buildF5Snapshot();
    const gameEval = evaluateMlbGameMarkets([], { game_id: snapshot.game_id });

    expect(gameEval.status).toBe('SKIP_MARKET_NO_EDGE');
    expect(gameEval.official_plays).toEqual([]);
    expect(gameEval.leans).toEqual([]);
    expect(gameEval.rejected).toEqual([]);
  });

  test('mlb-f5 payload contract validates with recommended_bet_type and odds_context', () => {
    const snapshot = buildF5Snapshot();
    const payload = {
      game_id: snapshot.game_id,
      sport: 'MLB',
      model_version: 'mlb-model-v1',
      home_team: snapshot.home_team,
      away_team: snapshot.away_team,
      matchup: `${snapshot.away_team} @ ${snapshot.home_team}`,
      start_time_utc: snapshot.game_time_utc,
      market_type: 'FIRST_5_INNINGS',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 4.5,
      confidence: 0.8,
      tier: 'BEST',
      ev_passed: true,
      reasoning: 'F5 projected 5.1 vs line 4.5',
      disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
      generated_at: '2026-03-27T18:00:00.000Z',
      projection: { projected_total: 5.1 },
      projection_source: 'FULL_MODEL',
      playability: {
        over_playable_at_or_below: 4.5,
        under_playable_at_or_above: 5.5,
      },
      missing_inputs: [],
      reason_codes: [],
      pass_reason_code: null,
      recommended_bet_type: 'total',
      odds_context: buildMlbF5OddsContext(snapshot),
      primary_game_market: true,
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
    };

    expect(validateCardPayload('mlb-f5', payload)).toEqual({
      success: true,
      errors: [],
    });
  });

  test('market availability resolves from current snapshot fields without F5 ML expectation', () => {
    const availability = buildMlbMarketAvailability(buildF5Snapshot());

    expect(availability).toMatchObject({
      f5_line_ok: true,
      f5_ml_ok: false,
      full_game_total_ok: true,
      expect_f5_total: true,
      expect_f5_ml: false,
    });
    expect(availability.blocking_reason_codes).toEqual([]);
  });

  test('market availability falls back to raw_data when F5 values are not promoted to top-level fields', () => {
    const availability = buildMlbMarketAvailability(
      buildF5Snapshot({
        total_f5: null,
        total_price_over_f5: null,
        total_price_under_f5: null,
        raw_data: {
          totals: [{ line: 8.5, over: -110, under: -110 }],
          totals_f5: [{ line: 4.5, over: -112, under: -108 }],
          mlb: {
            home_pitcher: buildF5Snapshot().raw_data.mlb.home_pitcher,
            away_pitcher: buildF5Snapshot().raw_data.mlb.away_pitcher,
          },
        },
      }),
    );

    expect(availability.f5_line_ok).toBe(true);
    expect(availability.full_game_total_ok).toBe(true);
    expect(availability.blocking_reason_codes).toEqual([]);
  });

  test('market availability emits F5_ML_UNAVAILABLE only when F5 ML expectation is active', () => {
    const availability = buildMlbMarketAvailability(buildF5Snapshot(), {
      expectF5Ml: true,
    });

    expect(availability.expect_f5_ml).toBe(true);
    expect(availability.f5_ml_ok).toBe(false);
    expect(availability.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE,
    );
    expect(availability.blocking_reason_codes).not.toContain(
      MLB_PIPELINE_REASON_CODES.F5_TOTAL_UNAVAILABLE,
    );
  });
});

describe('runMLBModel dual-run orchestration', () => {
  beforeEach(() => {
    // Most tests that exercise K prop emission need rollout gate open.
    // Tests that verify blocked/suppressed behaviour set their own value.
    process.env.MLB_K_PROPS = 'FULL';
  });

  const gameDriver = {
    market: 'f5_total',
    prediction: 'OVER',
    status: 'FIRE',
    action: 'FIRE',
    classification: 'BASE',
    confidence: 0.9,
    ev_threshold_passed: true,
    reasoning: 'F5 edge',
    projection_source: 'FULL_MODEL',
    reason_codes: [],
    missing_inputs: [],
    pass_reason_code: null,
    playability: {
      over_playable_at_or_below: 4.5,
      under_playable_at_or_above: 5.5,
    },
    projection: {
      projected_total: 5.3,
      projected_total_low: 4.7,
      projected_total_high: 5.9,
      projected_home_f5_runs: 2.8,
      projected_away_f5_runs: 2.5,
    },
    drivers: [{ type: 'mlb-f5', edge: 0.8, projected: 5.3 }],
  };

  const pitcherKHome = {
    market: 'pitcher_k_home',
    prediction: 'PASS',
    status: 'PASS',
    action: 'PASS',
    classification: 'PASS',
    confidence: 0.24,
    ev_threshold_passed: false,
    emit_card: true,
    card_verdict: 'PASS',
    reasoning: 'Home SP projection-only',
    drivers: [{ type: 'pitcher-k', projection: 7.1, k_mean: 7.1 }],
    projection: {
      k_mean: 7.1,
      probability_ladder: { p_5_plus: 0.81, p_6_plus: 0.69, p_7_plus: 0.54 },
      fair_prices: { k_6_plus: { over: -223, under: 223 } },
    },
    projection_source: 'FULL_MODEL',
    status_cap: 'PASS',
    playability: {
      over_playable_at_or_below: 6.5,
      under_playable_at_or_above: 7.5,
    },
    prop_decision: {
      verdict: 'PASS',
      lean_side: null,
      line: null,
      display_price: null,
      projection: 7.1,
      k_mean: 7.1,
      probability_ladder: { p_5_plus: 0.81, p_6_plus: 0.69, p_7_plus: 0.54 },
      fair_prices: { k_6_plus: { over: -223, under: 223 } },
      playability: {
        over_playable_at_or_below: 6.5,
        under_playable_at_or_above: 7.5,
      },
      projection_source: 'FULL_MODEL',
      status_cap: 'PASS',
      missing_inputs: [],
      flags: ['PASS_PROJECTION_ONLY_NO_MARKET'],
    },
    reason_codes: ['PASS_PROJECTION_ONLY_NO_MARKET'],
    pass_reason_code: 'PASS_PROJECTION_ONLY_NO_MARKET',
    basis: 'PROJECTION_ONLY',
  };

  const pitcherKAway = {
    market: 'pitcher_k_away',
    prediction: 'PASS',
    status: 'PASS',
    action: 'PASS',
    classification: 'PASS',
    confidence: 0.2,
    ev_threshold_passed: false,
    emit_card: true,
    card_verdict: 'PASS',
    reasoning: 'Away SP projection-only',
    drivers: [{ type: 'pitcher-k', projection: 6.8, k_mean: 6.8 }],
    projection: {
      k_mean: 6.8,
      probability_ladder: { p_5_plus: 0.79, p_6_plus: 0.65, p_7_plus: 0.5 },
      fair_prices: { k_6_plus: { over: -186, under: 186 } },
    },
    projection_source: 'FULL_MODEL',
    status_cap: 'PASS',
    playability: {
      over_playable_at_or_below: 6.0,
      under_playable_at_or_above: 7.5,
    },
    prop_decision: {
      verdict: 'PASS',
      lean_side: null,
      line: null,
      display_price: null,
      projection: 6.8,
      k_mean: 6.8,
      probability_ladder: { p_5_plus: 0.79, p_6_plus: 0.65, p_7_plus: 0.5 },
      fair_prices: { k_6_plus: { over: -186, under: 186 } },
      playability: {
        over_playable_at_or_below: 6.0,
        under_playable_at_or_above: 7.5,
      },
      projection_source: 'FULL_MODEL',
      status_cap: 'PASS',
      missing_inputs: [],
      flags: ['PASS_PROJECTION_ONLY_NO_MARKET'],
    },
    reason_codes: ['PASS_PROJECTION_ONLY_NO_MARKET'],
    pass_reason_code: 'PASS_PROJECTION_ONLY_NO_MARKET',
    basis: 'PROJECTION_ONLY',
  };

  afterEach(() => {
    delete process.env.PITCHER_KS_MODEL_MODE;
    delete process.env.MLB_K_PROPS;
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('writes one mlb-f5 and additive mlb-pitcher-k cards, never mlb-strikeout, and logs dual-run', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [
        {
          market: 'F5_TOTAL',
          status: 'FIRE',
          prediction: 'OVER',
          score: 0.9,
          edge: 0.8,
          projected: 5.3,
        },
      ],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [pitcherKHome, pitcherKAway],
      selection,
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel({ expectF5Ml: true });

    expect(result.success).toBe(true);
    expect(mocks.computePitcherKDriverCardsMock).toHaveBeenCalledWith(
      'mlb-game-001',
      expect.any(Object),
      { mode: 'PROJECTION_ONLY' },
    );
    expect(
      mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType),
    ).toEqual(['mlb-f5', 'mlb-pitcher-k', 'mlb-pitcher-k']);
    expect(
      mocks.insertCardPayload.mock.calls.some(
        ([card]) => card.cardType === 'mlb-strikeout',
      ),
    ).toBe(false);
    expect(mocks.prepareModelAndCardWrite).toHaveBeenCalledWith(
      'mlb-game-001',
      'mlb-model-v1',
      'mlb-strikeout',
      expect.any(Object),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('[MLB_DUAL_RUN]'),
    );

    const f5Payload = mocks.insertCardPayload.mock.calls[0][0].payloadData;
    expect(f5Payload.primary_game_market).toBe(true);
    expect(f5Payload.chosen_market).toBe('HAS_OFFICIAL_PLAYS');
    expect(f5Payload.recommended_bet_type).toBe('total');
    expect(f5Payload.projection_source).toBe('FULL_MODEL');
    expect(f5Payload.playability).toMatchObject({
      over_playable_at_or_below: 4.5,
      under_playable_at_or_above: 5.5,
    });
    expect(f5Payload.projection).toMatchObject({
      projected_total: 5.3,
      projected_total_low: 4.7,
      projected_total_high: 5.9,
      projected_home_f5_runs: 2.8,
      projected_away_f5_runs: 2.5,
    });
    expect(f5Payload.odds_context).toBeDefined();
    expect(f5Payload.pipeline_state).toMatchObject({
      f5_line_ok: true,
      f5_ml_ok: false,
      full_game_total_ok: true,
    });
    expect(f5Payload.pipeline_state.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE,
    );
  });

  test('missing F5 line emits projection-floor mlb-f5 and still calls computePitcherKDriverCards in ODDS_BACKED mode (per-pitcher fallback is PROJECTION_ONLY when no strikeout line)', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [],
      rejected: { F5_TOTAL: 'NO_F5_LINE' },
      selected_driver: null,
    };
    const oddsBackedProp = {
      ...pitcherKHome,
      basis: 'PROJECTION_ONLY',
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'ODDS_BACKED',
      gameDriverCards: [],
      pitcherKDriverCards: [oddsBackedProp],
      selection,
      snapshotOverrides: {
        total_f5: null,
        total_price_over_f5: null,
        total_price_under_f5: null,
        raw_data: {
          mlb: {
            home_pitcher: buildF5Snapshot().raw_data.mlb.home_pitcher,
            away_pitcher: buildF5Snapshot().raw_data.mlb.away_pitcher,
          },
        },
      },
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel({ expectF5Ml: true });

    expect(result.success).toBe(true);
    // K props use player_prop_lines — independent of F5 line. Call site must
    // stay in ODDS_BACKED mode; per-pitcher fallback is handled inside the model.
    expect(mocks.computePitcherKDriverCardsMock).toHaveBeenCalledWith(
      'mlb-game-001',
      expect.any(Object),
      { mode: 'ODDS_BACKED', bookmakerPriority: expect.any(Object) },
    );
    const emittedTypes = mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType);
    expect(emittedTypes).toEqual(expect.arrayContaining(['mlb-pitcher-k', 'mlb-f5']));
    expect(emittedTypes).toHaveLength(2);
    const pitcherKCall = mocks.insertCardPayload.mock.calls.find(([card]) => card.cardType === 'mlb-pitcher-k');
    const payload = pitcherKCall[0].payloadData;
    expect(payload).toMatchObject({
      basis: 'PROJECTION_ONLY',
      prediction: 'PASS',
      selection: { side: 'PASS' },
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      ev_passed: false,
      status_cap: 'PASS',
      line: null,
      tags: ['no_odds_mode'],
      projection: {
        k_mean: expect.any(Number),
        probability_ladder: {
          p_5_plus: expect.any(Number),
          p_6_plus: expect.any(Number),
          p_7_plus: expect.any(Number),
        },
      },
    });
    // With projection floor applied, F5_TOTAL_UNAVAILABLE is replaced by MARKET_PRICE_MISSING
    expect(payload.pipeline_state.blocking_reason_codes).not.toContain(
      MLB_PIPELINE_REASON_CODES.F5_TOTAL_UNAVAILABLE,
    );
    expect(payload.pipeline_state.blocking_reason_codes).toContain(
      'MARKET_PRICE_MISSING',
    );
    expect(payload.pipeline_state.blocking_reason_codes).not.toContain(
      'WATCHDOG_MARKET_UNAVAILABLE',
    );
    // Logging shape is schema-normalized; assert behavior via payload and reason codes,
    // not legacy free-form log fragments.
  });

  test('SKIP_MARKET_NO_EDGE still emits projection-only player and game props when fallback drivers exist', async () => {
    const explicitSkipSelection = {
      game_id: 'mlb-game-001',
      sport: 'MLB',
      status: 'SKIP_MARKET_NO_EDGE',
      market_results: [],
      official_plays: [],
      leans: [],
      rejected: [],
    };
    const projectionOnlyProp = {
      ...pitcherKHome,
      basis: 'PROJECTION_ONLY',
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'ODDS_BACKED',
      gameDriverCards: [],
      pitcherKDriverCards: [projectionOnlyProp],
      selection: explicitSkipSelection,
      snapshotOverrides: {
        total_f5: null,
        total_price_over_f5: null,
        total_price_under_f5: null,
        raw_data: {
          mlb: {
            home_pitcher: buildF5Snapshot().raw_data.mlb.home_pitcher,
            away_pitcher: buildF5Snapshot().raw_data.mlb.away_pitcher,
          },
        },
      },
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    const emittedTypes = mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType);
    expect(emittedTypes).toEqual(expect.arrayContaining(['mlb-pitcher-k', 'mlb-f5']));
  });

  test('no-edge mlb-f5 PASS cards are still written with playability metadata', async () => {
    const noEdgeDriver = {
      ...gameDriver,
      prediction: 'OVER',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      confidence: 0.76,
      ev_threshold_passed: false,
      pass_reason_code: 'PASS_NO_EDGE',
      reason_codes: ['PASS_NO_EDGE'],
      drivers: [{ type: 'mlb-f5', edge: 0.2, projected: 4.7 }],
      projection: {
        projected_total: 4.7,
        projected_total_low: 4.1,
        projected_total_high: 5.3,
        projected_home_f5_runs: 2.4,
        projected_away_f5_runs: 2.3,
      },
      playability: {
        over_playable_at_or_below: 4.0,
        under_playable_at_or_above: 5.5,
      },
    };
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [
        {
          market: 'F5_TOTAL',
          status: 'PASS',
          prediction: 'OVER',
          score: 0.76,
          edge: 0.2,
          projected: 4.7,
          projection_source: 'FULL_MODEL',
          pass_reason_code: 'PASS_NO_EDGE',
        },
      ],
      rejected: {},
      selected_driver: noEdgeDriver,
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [noEdgeDriver],
      pitcherKDriverCards: [],
      selection,
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    expect(
      mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType),
    ).toEqual(['mlb-f5']);
    expect(mocks.insertCardPayload.mock.calls[0][0].payloadData).toMatchObject({
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      ev_passed: false,
      projection_source: 'FULL_MODEL',
      reason_codes: ['PASS_NO_EDGE'],
      pass_reason_code: 'PASS_NO_EDGE',
      playability: {
        over_playable_at_or_below: 4.0,
        under_playable_at_or_above: 5.5,
      },
    });
  });

  test('execution-gate-demoted full_game_ml payload keeps terminal status fields in parity', async () => {
    const fullGameMlDriver = {
      market: 'full_game_ml',
      prediction: 'HOME',
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      confidence: 0.72,
      ev_threshold_passed: true,
      reasoning: 'Full-game ML edge',
      projection_source: 'FULL_MODEL',
      reason_codes: [],
      missing_inputs: [],
      pass_reason_code: null,
      drivers: [{
        type: 'mlb-full-game-ml',
        edge: 0.055,
        projected_win_prob_home: 0.542,
        win_prob_home: 0.542,
        side: 'HOME',
      }],
    };

    const selection = {
      chosen_market: 'FULL_GAME_ML',
      why_this_market: 'ML edge qualified',
      markets: [
        {
          market: 'FULL_GAME_ML',
          status: 'FIRE',
          prediction: 'HOME',
          score: 0.72,
          edge: 0.055,
        },
      ],
      rejected: {},
      selected_driver: fullGameMlDriver,
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'ODDS_BACKED',
      gameDriverCards: [fullGameMlDriver],
      pitcherKDriverCards: [],
      selection,
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    expect(
      mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType),
    ).toEqual(['mlb-full-game-ml']);

    const payload = mocks.insertCardPayload.mock.calls[0][0].payloadData;
    expect(payload.status).toBe('PASS');
    expect(payload.action).toBe('PASS');
    expect(payload.classification).toBe('PASS');
    expect(payload.execution_status).toBe('BLOCKED');
    expect(payload.pass_reason_code).toBe('PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT');
  });

  test('active F5 ML expectation emits F5_ML_UNAVAILABLE in pipeline state', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [
        {
          market: 'F5_TOTAL',
          status: 'FIRE',
          prediction: 'OVER',
          score: 0.9,
          edge: 0.8,
          projected: 5.3,
        },
      ],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [pitcherKHome],
      selection,
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel({ expectF5Ml: true });

    expect(result.success).toBe(true);
    const payload = mocks.insertCardPayload.mock.calls[0][0].payloadData;
    expect(payload.pipeline_state.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE,
    );
  });

  // ── WI-0648: MLB empirical sigma recalibration gate ───────────────────────

  test('sigma gate: emits MLB_SIGMA_PRESEASON_DEFAULT when game_results < threshold', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [{ market: 'F5_TOTAL', status: 'FIRE', prediction: 'OVER', score: 0.9, edge: 0.8, projected: 5.3 }],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [],
      selection,
      sigmaGameRows: buildSigmaGameRows(MIN_MLB_GAMES_FOR_RECAL - 1), // 19 rows — below threshold
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    const sigmaLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_PRESEASON_DEFAULT]'),
    );
    expect(sigmaLog).toBeDefined();
    expect(sigmaLog[0]).toContain(`threshold=${MIN_MLB_GAMES_FOR_RECAL}`);
    // Empirical log must NOT appear
    const empiricalLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_EMPIRICAL]'),
    );
    expect(empiricalLog).toBeUndefined();
  });

  test('sigma gate: emits MLB_SIGMA_EMPIRICAL when game_results >= threshold', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [{ market: 'F5_TOTAL', status: 'FIRE', prediction: 'OVER', score: 0.9, edge: 0.8, projected: 5.3 }],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [],
      selection,
      sigmaGameRows: buildSigmaGameRows(MIN_MLB_GAMES_FOR_RECAL), // exactly 20 rows — at threshold
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    const empiricalLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_EMPIRICAL]'),
    );
    expect(empiricalLog).toBeDefined();
    expect(empiricalLog[0]).toContain('games_sampled=20');
    // Preseason default log must NOT appear
    const preseasonLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_PRESEASON_DEFAULT]'),
    );
    expect(preseasonLog).toBeUndefined();
  });
});
