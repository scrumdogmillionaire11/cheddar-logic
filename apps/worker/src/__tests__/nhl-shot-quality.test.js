'use strict';

/**
 * WI-0772: Unit tests for MoneyPuck fenwick/hdcf shot quality edge path
 *
 * Tests that computeNHLDriverCards reads fenwick_pct and hdcf_pct from
 * raw_data.moneypuck, computes a blended shot_quality_edge, and applies it
 * as a ±0.15 goals/unit modifier to the projected total.
 */

jest.mock('@cheddar-logic/data', () => ({
  getDecisionRecord: jest.fn(() => null),
  insertDecisionEvent: jest.fn(),
  updateDecisionCandidateTracking: jest.fn(),
  upsertDecisionRecord: jest.fn(),
}));

const { computeNHLDriverCards } = require('../models/index.js');

/**
 * Build a minimal odds snapshot that forces an nhl-pace-totals card to emit.
 * Goalie save pcts + goals for/against are sufficient inputs.
 * We set a market total of 5.5 and make the model project well above it
 * by giving high offensive teams so the >=0.4 edge threshold is crossed.
 */
function buildBaseSnapshot(rawOverrides = {}) {
  return {
    id: 'nhl-shot-quality-test-001',
    game_id: 'nhl-test-game',
    home_team: 'Detroit Red Wings',
    away_team: 'Buffalo Sabres',
    game_time_utc: '2026-04-10T00:00:00.000Z',
    captured_at: '2026-04-09T18:00:00.000Z',
    h2h_home: -130,
    h2h_away: 110,
    spread_home: -1.5,
    spread_away: 1.5,
    spread_price_home: 115,
    spread_price_away: -140,
    total: 5.5,
    total_price_over: -110,
    total_price_under: -110,
    raw_data: {
      goals_for_home: 3.2,
      goals_for_away: 2.8,
      goals_against_home: 2.9,
      goals_against_away: 3.0,
      goalie_home_save_pct: 0.920,
      goalie_away_save_pct: 0.910,
      ...rawOverrides,
    },
  };
}

describe('NHL shot quality edge — WI-0772', () => {
  describe('Test A: MoneyPuck fenwick/hdcf present (home advantage)', () => {
    let paceCard;

    beforeAll(() => {
      const snapshot = buildBaseSnapshot({
        moneypuck: {
          fenwick_pct: { home: 55, away: 48 },
          hdcf_pct: { home: 53, away: 47 },
        },
      });

      const cards = computeNHLDriverCards('nhl-test-game', snapshot);
      paceCard = cards.find((c) => c.cardType === 'nhl-pace-totals');
    });

    it('emits an nhl-pace-totals card', () => {
      expect(paceCard).toBeDefined();
    });

    it('driverInputs contains shot_quality_inputs with fenwick_diff=7 and hdcf_diff=6', () => {
      expect(paceCard.driverInputs.shot_quality_inputs).toBeDefined();
      expect(paceCard.driverInputs.shot_quality_inputs.fenwick_diff).toBe(7);
      expect(paceCard.driverInputs.shot_quality_inputs.hdcf_diff).toBe(6);
    });

    it('driverInputs contains proj_total_base as a finite number', () => {
      expect(Number.isFinite(paceCard.driverInputs.proj_total_base)).toBe(true);
    });

    it('proj_total_adjusted differs from proj_total_base', () => {
      expect(paceCard.driverInputs.proj_total_adjusted).not.toBe(
        paceCard.driverInputs.proj_total_base,
      );
    });

    it('proj_total_adjusted is greater than proj_total_base (home OVER modifier)', () => {
      // fenwick_diff=7, hdcf_diff=6 => edge=6.5 => modifier=6.5*0.15=0.975
      expect(paceCard.driverInputs.proj_total_adjusted).toBeGreaterThan(
        paceCard.driverInputs.proj_total_base,
      );
    });
  });

  describe('Test B: moneypuck absent from raw_data', () => {
    let cards;
    let paceCard;

    it('does not throw when moneypuck is absent', () => {
      const snapshot = buildBaseSnapshot(); // no moneypuck key
      expect(() => {
        cards = computeNHLDriverCards('nhl-test-game', snapshot);
      }).not.toThrow();
    });

    beforeAll(() => {
      const snapshot = buildBaseSnapshot(); // no moneypuck key
      cards = computeNHLDriverCards('nhl-test-game', snapshot);
      paceCard = cards.find((c) => c.cardType === 'nhl-pace-totals');
    });

    it('emits an nhl-pace-totals card even without moneypuck data', () => {
      expect(paceCard).toBeDefined();
    });

    it('driverInputs.pricing_context contains a note about absent fenwick/hdcf', () => {
      expect(paceCard.driverInputs.pricing_context).toBeTruthy();
      expect(paceCard.driverInputs.pricing_context).toMatch(
        /fenwick_pct and hdcf_pct absent/i,
      );
    });

    it('proj_total_adjusted equals proj_total_base when moneypuck absent', () => {
      expect(paceCard.driverInputs.proj_total_adjusted).toBe(
        paceCard.driverInputs.proj_total_base,
      );
    });
  });
});
