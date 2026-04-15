'use strict';

// TD-04: Tests for summarizeNbaRejectReasonFamilies and checkNbaMarketCallDiagnostics
// Follows the same fixture-based pattern as check-pipeline-health.nhl.test.js

describe('summarizeNbaRejectReasonFamilies', () => {
  let rejectReasonRows;
  let summarizeNbaRejectReasonFamilies;

  beforeEach(() => {
    jest.resetModules();
    rejectReasonRows = [];

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => ({
        prepare: jest.fn((sql) => {
          if (
            sql.includes("card_type IN ('nba-totals-call', 'nba-spread-call')")
          ) {
            return { all: () => rejectReasonRows };
          }
          throw new Error(`Unhandled SQL in NBA health test: ${sql}`);
        }),
      })),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));

    ({ summarizeNbaRejectReasonFamilies } = require('../jobs/check_pipeline_health'));
  });

  test('returns zero counts with no rows', () => {
    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.uncategorized_count).toBe(0);
    expect(result.reason_family_counts['nba-totals-call']).toBeDefined();
    expect(result.reason_family_counts['nba-spread-call']).toBeDefined();
    // all counts zero
    for (const ct of ['nba-totals-call', 'nba-spread-call']) {
      const counts = result.reason_family_counts[ct];
      for (const v of Object.values(counts)) {
        expect(v).toBe(0);
      }
    }
  });

  test('classifies POLICY_QUARANTINE family from NBA_TOTAL_QUARANTINE_DEMOTE', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: 'NBA_TOTAL_QUARANTINE_DEMOTE',
        pass_reason: null,
        reason_codes_json: '["NBA_TOTAL_QUARANTINE_DEMOTE"]',
        cnt: 8,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-totals-call'].POLICY_QUARANTINE).toBe(8);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies NO_EDGE family from primary_reason_code', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 4,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-totals-call'].NO_EDGE).toBe(4);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies DATA_STALENESS family from pass_reason_code', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-spread-call',
        decision_reason: null,
        pass_reason: 'BLOCK_STALE_DATA',
        reason_codes_json: '["BLOCK_STALE_DATA"]',
        cnt: 2,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-spread-call'].DATA_STALENESS).toBe(2);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies INTEGRITY_VETO from integrity reason code', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-spread-call',
        decision_reason: 'GATE_INTEGRITY_VETO',
        pass_reason: null,
        reason_codes_json: '["GATE_INTEGRITY_VETO"]',
        cnt: 1,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-spread-call'].INTEGRITY_VETO).toBe(1);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies CONTRACT_MISMATCH from PROJECTION_ONLY', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: null,
        pass_reason: null,
        reason_codes_json: '["PROJECTION_ONLY_EXCLUSION"]',
        cnt: 3,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-totals-call'].CONTRACT_MISMATCH).toBe(3);
    expect(result.uncategorized_count).toBe(0);
  });

  test('returns UNCATEGORIZED for unknown reason codes and non-zero uncategorized_count', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: 'SOME_UNKNOWN_CODE_XYZ',
        pass_reason: null,
        reason_codes_json: '["SOME_UNKNOWN_CODE_XYZ"]',
        cnt: 1,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-totals-call'].UNCATEGORIZED).toBe(1);
    expect(result.uncategorized_count).toBe(1);
  });

  test('returns deterministic per-market buckets for both NBA card types', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: 'NBA_TOTAL_QUARANTINE_DEMOTE',
        pass_reason: null,
        reason_codes_json: '["NBA_TOTAL_QUARANTINE_DEMOTE"]',
        cnt: 5,
      },
      {
        card_type: 'nba-spread-call',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 2,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.uncategorized_count).toBe(0);
    expect(result.reason_family_counts['nba-totals-call'].POLICY_QUARANTINE).toBe(5);
    expect(result.reason_family_counts['nba-spread-call'].NO_EDGE).toBe(2);
  });

  test('handles malformed reason_codes_json gracefully as UNCATEGORIZED', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: null,
        pass_reason: null,
        reason_codes_json: 'NOT_VALID_JSON',
        cnt: 1,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNbaRejectReasonFamilies(db);

    expect(result.reason_family_counts['nba-totals-call'].UNCATEGORIZED).toBe(1);
    expect(result.uncategorized_count).toBe(1);
  });
});

describe('checkNbaMarketCallDiagnostics', () => {
  let rejectReasonRows;
  let pipelineWrites;
  let checkNbaMarketCallDiagnostics;

  beforeEach(() => {
    jest.resetModules();
    rejectReasonRows = [];
    pipelineWrites = [];

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => ({
        prepare: jest.fn((sql) => {
          if (sql.includes('INSERT INTO pipeline_health')) {
            return { run: (...args) => { pipelineWrites.push(args); } };
          }
          if (
            sql.includes("card_type IN ('nba-totals-call', 'nba-spread-call')")
          ) {
            return { all: () => rejectReasonRows };
          }
          throw new Error(`Unhandled SQL in NBA diagnostics test: ${sql}`);
        }),
      })),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));

    ({ checkNbaMarketCallDiagnostics } = require('../jobs/check_pipeline_health'));
  });

  test('returns ok=true and writes ok status when all blockers are categorized', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-totals-call',
        decision_reason: 'NBA_TOTAL_QUARANTINE_DEMOTE',
        pass_reason: null,
        reason_codes_json: '["NBA_TOTAL_QUARANTINE_DEMOTE"]',
        cnt: 2,
      },
    ];

    const result = checkNbaMarketCallDiagnostics();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('all blockers categorized');
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics.uncategorized_count).toBe(0);
    expect(pipelineWrites.length).toBe(1);
    expect(pipelineWrites[0][0]).toBe('nba');
    expect(pipelineWrites[0][1]).toBe('market_call_blockers');
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('returns ok=false and writes warning status when uncategorized blockers exist', () => {
    rejectReasonRows = [
      {
        card_type: 'nba-spread-call',
        decision_reason: 'WEIRD_UNKNOWN_REASON',
        pass_reason: null,
        reason_codes_json: '["WEIRD_UNKNOWN_REASON"]',
        cnt: 1,
      },
    ];

    const result = checkNbaMarketCallDiagnostics();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('uncategorized');
    expect(pipelineWrites[0][2]).toBe('warning');
  });
});
