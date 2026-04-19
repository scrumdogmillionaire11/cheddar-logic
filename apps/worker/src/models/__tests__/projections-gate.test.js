'use strict';
// WI-0820: Input gate regression tests for projections.js
// Verifies NO_BET / DEGRADED paths in projectNBACanonical.
// Note: projectNBA was deleted in WI-1011 (dead-code sweep); its input-gate
// behaviour is now covered exclusively by projectNBACanonical.

const projections = require('../projections');
const { projectNBACanonical } = projections;

describe('projectNBA — deleted in WI-1011', () => {
  test('projectNBA is no longer exported', () => {
    expect(projections.projectNBA).toBeUndefined();
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
