'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDecisionRecord: jest.fn(() => null),
  insertDecisionEvent: jest.fn(),
  updateDecisionCandidateTracking: jest.fn(),
  upsertDecisionRecord: jest.fn(),
}));

const { deriveAction } = require('../decision-publisher.js');

describe('deriveAction tier vocabulary coverage', () => {
  test('SUPER maps to FIRE', () => {
    expect(deriveAction({ tier: 'SUPER' })).toBe('FIRE');
  });

  test('BEST maps to HOLD', () => {
    expect(deriveAction({ tier: 'BEST' })).toBe('HOLD');
  });

  test('WATCH maps to HOLD', () => {
    expect(deriveAction({ tier: 'WATCH' })).toBe('HOLD');
  });

  test('GOOD maps to HOLD', () => {
    expect(deriveAction({ tier: 'GOOD' })).toBe('HOLD');
  });

  test('OK maps to PASS', () => {
    expect(deriveAction({ tier: 'OK' })).toBe('PASS');
  });

  test('BAD maps to PASS', () => {
    expect(deriveAction({ tier: 'BAD' })).toBe('PASS');
  });

  test('null maps to PASS', () => {
    expect(deriveAction({ tier: null })).toBe('PASS');
  });

  test('undefined maps to PASS', () => {
    expect(deriveAction({})).toBe('PASS');
  });

  test('unknown strings map to PASS', () => {
    expect(deriveAction({ tier: 'UNKNOWN_XYZ' })).toBe('PASS');
  });
});
