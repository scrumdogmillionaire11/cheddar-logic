'use strict';

/**
 * @typedef {Object} SideSignals
 * @property {string|null} scraper_name
 * @property {'CONFIRMED'|'EXPECTED'|null} scraper_status
 * @property {boolean} has_metrics
 * @property {string|null} user_name
 * @property {'CONFIRMED'|'EXPECTED'|null} user_status
 */

/**
 * @typedef {Object} ScenarioCase
 * @property {string} id
 * @property {string} name
 * @property {string} notes
 * @property {{home: SideSignals, away: SideSignals, legacy?: {homeGoalieConfirmed?: boolean, awayGoalieConfirmed?: boolean}}} input
 * @property {{
 *  canonical_starter_state: {home: 'CONFIRMED'|'EXPECTED'|'UNKNOWN'|'CONFLICTING', away: 'CONFIRMED'|'EXPECTED'|'UNKNOWN'|'CONFLICTING'},
 *  evidence_flags: {home: string[], away: string[]},
 *  adjustment_trust: {home: 'FULL'|'DEGRADED'|'NEUTRALIZED'|'BLOCKED', away: 'FULL'|'DEGRADED'|'NEUTRALIZED'|'BLOCKED'},
 *  model_descriptive_output: 'present'|'absent',
 *  official_eligible: boolean,
 *  consistency_vol_env: 'VOLATILE'|'STABLE',
 *  consistency_total_bias: 'OK'|'INSUFFICIENT_DATA',
 *  watchdog_reason_codes: string[],
 *  wrapper_action: 'FIRE'|'HOLD'|'PASS'|Array<'FIRE'|'HOLD'|'PASS'>
 * }} expected
 */

/** @type {ScenarioCase[]} */
const SCENARIOS = [
  {
    id: 'A',
    name: 'Case A — Clean confirmed starters',
    notes: 'Both confirmed with metrics and no source disagreement.',
    input: {
      home: {
        scraper_name: 'Home Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFIRMED', away: 'CONFIRMED' },
      evidence_flags: { home: [], away: [] },
      adjustment_trust: { home: 'FULL', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: true,
      consistency_vol_env: 'STABLE',
      consistency_total_bias: 'OK',
      watchdog_reason_codes: [],
      wrapper_action: ['FIRE', 'HOLD'],
    },
  },
  {
    id: 'B',
    name: 'Case B — Confirmed home, expected away',
    notes: 'Away expected starter degrades trust but remains eligible.',
    input: {
      home: {
        scraper_name: 'Home Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Expected',
        scraper_status: 'EXPECTED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFIRMED', away: 'EXPECTED' },
      evidence_flags: { home: [], away: [] },
      adjustment_trust: { home: 'FULL', away: 'DEGRADED' },
      model_descriptive_output: 'present',
      official_eligible: true,
      consistency_vol_env: 'STABLE',
      consistency_total_bias: 'OK',
      watchdog_reason_codes: [],
      wrapper_action: 'HOLD',
    },
  },
  {
    id: 'C',
    name: 'Case C — Unknown vs unknown',
    notes: 'No names and no usable status for either side.',
    input: {
      home: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: false,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: false,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'UNKNOWN', away: 'UNKNOWN' },
      evidence_flags: {
        home: ['SEASON_TABLE_INFERENCE_ONLY'],
        away: ['SEASON_TABLE_INFERENCE_ONLY'],
      },
      adjustment_trust: { home: 'NEUTRALIZED', away: 'NEUTRALIZED' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_UNCONFIRMED'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'D',
    name: 'Case D — User confirmed, scraper expected, same name',
    notes: 'User input wins when sources agree on identity.',
    input: {
      home: {
        scraper_name: 'Same Goalie',
        scraper_status: 'EXPECTED',
        has_metrics: true,
        user_name: 'Same Goalie',
        user_status: 'CONFIRMED',
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFIRMED', away: 'CONFIRMED' },
      evidence_flags: { home: [], away: [] },
      adjustment_trust: { home: 'FULL', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: true,
      consistency_vol_env: 'STABLE',
      consistency_total_bias: 'OK',
      watchdog_reason_codes: [],
      wrapper_action: ['FIRE', 'HOLD'],
    },
  },
  {
    id: 'E',
    name: 'Case E — Starter resolved but metrics missing',
    notes: 'Name is known via user confirmation but tier confidence is low.',
    input: {
      home: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: false,
        user_name: 'Home Confirmed',
        user_status: 'CONFIRMED',
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFIRMED', away: 'CONFIRMED' },
      evidence_flags: { home: ['METRICS_JOIN_FAILED'], away: [] },
      adjustment_trust: { home: 'DEGRADED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: true,
      consistency_vol_env: 'STABLE',
      consistency_total_bias: 'OK',
      watchdog_reason_codes: [],
      wrapper_action: 'HOLD',
    },
  },
  {
    id: 'F',
    name: 'Case F — Conflicting source evidence',
    notes: 'User and scraper disagree on starter identity.',
    input: {
      home: {
        scraper_name: 'Scraper Home',
        scraper_status: 'EXPECTED',
        has_metrics: true,
        user_name: 'User Home',
        user_status: 'CONFIRMED',
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFLICTING', away: 'CONFIRMED' },
      evidence_flags: { home: ['CONFLICTING_SOURCE_EVIDENCE'], away: [] },
      adjustment_trust: { home: 'BLOCKED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_CONFLICTING'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'G',
    name: 'Case G — Backup rumor / season-table inference only',
    notes: 'No confirmed starter identity; only weak inference signals.',
    input: {
      home: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'UNKNOWN', away: 'CONFIRMED' },
      evidence_flags: { home: ['SEASON_TABLE_INFERENCE_ONLY'], away: [] },
      adjustment_trust: { home: 'NEUTRALIZED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_UNCONFIRMED'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'FC-1',
    name: 'FC-1 — Classic split-brain',
    notes: 'Same semantic intent as Case F, retained as explicit failure case.',
    input: {
      home: {
        scraper_name: 'Scraper Home',
        scraper_status: 'EXPECTED',
        has_metrics: true,
        user_name: 'User Home',
        user_status: 'CONFIRMED',
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFLICTING', away: 'CONFIRMED' },
      evidence_flags: { home: ['CONFLICTING_SOURCE_EVIDENCE'], away: [] },
      adjustment_trust: { home: 'BLOCKED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_CONFLICTING'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'FC-2',
    name: 'FC-2 — Expected goalie with missing tier lookup',
    notes: 'Expected starter resolved without metrics should remain degraded.',
    input: {
      home: {
        scraper_name: 'Home Expected',
        scraper_status: 'EXPECTED',
        has_metrics: false,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'EXPECTED', away: 'CONFIRMED' },
      evidence_flags: { home: ['METRICS_JOIN_FAILED'], away: [] },
      adjustment_trust: { home: 'DEGRADED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: true,
      consistency_vol_env: 'STABLE',
      consistency_total_bias: 'OK',
      watchdog_reason_codes: [],
      wrapper_action: 'HOLD',
    },
  },
  {
    id: 'FC-3',
    name: 'FC-3 — Name resolved, certainty absent',
    notes: 'Scraper name with no certainty token should map to EXPECTED.',
    input: {
      home: {
        scraper_name: 'Home Named',
        scraper_status: null,
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'EXPECTED', away: 'CONFIRMED' },
      evidence_flags: { home: [], away: [] },
      adjustment_trust: { home: 'DEGRADED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: true,
      consistency_vol_env: 'STABLE',
      consistency_total_bias: 'OK',
      watchdog_reason_codes: [],
      wrapper_action: 'HOLD',
    },
  },
  {
    id: 'FC-4',
    name: 'FC-4 — Season-table inference only',
    notes: 'No identity resolution but weak seasonal signal exists.',
    input: {
      home: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'UNKNOWN', away: 'CONFIRMED' },
      evidence_flags: { home: ['SEASON_TABLE_INFERENCE_ONLY'], away: [] },
      adjustment_trust: { home: 'NEUTRALIZED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_UNCONFIRMED'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'FC-5',
    name: 'FC-5 — Both sides unresolved',
    notes: 'No names, no statuses, no user input across both teams.',
    input: {
      home: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: false,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: null,
        scraper_status: null,
        has_metrics: false,
        user_name: null,
        user_status: null,
      },
    },
    expected: {
      canonical_starter_state: { home: 'UNKNOWN', away: 'UNKNOWN' },
      evidence_flags: {
        home: ['SEASON_TABLE_INFERENCE_ONLY'],
        away: ['SEASON_TABLE_INFERENCE_ONLY'],
      },
      adjustment_trust: { home: 'NEUTRALIZED', away: 'NEUTRALIZED' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_UNCONFIRMED'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'FC-6',
    name: 'FC-6 — One side confirmed, one side conflicting',
    notes: 'Any blocked side must force ineligible + PASS.',
    input: {
      home: {
        scraper_name: 'Home Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      away: {
        scraper_name: 'Away Scraper',
        scraper_status: 'EXPECTED',
        has_metrics: true,
        user_name: 'Away User',
        user_status: 'CONFIRMED',
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFIRMED', away: 'CONFLICTING' },
      evidence_flags: { home: [], away: ['CONFLICTING_SOURCE_EVIDENCE'] },
      adjustment_trust: { home: 'FULL', away: 'BLOCKED' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_CONFLICTING'],
      wrapper_action: 'PASS',
    },
  },
  {
    id: 'FC-7',
    name: 'FC-7 — Canonical conflicting must beat legacy confirmed boolean',
    notes: 'Regression guard for side-door boolean reads after canonical rollout.',
    input: {
      home: {
        scraper_name: 'Home Scraper',
        scraper_status: 'EXPECTED',
        has_metrics: true,
        user_name: 'Home User',
        user_status: 'CONFIRMED',
      },
      away: {
        scraper_name: 'Away Confirmed',
        scraper_status: 'CONFIRMED',
        has_metrics: true,
        user_name: null,
        user_status: null,
      },
      legacy: {
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
      },
    },
    expected: {
      canonical_starter_state: { home: 'CONFLICTING', away: 'CONFIRMED' },
      evidence_flags: { home: ['CONFLICTING_SOURCE_EVIDENCE'], away: [] },
      adjustment_trust: { home: 'BLOCKED', away: 'FULL' },
      model_descriptive_output: 'present',
      official_eligible: false,
      consistency_vol_env: 'VOLATILE',
      consistency_total_bias: 'INSUFFICIENT_DATA',
      watchdog_reason_codes: ['GOALIE_CONFLICTING'],
      wrapper_action: 'PASS',
    },
  },
];

module.exports = {
  SCENARIOS,
};
