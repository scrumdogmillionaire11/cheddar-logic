'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function writeCsv(filePath, rows) {
  const header = 'team_name,ft_pct,season,source_updated_at';
  const lines = rows.map((row) =>
    [
      row.team_name,
      row.ft_pct,
      row.season || '2025-2026',
      row.source_updated_at || new Date().toISOString(),
    ].join(','),
  );
  fs.writeFileSync(filePath, [header, ...lines].join('\n') + '\n', 'utf8');
}

describe('teamrankings-ft lookup', () => {
  let tempDir;
  let csvPath;
  const originalPath = process.env.TEAMRANKINGS_NCAAM_FT_CSV_PATH;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamrankings-ft-'));
    csvPath = path.join(tempDir, 'teamrankings_ncaam_ft_pct.csv');
    process.env.TEAMRANKINGS_NCAAM_FT_CSV_PATH = csvPath;
  });

  afterEach(() => {
    process.env.TEAMRANKINGS_NCAAM_FT_CSV_PATH = originalPath;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests.
    }
  });

  test('matches mascot suffix names against school-only TeamRankings rows', () => {
    writeCsv(csvPath, [
      { team_name: 'Siena', ft_pct: '76.6' },
      { team_name: 'SMU', ft_pct: '74.2' },
      { team_name: 'William & Mary', ft_pct: '74.9' },
    ]);

    const { lookupTeamRankingsFreeThrowPct } = require('../src/teamrankings-ft');
    expect(lookupTeamRankingsFreeThrowPct('Siena Saints')?.freeThrowPct).toBe(
      76.6,
    );
    expect(lookupTeamRankingsFreeThrowPct('SMU MUSTANGS')?.freeThrowPct).toBe(
      74.2,
    );
    expect(
      lookupTeamRankingsFreeThrowPct('William & Mary Tribe')?.freeThrowPct,
    ).toBe(74.9);
  });

  test('matches directional abbreviations and prefers more specific prefix', () => {
    writeCsv(csvPath, [
      { team_name: 'North Dakota', ft_pct: '74.0' },
      { team_name: 'N Dakota St', ft_pct: '72.1' },
      { team_name: 'Alabama', ft_pct: '76.7' },
      { team_name: 'Alabama St', ft_pct: '78.2' },
    ]);

    const { lookupTeamRankingsFreeThrowPct } = require('../src/teamrankings-ft');
    expect(
      lookupTeamRankingsFreeThrowPct('North Dakota St Bison')?.freeThrowPct,
    ).toBe(72.1);
    expect(
      lookupTeamRankingsFreeThrowPct('ALABAMA ST HORNETS')?.freeThrowPct,
    ).toBe(78.2);
  });

  test('returns null when no candidate can be matched', () => {
    writeCsv(csvPath, [{ team_name: 'Duke', ft_pct: '78.4' }]);
    const { lookupTeamRankingsFreeThrowPct } = require('../src/teamrankings-ft');
    expect(lookupTeamRankingsFreeThrowPct('Imaginary College Unicorns')).toBe(
      null,
    );
  });
});
