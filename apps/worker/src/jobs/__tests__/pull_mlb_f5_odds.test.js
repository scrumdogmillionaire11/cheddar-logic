'use strict';
/**
 * Tests for pull_mlb_f5_odds.js
 *
 * Covers:
 *   - parseF5TotalLine:  extracts line + over/under prices from Odds API event response
 *   - resolveGameId:     two-step exact-then-prefix game ID resolution (MLB)
 *
 * These are the parsing and resolution pieces that run inside the main async job.
 * HTTP calls and DB writes are not exercised here.
 */

const { parseF5TotalLine, resolveGameId } = require('../pull_mlb_f5_odds');

// ─────────────────────────────────────────────────────────────────────────────
// parseF5TotalLine
// ─────────────────────────────────────────────────────────────────────────────

describe('parseF5TotalLine', () => {
  test('returns null when no bookmakers present', () => {
    expect(parseF5TotalLine({})).toBeNull();
    expect(parseF5TotalLine({ bookmakers: [] })).toBeNull();
    expect(parseF5TotalLine(null)).toBeNull();
    expect(parseF5TotalLine(undefined)).toBeNull();
  });

  test('returns null when bookmakers have no totals_1st_5_innings market', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'draftkings',
          markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: -150 }, { name: 'Away', price: 130 }] }],
        },
      ],
    };
    expect(parseF5TotalLine(eventOdds)).toBeNull();
  });

  test('returns null when totals_1st_5_innings market has no outcomes with valid point', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'draftkings',
          markets: [{ key: 'totals_1st_5_innings', outcomes: [{ name: 'Over' }, { name: 'Under' }] }],
        },
      ],
    };
    expect(parseF5TotalLine(eventOdds)).toBeNull();
  });

  test('parses line + over/under prices from a single bookmaker', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 4.5, price: -110 },
                { name: 'Under', point: 4.5, price: -110 },
              ],
            },
          ],
        },
      ],
    };
    const result = parseF5TotalLine(eventOdds);
    expect(result).not.toBeNull();
    expect(result.line).toBe(4.5);
    expect(result.overPrice).toBe(-110);
    expect(result.underPrice).toBe(-110);
    expect(result.bookmaker).toBe('draftkings');
  });

  test('selects highest-priority bookmaker (DK > FD > BetMGM)', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'betmgm',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 5, price: -105 },
                { name: 'Under', point: 5, price: -115 },
              ],
            },
          ],
        },
        {
          key: 'fanduel',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 4.5, price: 100 },
                { name: 'Under', point: 4.5, price: -130 },
              ],
            },
          ],
        },
        {
          key: 'draftkings',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 4.5, price: -110 },
                { name: 'Under', point: 4.5, price: -110 },
              ],
            },
          ],
        },
      ],
    };
    const result = parseF5TotalLine(eventOdds);
    expect(result.bookmaker).toBe('draftkings');
    expect(result.line).toBe(4.5);
    expect(result.overPrice).toBe(-110);
  });

  test('falls back to fanduel when draftkings missing', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'betmgm',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 5, price: -105 },
                { name: 'Under', point: 5, price: -115 },
              ],
            },
          ],
        },
        {
          key: 'fanduel',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 4.5, price: 100 },
                { name: 'Under', point: 4.5, price: -130 },
              ],
            },
          ],
        },
      ],
    };
    const result = parseF5TotalLine(eventOdds);
    expect(result.bookmaker).toBe('fanduel');
  });

  test('handles over-only or under-only outcomes gracefully', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [{ name: 'Over', point: 4.5, price: -115 }],
            },
          ],
        },
      ],
    };
    const result = parseF5TotalLine(eventOdds);
    expect(result.line).toBe(4.5);
    expect(result.overPrice).toBe(-115);
    expect(result.underPrice).toBeNull();
  });

  test('handles decimal odds gracefully (truncates to integer)', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 4.5, price: -109.7 },
                { name: 'Under', point: 4.5, price: -110.2 },
              ],
            },
          ],
        },
      ],
    };
    const result = parseF5TotalLine(eventOdds);
    expect(Number.isInteger(result.overPrice)).toBe(true);
    expect(Number.isInteger(result.underPrice)).toBe(true);
  });

  test('skips bookmakers with no matching market key', () => {
    const eventOdds = {
      bookmakers: [
        {
          key: 'draftkings',
          markets: [{ key: 'pitcher_strikeouts', outcomes: [] }],
        },
        {
          key: 'fanduel',
          markets: [
            {
              key: 'totals_1st_5_innings',
              outcomes: [
                { name: 'Over', point: 4.5, price: -112 },
                { name: 'Under', point: 4.5, price: -108 },
              ],
            },
          ],
        },
      ],
    };
    const result = parseF5TotalLine(eventOdds);
    expect(result.bookmaker).toBe('fanduel');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveGameId
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveGameId', () => {
  /** Build a minimal better-sqlite3 stub that returns rows from a hardcoded set. */
  function buildDbStub({ exactRows = [], prefixRows = [] } = {}) {
    return {
      prepare(sql) {
        const isPrefix = sql.includes('status');
        return {
          all(_time) {
            return isPrefix ? prefixRows : exactRows;
          },
        };
      },
    };
  }

  test('returns null when no exact or prefix match found', () => {
    const db = buildDbStub();
    const event = { id: 'e1', commence_time: '2026-04-02T18:00:00Z', home_team: 'Kansas City Royals', away_team: 'Minnesota Twins' };
    expect(resolveGameId(db, event)).toBeNull();
  });

  test('returns game_id on exact team name match', () => {
    const db = buildDbStub({
      exactRows: [
        { game_id: 'game-kc-min', home_team: 'KANSAS CITY ROYALS', away_team: 'MINNESOTA TWINS' },
      ],
    });
    const event = { id: 'e1', commence_time: '2026-04-02T18:00:00Z', home_team: 'Kansas City Royals', away_team: 'Minnesota Twins' };
    expect(resolveGameId(db, event)).toBe('game-kc-min');
  });

  test('exact match normalizes both sides case-insensitively', () => {
    // Odds API returns "New York Yankees", games table has "NEW YORK YANKEES"
    const db = buildDbStub({
      exactRows: [
        { game_id: 'game-nyy-bos', home_team: 'NEW YORK YANKEES', away_team: 'BOSTON RED SOX' },
      ],
    });
    const event = { id: 'e2', commence_time: '2026-04-03T20:00:00Z', home_team: 'New York Yankees', away_team: 'Boston Red Sox' };
    expect(resolveGameId(db, event)).toBe('game-nyy-bos');
  });

  test('falls back to prefix strategy when exact match fails', () => {
    // Odds API returns city-only "Kansas City" vs full name "Kansas City Royals"
    const db = buildDbStub({
      exactRows: [
        { game_id: 'game-kc-min', home_team: 'KANSAS CITY ROYALS', away_team: 'MINNESOTA TWINS' },
      ],
      prefixRows: [
        { game_id: 'game-kc-min', home_team: 'KANSAS CITY ROYALS', away_team: 'MINNESOTA TWINS' },
      ],
    });
    // Odd API name that doesn't match exactly.
    const event = { id: 'e3', commence_time: '2026-04-02T18:00:00Z', home_team: 'Kansas City', away_team: 'Minnesota' };
    // exactRows uses norm → 'kansascityroyals' !== 'kansascity', so drops to prefix
    // prefixRows: norm('Kansas City Royals').slice(0,6) = 'kansas' which includes norm('Kansas City').slice(0,6) = 'kansas'
    expect(resolveGameId(db, event)).toBe('game-kc-min');
  });

  test('returns null when prefix strategy also fails', () => {
    const db = buildDbStub({
      prefixRows: [
        { game_id: 'game-nyy-bos', home_team: 'NEW YORK YANKEES', away_team: 'BOSTON RED SOX' },
      ],
    });
    const event = { id: 'e4', commence_time: '2026-04-03T20:00:00Z', home_team: 'San Diego Padres', away_team: 'Los Angeles Dodgers' };
    expect(resolveGameId(db, event)).toBeNull();
  });
});
