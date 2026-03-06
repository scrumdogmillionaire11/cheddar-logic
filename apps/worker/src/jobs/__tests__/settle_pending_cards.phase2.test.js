const { __private } = require('../settle_pending_cards.js');

describe('Settlement contract (post-legacy)', () => {
  test('does not expose legacy top-level card selector', () => {
    expect(__private.selectTopLevelCard).toBeUndefined();
  });

  test('grades moneyline selections deterministically', () => {
    expect(
      __private.gradeLockedMarket({
        marketType: 'MONEYLINE',
        selection: 'HOME',
        line: null,
        homeScore: 101,
        awayScore: 95,
      }),
    ).toBe('win');

    expect(
      __private.gradeLockedMarket({
        marketType: 'MONEYLINE',
        selection: 'AWAY',
        line: null,
        homeScore: 101,
        awayScore: 95,
      }),
    ).toBe('loss');
  });

  test('computes pnl units from American odds', () => {
    expect(__private.computePnlUnits('win', 150)).toBe(1.5);
    expect(__private.computePnlUnits('win', -150)).toBeCloseTo(0.6667, 4);
    expect(__private.computePnlUnits('loss', -110)).toBe(-1);
    expect(__private.computePnlUnits('push', -110)).toBe(0);
  });
});
