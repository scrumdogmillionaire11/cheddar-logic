'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDecisionRecord: jest.fn(() => null),
  insertDecisionEvent: jest.fn(),
  updateDecisionCandidateTracking: jest.fn(),
  upsertDecisionRecord: jest.fn(),
}));

const { applyDecisionVeto } = require('../../utils/decision-publisher');

describe('applyDecisionVeto canonical field consistency', () => {
  test('veto sets action and decision_v2 official status to PASS together', () => {
    const card = {
      action: 'FIRE',
      classification: 'BASE',
      status: 'FIRE',
      decision_v2: {
        official_status: 'PLAY',
        edge_pct: 0.07,
        is_settleable: true,
      },
    };

    applyDecisionVeto(card, 'PASS_EXECUTION_GATE_BLOCKED');

    expect(card.action).toBe('PASS');
    expect(card.classification).toBe('PASS');
    expect(card.decision_v2.official_status).toBe('PASS');
    expect(card.decision_v2.is_settleable).toBe(false);
  });

  test('veto without decision_v2 does not throw', () => {
    const card = {
      action: 'FIRE',
      classification: 'BASE',
      status: 'FIRE',
    };

    expect(() =>
      applyDecisionVeto(card, 'PASS_EXECUTION_GATE_BLOCKED'),
    ).not.toThrow();
    expect(card.action).toBe('PASS');
    expect(card.pass_reason_code).toBe('PASS_EXECUTION_GATE_BLOCKED');
  });

  test('veto appends the veto reason code while preserving prior reasons', () => {
    const card = {
      action: 'FIRE',
      reason_codes: ['PRIOR_REASON'],
      decision_v2: { official_status: 'PLAY' },
    };

    applyDecisionVeto(card, 'PASS_EXECUTION_GATE_LOW_EDGE');

    expect(card.reason_codes).toContain('PRIOR_REASON');
    expect(card.reason_codes).toContain('PASS_EXECUTION_GATE_LOW_EDGE');
  });
});
