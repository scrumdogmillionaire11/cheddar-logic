const fs = require('fs');
const path = require('path');
const { validateCardPayload } = require('@cheddar-logic/data');
const { computeTotalBias } = require('../../models/cross-market');

function loadFixture(name) {
  const fixturePath = path.join(
    __dirname,
    '..',
    'fixtures',
    'pipeline-card-payload',
    name,
  );
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

describe('pipeline card payload contract', () => {
  test('golden path: NHL WATCH total with low coverage and valid edge remains playable', () => {
    const fixture = loadFixture('nhl-watch-total-low-coverage.json');

    expect(computeTotalBias(fixture.decision)).toBe('OK');

    const validation = validateCardPayload('nhl-totals-call', fixture.payload);
    expect(validation.success).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('golden path: NBA WATCH total with low coverage and valid edge remains playable', () => {
    const fixture = loadFixture('nba-watch-total-low-coverage.json');

    expect(computeTotalBias(fixture.decision)).toBe('OK');

    const validation = validateCardPayload('nba-totals-call', fixture.payload);
    expect(validation.success).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('legacy unrepairable PASS fixture remains blocked', () => {
    const fixture = loadFixture('ncaam-pass-unrepairable-legacy.json');

    expect(fixture.legacy_play.action).toBe('PASS');
    expect(fixture.legacy_play.kind).toBe('EVIDENCE');
    expect(fixture.legacy_play.market_type).toBe('INFO');
    expect(fixture.legacy_play.repair_applied).toBe(false);
    expect(fixture.legacy_play.reason_codes).toEqual(
      expect.arrayContaining(['PASS_UNREPAIRABLE_LEGACY']),
    );
  });

  test('contract validation failures are explicit for ambiguous/invalid market state', () => {
    const fixture = loadFixture('invalid-total-selection.json');

    const validation = validateCardPayload('nba-totals-call', fixture.payload);
    expect(validation.success).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/market_contract/i);
    expect(validation.errors.join(' ')).toMatch(/INVALID_TOTAL_SELECTION/i);
  });
});
