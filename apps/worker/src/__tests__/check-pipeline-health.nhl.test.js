'use strict';

// TD-04: Tests for summarizeNhlRejectReasonFamilies and checkNhlMarketCallDiagnostics
// Follows the same fixture-based pattern as check-pipeline-health.mlb.test.js

describe('summarizeNhlRejectReasonFamilies', () => {
  let rejectReasonRows;
  let summarizeNhlRejectReasonFamilies;

  beforeEach(() => {
    jest.resetModules();
    rejectReasonRows = [];

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => ({
        prepare: jest.fn((sql) => {
          if (
            sql.includes("card_type IN ('nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call')")
          ) {
            return { all: () => rejectReasonRows };
          }
          throw new Error(`Unhandled SQL in NHL health test: ${sql}`);
        }),
      })),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));

    ({ summarizeNhlRejectReasonFamilies } = require('../jobs/check_pipeline_health'));
  });

  test('returns zero counts with no rows', () => {
    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.uncategorized_count).toBe(0);
    expect(result.reason_family_counts['nhl-totals-call']).toBeDefined();
    expect(result.reason_family_counts['nhl-spread-call']).toBeDefined();
    expect(result.reason_family_counts['nhl-moneyline-call']).toBeDefined();
    // all counts zero
    for (const ct of ['nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call']) {
      const counts = result.reason_family_counts[ct];
      for (const v of Object.values(counts)) {
        expect(v).toBe(0);
      }
    }
  });

  test('classifies NO_EDGE family from primary_reason_code', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-totals-call',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 4,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.reason_family_counts['nhl-totals-call'].NO_EDGE).toBe(4);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies DATA_STALENESS family from pass_reason_code', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-moneyline-call',
        decision_reason: null,
        pass_reason: 'BLOCK_STALE_DATA',
        reason_codes_json: '["BLOCK_STALE_DATA"]',
        cnt: 2,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.reason_family_counts['nhl-moneyline-call'].DATA_STALENESS).toBe(2);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies INTEGRITY_VETO from goalie reason code', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-spread-call',
        decision_reason: 'GATE_GOALIE_UNCONFIRMED',
        pass_reason: null,
        reason_codes_json: '["GATE_GOALIE_UNCONFIRMED"]',
        cnt: 1,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.reason_family_counts['nhl-spread-call'].INTEGRITY_VETO).toBe(1);
    expect(result.uncategorized_count).toBe(0);
  });

  test('classifies CONTRACT_MISMATCH from NO_ODDS_MODE_LEAN', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-totals-call',
        decision_reason: null,
        pass_reason: null,
        reason_codes_json: '["NO_ODDS_MODE_LEAN"]',
        cnt: 3,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.reason_family_counts['nhl-totals-call'].CONTRACT_MISMATCH).toBe(3);
    expect(result.uncategorized_count).toBe(0);
  });

  test('returns UNCATEGORIZED for unknown reason codes and non-zero uncategorized_count', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-moneyline-call',
        decision_reason: 'SOME_UNKNOWN_CODE_XYZ',
        pass_reason: null,
        reason_codes_json: '["SOME_UNKNOWN_CODE_XYZ"]',
        cnt: 1,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.reason_family_counts['nhl-moneyline-call'].UNCATEGORIZED).toBe(1);
    expect(result.uncategorized_count).toBe(1);
  });

  test('returns deterministic per-market buckets for all three card types', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-totals-call',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 5,
      },
      {
        card_type: 'nhl-spread-call',
        decision_reason: 'BLOCK_STALE_DATA',
        pass_reason: null,
        reason_codes_json: '["BLOCK_STALE_DATA"]',
        cnt: 2,
      },
      {
        card_type: 'nhl-moneyline-call',
        decision_reason: 'GATE_GOALIE_UNCONFIRMED',
        pass_reason: null,
        reason_codes_json: '["GATE_GOALIE_UNCONFIRMED"]',
        cnt: 3,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.uncategorized_count).toBe(0);
    expect(result.reason_family_counts['nhl-totals-call'].NO_EDGE).toBe(5);
    expect(result.reason_family_counts['nhl-spread-call'].DATA_STALENESS).toBe(2);
    expect(result.reason_family_counts['nhl-moneyline-call'].INTEGRITY_VETO).toBe(3);
  });

  test('handles malformed reason_codes_json gracefully as UNCATEGORIZED', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-totals-call',
        decision_reason: null,
        pass_reason: null,
        reason_codes_json: 'NOT_VALID_JSON',
        cnt: 1,
      },
    ];

    const db = require('@cheddar-logic/data').getDatabase();
    const result = summarizeNhlRejectReasonFamilies(db);

    expect(result.reason_family_counts['nhl-totals-call'].UNCATEGORIZED).toBe(1);
    expect(result.uncategorized_count).toBe(1);
  });
});

describe('checkNhlMarketCallDiagnostics', () => {
  let rejectReasonRows;
  let pipelineWrites;
  let checkNhlMarketCallDiagnostics;

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
            sql.includes("card_type IN ('nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call')")
          ) {
            return { all: () => rejectReasonRows };
          }
          throw new Error(`Unhandled SQL in NHL diagnostics test: ${sql}`);
        }),
      })),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));

    ({ checkNhlMarketCallDiagnostics } = require('../jobs/check_pipeline_health'));
  });

  test('returns ok=true and writes ok status when all blockers are categorized', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-totals-call',
        decision_reason: 'PASS_NO_EDGE',
        pass_reason: null,
        reason_codes_json: '["PASS_NO_EDGE"]',
        cnt: 2,
      },
    ];

    const result = checkNhlMarketCallDiagnostics();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('all blockers categorized');
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics.uncategorized_count).toBe(0);
    expect(pipelineWrites.length).toBe(1);
    expect(pipelineWrites[0][0]).toBe('nhl');
    expect(pipelineWrites[0][1]).toBe('market_call_blockers');
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('returns ok=false and writes warning status when uncategorized blockers exist', () => {
    rejectReasonRows = [
      {
        card_type: 'nhl-moneyline-call',
        decision_reason: 'WEIRD_UNKNOWN_REASON',
        pass_reason: null,
        reason_codes_json: '["WEIRD_UNKNOWN_REASON"]',
        cnt: 1,
      },
    ];

    const result = checkNhlMarketCallDiagnostics();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('uncategorized');
    expect(pipelineWrites[0][2]).toBe('warning');
  });
});

describe('checkNhlMoneylineCoverage', () => {
  let h2hGamesCount;
  let moneylineCardsCount;
  let pipelineWrites;
  let checkNhlMoneylineCoverage;

  beforeEach(() => {
    jest.resetModules();
    h2hGamesCount = 0;
    moneylineCardsCount = 0;
    pipelineWrites = [];

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => ({
        prepare: jest.fn((sql) => {
          if (sql.includes('INSERT INTO pipeline_health')) {
            return { run: (...args) => { pipelineWrites.push(args); } };
          }
          if (sql.includes('COUNT(DISTINCT g.game_id) AS cnt')) {
            return { get: () => ({ cnt: h2hGamesCount }) };
          }
          if (sql.includes("card_type = 'nhl-moneyline-call'")) {
            return { get: () => ({ cnt: moneylineCardsCount }) };
          }
          throw new Error(`Unhandled SQL in NHL ML coverage test: ${sql}`);
        }),
      })),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
    }));

    ({ checkNhlMoneylineCoverage } = require('../jobs/check_pipeline_health'));
  });

  test('returns ok=true when no h2h games are in lookahead window', () => {
    h2hGamesCount = 0;
    moneylineCardsCount = 0;

    const result = checkNhlMoneylineCoverage();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('no games with h2h odds');
    expect(result.diagnostics.nhl_games_with_h2h_odds).toBe(0);
    expect(result.diagnostics.nhl_moneyline_cards_count).toBe(0);
    expect(result.diagnostics.alert_code).toBeNull();
    expect(pipelineWrites[0][0]).toBe('nhl');
    expect(pipelineWrites[0][1]).toBe('moneyline_coverage');
    expect(pipelineWrites[0][2]).toBe('ok');
  });

  test('returns ok=false with NHL_ML_SURFACING_GAP when h2h games exist but no ML cards', () => {
    h2hGamesCount = 3;
    moneylineCardsCount = 0;

    const result = checkNhlMoneylineCoverage();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('NHL_ML_SURFACING_GAP');
    expect(result.diagnostics.nhl_games_with_h2h_odds).toBe(3);
    expect(result.diagnostics.nhl_moneyline_cards_count).toBe(0);
    expect(result.diagnostics.alert_code).toBe('NHL_ML_SURFACING_GAP');
    expect(pipelineWrites[0][0]).toBe('nhl');
    expect(pipelineWrites[0][1]).toBe('moneyline_coverage');
    expect(pipelineWrites[0][2]).toBe('failed');
  });

  test('returns ok=true when h2h games and moneyline cards are both present', () => {
    h2hGamesCount = 2;
    moneylineCardsCount = 6;

    const result = checkNhlMoneylineCoverage();

    expect(result.ok).toBe(true);
    expect(result.reason).toContain('2 game(s) with h2h odds');
    expect(result.reason).toContain('6 nhl-moneyline-call card(s)');
    expect(result.diagnostics.nhl_games_with_h2h_odds).toBe(2);
    expect(result.diagnostics.nhl_moneyline_cards_count).toBe(6);
    expect(result.diagnostics.alert_code).toBeNull();
    expect(pipelineWrites[0][2]).toBe('ok');
  });
});

describe('checkNhlSogSyncFreshness / checkNhlSogPullFreshness', () => {
  let wasJobRecentlySuccessfulMock;
  let upcomingNhlGameCount;
  let pipelineWrites;
  let checkNhlSogSyncFreshness;
  let checkNhlSogPullFreshness;

  beforeEach(() => {
    jest.resetModules();
    wasJobRecentlySuccessfulMock = jest.fn(() => true);
    upcomingNhlGameCount = 2;
    pipelineWrites = [];

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => ({
        prepare: jest.fn((sql) => {
          if (sql.includes('COUNT(*)') && sql.includes('FROM games')) {
            return { get: jest.fn(() => ({ cnt: upcomingNhlGameCount })) };
          }
          if (sql.includes('INSERT INTO pipeline_health')) {
            return {
              run: jest.fn((...args) => { pipelineWrites.push(args); }),
            };
          }
          return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
        }),
      })),
      insertJobRun: jest.fn(),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: wasJobRecentlySuccessfulMock,
    }));

    const mod = require('../jobs/check_pipeline_health');
    checkNhlSogSyncFreshness = mod.checkNhlSogSyncFreshness;
    checkNhlSogPullFreshness = mod.checkNhlSogPullFreshness;
  });

  test('sync: returns ok=true when sync_nhl_sog_player_ids ran within 1440 min', () => {
    wasJobRecentlySuccessfulMock.mockReturnValue(true);
    const result = checkNhlSogSyncFreshness();
    expect(result.ok).toBe(true);
    expect(wasJobRecentlySuccessfulMock).toHaveBeenCalledWith('sync_nhl_sog_player_ids', 1440);
  });

  test('sync: returns ok=false and writes failed when sync_nhl_sog_player_ids has not run', () => {
    wasJobRecentlySuccessfulMock.mockReturnValue(false);
    const result = checkNhlSogSyncFreshness();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sync_nhl_sog_player_ids');
    expect(pipelineWrites.some((w) => w[1] === 'sog_sync_freshness' && w[2] === 'failed')).toBe(true);
  });

  test('sync: returns ok=true (skipped) when no upcoming NHL games', () => {
    upcomingNhlGameCount = 0;
    const result = checkNhlSogSyncFreshness();
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('model check skipped');
  });

  test('pull: returns ok=true when pull_nhl_player_shots ran within 1440 min', () => {
    wasJobRecentlySuccessfulMock.mockReturnValue(true);
    const result = checkNhlSogPullFreshness();
    expect(result.ok).toBe(true);
    expect(wasJobRecentlySuccessfulMock).toHaveBeenCalledWith('pull_nhl_player_shots', 1440);
  });

  test('pull: returns ok=false and writes failed when pull_nhl_player_shots has not run', () => {
    wasJobRecentlySuccessfulMock.mockReturnValue(false);
    const result = checkNhlSogPullFreshness();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pull_nhl_player_shots');
    expect(pipelineWrites.some((w) => w[1] === 'sog_pull_freshness' && w[2] === 'failed')).toBe(true);
  });
});
