const { __testables } = require('../team-metrics');

const { lookupTeamFromScoreboardIndex, normalizeTeamKey } = __testables;

describe('team-metrics scoreboard variant fallback', () => {
  test('matches Seattle Redhawks against Seattle U scoreboard entry', () => {
    const entry = { id: 9991, abbr: 'SEAU' };
    const index = new Map([
      [normalizeTeamKey('Seattle U Redhawks'), entry],
    ]);

    expect(
      lookupTeamFromScoreboardIndex(index, 'Seattle Redhawks', 'NCAAM'),
    ).toEqual(entry);
  });

  test('matches St. Thomas (MN) Tommies against St. Thomas-Minnesota scoreboard entry', () => {
    const entry = { id: 9992, abbr: 'UST' };
    const index = new Map([
      [normalizeTeamKey('St. Thomas-Minnesota Tommies'), entry],
    ]);

    expect(
      lookupTeamFromScoreboardIndex(
        index,
        'St. Thomas (MN) Tommies',
        'NCAAM',
      ),
    ).toEqual(entry);
  });

  test('returns null when multiple different scoreboard teams match the same canonical variant', () => {
    const index = new Map([
      [normalizeTeamKey('Seattle U Redhawks'), { id: 1001, abbr: 'SEAU' }],
      [normalizeTeamKey('Seattle University Redhawks'), { id: 1002, abbr: 'SEAU2' }],
    ]);

    expect(
      lookupTeamFromScoreboardIndex(index, 'Seattle Redhawks', 'NCAAM'),
    ).toBeNull();
  });
});
