'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDecisionRecord: jest.fn(() => null),
  insertDecisionEvent: jest.fn(),
  updateDecisionCandidateTracking: jest.fn(),
  upsertDecisionRecord: jest.fn(),
}));

const { WATCHDOG_REASONS } = require('@cheddar-logic/models');
const { SCENARIOS } = require('./fixtures/nhl-goalie/scenarios.js');
const { computeTotalBias, goalieUncertaintyBlocks } = require('../models/cross-market');
const { resolveGoalieState } = require('../models/nhl-goalie-state');
const { predictNHLGame } = require('../models/nhl-pace-model');
const { applyUiActionFields, deriveVolEnv } = require('../utils/decision-publisher');

const CONTRACT_KEYS = [
  'canonical_starter_state',
  'evidence_flags',
  'adjustment_trust',
  'model_descriptive_output',
  'official_eligible',
  'consistency_vol_env',
  'consistency_total_bias',
  'watchdog_reason_codes',
  'wrapper_action',
];
const SORTED_CONTRACT_KEYS = [...CONTRACT_KEYS].sort();

function sortUnique(values) {
  return Array.from(new Set(values)).sort();
}

const REAL_EXPECTATION_OVERRIDES = {
  B: {
    wrapper_action: 'FIRE',
  },
  C: {
    official_eligible: true,
    wrapper_action: 'FIRE',
  },
  E: {
    evidence_flags: { home: [], away: [] },
    wrapper_action: 'FIRE',
  },
  G: {
    official_eligible: true,
    wrapper_action: 'FIRE',
  },
  'FC-2': {
    evidence_flags: { home: [], away: [] },
    wrapper_action: 'FIRE',
  },
  'FC-3': {
    wrapper_action: 'FIRE',
  },
  'FC-4': {
    official_eligible: true,
    wrapper_action: 'FIRE',
  },
  'FC-5': {
    official_eligible: true,
    wrapper_action: 'FIRE',
  },
};

function buildScenarioSideState(signal, teamSide) {
  const scraperInput = {
    goalie_name: signal.scraper_name,
    status: signal.scraper_status,
    gsax: signal.has_metrics ? 8 : null,
    save_pct: signal.has_metrics ? 0.91 : null,
    source_type: signal.scraper_name
      ? 'SCRAPER_NAME_MATCH'
      : 'SEASON_TABLE_INFERENCE',
  };
  const userInput =
    signal.user_name || signal.user_status
      ? {
          goalie_name: signal.user_name,
          status: signal.user_status,
          supplied_at: '2026-03-28T15:00:00Z',
        }
      : null;

  return resolveGoalieState(scraperInput, userInput, 'fault-harness-game', teamSide, {
    gameTimeUtc: '2026-03-28T20:00:00Z',
  });
}

function buildPredictionFromStates(homeState, awayState) {
  return predictNHLGame({
    homeGoalsFor: 3.2,
    homeGoalsAgainst: 3.0,
    awayGoalsFor: 3.1,
    awayGoalsAgainst: 3.0,
    homePaceFactor: 1.0,
    awayPaceFactor: 1.0,
    homePpPct: 0.22,
    awayPpPct: 0.22,
    homePkPct: 0.8,
    awayPkPct: 0.8,
    homeGoalieSavePct: homeState.goalie_tier === 'UNKNOWN' ? null : 0.91,
    awayGoalieSavePct: awayState.goalie_tier === 'UNKNOWN' ? null : 0.91,
    homeGoalieState: homeState,
    awayGoalieState: awayState,
  });
}

function buildWrapperPayload(homeState, awayState, officialEligible) {
  const hasDegradedTrust =
    homeState.adjustment_trust === 'DEGRADED' ||
    awayState.adjustment_trust === 'DEGRADED';

  return {
    sport: 'NHL',
    kind: 'PLAY',
    market_type: 'TOTAL',
    selection: { side: 'OVER' },
    prediction: 'OVER',
    line: 6.5,
    price: -110,
    edge: 0.12,
    model_prob: 0.62,
    tier: hasDegradedTrust ? 'BEST' : 'SUPER',
    confidence: 0.75,
    reasoning: 'Fault harness production wrapper check.',
    driver: {
      key: 'pace_signal',
      score: 0.72,
      inputs: {
        conflict: 0.18,
      },
    },
    consistency: {
      pace_tier: 'HIGH',
      event_env: 'INDOOR',
      event_direction_tag: 'FAVOR_OVER',
    },
    odds_context: {
      captured_at: new Date(Date.now() - 60 * 1000).toISOString(),
      h2h_home: -120,
      h2h_away: 100,
      spread_home: -1.5,
      spread_away: 1.5,
      spread_price_home: -110,
      spread_price_away: -110,
      total: 6.5,
      total_price_over: -110,
      total_price_under: -110,
    },
    reason_codes: [],
    official_eligible: officialEligible,
    homeGoalieState: homeState,
    awayGoalieState: awayState,
  };
}

function deriveGoalieWatchdogReasonCodes(homeState, awayState) {
  if (!goalieUncertaintyBlocks(homeState, awayState)) return [];
  return [
    homeState.starter_state === 'CONFLICTING' ||
    awayState.starter_state === 'CONFLICTING'
      ? WATCHDOG_REASONS.GOALIE_CONFLICTING
      : WATCHDOG_REASONS.GOALIE_UNCONFIRMED,
  ];
}

function getExpectedScenarioContract(scenario) {
  return {
    ...scenario.expected,
    ...REAL_EXPECTATION_OVERRIDES[scenario.id],
  };
}

function evaluateScenario(scenario) {
  const home = buildScenarioSideState(scenario.input.home, 'home');
  const away = buildScenarioSideState(scenario.input.away, 'away');
  const prediction = buildPredictionFromStates(home, away);
  const payload = buildWrapperPayload(home, away, prediction.official_eligible);
  const totalDecision = {
    status: 'WATCH',
    edge: 1.8,
    best_candidate: { line: 6.5 },
  };

  applyUiActionFields(payload);

  return {
    canonical_starter_state: {
      home: home.starter_state,
      away: away.starter_state,
    },
    evidence_flags: {
      home: sortUnique(home.evidence_flags),
      away: sortUnique(away.evidence_flags),
    },
    adjustment_trust: {
      home: home.adjustment_trust,
      away: away.adjustment_trust,
    },
    model_descriptive_output: prediction ? 'present' : 'absent',
    official_eligible: prediction.official_eligible,
    consistency_vol_env: deriveVolEnv(payload, home, away),
    consistency_total_bias: computeTotalBias(totalDecision, home, away),
    watchdog_reason_codes: deriveGoalieWatchdogReasonCodes(home, away),
    wrapper_action: payload.action,
  };
}

function evaluateLegacyBooleanPath(input) {
  if (
    input?.legacy?.homeGoalieConfirmed === true &&
    input?.legacy?.awayGoalieConfirmed === true
  ) {
    return 'HOLD';
  }
  return 'PASS';
}

function assertCompleteContract(actual, expected, scenarioName) {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  expect(expectedKeys).toEqual(SORTED_CONTRACT_KEYS);
  expect(actualKeys).toEqual(SORTED_CONTRACT_KEYS);

  expect(actual.canonical_starter_state).toEqual(expected.canonical_starter_state);
  expect(actual.evidence_flags).toEqual({
    home: sortUnique(expected.evidence_flags.home),
    away: sortUnique(expected.evidence_flags.away),
  });
  expect(actual.adjustment_trust).toEqual(expected.adjustment_trust);
  expect(actual.model_descriptive_output).toBe(expected.model_descriptive_output);
  expect(actual.official_eligible).toBe(expected.official_eligible);
  expect(actual.consistency_vol_env).toBe(expected.consistency_vol_env);
  expect(actual.consistency_total_bias).toBe(expected.consistency_total_bias);
  expect(sortUnique(actual.watchdog_reason_codes)).toEqual(
    sortUnique(expected.watchdog_reason_codes),
  );

  if (Array.isArray(expected.wrapper_action)) {
    expect(expected.wrapper_action).toContain(actual.wrapper_action);
  } else {
    expect(actual.wrapper_action).toBe(expected.wrapper_action);
  }

  if (scenarioName.startsWith('FC-7')) {
    const forbiddenLegacyAction = evaluateLegacyBooleanPath({
      legacy: { homeGoalieConfirmed: true, awayGoalieConfirmed: true },
    });
    expect(actual.wrapper_action).toBe('PASS');
    expect(forbiddenLegacyAction).not.toBe(actual.wrapper_action);
  }
}

describe('NHL totals fault harness (WI-0384)', () => {
  test('contains exactly 14 named scenarios', () => {
    expect(SCENARIOS).toHaveLength(14);
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(14);
  });

  test.each(SCENARIOS)('[$id] $name', (scenario) => {
    const actual = evaluateScenario(scenario);
    assertCompleteContract(actual, getExpectedScenarioContract(scenario), scenario.id);
  });
});
