'use strict';

/**
 * H-1: Recent cards missing decision_v2.official_status must fail closed.
 */

const { __private } = require('../settle_pending_cards');
const { resolveNonActionableFinalReason } = __private;

const BASE_ROW = { market_key: 'nhl-total', card_type: 'nhl-total', sport: 'NHL' };

describe('H-1: legacy settlement fallback removed for recent cards', () => {
  test('card missing official_status fails closed with NON_ACTIONABLE_MISSING_CANONICAL_STATUS', () => {
    const payloadData = { kind: 'PLAY', status: 'FIRE', action: 'FIRE', classification: 'BASE' };
    const result = resolveNonActionableFinalReason(payloadData, BASE_ROW);
    expect(result).not.toBeNull();
    expect(result.code).toBe('NON_ACTIONABLE_MISSING_CANONICAL_STATUS');
  });

  test('card missing official_status with legacy status=PASS now fails closed', () => {
    const payloadData = { kind: 'PLAY', status: 'PASS', action: 'PASS' };
    const result = resolveNonActionableFinalReason(payloadData, BASE_ROW);
    expect(result).not.toBeNull();
    expect(result.code).toBe('NON_ACTIONABLE_MISSING_CANONICAL_STATUS');
  });

  test('card with decision_v2.official_status=PASS is non-actionable via canonical path', () => {
    const payloadData = { kind: 'PLAY', decision_v2: { official_status: 'PASS' } };
    const result = resolveNonActionableFinalReason(payloadData, BASE_ROW);
    expect(result).not.toBeNull();
    expect(result.code).toBe('NON_ACTIONABLE_FINAL_PASS');
  });

  test('card with decision_v2.official_status=PLAY returns null (is actionable)', () => {
    const payloadData = { kind: 'PLAY', decision_v2: { official_status: 'PLAY' } };
    const result = resolveNonActionableFinalReason(payloadData, BASE_ROW);
    expect(result).toBeNull();
  });
});
