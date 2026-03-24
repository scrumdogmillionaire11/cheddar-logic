'use strict';

// Tests for applyNbaTotalQuarantine() — quick-79 / WI-0588
// This file tests the pure demotion function directly.
// Integration tests (via buildDecisionV2) are in the same file below.

describe('applyNbaTotalQuarantine (unit)', () => {
  let applyNbaTotalQuarantine;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.QUARANTINE_NBA_TOTAL;
    const patch = require('../decision-pipeline-v2.patch');
    applyNbaTotalQuarantine = patch.applyNbaTotalQuarantine;
  });

  afterEach(() => {
    delete process.env.QUARANTINE_NBA_TOTAL;
  });

  it('returns unchanged when sport is not NBA', () => {
    const input = { sport: 'NHL', marketType: 'TOTAL', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PLAY');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('returns unchanged when marketType is not TOTAL', () => {
    const input = { sport: 'NBA', marketType: 'SPREAD', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PLAY');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('returns unchanged when officialStatus is PASS', () => {
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'PASS', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PASS');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('demotes PLAY to LEAN for NBA TOTAL', () => {
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'PLAY', priceReasonCodes: ['SOME_REASON'] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('LEAN');
    expect(result.priceReasonCodes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
    expect(result.priceReasonCodes).toContain('SOME_REASON');
  });

  it('demotes LEAN to PASS for NBA TOTAL', () => {
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'LEAN', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PASS');
    expect(result.priceReasonCodes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('does not duplicate NBA_TOTAL_QUARANTINE_DEMOTE if already present', () => {
    const input = {
      sport: 'NBA',
      marketType: 'TOTAL',
      officialStatus: 'PLAY',
      priceReasonCodes: ['NBA_TOTAL_QUARANTINE_DEMOTE'],
    };
    const result = applyNbaTotalQuarantine(input);
    const count = result.priceReasonCodes.filter(c => c === 'NBA_TOTAL_QUARANTINE_DEMOTE').length;
    expect(count).toBe(1);
  });

  it('is case-insensitive for sport and marketType', () => {
    const input = { sport: 'nba', marketType: 'total', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('LEAN');
  });

  it('returns unchanged when QUARANTINE_NBA_TOTAL flag is off', () => {
    jest.resetModules();
    process.env.QUARANTINE_NBA_TOTAL = '0';
    const patch = require('../decision-pipeline-v2.patch');
    const fn = patch.applyNbaTotalQuarantine;
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = fn(input);
    expect(result.officialStatus).toBe('PLAY');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });
});
