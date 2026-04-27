'use strict';

const mockUpsertPlayerBlkRates = jest.fn();

jest.mock('@cheddar-logic/data', () => ({
  upsertPlayerBlkRates: mockUpsertPlayerBlkRates,
}));

const {
  parseCsv,
  ingestNstBlkRates,
  normalizeSplitRows,
  assertNstSchemaIntegrity,
} = require('../ingest_nst_blk_rates');

describe('ingest_nst_blk_rates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('parseCsv parses NST-style content', () => {
    const rows = parseCsv('Player,PlayerID,Team,EV BLK,EV TOI,PK BLK,PK TOI\nJaccob Slavin,8474565,CAR,40,400,20,100\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].Player).toBe('Jaccob Slavin');
  });

  test('returns missing_urls when URL env vars are absent', async () => {
    const result = await ingestNstBlkRates({ seasonUrl: undefined, l10Url: undefined, l5Url: undefined });
    expect(result).toEqual({ inserted: 0, skipped: 0, error: 'missing_urls' });
    expect(mockUpsertPlayerBlkRates).not.toHaveBeenCalled();
  });

  test('ingest merges season/l10/l5 CSVs and upserts rates', async () => {
    const csvSeason = 'Player,PlayerID,Team,EV BLK,EV TOI,PK BLK,PK TOI\nJaccob Slavin,8474565,CAR,40,400,20,100\n';
    const csvL10 = 'Player,PlayerID,Team,EV BLK,EV TOI,PK BLK,PK TOI\nJaccob Slavin,8474565,CAR,8,80,4,20\n';
    const csvL5 = 'Player,PlayerID,Team,EV BLK,EV TOI,PK BLK,PK TOI\nJaccob Slavin,8474565,CAR,5,40,2,10\n';
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => csvSeason })
      .mockResolvedValueOnce({ ok: true, text: async () => csvL10 })
      .mockResolvedValueOnce({ ok: true, text: async () => csvL5 });

    const result = await ingestNstBlkRates({
      season: '20252026',
      seasonUrl: 'https://example.com/season.csv',
      l10Url: 'https://example.com/l10.csv',
      l5Url: 'https://example.com/l5.csv',
      fetchImpl,
    });

    expect(result.inserted).toBe(1);
    expect(mockUpsertPlayerBlkRates).toHaveBeenCalledWith(
      expect.objectContaining({
        nhlPlayerId: '8474565',
        season: '20252026',
        evBlocksSeasonPer60: 6,
        evBlocksL10Per60: 6,
        evBlocksL5Per60: 7.5,
        pkBlocksSeasonPer60: 12,
        pkBlocksL10Per60: 12,
        pkBlocksL5Per60: 12,
        pkToiPerGame: 100,
      }),
    );
  });

  test('normalizeSplitRows accepts aliased/mixed-case headers', () => {
    const rows = parseCsv(
      '"Player Name",player_id,TEAM,EV_BLOCKS,EV_TOI,PK_BLOCKS,PK_TOI\nJaccob Slavin,8474565,CAR,40,400,20,100\n',
    );
    const normalized = normalizeSplitRows(rows);
    const player = normalized.get('8474565');

    expect(player).toBeTruthy();
    expect(player.evRate).toBeCloseTo(6, 5);
    expect(player.pkRate).toBeCloseTo(12, 5);
  });

  test('assertNstSchemaIntegrity throws on malformed CSV schema', () => {
    const malformed = 'Player,Team,EV TOI,PK TOI\nJaccob Slavin,CAR,400,100\n';
    expect(() => assertNstSchemaIntegrity(malformed, 'season')).toThrow(/SCHEMA_DRIFT/);
  });
});
