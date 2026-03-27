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

  test('CLV guard rejects projection-only payloads', () => {
    expect(
      __private.resolveDecisionBasisForSettlement({
        decision_basis_meta: {
          decision_basis: 'PROJECTION_ONLY',
        },
      }),
    ).toBe('PROJECTION_ONLY');

    expect(
      __private.isClvEligiblePayload({
        decision_basis_meta: {
          market_line_source: 'synthetic',
        },
      }),
    ).toBe(false);
  });

  test('CLV guard treats legacy payloads as odds-backed', () => {
    expect(__private.resolveDecisionBasisForSettlement({})).toBe('ODDS_BACKED');
    expect(__private.isClvEligiblePayload({ market_type: 'MONEYLINE' })).toBe(
      true,
    );
  });

  test('resolves closing odds using market-specific precedence', () => {
    const snapshot = {
      h2h_home: -135,
      h2h_away: 118,
      spread_price_home: -112,
      spread_price_away: -108,
      total_price_over: -114,
      total_price_under: -106,
      raw_data: JSON.stringify({
        total_price_over_1p: -128,
        total_price_under_1p: 104,
      }),
    };

    expect(
      __private.resolveClosingOddsFromSnapshot({
        snapshot,
        marketType: 'MONEYLINE',
        selection: 'HOME',
      }),
    ).toBe(-135);
    expect(
      __private.resolveClosingOddsFromSnapshot({
        snapshot,
        marketType: 'SPREAD',
        selection: 'AWAY',
      }),
    ).toBe(-108);
    expect(
      __private.resolveClosingOddsFromSnapshot({
        snapshot,
        marketType: 'TOTAL',
        selection: 'OVER',
        period: '1P',
      }),
    ).toBe(-128);
    expect(
      __private.resolveClosingOddsFromSnapshot({
        snapshot,
        marketType: 'TOTAL',
        selection: 'UNDER',
        period: 'FULL_GAME',
      }),
    ).toBe(-106);
  });

  test('falls back to full-game total price when 1P close is absent', () => {
    const snapshot = {
      total_price_over: -111,
      total_price_under: -109,
      raw_data: JSON.stringify({}),
    };

    expect(
      __private.resolveClosingOddsFromSnapshot({
        snapshot,
        marketType: 'TOTAL',
        selection: 'OVER',
        period: '1P',
      }),
    ).toBe(-111);
    expect(
      __private.resolveClosingOddsFromSnapshot({
        snapshot,
        marketType: 'TOTAL',
        selection: 'UNDER',
        period: '1P',
      }),
    ).toBe(-109);
  });

  test('computes positive CLV when the close gets more expensive on the same side', () => {
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({
          h2h_home: -130,
          raw_data: JSON.stringify({}),
        })),
      })),
    };

    expect(
      __private.buildClvSettlementPayload({
        db,
        gameId: 'game-1',
        marketType: 'MONEYLINE',
        selection: 'HOME',
        oddsAtPick: -110,
      }),
    ).toMatchObject({
      closingOdds: -130,
      clvPct: expect.any(Number),
    });
    expect(
      __private.buildClvSettlementPayload({
        db,
        gameId: 'game-1',
        marketType: 'MONEYLINE',
        selection: 'HOME',
        oddsAtPick: -110,
      }).clvPct,
    ).toBeGreaterThan(0);
  });

  test('leaves CLV unresolved when no usable closing odds are available', () => {
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({
          raw_data: JSON.stringify({}),
        })),
      })),
    };

    expect(
      __private.buildClvSettlementPayload({
        db,
        gameId: 'game-1',
        marketType: 'TOTAL',
        selection: 'OVER',
        period: '1P',
        oddsAtPick: -110,
      }),
    ).toBeNull();
  });
});
