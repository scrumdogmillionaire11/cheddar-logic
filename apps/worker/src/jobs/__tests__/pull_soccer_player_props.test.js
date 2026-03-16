const {
  parseEventPropLines,
  normalizeOutcomeSide,
  normalizePlayerName,
} = require('../pull_soccer_player_props');

describe('pull_soccer_player_props', () => {
  test('normalizeOutcomeSide maps over/under + yes/no', () => {
    expect(normalizeOutcomeSide('Over')).toBe('over');
    expect(normalizeOutcomeSide('UNDER')).toBe('under');
    expect(normalizeOutcomeSide('Yes')).toBe('over');
    expect(normalizeOutcomeSide('No')).toBe('under');
    expect(normalizeOutcomeSide('Home')).toBeNull();
  });

  test('normalizePlayerName trims and collapses whitespace', () => {
    expect(normalizePlayerName('  Bukayo   Saka  ')).toBe('Bukayo Saka');
  });

  test('parseEventPropLines parses player_shots over/under rows', () => {
    const eventOdds = {
      id: 'evt-001',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_shots',
              outcomes: [
                { name: 'Over', description: 'Bryan Mbeumo', point: 1.5, price: -115 },
                { name: 'Under', description: 'Bryan Mbeumo', point: 1.5, price: -105 },
              ],
            },
          ],
        },
      ],
    };

    const rows = parseEventPropLines(
      eventOdds,
      'soccer-game-001',
      'player_shots',
      '2026-03-16T00:00:00.000Z',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sport: 'SOCCER',
      gameId: 'soccer-game-001',
      playerName: 'Bryan Mbeumo',
      propType: 'player_shots',
      line: 1.5,
      overPrice: -115,
      underPrice: -105,
      bookmaker: 'draftkings',
    });
  });

  test('parseEventPropLines maps Yes/No to to_score_or_assist at line 0.5', () => {
    const eventOdds = {
      id: 'evt-002',
      bookmakers: [
        {
          key: 'fanduel',
          markets: [
            {
              key: 'to_score_or_assist',
              outcomes: [
                { name: 'Yes', description: 'Matheus Cunha', price: 140 },
                { name: 'No', description: 'Matheus Cunha', price: -170 },
              ],
            },
          ],
        },
      ],
    };

    const rows = parseEventPropLines(
      eventOdds,
      'soccer-game-002',
      'to_score_or_assist',
      '2026-03-16T00:00:00.000Z',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      playerName: 'Matheus Cunha',
      propType: 'to_score_or_assist',
      line: 0.5,
      overPrice: 140,
      underPrice: -170,
      bookmaker: 'fanduel',
    });
  });
});
