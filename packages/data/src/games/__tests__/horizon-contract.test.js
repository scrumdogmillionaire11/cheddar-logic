'use strict';
/**
 * Unit tests for packages/data/src/games/horizon-contract.js
 *
 * Verifies the ET-day-boundary MLB visibility rule is deterministic and correct.
 * Run: npm --prefix packages/data run test -- src/games/__tests__/horizon-contract.test.js
 */

const {
  computeMLBHorizonEndUtc,
  horizonEndToApproximateHours,
  HORIZON_CONTRACT_VERSION,
} = require('../horizon-contract');

describe('HORIZON_CONTRACT_VERSION', () => {
  test('is set to canonical version string', () => {
    expect(HORIZON_CONTRACT_VERSION).toBe('v1-et-boundary-aware');
  });
});

describe('computeMLBHorizonEndUtc', () => {
  // All examples from WI-1154 Horizon Contract Definition
  // today ET = 2026-04-24 (EDT = UTC-4)

  test('08:00 ET → horizon = 2026-04-25 23:59:59 ET = 2026-04-26 03:59:59 UTC', () => {
    // 2026-04-24 08:00 EDT = 2026-04-24 12:00 UTC
    const now = new Date('2026-04-24T12:00:00Z');
    const result = computeMLBHorizonEndUtc(now);
    expect(result).toBe('2026-04-26 03:59:59');
  });

  test('18:00 ET → horizon = 2026-04-25 23:59:59 ET = 2026-04-26 03:59:59 UTC', () => {
    // 2026-04-24 18:00 EDT = 2026-04-24 22:00 UTC
    const now = new Date('2026-04-24T22:00:00Z');
    const result = computeMLBHorizonEndUtc(now);
    expect(result).toBe('2026-04-26 03:59:59');
  });

  test('23:30 ET → horizon = 2026-04-25 23:59:59 ET = 2026-04-26 03:59:59 UTC', () => {
    // 2026-04-24 23:30 EDT = 2026-04-25 03:30 UTC
    const now = new Date('2026-04-25T03:30:00Z');
    const result = computeMLBHorizonEndUtc(now);
    expect(result).toBe('2026-04-26 03:59:59');
  });

  test('horizon is the same regardless of time-of-day on the same ET calendar day', () => {
    const morning = new Date('2026-04-24T12:00:00Z'); // 08:00 ET
    const evening = new Date('2026-04-24T22:00:00Z'); // 18:00 ET
    const lateNight = new Date('2026-04-25T03:30:00Z'); // 23:30 ET (still 04-24 ET — wait that's 04-24 night = still 04-24 ET? No, 23:30 ET is still 04-24. 03:30 UTC is 2026-04-25 in UTC but 2026-04-24 23:30 in ET)
    expect(computeMLBHorizonEndUtc(morning)).toBe(computeMLBHorizonEndUtc(evening));
    expect(computeMLBHorizonEndUtc(evening)).toBe(computeMLBHorizonEndUtc(lateNight));
  });

  test('game at horizon boundary (03:59:59 UTC on 2026-04-26) is within horizon', () => {
    const now = new Date('2026-04-24T22:00:00Z'); // 18:00 ET
    const horizonEnd = computeMLBHorizonEndUtc(now);
    const gameAtBoundary = '2026-04-26 03:59:59';
    expect(horizonEnd).toBe(gameAtBoundary);
  });

  test('game one second after horizon (04:00:00 UTC on 2026-04-26) is outside horizon', () => {
    const now = new Date('2026-04-24T22:00:00Z'); // 18:00 ET
    const horizonEnd = computeMLBHorizonEndUtc(now);
    const gameAfterBoundary = '2026-04-26 04:00:00';
    expect(horizonEnd < gameAfterBoundary).toBe(true);
  });

  test('rolls over correctly at ET midnight', () => {
    // 2026-04-25 00:00 EDT = 2026-04-25 04:00 UTC
    // Now today ET = 2026-04-25, so horizon end = 2026-04-26 23:59:59 ET = 2026-04-27 03:59:59 UTC
    const now = new Date('2026-04-25T04:01:00Z');
    const result = computeMLBHorizonEndUtc(now);
    expect(result).toBe('2026-04-27 03:59:59');
  });

  test('returns a SQL-compatible timestamp format (YYYY-MM-DD HH:MM:SS)', () => {
    const now = new Date('2026-04-24T15:30:00Z');
    const result = computeMLBHorizonEndUtc(now);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('handles EST (winter, UTC-5): horizon ends 04:59:59 UTC next day', () => {
    // 2026-01-15 15:00 EST = 2026-01-15 20:00 UTC
    // Today ET = 2026-01-15, horizon end = 2026-01-16 23:59:59 EST = 2026-01-17 04:59:59 UTC
    const now = new Date('2026-01-15T20:00:00Z');
    const result = computeMLBHorizonEndUtc(now);
    expect(result).toBe('2026-01-17 04:59:59');
  });
});

describe('horizonEndToApproximateHours', () => {
  test('returns a positive number for future horizon', () => {
    const now = new Date('2026-04-24T12:00:00Z');
    const hours = horizonEndToApproximateHours(now);
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThan(50);
  });

  test('early morning (08:00 ET) gives ~40h horizon', () => {
    // 2026-04-24 08:00 EDT (= 12:00 UTC) → horizon 2026-04-26 03:59:59 UTC = ~40h later
    const now = new Date('2026-04-24T12:00:00Z');
    const hours = horizonEndToApproximateHours(now);
    expect(hours).toBeGreaterThanOrEqual(38);
    expect(hours).toBeLessThan(48);
  });

  test('late night (23:30 ET) gives ~24.5h horizon', () => {
    // 2026-04-24 23:30 EDT (= 2026-04-25 03:30 UTC) → horizon 2026-04-26 03:59:59 UTC ≈ 24.5h later
    // The window is "end of tomorrow ET", which from 23:30 ET tonight is still ~24.5 hours away
    const now = new Date('2026-04-25T03:30:00Z');
    const hours = horizonEndToApproximateHours(now);
    expect(hours).toBeGreaterThanOrEqual(23);
    expect(hours).toBeLessThan(26);
  });
});
