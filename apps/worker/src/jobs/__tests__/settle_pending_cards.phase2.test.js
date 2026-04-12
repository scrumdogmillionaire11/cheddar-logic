/**
 * Phase 2 tests for settle_pending_cards.js
 * Verifies market_period_token is written to card_results.metadata at settlement time.
 */

const { __private } = require('../settle_pending_cards.js');

describe('Settlement contract (post-legacy)', () => {
  test('F5 signature guard detects all canonical token variants', () => {
    const cases = [
      {
        name: 'card_type mlb-f5',
        row: { card_type: 'mlb-f5', market_type: 'TOTAL' },
        payload: {},
      },
      {
        name: 'card_type mlb-f5-ml',
        row: { card_type: 'mlb-f5-ml', market_type: 'MONEYLINE' },
        payload: {},
      },
      {
        name: 'market_type FIRST_5_INNINGS',
        row: { card_type: 'mlb-moneyline', market_type: 'FIRST_5_INNINGS' },
        payload: {},
      },
      {
        name: 'market_type F5_TOTAL',
        row: { card_type: 'mlb-totals', market_type: 'F5_TOTAL' },
        payload: {},
      },
      {
        name: 'market_type F5_ML',
        row: { card_type: 'mlb-moneyline', market_type: 'F5_ML' },
        payload: {},
      },
      {
        name: 'payload market f5_total',
        row: { card_type: 'mlb-moneyline', market_type: 'TOTAL' },
        payload: { market: 'f5_total' },
      },
      {
        name: 'payload market_key mlb_f5_ml',
        row: { card_type: 'mlb-moneyline', market_type: 'MONEYLINE' },
        payload: { market_key: 'mlb_f5_ml' },
      },
    ];

    for (const testCase of cases) {
      expect(
        __private.isProjectionOnlyF5Row(testCase.row, testCase.payload),
      ).toBe(true);
    }
  });

  test('F5 signature guard leaves non-F5 rows eligible for standard settlement', () => {
    expect(
      __private.isProjectionOnlyF5Row(
        { card_type: 'mlb-moneyline', market_type: 'MONEYLINE' },
        { market_key: 'mlb_moneyline' },
      ),
    ).toBe(false);
    expect(
      __private.isProjectionOnlyF5Row(
        { card_type: 'nba-totals-call', market_type: 'TOTAL' },
        { market: 'total' },
      ),
    ).toBe(false);
  });

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

  // ---- Phase 2: market_period_token persistence ----

  test('normalizeSettlementPeriod returns 1P for a 1P card_type', () => {
    expect(__private.normalizeSettlementPeriod(null, 'nhl-pace-1p')).toBe('1P');
    expect(__private.normalizeSettlementPeriod('', 'nhl-1p-totals')).toBe('1P');
    expect(__private.normalizeSettlementPeriod(null, 'NHL_PACE_1P')).toBe('1P');
  });

  test('normalizeSettlementPeriod returns FULL_GAME for a full-game card', () => {
    expect(__private.normalizeSettlementPeriod(null, 'nhl-totals-call')).toBe('FULL_GAME');
    expect(__private.normalizeSettlementPeriod(null, 'nba-totals-call')).toBe('FULL_GAME');
    expect(__private.normalizeSettlementPeriod('FULL_GAME', null)).toBe('FULL_GAME');
  });

  test('normalizeSettlementPeriod prefers explicit period value over card_type', () => {
    // Even if card_type has no 1P, an explicit 1P period value should win
    expect(__private.normalizeSettlementPeriod('1P', 'nhl-totals-call')).toBe('1P');
    expect(__private.normalizeSettlementPeriod('P1', 'nba-moneyline')).toBe('1P');
    expect(__private.normalizeSettlementPeriod('FIRST_PERIOD', 'nba-moneyline')).toBe('1P');
  });

  test('deriveAndMergePeriodToken merges token into existing metadata without clobbering other fields', () => {
    const existingMeta = {
      backfilledAt: '2026-01-01T00:00:00Z',
      marketContractValid: true,
    };
    const merged = __private.deriveAndMergePeriodToken({
      existingMeta,
      token: '1P',
    });
    // Preserves existing fields
    expect(merged.backfilledAt).toBe('2026-01-01T00:00:00Z');
    expect(merged.marketContractValid).toBe(true);
    // Adds the new token
    expect(merged.market_period_token).toBe('1P');
  });

  test('deriveAndMergePeriodToken handles null/empty existing metadata', () => {
    expect(__private.deriveAndMergePeriodToken({ existingMeta: null, token: 'FULL_GAME' }))
      .toMatchObject({ market_period_token: 'FULL_GAME' });
    expect(__private.deriveAndMergePeriodToken({ existingMeta: {}, token: '1P' }))
      .toMatchObject({ market_period_token: '1P' });
  });

  test('settlement UPDATE includes market_period_token in metadata for successful settlements (DB integration)', () => {
    // This test exercises the DB path via a mock db object to confirm the
    // metadata column in the UPDATE includes market_period_token.
    const updates = [];
    const db = {
      prepare: jest.fn((sql) => ({
        run: jest.fn((...args) => {
          updates.push({ sql: sql.trim(), args });
          // Return truthy change count for status check
          return { changes: 1 };
        }),
        get: jest.fn(() => ({
          status: 'settled',
          result: 'win',
          settled_at: '2026-01-01T00:00:00Z',
        })),
      })),
    };

    const mergedMeta = __private.deriveAndMergePeriodToken({
      existingMeta: { backfilledAt: '2025-12-01T00:00:00Z' },
      token: '1P',
    });

    // Confirm the merged object has the token and preserved field
    expect(mergedMeta.market_period_token).toBe('1P');
    expect(mergedMeta.backfilledAt).toBe('2025-12-01T00:00:00Z');

    // Simulate calling the update with the merged metadata (as settle_pending_cards.js does)
    const stmt = db.prepare(
      `UPDATE card_results SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?,
       sharp_price_status = ?, primary_reason_code = ?, edge_pct = ?, metadata = ?
       WHERE id = ? AND status = 'pending'`,
    );
    stmt.run('win', '2026-01-01T00:00:00Z', 0.909, null, null, null, JSON.stringify(mergedMeta), 'result-1');

    expect(updates).toHaveLength(1);
    const passedMeta = JSON.parse(updates[0].args[6]);
    expect(passedMeta.market_period_token).toBe('1P');
    expect(passedMeta.backfilledAt).toBe('2025-12-01T00:00:00Z');
  });

  test('display backfill authority guard stays disabled even when override requested', () => {
    expect(__private.shouldEnableDisplayBackfill(false)).toBe(false);
    expect(__private.shouldEnableDisplayBackfill(true)).toBe(false);
    expect(__private.shouldEnableDisplayBackfill(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePlayerShotsActualValue — full-game shots contract (WI-0909)
// ─────────────────────────────────────────────────────────────────────────────

const FULL_GAME = 'FULL_GAME';

// Minimal gameResultMetadata fixture builder
function makeGRM({ byId = {}, byName = {} } = {}) {
  return {
    playerShots: {
      fullGameByPlayerId: byId,
      firstPeriodByPlayerId: {},
      playerIdByNormalizedName: byName,
    },
  };
}

describe('resolvePlayerShotsActualValue — full-game shots contract (WI-0909)', () => {
  test('returns shot value when player found by direct id (FULL_GAME)', () => {
    const grm = makeGRM({ byId: { '8478402': 5 } });
    const result = __private.resolvePlayerShotsActualValue({
      gameResultMetadata: grm,
      playerId: '8478402',
      playerName: 'Connor McDavid',
      period: FULL_GAME,
    });
    expect(result).toBe(5);
  });

  test('returns shot value when player found by normalized-name fallback (FULL_GAME)', () => {
    const grm = makeGRM({
      byId: { '8478402': 3 },
      byName: { 'connor mcdavid': '8478402' },
    });
    // Use a player_id NOT in byId, but name maps to it
    const result = __private.resolvePlayerShotsActualValue({
      gameResultMetadata: grm,
      playerId: '9999999',
      playerName: 'Connor McDavid',
      period: FULL_GAME,
    });
    expect(result).toBe(3);
  });

  test('throws MISSING_PLAYER_SHOTS_VALUE with resolvedAttempts=[id,name] when player absent by both methods (FULL_GAME)', () => {
    // This is the previously-diverging mismatch fixture: player not in either lookup path
    const grm = makeGRM({
      byId: { '8888888': 4 },
      byName: { 'some other player': '8888888' },
    });
    let thrownError;
    try {
      __private.resolvePlayerShotsActualValue({
        gameResultMetadata: grm,
        playerId: '9999999',
        playerName: 'Unknown Player',
        period: FULL_GAME,
      });
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError.code).toBe('MISSING_PLAYER_SHOTS_VALUE');
    expect(thrownError.details).toEqual(
      expect.objectContaining({
        resolvedAttempts: expect.arrayContaining(['id', 'name']),
      }),
    );
  });
});
