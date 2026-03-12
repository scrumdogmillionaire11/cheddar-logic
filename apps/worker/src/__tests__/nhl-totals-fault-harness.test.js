'use strict';

const { SCENARIOS } = require('./fixtures/nhl-goalie/scenarios.js');

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

// TODO: replace stub with real implementation after WI-0379/WI-0380.
function resolveCanonicalSide(signal) {
  const evidence = [];

  if (
    signal.user_name &&
    signal.scraper_name &&
    signal.user_name !== signal.scraper_name
  ) {
    evidence.push('CONFLICTING_SOURCE_EVIDENCE');
    return {
      starter_state: 'CONFLICTING',
      evidence_flags: evidence,
    };
  }

  if (signal.user_name || signal.user_status) {
    const starterState = signal.user_status || 'EXPECTED';
    if (!signal.has_metrics && starterState !== 'UNKNOWN') {
      evidence.push('METRICS_JOIN_FAILED');
    }
    return {
      starter_state: starterState,
      evidence_flags: evidence,
    };
  }

  if (signal.scraper_name) {
    const starterState = signal.scraper_status || 'EXPECTED';
    if (!signal.has_metrics && starterState !== 'UNKNOWN') {
      evidence.push('METRICS_JOIN_FAILED');
    }
    return {
      starter_state: starterState,
      evidence_flags: evidence,
    };
  }

  evidence.push('SEASON_TABLE_INFERENCE_ONLY');
  return {
    starter_state: 'UNKNOWN',
    evidence_flags: evidence,
  };
}

// TODO: replace stub with real implementation after WI-0381.
function deriveAdjustmentTrust(sideState) {
  if (sideState.starter_state === 'CONFLICTING') return 'BLOCKED';
  if (sideState.starter_state === 'UNKNOWN') return 'NEUTRALIZED';
  if (sideState.evidence_flags.includes('METRICS_JOIN_FAILED')) return 'DEGRADED';
  if (sideState.starter_state === 'EXPECTED') return 'DEGRADED';
  return 'FULL';
}

// TODO: replace stub with real implementation after WI-0381.
function deriveOfficialEligibility(homeTrust, awayTrust) {
  if (homeTrust === 'BLOCKED' || awayTrust === 'BLOCKED') return false;
  if (homeTrust === 'NEUTRALIZED' || awayTrust === 'NEUTRALIZED') return false;
  return true;
}

// TODO: replace stub with real implementation after WI-0382.
function deriveConsistency(homeStarterState, awayStarterState) {
  const unresolved =
    homeStarterState === 'UNKNOWN' ||
    homeStarterState === 'CONFLICTING' ||
    awayStarterState === 'UNKNOWN' ||
    awayStarterState === 'CONFLICTING';

  if (unresolved) {
    return {
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
    };
  }

  return {
    consistency_vol_env: 'STABLE',
    consistency_total_bias: 'OK',
  };
}

// TODO: replace stub with real implementation after WI-0383.
function deriveWatchdogAndWrapper({
  homeStarterState,
  awayStarterState,
  homeTrust,
  awayTrust,
  officialEligible,
}) {
  if (homeStarterState === 'CONFLICTING' || awayStarterState === 'CONFLICTING') {
    return {
      watchdog_reason_codes: ['GOALIE_CONFLICTING'],
      wrapper_action: 'PASS',
    };
  }

  if (homeStarterState === 'UNKNOWN' || awayStarterState === 'UNKNOWN') {
    return {
      watchdog_reason_codes: ['GOALIE_UNCONFIRMED'],
      wrapper_action: 'PASS',
    };
  }

  if (!officialEligible) {
    return {
      watchdog_reason_codes: [],
      wrapper_action: 'PASS',
    };
  }

  if (homeTrust === 'DEGRADED' || awayTrust === 'DEGRADED') {
    return {
      watchdog_reason_codes: [],
      wrapper_action: 'HOLD',
    };
  }

  return {
    watchdog_reason_codes: [],
    wrapper_action: 'FIRE',
  };
}

function evaluateScenario(scenario) {
  const home = resolveCanonicalSide(scenario.input.home);
  const away = resolveCanonicalSide(scenario.input.away);

  const homeTrust = deriveAdjustmentTrust(home);
  const awayTrust = deriveAdjustmentTrust(away);

  const officialEligible = deriveOfficialEligibility(homeTrust, awayTrust);
  const consistency = deriveConsistency(home.starter_state, away.starter_state);
  const action = deriveWatchdogAndWrapper({
    homeStarterState: home.starter_state,
    awayStarterState: away.starter_state,
    homeTrust,
    awayTrust,
    officialEligible,
  });

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
      home: homeTrust,
      away: awayTrust,
    },
    model_descriptive_output: 'present',
    official_eligible: officialEligible,
    consistency_vol_env: consistency.consistency_vol_env,
    consistency_total_bias: consistency.consistency_total_bias,
    watchdog_reason_codes: action.watchdog_reason_codes,
    wrapper_action: action.wrapper_action,
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
    assertCompleteContract(actual, scenario.expected, scenario.id);
  });
});
