'use strict';
/**
 * Tests for pull_mlb_pitcher_strikeout_props.js
 *
 * Covers:
 *   - parseEventPropLines: pitcher_strikeouts lines parsed from Odds API response
 *   - resolveGameId:       two-step exact-then-prefix strategy for MLB games
 *
 * WI-0597 acceptance: pull job can ingest pitcher prop lines into player_prop_lines
 * with correct propType='pitcher_strikeouts', ODDS_BACKED guard, and freshness metadata.
 */

const {
  parseEventPropLines,
  resolveGameId,
} = require('../pull_mlb_pitcher_strikeout_props');

// ─────────────────────────────────────────────────────────────────────────────
// parseEventPropLines
// ─────────────────────────────────────────────────────────────────────────────

describe('parseEventPropLines — pitcher_strikeouts', () => {
  const GAME_ID = 'mlb-2026-03.26-nyy-bos';
  const FETCHED_AT = '2026-03-26T18:00:00.000Z';

  test('parses Over/Under pitcher_strikeouts outcomes into one row per pitcher per bookmaker', () => {
    const eventOdds = {
      id: 'evt-k-1',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'pitcher_strikeouts',
              outcomes: [
                { name: 'Over', description: 'Gerrit Cole', point: 7.5, price: -115 },
                { name: 'Under', description: 'Gerrit Cole', point: 7.5, price: -105 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sport: 'MLB',
      gameId: GAME_ID,
      playerName: 'Gerrit Cole',
      propType: 'pitcher_strikeouts',
      line: 7.5,
      overPrice: -115,
      underPrice: -105,
      bookmaker: 'draftkings',
      period: 'full_game',
      fetchedAt: FETCHED_AT,
    });
  });

  test('produces one row per pitcher when multiple bookmakers offer the same line', () => {
    const makeBm = (bmKey) => ({
      key: bmKey,
      markets: [
        {
          key: 'pitcher_strikeouts',
          outcomes: [
            { name: 'Over', description: 'Max Scherzer', point: 6.5, price: -110 },
            { name: 'Under', description: 'Max Scherzer', point: 6.5, price: -110 },
          ],
        },
      ],
    });

    const rows = parseEventPropLines(
      { id: 'evt-multi', bookmakers: [makeBm('draftkings'), makeBm('fanduel')] },
      GAME_ID,
      FETCHED_AT,
    );
    // One row per (pitcher × bookmaker)
    expect(rows).toHaveLength(2);
    const bookmakers = rows.map((r) => r.bookmaker).sort();
    expect(bookmakers).toEqual(['draftkings', 'fanduel']);
    expect(rows[0].propType).toBe('pitcher_strikeouts');
    expect(rows[1].propType).toBe('pitcher_strikeouts');
  });

  test('preserves ladder lines — two different lines for same pitcher produce two rows', () => {
    const eventOdds = {
      id: 'evt-ladder',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'pitcher_strikeouts',
              outcomes: [
                { name: 'Over', description: 'Corbin Burnes', point: 6.5, price: -120 },
                { name: 'Under', description: 'Corbin Burnes', point: 6.5, price: 100 },
                { name: 'Over', description: 'Corbin Burnes', point: 7.0, price: 110 },
                { name: 'Under', description: 'Corbin Burnes', point: 7.0, price: -130 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(2);
    const lines = rows.map((r) => r.line).sort();
    expect(lines).toEqual([6.5, 7.0]);
  });

  test('normalizes decimal odds to American prices', () => {
    const eventOdds = {
      id: 'evt-decimal',
      bookmakers: [
        {
          key: 'fanduel',
          markets: [
            {
              key: 'pitcher_strikeouts',
              outcomes: [
                // 1.77 decimal → -130 American: round(-100 / (1.77 - 1)) = -130
                { name: 'Over', description: 'Justin Verlander', point: 5.5, price: 1.77 },
                // 2.15 decimal → +115 American: round((2.15 - 1) * 100) = +115
                { name: 'Under', description: 'Justin Verlander', point: 5.5, price: 2.15 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0].overPrice).toBe(-130);
    expect(rows[0].underPrice).toBe(115);
  });

  test('handles two pitchers in one response — separate rows, no cross-contamination', () => {
    const eventOdds = {
      id: 'evt-two-pitchers',
      bookmakers: [
        {
          key: 'betmgm',
          markets: [
            {
              key: 'pitcher_strikeouts',
              outcomes: [
                { name: 'Over', description: 'Pitcher A', point: 7.5, price: -110 },
                { name: 'Under', description: 'Pitcher A', point: 7.5, price: -110 },
                { name: 'Over', description: 'Pitcher B', point: 5.5, price: -115 },
                { name: 'Under', description: 'Pitcher B', point: 5.5, price: -105 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(2);

    const rowA = rows.find((r) => r.playerName === 'Pitcher A');
    const rowB = rows.find((r) => r.playerName === 'Pitcher B');
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA.line).toBe(7.5);
    expect(rowB.line).toBe(5.5);
    expect(rowA.playerName).not.toBe(rowB.playerName);
  });

  test('skips outcomes with missing description, unrecognized side, or non-finite line', () => {
    const eventOdds = {
      id: 'evt-skip',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'pitcher_strikeouts',
              outcomes: [
                // valid row that should survive
                { name: 'Over', description: 'Good Pitcher', point: 6.5, price: -110 },
                { name: 'Under', description: 'Good Pitcher', point: 6.5, price: -110 },
                // no description
                { name: 'Over', description: null, point: 7.0, price: -110 },
                // unrecognized side
                { name: 'Push', description: 'Bad Pitcher', point: 7.0, price: -110 },
                // non-finite point
                { name: 'Over', description: 'Bad Pitcher', point: 'N/A', price: -110 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0].playerName).toBe('Good Pitcher');
  });

  test('returns empty array when response has no bookmakers', () => {
    const rows = parseEventPropLines({}, GAME_ID, FETCHED_AT);
    expect(rows).toEqual([]);
  });

  test('ignores markets that are not pitcher_strikeouts', () => {
    const eventOdds = {
      id: 'evt-other-market',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: 'Not A Pitcher', point: 3.5, price: -110 },
                { name: 'Under', description: 'Not A Pitcher', point: 3.5, price: -110 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveGameId — two-step strategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic mock db:
 *   step1Rows — returned by first prepare().all() (1-hour exact candidates)
 *   step2Rows — returned by second prepare().all() (4-hour prefix candidates)
 */
function makeDb(step1Rows, step2Rows = []) {
  let callCount = 0;
  return {
    prepare: jest.fn().mockImplementation(() => {
      callCount += 1;
      const rows = callCount === 1 ? step1Rows : step2Rows;
      return { all: jest.fn().mockReturnValue(rows) };
    }),
  };
}

describe('resolveGameId — step 1 (exact normalized match)', () => {
  test('returns game_id when exact team names match a step-1 candidate', () => {
    const db = makeDb([
      { game_id: 'mlb-nyy-bos-1', home_team: 'Boston Red Sox', away_team: 'New York Yankees' },
    ]);
    const result = resolveGameId(db, {
      commence_time: '2026-03-26T18:00:00Z',
      home_team: 'Boston Red Sox',
      away_team: 'New York Yankees',
    });
    expect(result).toBe('mlb-nyy-bos-1');
    // Step 2 query must NOT have fired
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  test('is case-insensitive and ignores non-alpha characters', () => {
    const db = makeDb([
      { game_id: 'mlb-case-1', home_team: 'BOSTON RED SOX', away_team: 'NEW YORK YANKEES' },
    ]);
    const result = resolveGameId(db, {
      commence_time: '2026-03-26T18:00:00Z',
      home_team: 'boston red sox',
      away_team: 'new york yankees',
    });
    expect(result).toBe('mlb-case-1');
  });

  test('falls through to step 2 when step-1 candidates do not match', () => {
    const db = makeDb(
      [{ game_id: 'wrong-game', home_team: 'Chicago Cubs', away_team: 'St. Louis Cardinals' }],
      [{ game_id: 'right-game', home_team: 'Boston Red Sox', away_team: 'New York Yankees' }],
    );
    // Suppress prefix-fallback warning
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveGameId(db, {
      commence_time: '2026-03-26T18:00:00Z',
      home_team: 'Boston Red Sox',
      away_team: 'New York Yankees',
    });
    expect(result).toBe('right-game');
    expect(db.prepare).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });
});

describe('resolveGameId — step 2 (prefix fallback)', () => {
  test('emits console.warn when prefix fallback is used', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(
      [], // step 1: no candidates
      [{ game_id: 'mlb-prefix-1', home_team: 'Red Sox', away_team: 'Yankees' }],
    );
    resolveGameId(db, {
      commence_time: '2026-03-26T18:00:00Z',
      home_team: 'Boston Red Sox',
      away_team: 'New York Yankees',
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prefix fallback'));
    warnSpy.mockRestore();
  });

  test('returns game_id from step-2 prefix match', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(
      [],
      [{ game_id: 'mlb-prefix-2', home_team: 'Red Sox', away_team: 'Yankees' }],
    );
    const result = resolveGameId(db, {
      commence_time: '2026-03-26T18:00:00Z',
      home_team: 'Boston Red Sox',
      away_team: 'New York Yankees',
    });
    expect(result).toBe('mlb-prefix-2');
    jest.restoreAllMocks();
  });
});

describe('resolveGameId — no match', () => {
  test('returns null when neither step finds a matching game', () => {
    const db = makeDb([], []);
    const result = resolveGameId(db, {
      commence_time: '2026-03-26T18:00:00Z',
      home_team: 'Boston Red Sox',
      away_team: 'New York Yankees',
    });
    expect(result).toBeNull();
  });
});
