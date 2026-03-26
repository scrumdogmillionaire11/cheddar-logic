'use strict';
/**
 * Tests for market-contract.js — pitcher strikeouts market mapping
 *
 * WI-0598 acceptance: canonical market mapping for pitcher K is deterministic
 * and test-covered. Existing non-pitcher validations remain green.
 */
const {
  buildMarketKey,
  normalizeMarketType,
  toRecommendedBetType,
  deriveLockedMarketContext,
} = require('../market-contract');

// ─────────────────────────────────────────────────────────────────────────────
// Normalization helpers — pitcher_strikeouts uses TOTAL as underlying type
// when evaluated via market-contract (OVER/UNDER semantics).
// ─────────────────────────────────────────────────────────────────────────────

describe('market-contract — normalizeMarketType', () => {
  test('normalizes TOTAL variants', () => {
    expect(normalizeMarketType('TOTAL')).toBe('TOTAL');
    expect(normalizeMarketType('totals')).toBe('TOTAL');
    expect(normalizeMarketType('over_under')).toBe('TOTAL');
  });

  test('normalizes SPREAD variants', () => {
    expect(normalizeMarketType('SPREAD')).toBe('SPREAD');
    expect(normalizeMarketType('puck_line')).toBe('SPREAD');
  });

  test('normalizes MONEYLINE variants', () => {
    expect(normalizeMarketType('MONEYLINE')).toBe('MONEYLINE');
    expect(normalizeMarketType('ml')).toBe('MONEYLINE');
    expect(normalizeMarketType('h2h')).toBe('MONEYLINE');
  });

  test('returns null for unknown market type', () => {
    expect(normalizeMarketType('PROP')).toBeNull();
    expect(normalizeMarketType('PITCHER_STRIKEOUTS')).toBeNull();
    expect(normalizeMarketType('')).toBeNull();
    expect(normalizeMarketType(null)).toBeNull();
  });
});

describe('market-contract — toRecommendedBetType', () => {
  test('maps TOTAL to "total"', () => {
    expect(toRecommendedBetType('TOTAL')).toBe('total');
  });

  test('maps SPREAD to "spread"', () => {
    expect(toRecommendedBetType('SPREAD')).toBe('spread');
  });

  test('maps MONEYLINE to "moneyline"', () => {
    expect(toRecommendedBetType('MONEYLINE')).toBe('moneyline');
  });

  test('maps unknown canonical type to "unknown"', () => {
    expect(toRecommendedBetType('PROP')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildMarketKey — pitcher_strikeouts OVER/UNDER via TOTAL contract
// When market_type='TOTAL' and selection='OVER'/'UNDER', the contract produces
// a deterministic key. PROP cards bypass this path entirely.
// ─────────────────────────────────────────────────────────────────────────────

describe('market-contract — buildMarketKey for strikeout-style TOTAL markets', () => {
  test('builds deterministic key for TOTAL/OVER with a line', () => {
    const key = buildMarketKey({
      gameId: 'mlb-k-game-001',
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 7.5,
      period: 'FULL_GAME',
    });
    expect(key).toMatch(/TOTAL/);
    expect(key).toMatch(/OVER/);
    expect(key).toMatch(/7\.5/);
  });

  test('builds deterministic key for TOTAL/UNDER with a line', () => {
    const key = buildMarketKey({
      gameId: 'mlb-k-game-001',
      marketType: 'TOTAL',
      selection: 'UNDER',
      line: 7.5,
      period: 'FULL_GAME',
    });
    expect(key).toMatch(/TOTAL/);
    expect(key).toMatch(/UNDER/);
  });

  test('same game, same market, same line produces identical keys', () => {
    const args = {
      gameId: 'mlb-k-game-002',
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 6.5,
      period: 'FULL_GAME',
    };
    expect(buildMarketKey(args)).toBe(buildMarketKey(args));
  });

  test('different lines produce different keys', () => {
    const base = { gameId: 'mlb-k-game-003', marketType: 'TOTAL', selection: 'OVER', period: 'FULL_GAME' };
    const key1 = buildMarketKey({ ...base, line: 6.5 });
    const key2 = buildMarketKey({ ...base, line: 7.5 });
    expect(key1).not.toBe(key2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveLockedMarketContext — PROP cards return null (bypass)
// PROP market_type is not SPREAD/TOTAL/MONEYLINE, so deriveLockedMarketContext
// returns null — the validator's SOCCER_SELF_CONTAINED_TYPES set ensures
// mlb-pitcher-k skips this check. Verify the null-return behavior directly.
// ─────────────────────────────────────────────────────────────────────────────

describe('market-contract — deriveLockedMarketContext for PROP cards', () => {
  test('returns null for PROP market_type (not a recognized market contract type)', () => {
    // market_type='PROP' is not SPREAD/TOTAL/MONEYLINE — contract returns null.
    // This is the expected no-op path for pitcher K cards.
    const payload = {
      kind: 'PLAY',
      market_type: 'PROP',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      game_id: 'mlb-k-prop-001',
      home_team: 'Yankees',
      away_team: 'Red Sox',
    };
    const result = deriveLockedMarketContext(payload, {
      requirePrice: false,
      requireLineForMarket: true,
    });
    expect(result).toBeNull();
  });

  test('returns null for EVIDENCE kind regardless of market', () => {
    const payload = {
      kind: 'EVIDENCE',
      market_type: 'TOTAL',
      prediction: 'OVER',
      selection: { side: 'OVER' },
    };
    const result = deriveLockedMarketContext(payload, {
      requirePrice: false,
      requireLineForMarket: false,
    });
    expect(result).toBeNull();
  });

  test('correctly derives TOTAL market context when market_type is TOTAL with a line', () => {
    // Confirm existing TOTAL contract still works after pitcher K additions.
    const payload = {
      kind: 'PLAY',
      market_type: 'TOTAL',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 220.5,
      game_id: 'nba-total-001',
      home_team: 'Lakers',
      away_team: 'Celtics',
    };
    const result = deriveLockedMarketContext(payload, {
      requirePrice: false,
      requireLineForMarket: true,
    });
    expect(result).not.toBeNull();
    expect(result.marketType).toBe('TOTAL');
    expect(result.selection).toBe('OVER');
    expect(result.line).toBe(220.5);
  });
});
