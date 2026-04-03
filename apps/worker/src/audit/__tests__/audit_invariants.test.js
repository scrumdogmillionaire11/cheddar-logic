'use strict';

/**
 * Unit Tests — audit_invariants.js INV-007
 *
 * Tests for checkMlbPitcherKQualityContract and its integration
 * with runAuditInvariants.
 *
 * WI: WORK_QUEUE/WI-0747.md
 */

const {
  checkMlbPitcherKQualityContract,
  runAuditInvariants,
} = require('../audit_invariants');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCard(overrides = {}) {
  return {
    cardType: 'mlb-pitcher-k',
    payloadData: {
      prop_decision: {
        model_quality: 'FULL_MODEL',
        proxy_fields: [],
        degradation_reasons: [],
        missing_inputs: [],
        ...((overrides.prop_decision) || {}),
      },
      execution_status: 'PROJECTION_ONLY',
      ...((overrides.payloadData) || {}),
    },
    ...overrides,
  };
}

// ── INV-007 unit tests ────────────────────────────────────────────────────────

describe('checkMlbPitcherKQualityContract (INV-007)', () => {
  it('passes for FULL_MODEL card with no proxy_fields', () => {
    const card = makeCard();
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(true);
  });

  it('passes for FALLBACK card with proxy_fields populated', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: 'FALLBACK',
        proxy_fields: ['starter_whiff_proxy'],
        degradation_reasons: ['starter_whiff_proxy'],
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(true);
  });

  it('passes for DEGRADED_MODEL card with empty proxy_fields', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: 'DEGRADED_MODEL',
        proxy_fields: [],
        degradation_reasons: ['opp_chase_pct_missing'],
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(true);
  });

  it('fails when model_quality is missing', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: undefined,
        proxy_fields: [],
        degradation_reasons: [],
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(false);
    expect(result.violation.invariant_id).toBe('INV-007');
    expect(result.violation.field_path).toBe('prop_decision.model_quality');
  });

  it('fails when model_quality is an invalid string', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: 'GARBAGE',
        proxy_fields: [],
        degradation_reasons: [],
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(false);
    expect(result.violation.invariant_id).toBe('INV-007');
  });

  it('fails when proxy_fields is non-empty but model_quality is FULL_MODEL', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: 'FULL_MODEL',
        proxy_fields: ['starter_whiff_proxy'],
        degradation_reasons: ['starter_whiff_proxy'],
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(false);
    expect(result.violation.invariant_id).toBe('INV-007');
    expect(result.violation.field_path).toBe('prop_decision.model_quality');
    expect(result.violation.expected).toContain('FALLBACK');
    expect(result.violation.actual).toBe('FULL_MODEL');
  });

  it('fails when proxy_fields is non-empty but model_quality is DEGRADED_MODEL', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: 'DEGRADED_MODEL',
        proxy_fields: ['ip_proxy'],
        degradation_reasons: ['ip_proxy'],
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(false);
    expect(result.violation.invariant_id).toBe('INV-007');
  });

  it('fails when degradation_reasons is not an array', () => {
    const card = makeCard({
      prop_decision: {
        model_quality: 'FULL_MODEL',
        proxy_fields: [],
        degradation_reasons: 'oops-a-string',
        missing_inputs: [],
      },
    });
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(false);
    expect(result.violation.invariant_id).toBe('INV-007');
    expect(result.violation.field_path).toBe('prop_decision.degradation_reasons');
  });

  it('skips non-MLB_PITCHER_K cards silently', () => {
    const nbaCard = {
      cardType: 'nba-totals-call',
      payloadData: { prop_decision: { model_quality: 'GARBAGE' } },
    };
    const result = checkMlbPitcherKQualityContract(nbaCard, nbaCard);
    expect(result.passed).toBe(true);
  });

  it('skips when prop_decision is null (PASS card)', () => {
    const card = {
      cardType: 'mlb-pitcher-k',
      payloadData: { prop_decision: null, execution_status: 'PROJECTION_ONLY' },
    };
    const result = checkMlbPitcherKQualityContract(card, card);
    expect(result.passed).toBe(true);
  });
});

describe('runAuditInvariants includes INV-007', () => {
  it('surfaces INV-007 violation in runAuditInvariants output', () => {
    const badCard = makeCard({
      prop_decision: {
        model_quality: 'FULL_MODEL',
        proxy_fields: ['starter_whiff_proxy'],
        degradation_reasons: ['starter_whiff_proxy'],
        missing_inputs: [],
      },
    });

    const violations = runAuditInvariants({ cards: [badCard] });
    const inv007 = violations.filter((v) => v.invariant_id === 'INV-007');
    expect(inv007.length).toBeGreaterThan(0);
  });

  it('produces no INV-007 violation for a clean FULL_MODEL card', () => {
    const cleanCard = makeCard();
    const violations = runAuditInvariants({ cards: [cleanCard] });
    const inv007 = violations.filter((v) => v.invariant_id === 'INV-007');
    expect(inv007).toHaveLength(0);
  });
});
