'use strict';
// WI-0820: Input gate regression tests for projections.js
// Verifies NO_BET / DEGRADED paths in projectNBA and projectNBACanonical.

const { projectNBA, projectNBACanonical } = require('../projections');

describe('projectNBA — WI-0820 input gate', () => {
  test('null pace → NO_BET with missingCritical listing pace keys', () => {
    const result = projectNBA(110, 108, 105, 112, null, null);
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('homePace');
    expect(result.missingCritical).toContain('awayPace');
    expect(result.projection_source).toBe('NO_BET');
  });

  test('null homeOffense → NO_BET', () => {
    const result = projectNBA(null, 108, 105, 112, 100, 98);
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('homeOffRtg');
  });

  test('all nulls → NO_BET', () => {
    const result = projectNBA(null, null, null, null, null, null);
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical.length).toBeGreaterThan(0);
  });

  test('valid core, no rest (optional) → DEGRADED with confidence cap', () => {
    const result = projectNBA(110, 108, 105, 112, 100, 98, null, null);
    // Optional rest is null → DEGRADED
    expect(result.model_status).toBe('DEGRADED');
    // Confidence is in 0-100 scale in projectNBA
    expect(result.confidence).toBeLessThanOrEqual(55); // 0.55 * 100
  });

  test('all valid including rest → MODEL_OK', () => {
    const result = projectNBA(110, 108, 105, 112, 100, 98, 1, 1);
    expect(result.model_status).toBe('MODEL_OK');
    expect(typeof result.homeProjected).toBe('number');
    expect(typeof result.awayProjected).toBe('number');
  });

  test('valid core → result has model_status field', () => {
    const result = projectNBA(110, 108, 105, 112, 100, 98);
    expect(result).toHaveProperty('model_status');
    expect(['MODEL_OK', 'DEGRADED']).toContain(result.model_status);
  });
});

describe('projectNBACanonical — WI-0820 input gate', () => {
  test('null homePace → NO_BET object (not null)', () => {
    const result = projectNBACanonical(110, 108, null, 105, 112, 98);
    expect(result).not.toBeNull();
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('homePace');
    expect(result.projection_source).toBe('NO_BET');
    expect(result.market).toBe('canonical_total');
  });

  test('null awayOffRtg → NO_BET', () => {
    const result = projectNBACanonical(110, 108, 100, null, 112, 98);
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('awayOffRtg');
  });

  test('all valid → numeric projectedTotal (not NO_BET)', () => {
    const result = projectNBACanonical(110, 108, 100, 105, 112, 98);
    expect(result.status).toBeUndefined(); // no status on valid result
    expect(typeof result.projectedTotal).toBe('number');
    expect(result.projectedTotal).toBeGreaterThan(150);
  });
});
