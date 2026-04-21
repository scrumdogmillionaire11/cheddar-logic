'use strict';

/**
 * settlement-annotation.test.js
 *
 * Unit tests for extracted settlement-annotation helper (WI-1108).
 * Verifies:
 * - Pure, deterministic behavior of settlement context resolution
 * - Grading logic produces expected outcomes
 * - Error handling for edge cases
 */

const {
  gradeLockedMarket,
  normalizeSettlementPeriod,
  extractSettlementPeriod,
  computePnlUnits,
  computePnlOutcome,
  resolveMlbPitcherKSettlementContext,
  gradeMlbPitcherKMarket,
  gradeNhlPlayerShotsMarket,
} = require('../settlement-annotation');

describe('settlement-annotation helper', () => {
  describe('normalizeSettlementPeriod', () => {
    test('normalizes standard period tokens', () => {
      expect(normalizeSettlementPeriod('1P')).toBe('1P');
      expect(normalizeSettlementPeriod('FULL_GAME')).toBe('FULL_GAME');
      expect(normalizeSettlementPeriod('first_period')).toBe('1P');
      expect(normalizeSettlementPeriod('first-5-innings')).toBe('1P');
      expect(normalizeSettlementPeriod('regulation')).toBe('FULL_GAME');
    });

    test('defaults to FULL_GAME for unknown periods', () => {
      expect(normalizeSettlementPeriod(null)).toBe('FULL_GAME');
      expect(normalizeSettlementPeriod('')).toBe('FULL_GAME');
      expect(normalizeSettlementPeriod('unknown')).toBe('FULL_GAME');
    });

    test('respects card_type prefix when period token is null', () => {
      // F5 cardtypes need explicit FIRST_5_INNINGS in the string to be detected
      expect(normalizeSettlementPeriod(null, 'nhl-first_5_innings')).toBe('1P');
      expect(normalizeSettlementPeriod(null, 'nhl-1p-shots')).toBe('1P');
      // Without matching prefix, defaults to FULL_GAME('1P');
      expect(normalizeSettlementPeriod(null, 'nhl-1p-shots')).toBe('1P');
      // Without matching prefix, defaults to FULL_GAME
      expect(normalizeSettlementPeriod(null, 'nfl-full-game')).toBe('FULL_GAME');
    });
  });

  describe('gradeLockedMarket', () => {
    test('grades moneyline HOME winner correctly', () => {
      const result = gradeLockedMarket({
        marketType: 'MONEYLINE',
        selection: 'HOME',
        line: null,
        homeScore: 3,
        awayScore: 2,
      });
      expect(result).toBe('win');
    });

    test('grades moneyline HOME loser correctly', () => {
      const result = gradeLockedMarket({
        marketType: 'MONEYLINE',
        selection: 'HOME',
        line: null,
        homeScore: 2,
        awayScore: 3,
      });
      expect(result).toBe('loss');
    });

    test('grades moneyline AWAY winner correctly', () => {
      const result = gradeLockedMarket({
        marketType: 'MONEYLINE',
        selection: 'AWAY',
        line: null,
        homeScore: 2,
        awayScore: 3,
      });
      expect(result).toBe('win');
    });

    test('grades moneyline push correctly', () => {
      const result = gradeLockedMarket({
        marketType: 'MONEYLINE',
        selection: 'HOME',
        line: null,
        homeScore: 2,
        awayScore: 2,
      });
      expect(result).toBe('push');
    });

    test('grades SPREAD correctly', () => {
      const win = gradeLockedMarket({
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -3.5,
        homeScore: 10,
        awayScore: 5,
      });
      expect(win).toBe('win');

      const loss = gradeLockedMarket({
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -3.5,
        homeScore: 8,
        awayScore: 5,
      });
      expect(loss).toBe('loss');

      const push = gradeLockedMarket({
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -3.5,
        homeScore: 8.5,
        awayScore: 5,
      });
      expect(push).toBe('push');
    });

    test('grades TOTAL correctly', () => {
      const over = gradeLockedMarket({
        marketType: 'TOTAL',
        selection: 'OVER',
        line: 10,
        homeScore: 8,
        awayScore: 5,
      });
      expect(over).toBe('win');

      const under = gradeLockedMarket({
        marketType: 'TOTAL',
        selection: 'UNDER',
        line: 10,
        homeScore: 8,
        awayScore: 5,
      });
      expect(under).toBe('loss');
    });

    test('grades 1P period correctly', () => {
      const result = gradeLockedMarket({
        marketType: 'TOTAL',
        selection: 'OVER',
        line: 3,
        period: '1P',
        homeScore: 5,
        awayScore: 2,
        firstPeriodScores: { home: 2, away: 1 },
      });
      // 1P total: 2 + 1 = 3, which equals line of 3, so it's a push
      expect(result).toBe('push');
    });

    test('throws on missing final scores', () => {
      expect(() => {
        gradeLockedMarket({
          marketType: 'MONEYLINE',
          selection: 'HOME',
          line: null,
          homeScore: null,
          awayScore: 2,
        });
      }).toThrow();
    });

    test('throws on missing period scores for 1P', () => {
      expect(() => {
        gradeLockedMarket({
          marketType: 'TOTAL',
          selection: 'OVER',
          line: 3,
          period: '1P',
          homeScore: 5,
          awayScore: 2,
          firstPeriodScores: null,
        });
      }).toThrow();
    });
  });

  describe('computePnlUnits', () => {
    test('returns 0 for push', () => {
      expect(computePnlUnits('push', 100)).toBe(0.0);
    });

    test('returns -1 for loss', () => {
      expect(computePnlUnits('loss', 100)).toBe(-1.0);
    });

    test('computes positive odds payout', () => {
      expect(computePnlUnits('win', 100)).toBeCloseTo(1.0, 6);
      expect(computePnlUnits('win', 200)).toBeCloseTo(2.0, 6);
    });

    test('computes negative odds payout', () => {
      expect(computePnlUnits('win', -100)).toBeCloseTo(1.0, 6);
      expect(computePnlUnits('win', -200)).toBeCloseTo(0.5, 6);
    });

    test('returns null for invalid odds', () => {
      expect(computePnlUnits('win', 0)).toBeNull();
      expect(computePnlUnits('win', null)).toBeNull();
      expect(computePnlUnits('win', undefined)).toBeNull();
    });
  });

  describe('computePnlOutcome', () => {
    test('returns pnl_units for valid win', () => {
      const outcome = computePnlOutcome('win', -110);
      expect(outcome.pnlUnits).toBeCloseTo(100 / 110, 6);
      expect(outcome.anomalyCode).toBeNull();
    });

    test('flags win with zero odds', () => {
      const outcome = computePnlOutcome('win', 0);
      expect(outcome.pnlUnits).toBeNull();
      expect(outcome.anomalyCode).toBe('PNL_ODDS_INVALID');
    });

    test('handles loss and push normally', () => {
      expect(computePnlOutcome('loss', 100)).toEqual({
        pnlUnits: -1,
        anomalyCode: null,
        anomalyMessage: null,
      });
      expect(computePnlOutcome('push', 100)).toEqual({
        pnlUnits: 0,
        anomalyCode: null,
        anomalyMessage: null,
      });
    });
  });

  describe('gradeMlbPitcherKMarket', () => {
    test('grades OVER winner', () => {
      const result = gradeMlbPitcherKMarket({
        selection: 'OVER',
        line: 10,
        actualStrikeouts: 12,
      });
      expect(result).toBe('win');
    });

    test('grades UNDER loser on over', () => {
      const result = gradeMlbPitcherKMarket({
        selection: 'UNDER',
        line: 10,
        actualStrikeouts: 12,
      });
      expect(result).toBe('loss');
    });

    test('grades push on exact line', () => {
      const result = gradeMlbPitcherKMarket({
        selection: 'OVER',
        line: 10,
        actualStrikeouts: 10,
      });
      expect(result).toBe('push');
    });

    test('throws on missing strikeout value', () => {
      expect(() => {
        gradeMlbPitcherKMarket({
          selection: 'OVER',
          line: 10,
          actualStrikeouts: null,
        });
      }).toThrow();
    });
  });

  describe('gradeNhlPlayerShotsMarket', () => {
    test('grades OVER winner', () => {
      const result = gradeNhlPlayerShotsMarket({
        selection: 'OVER',
        line: 5,
        actualShots: 7,
      });
      expect(result).toBe('win');
    });

    test('grades push on exact line', () => {
      const result = gradeNhlPlayerShotsMarket({
        selection: 'OVER',
        line: 5,
        actualShots: 5,
      });
      expect(result).toBe('push');
    });

    test('throws on missing shots value', () => {
      expect(() => {
        gradeNhlPlayerShotsMarket({
          selection: 'OVER',
          line: 5,
          actualShots: null,
        });
      }).toThrow();
    });
  });

  describe('deterministic parity', () => {
    test('same inputs always produce same outputs (moneyline)', () => {
      const inputs = {
        marketType: 'MONEYLINE',
        selection: 'HOME',
        line: null,
        homeScore: 3,
        awayScore: 2,
      };

      const result1 = gradeLockedMarket(inputs);
      const result2 = gradeLockedMarket(inputs);
      const result3 = gradeLockedMarket(inputs);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
      expect(result1).toBe('win');
    });

    test('pnl computation is deterministic', () => {
      const inputs = { result: 'win', odds: -110 };

      const outcome1 = computePnlOutcome(inputs.result, inputs.odds);
      const outcome2 = computePnlOutcome(inputs.result, inputs.odds);

      expect(outcome1.pnlUnits).toBe(outcome2.pnlUnits);
      expect(outcome1.anomalyCode).toBe(outcome2.anomalyCode);
    });
  });
});
