/**
 * Unit tests for nhl-lineup driver card emission (WI-0465-D)
 *
 * Tests:
 * 1. No lineup card emitted when injury factors >= 0.95
 * 2. Lineup card emitted when homeSkaterInjuryFactor < 0.95
 * 3. Lineup card emitted when awaySkaterInjuryFactor < 0.95
 * 4. Lineup card emitted when both factors < 0.95
 * 5. Card has correct direction=UNDER, driverKey=lineupInjury
 * 6. Card includes confirmed-out player names in driverInputs
 * 7. Card suppression % is correct
 */

'use strict';

const { computeNHLDriverCards } = require('../index');

// Minimal odds snapshot with enough fields to pass through the function
function buildOddsSnapshot(rawDataOverrides = {}) {
  return {
    game_time_utc: '2026-04-01T23:00:00.000Z',
    total: 6.0,
    total_price_over: -110,
    total_price_under: -110,
    raw_data: JSON.stringify({
      goals_for_home: 3.2,
      goals_for_away: 3.1,
      goals_against_home: 2.8,
      goals_against_away: 3.0,
      ...rawDataOverrides,
    }),
  };
}

function buildInjuryStatus(players) {
  // players: array of {player, status}
  return players;
}

describe('computeNHLDriverCards — nhl-lineup card (WI-0465-D)', () => {
  test('no lineup card when no injuries present', () => {
    const snapshot = buildOddsSnapshot({ injury_status: { home: [], away: [] } });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const lineupCards = cards.filter((c) => c.cardType === 'nhl-lineup');
    expect(lineupCards).toHaveLength(0);
  });

  test('no lineup card when factor is exactly 0.965 (one confirmed-out)', () => {
    // 1 confirmed-out → factor = max(0.88, 1 - 0.035) = 0.965 — still above 0.95 threshold
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [{ player: 'Player A', status: 'out' }],
        away: [],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const lineupCards = cards.filter((c) => c.cardType === 'nhl-lineup');
    // factor 0.965 > 0.95 — no card
    expect(lineupCards).toHaveLength(0);
  });

  test('lineup card emitted when two home players are confirmed out (factor 0.93 < 0.95)', () => {
    // 2 confirmed-out → factor = max(0.88, 1 - 2*0.035) = 0.93 → < 0.95
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [
          { player: 'Connor McDavid', status: 'out' },
          { player: 'Leon Draisaitl', status: 'IR' },
        ],
        away: [],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const lineupCards = cards.filter((c) => c.cardType === 'nhl-lineup');
    expect(lineupCards).toHaveLength(1);
  });

  test('lineup card emitted when two away players are confirmed out', () => {
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [],
        away: [
          { player: 'Auston Matthews', status: 'out' },
          { player: 'Mitch Marner', status: 'IR' },
        ],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const lineupCards = cards.filter((c) => c.cardType === 'nhl-lineup');
    expect(lineupCards).toHaveLength(1);
  });

  test('lineup card emitted when both teams have two confirmed-out players', () => {
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [
          { player: 'Player A', status: 'out' },
          { player: 'Player B', status: 'ltir' },
        ],
        away: [
          { player: 'Player C', status: 'out' },
          { player: 'Player D', status: 'suspended' },
        ],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const lineupCards = cards.filter((c) => c.cardType === 'nhl-lineup');
    expect(lineupCards).toHaveLength(1);
  });

  test('lineup card has correct shape: direction=UNDER, driverKey=lineupInjury, market_type=TOTAL', () => {
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [
          { player: 'Star Forward', status: 'out' },
          { player: 'Top Scorer', status: 'IR' },
        ],
        away: [],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const card = cards.find((c) => c.cardType === 'nhl-lineup');
    expect(card).toBeDefined();
    expect(card.prediction).toBe('UNDER');
    expect(card.driverKey).toBe('lineupInjury');
    expect(card.market_type).toBe('TOTAL');
    expect(card.selection.side).toBe('UNDER');
    expect(card.driverScore).toBe(0.25); // UNDER signal
    expect(card.reason_codes).toContain('LINEUP_INJURY_SIGNAL');
  });

  test('lineup card driverInputs contains confirmed-out player names', () => {
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [
          { player: 'Connor McDavid', status: 'out' },
          { player: 'Leon Draisaitl', status: 'IR' },
        ],
        away: [],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const card = cards.find((c) => c.cardType === 'nhl-lineup');
    expect(card.driverInputs.home_out_players).toContain('Connor McDavid');
    expect(card.driverInputs.home_out_players).toContain('Leon Draisaitl');
    expect(card.driverInputs.away_out_players).toHaveLength(0);
  });

  test('lineup card suppression % is computed correctly for two confirmed-out', () => {
    // 2 confirmed-out → factor = 0.93 → suppression = (1 - 0.93) * 100 = 7%
    const snapshot = buildOddsSnapshot({
      injury_status: {
        home: [
          { player: 'P1', status: 'out' },
          { player: 'P2', status: 'out' },
        ],
        away: [],
      },
    });
    const cards = computeNHLDriverCards('game-001', snapshot);
    const card = cards.find((c) => c.cardType === 'nhl-lineup');
    expect(card.driverInputs.home_suppression_pct).toBe(7);
    expect(card.driverInputs.away_suppression_pct).toBe(0);
    expect(card.driverInputs.total_suppression_pct).toBe(7);
  });
});
