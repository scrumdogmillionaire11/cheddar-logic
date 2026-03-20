'use strict';

const {
  deriveSeasonId,
  buildCayenneExp,
  mergeTeamStatsRows,
  upsertTeamStatsRows,
  parseCliArgs,
} = require('../pull_nhl_team_stats');

describe('pull_nhl_team_stats', () => {
  test('deriveSeasonId uses Sep rollover', () => {
    expect(deriveSeasonId(new Date('2026-10-01T00:00:00Z'))).toBe(20262027);
    expect(deriveSeasonId(new Date('2026-03-01T00:00:00Z'))).toBe(20252026);
  });

  test('buildCayenneExp includes homeRoad only for H/R splits', () => {
    expect(buildCayenneExp({ seasonId: 20252026, homeRoad: 'ALL' })).toBe(
      'seasonId=20252026 and gameTypeId=2',
    );
    expect(buildCayenneExp({ seasonId: 20252026, homeRoad: 'H' })).toContain(
      'homeRoad="H"',
    );
  });

  test('mergeTeamStatsRows maps PK% and penaltiesTakenPer60 into matchup rows', () => {
    const merged = mergeTeamStatsRows(
      {
        data: [
          { teamId: 1, teamFullName: 'Team One', penaltyKillPct: 0.79 },
          { teamId: 2, teamFullName: 'Team Two', penaltyKillPct: 0.83 },
        ],
      },
      {
        data: [
          { teamId: 1, teamFullName: 'Team One', penaltiesTakenPer60: 3.4 },
          { teamId: 2, teamFullName: 'Team Two', penaltiesTakenPer60: 2.6 },
        ],
      },
      { seasonId: 20252026, homeRoad: 'R' },
    );

    expect(merged).toHaveLength(2);
    const row = merged.find((r) => r.team_id === 1);
    expect(row).toEqual(
      expect.objectContaining({
        season: '20252026',
        home_road: 'R',
        pk_pct: 0.79,
        penalties_against_per60: 3.4,
      }),
    );
  });

  test('upsertTeamStatsRows ensures table and upserts each row', () => {
    const run = jest.fn();
    const db = {
      exec: jest.fn(),
      prepare: jest.fn(() => ({ run })),
    };

    const upserted = upsertTeamStatsRows(db, [
      {
        team_id: 1,
        team_name: 'Team One',
        season: '20252026',
        home_road: 'ALL',
        pk_pct: 0.8,
        penalties_against_per60: 3.1,
        source: 'nhl_stats_api',
      },
      {
        team_id: 2,
        team_name: 'Team Two',
        season: '20252026',
        home_road: 'H',
        pk_pct: 0.78,
        penalties_against_per60: 3.5,
        source: 'nhl_stats_api',
      },
    ]);

    expect(upserted).toBe(2);
    expect(db.exec).toHaveBeenCalledTimes(2);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO team_stats'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('parseCliArgs supports --dry-run and --season', () => {
    const parsed = parseCliArgs(['--dry-run', '--season', '20252026']);
    expect(parsed).toEqual({ dryRun: true, seasonId: '20252026' });
  });
});
