'use strict';

/**
 * WI-0774: Unit tests for resolveGoalieState with NHL API source types.
 *
 * Tests:
 * - lookupApiGoalieRow with null db → returns null
 * - lookupApiGoalieRow with mock db (confirmed=1) → returns row
 * - resolveGoalieState with confirmed API row → NHL_API_CONFIRMED, tier_confidence=HIGH
 * - resolveGoalieState with probable API row → NHL_API_PROBABLE, tier_confidence=MEDIUM
 * - resolveGoalieState with no DB row, scraper name present → SCRAPER_NAME_MATCH
 * - resolveGoalieState with no DB row, no scraper name → missing_inputs=['goalie_unresolved'], UNKNOWN
 *
 * Run via Jest: npm --prefix apps/worker test -- --testPathPattern="nhl-goalie-state"
 */

const assert = require('assert');
const {
  resolveGoalieState,
  lookupApiGoalieRow,
} = require('../models/nhl-goalie-state');

describe('nhl-goalie-state', () => {

// ─── lookupApiGoalieRow ───────────────────────────────────────────────────────

test('lookupApiGoalieRow: returns null when db is null', () => {
  const result = lookupApiGoalieRow(null, 'game-1', 'TOR');
  assert.strictEqual(result, null);
});

test('lookupApiGoalieRow: returns null when db is undefined', () => {
  const result = lookupApiGoalieRow(undefined, 'game-1', 'TOR');
  assert.strictEqual(result, null);
});

test('lookupApiGoalieRow: returns row from mock db when confirmed=1', () => {
  const fakeRow = { goalie_id: '12345', goalie_name: 'Ilya Samsonov', confirmed: 1 };
  const mockDb = {
    prepare: () => ({ get: () => fakeRow }),
  };
  const result = lookupApiGoalieRow(mockDb, '2024020001', 'TOR');
  assert.deepStrictEqual(result, fakeRow);
});

test('lookupApiGoalieRow: returns null when db.prepare().get() returns null/undefined', () => {
  const mockDb = {
    prepare: () => ({ get: () => null }),
  };
  const result = lookupApiGoalieRow(mockDb, '2024020001', 'TOR');
  assert.strictEqual(result, null);
});

test('lookupApiGoalieRow: returns null when db.prepare throws', () => {
  const mockDb = {
    prepare: () => { throw new Error('table not found'); },
  };
  const result = lookupApiGoalieRow(mockDb, '2024020001', 'TOR');
  assert.strictEqual(result, null);
});

// ─── resolveGoalieState with NHL_API_CONFIRMED ────────────────────────────────

test('resolveGoalieState: confirmed=1 row → NHL_API_CONFIRMED, starter_state=CONFIRMED, tier_confidence=HIGH', () => {
  const fakeRow = { goalie_id: '8479361', goalie_name: 'Ilya Samsonov', confirmed: 1 };
  const mockDb = {
    prepare: () => ({ get: () => fakeRow }),
  };

  const state = resolveGoalieState(
    { goalie_name: null, gsax: 8.5, save_pct: null, source_type: null, status: null },
    null,
    'game-123',
    'home',
    { db: mockDb, teamId: 'TOR' },
  );

  assert.strictEqual(state.starter_source, 'NHL_API_CONFIRMED');
  assert.strictEqual(state.starter_state, 'CONFIRMED');
  assert.strictEqual(state.tier_confidence, 'HIGH');
  assert.strictEqual(state.goalie_name, 'Ilya Samsonov');
  assert.ok(state.evidence_flags.includes('NHL_API_CONFIRMED'));
});

test('resolveGoalieState: confirmed=1 row → adjustment_trust=FULL', () => {
  const fakeRow = { goalie_id: '8479361', goalie_name: 'Ilya Samsonov', confirmed: 1 };
  const mockDb = {
    prepare: () => ({ get: () => fakeRow }),
  };

  const state = resolveGoalieState(
    { goalie_name: null, gsax: 8.5 },
    null,
    'game-123',
    'home',
    { db: mockDb, teamId: 'TOR' },
  );

  assert.strictEqual(state.adjustment_trust, 'FULL');
});

// ─── resolveGoalieState with NHL_API_PROBABLE ─────────────────────────────────

test('resolveGoalieState: confirmed=0 row → NHL_API_PROBABLE, starter_state=EXPECTED, tier_confidence=MEDIUM', () => {
  const fakeRow = { goalie_id: null, goalie_name: null, confirmed: 0 };
  const mockDb = {
    prepare: () => ({ get: () => fakeRow }),
  };

  const state = resolveGoalieState(
    { goalie_name: null, gsax: 3.0 },
    null,
    'game-456',
    'away',
    { db: mockDb, teamId: 'MTL' },
  );

  assert.strictEqual(state.starter_source, 'NHL_API_PROBABLE');
  assert.strictEqual(state.starter_state, 'EXPECTED');
  assert.strictEqual(state.tier_confidence, 'MEDIUM');
  assert.ok(state.evidence_flags.includes('NHL_API_PROBABLE'));
});

// ─── resolveGoalieState fallthrough to SCRAPER_NAME_MATCH ────────────────────

test('resolveGoalieState: no DB row, scraper name present → SCRAPER_NAME_MATCH', () => {
  const mockDb = {
    prepare: () => ({ get: () => null }),
  };

  const state = resolveGoalieState(
    { goalie_name: 'Andrei Vasilevskiy', gsax: 15.2, save_pct: 0.925 },
    null,
    'game-789',
    'home',
    { db: mockDb, teamId: 'TBL' },
  );

  assert.strictEqual(state.starter_source, 'SCRAPER_NAME_MATCH');
  assert.strictEqual(state.goalie_name, 'Andrei Vasilevskiy');
  // No missing_inputs when scraper resolves
  assert.ok(!state.missing_inputs || !state.missing_inputs.includes('goalie_unresolved'));
});

// ─── resolveGoalieState with no DB row and no scraper → missing_inputs ────────

test('resolveGoalieState: no DB row, no scraper name → missing_inputs contains goalie_unresolved', () => {
  const mockDb = {
    prepare: () => ({ get: () => null }),
  };

  const state = resolveGoalieState(
    { goalie_name: null, gsax: null },
    null,
    'game-999',
    'away',
    { db: mockDb, teamId: 'VAN' },
  );

  assert.strictEqual(state.starter_state, 'UNKNOWN');
  assert.ok(Array.isArray(state.missing_inputs), 'missing_inputs should be an array');
  assert.ok(state.missing_inputs.includes('goalie_unresolved'), 'should contain goalie_unresolved');
});

test('resolveGoalieState: no db option at all, no scraper name → missing_inputs contains goalie_unresolved', () => {
  const state = resolveGoalieState(
    { goalie_name: null, gsax: null },
    null,
    'game-000',
    'home',
    {},
  );

  assert.strictEqual(state.starter_state, 'UNKNOWN');
  assert.ok(Array.isArray(state.missing_inputs), 'missing_inputs should be an array');
  assert.ok(state.missing_inputs.includes('goalie_unresolved'));
});

}); // end describe('nhl-goalie-state')
