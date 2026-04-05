'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// settle_pending_cards.ordering-guard.test.js
// Verifies the sequential ordering guard: settle_pending_cards must not run
// before settle_projections has completed (SUCCESS) for the same window key.
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('@cheddar-logic/data', () => ({
  buildMarketKey: jest.fn(),
  createMarketError: jest.fn(),
  incrementTrackingStat: jest.fn(),
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  normalizeMarketType: jest.fn(),
  normalizeSelectionForMarket: jest.fn(),
  parseLine: jest.fn(),
  recordClvEntry: jest.fn(),
  settleClvEntry: jest.fn(),
  hasSuccessfulJobRun: jest.fn().mockReturnValue(false),
  shouldRunJobKey: jest.fn().mockReturnValue(true),
  withDb: jest.fn(async (fn) => fn()),
}));

jest.mock('../../utils/db-backup.js', () => ({
  backupDatabase: jest.fn(),
}));

const { hasSuccessfulJobRun } = require('@cheddar-logic/data');
const { settlePendingCards } = require('../settle_pending_cards.js');

describe('settlePendingCards — sequential ordering guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips with guardedBy=settle_projections when projections not yet SUCCESS (hourly key)', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);

    const jobKey = 'settle|hourly|2026-04-04|14|pending-cards';
    const result = await settlePendingCards({ jobKey, dryRun: false });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.guardedBy).toBe('settle_projections');
    expect(hasSuccessfulJobRun).toHaveBeenCalledWith(
      'settle|hourly|2026-04-04|14|projections',
    );
  });

  test('skips with guardedBy=settle_projections when projections not yet SUCCESS (nightly key)', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);

    const jobKey = 'settle|nightly|2026-04-04|pending-cards';
    const result = await settlePendingCards({ jobKey, dryRun: false });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.guardedBy).toBe('settle_projections');
    expect(hasSuccessfulJobRun).toHaveBeenCalledWith(
      'settle|nightly|2026-04-04|projections',
    );
  });

  test('no guard check when jobKey is null', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);
    // Should fall through guard (no jobKey), hit dryRun fast-exit
    const result = await settlePendingCards({ jobKey: null, dryRun: true });

    expect(hasSuccessfulJobRun).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  test('log message contains SKIP: settle_projections text', async () => {
    hasSuccessfulJobRun.mockReturnValue(false);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const jobKey = 'settle|hourly|2026-04-04|14|pending-cards';
    await settlePendingCards({ jobKey, dryRun: false });

    const logs = consoleSpy.mock.calls.map((c) => c[0]).filter(Boolean);
    const guardLog = logs.find((l) => String(l).includes('settle_projections not yet SUCCESS'));
    expect(guardLog).toBeDefined();

    consoleSpy.mockRestore();
  });
});
