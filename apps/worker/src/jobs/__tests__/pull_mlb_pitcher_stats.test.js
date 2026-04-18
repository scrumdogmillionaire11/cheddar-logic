const {
  normalizeMlbTeamAbbreviation,
  selectPitcherTeamAbbreviation,
} = require('../pull_mlb_pitcher_stats');

describe('pull_mlb_pitcher_stats team resolution', () => {
  test('normalizes known full team names to abbreviations', () => {
    expect(normalizeMlbTeamAbbreviation('Boston Red Sox')).toBe('BOS');
    expect(normalizeMlbTeamAbbreviation('St. Louis Cardinals')).toBe('STL');
    expect(normalizeMlbTeamAbbreviation('Athletics')).toBe('ATH');
  });

  test('keeps abbreviation tokens unchanged', () => {
    expect(normalizeMlbTeamAbbreviation('bal')).toBe('BAL');
    expect(normalizeMlbTeamAbbreviation('NYY')).toBe('NYY');
  });

  test('prefers current-team identity when schedule team conflicts', () => {
    expect(selectPitcherTeamAbbreviation('BAL', 'Toronto Blue Jays')).toBe('TOR');
    expect(selectPitcherTeamAbbreviation('BOS', 'PHI')).toBe('PHI');
  });

  test('uses schedule team when no conflict exists', () => {
    expect(selectPitcherTeamAbbreviation('BAL', 'BAL')).toBe('BAL');
    expect(selectPitcherTeamAbbreviation('BAL', null)).toBe('BAL');
  });

  test('falls back to current-team when schedule mapping missing', () => {
    expect(selectPitcherTeamAbbreviation(null, 'Chicago Cubs')).toBe('CHC');
  });
});
