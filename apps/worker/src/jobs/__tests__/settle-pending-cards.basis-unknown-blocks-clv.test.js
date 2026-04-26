'use strict';

/**
 * H-2: Missing basis metadata must default to UNKNOWN, not ODDS_BACKED.
 *
 * Before this fix, cards missing all three basis fields defaulted to
 * ODDS_BACKED and got CLV computed, inflating positive-EV metrics for
 * projection-only plays. Now they default to UNKNOWN and are CLV-ineligible.
 */

const { __private } = require('../settle_pending_cards');
const { resolveDecisionBasisForSettlement, isClvEligiblePayload } = __private;

describe('H-2: CLV basis defaults to UNKNOWN when metadata absent', () => {
  test('missing basis defaults to UNKNOWN (not ODDS_BACKED)', () => {
    const payloadData = {};
    expect(resolveDecisionBasisForSettlement(payloadData)).toBe('UNKNOWN');
  });

  test('explicit ODDS_BACKED is preserved', () => {
    const payloadData = { basis: 'ODDS_BACKED' };
    expect(resolveDecisionBasisForSettlement(payloadData)).toBe('ODDS_BACKED');
  });

  test('explicit PROJECTION_ONLY is preserved', () => {
    const payloadData = { basis: 'PROJECTION_ONLY' };
    expect(resolveDecisionBasisForSettlement(payloadData)).toBe('PROJECTION_ONLY');
  });

  test('line_source=PROJECTION_FLOOR returns PROJECTION_ONLY', () => {
    const payloadData = { line_source: 'PROJECTION_FLOOR' };
    expect(resolveDecisionBasisForSettlement(payloadData)).toBe('PROJECTION_ONLY');
  });

  test('UNKNOWN basis blocks CLV write', () => {
    const payloadData = {};
    expect(isClvEligiblePayload(payloadData)).toBe(false);
  });

  test('ODDS_BACKED basis is CLV eligible', () => {
    const payloadData = { basis: 'ODDS_BACKED' };
    expect(isClvEligiblePayload(payloadData)).toBe(true);
  });
});
