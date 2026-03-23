'use strict';
/**
 * Tests for pull_nhl_player_shots_props.js
 *
 * Covers:
 *   - parseEventPropLines: SOG + BLK parsed from same Odds API response, no collision
 *   - resolveGameId: two-step exact-then-prefix strategy
 *
 * WI-0526 Phase 2 acceptance: both prop_type values stored independently,
 * resolveGameId aligned with model runner's proximity logic.
 */

const {
  parseEventPropLines,
  resolveGameId,
} = require('../pull_nhl_player_shots_props');

// ────────────────────────────────────────────────────────────────────────────
// parseEventPropLines
// ────────────────────────────────────────────────────────────────────────────

describe('parseEventPropLines — shots_on_goal', () => {
  const GAME_ID = 'nhl-2026-01.01-bos-tor';
  const FETCHED_AT = '2026-03-20T18:00:00.000Z';

  test('parses Over/Under SOG outcomes into shots_on_goal row', () => {
    const eventOdds = {
      id: 'evt-sog-1',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: 'Auston Matthews', point: 2.5, price: -115 },
                { name: 'Under', description: 'Auston Matthews', point: 2.5, price: -105 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sport: 'NHL',
      gameId: GAME_ID,
      playerName: 'Auston Matthews',
      propType: 'shots_on_goal',
      line: 2.5,
      overPrice: -115,
      underPrice: -105,
      bookmaker: 'draftkings',
      period: 'full_game',
    });
  });

  test('produces one row per player when multiple bookmakers', () => {
    const outcome = (bm) => ({
      key: bm,
      markets: [
        {
          key: 'player_shots_on_goal',
          outcomes: [
            { name: 'Over', description: 'Mitch Marner', point: 3.5, price: -110 },
            { name: 'Under', description: 'Mitch Marner', point: 3.5, price: -110 },
          ],
        },
      ],
    });
    const rows = parseEventPropLines(
      { id: 'evt-multi', bookmakers: [outcome('draftkings'), outcome('fanduel')] },
      GAME_ID,
      FETCHED_AT,
    );
    // One row per (player × bookmaker): 1 player × 2 bookmakers = 2 rows
    expect(rows).toHaveLength(2);
    const bms = rows.map((r) => r.bookmaker).sort();
    expect(bms).toEqual(['draftkings', 'fanduel']);
  });

  test('normalizes decimal odds to canonical American prices', () => {
    const eventOdds = {
      id: 'evt-decimal',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: 'Brady Tkachuk', point: 3, price: 1.77 },
                { name: 'Under', description: 'Brady Tkachuk', point: 3, price: 2.15 },
              ],
            },
          ],
        },
      ],
    };

    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      line: 3,
      overPrice: -130,
      underPrice: 115,
    });
  });

  test('preserves multiple threshold ladders for one player at one bookmaker', () => {
    const eventOdds = {
      id: 'evt-ladder',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: 'Brady Tkachuk', point: 3, price: -330 },
                { name: 'Under', description: 'Brady Tkachuk', point: 3, price: 240 },
                { name: 'Over', description: 'Brady Tkachuk', point: 4, price: -135 },
                { name: 'Under', description: 'Brady Tkachuk', point: 4, price: 105 },
              ],
            },
          ],
        },
      ],
    };

    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.line).sort((a, b) => a - b)).toEqual([3, 4]);
    expect(rows.find((row) => row.line === 3)).toMatchObject({
      playerName: 'Brady Tkachuk',
      overPrice: -330,
      underPrice: 240,
    });
    expect(rows.find((row) => row.line === 4)).toMatchObject({
      playerName: 'Brady Tkachuk',
      overPrice: -135,
      underPrice: 105,
    });
  });
});

describe('parseEventPropLines — blocked_shots', () => {
  const GAME_ID = 'nhl-2026-03.20-tor-bos';
  const FETCHED_AT = '2026-03-20T18:00:00.000Z';

  test('parses Over/Under BLK outcomes into blocked_shots row', () => {
    const eventOdds = {
      id: 'evt-blk-1',
      bookmakers: [
        {
          key: 'fanduel',
          markets: [
            {
              key: 'player_blocked_shots',
              outcomes: [
                { name: 'Over', description: 'Morgan Rielly', point: 1.5, price: -120 },
                { name: 'Under', description: 'Morgan Rielly', point: 1.5, price: -100 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sport: 'NHL',
      propType: 'blocked_shots',
      playerName: 'Morgan Rielly',
      line: 1.5,
      overPrice: -120,
      underPrice: -100,
    });
  });
});

describe('parseEventPropLines — SOG + BLK in same response (no collision)', () => {
  const GAME_ID = 'nhl-2026-03.20-mixed';
  const FETCHED_AT = '2026-03-20T18:00:00.000Z';

  test('extracts two separate rows when same bookmaker carries both markets', () => {
    const eventOdds = {
      id: 'evt-mixed',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: 'Player A', point: 3.5, price: -110 },
                { name: 'Under', description: 'Player A', point: 3.5, price: -110 },
              ],
            },
            {
              key: 'player_blocked_shots',
              outcomes: [
                { name: 'Over', description: 'Player B', point: 1.5, price: -115 },
                { name: 'Under', description: 'Player B', point: 1.5, price: -105 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(2);

    const sogRow = rows.find((r) => r.propType === 'shots_on_goal');
    const blkRow = rows.find((r) => r.propType === 'blocked_shots');

    expect(sogRow).toBeDefined();
    expect(blkRow).toBeDefined();

    // Ensure prop_types don't bleed into each other
    expect(sogRow.playerName).toBe('Player A');
    expect(blkRow.playerName).toBe('Player B');
    expect(sogRow.propType).toBe('shots_on_goal');
    expect(blkRow.propType).toBe('blocked_shots');
  });

  test('same player in both markets produces two distinct rows', () => {
    const player = 'Dual Threat Player';
    const eventOdds = {
      id: 'evt-dual',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: player, point: 3.5, price: -110 },
                { name: 'Under', description: player, point: 3.5, price: -110 },
              ],
            },
            {
              key: 'player_blocked_shots',
              outcomes: [
                { name: 'Over', description: player, point: 1.5, price: -120 },
                { name: 'Under', description: player, point: 1.5, price: -100 },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT);
    expect(rows).toHaveLength(2);
    const propTypes = rows.map((r) => r.propType).sort();
    expect(propTypes).toEqual(['blocked_shots', 'shots_on_goal']);
  });
});

describe('parseEventPropLines — edge cases', () => {
  const GAME_ID = 'nhl-edge';
  const FETCHED_AT = '2026-03-20T18:00:00.000Z';

  test('unknown market key is silently ignored', () => {
    const eventOdds = {
      id: 'evt-unknown',
      bookmakers: [
        {
          key: 'betmgm',
          markets: [
            {
              key: 'player_anytime_scorer',
              outcomes: [
                { name: 'Over', description: 'Some Player', point: 0.5, price: 150 },
              ],
            },
          ],
        },
      ],
    };
    expect(parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT)).toHaveLength(0);
  });

  test('player row omitted when point (line) is null/missing', () => {
    const eventOdds = {
      id: 'evt-noline',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots_on_goal',
              outcomes: [
                { name: 'Over', description: 'Player C', price: -110 }, // no point
              ],
            },
          ],
        },
      ],
    };
    expect(parseEventPropLines(eventOdds, GAME_ID, FETCHED_AT)).toHaveLength(0);
  });

  test('returns empty array when bookmakers list absent', () => {
    expect(parseEventPropLines({}, GAME_ID, FETCHED_AT)).toHaveLength(0);
  });

  test('returns empty array when eventOdds is null/undefined', () => {
    expect(parseEventPropLines(null, GAME_ID, FETCHED_AT)).toHaveLength(0);
    expect(parseEventPropLines(undefined, GAME_ID, FETCHED_AT)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// resolveGameId — two-step strategy
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic mock db:
 *   step1Rows  — returned by the first prepare().all() call (1-hour exact candidates)
 *   step2Rows  — returned by the second prepare().all() call (4-hour prefix candidates)
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
      { game_id: 'nhl-tor-bos-1', home_team: 'Toronto Maple Leafs', away_team: 'Boston Bruins' },
    ]);
    const result = resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
    });
    expect(result).toBe('nhl-tor-bos-1');
    // Step 2 query should NOT have run
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  test('is case-insensitive and strips non-alpha characters', () => {
    const db = makeDb([
      { game_id: 'nhl-case-1', home_team: 'TORONTO MAPLE LEAFS', away_team: 'BOSTON BRUINS' },
    ]);
    const result = resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'toronto maple leafs',
      away_team: 'boston bruins',
    });
    expect(result).toBe('nhl-case-1');
  });

  test('skips non-matching step-1 candidates and falls through to step 2', () => {
    // Step 1 can only returns a different game, step 2 has the right one
    const db = makeDb(
      [{ game_id: 'wrong-game', home_team: 'Colorado Avalanche', away_team: 'Vegas Golden Knights' }],
      [{ game_id: 'right-game', home_team: 'Toronto Maple Leafs', away_team: 'Boston Bruins' }],
    );
    const result = resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
    });
    expect(result).toBe('right-game');
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });
});

describe('resolveGameId — step 2 (prefix fallback)', () => {
  test('emits a console.warn when prefix fallback is used', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(
      [], // step 1: no candidates at all
      [{ game_id: 'nhl-prefix-1', home_team: 'Maple Leafs', away_team: 'Bruins' }],
    );
    resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prefix fallback'));
    warnSpy.mockRestore();
  });

  test('returns game_id from step-2 prefix match', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(
      [],
      [{ game_id: 'nhl-prefix-2', home_team: 'Maple Leafs', away_team: 'Bruins' }],
    );
    const result = resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
    });
    expect(result).toBe('nhl-prefix-2');
    jest.restoreAllMocks();
  });
});

describe('resolveGameId — no match', () => {
  test('returns null when neither step finds a matching game', () => {
    const db = makeDb([], []);
    const result = resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
    });
    expect(result).toBeNull();
  });

  test('returns null when step-2 candidates do not prefix-match', () => {
    const db = makeDb(
      [],
      [{ game_id: 'unrelated', home_team: 'Colorado Avalanche', away_team: 'Vegas Golden Knights' }],
    );
    const result = resolveGameId(db, {
      commence_time: '2026-03-20T23:00:00Z',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
    });
    expect(result).toBeNull();
  });
});
