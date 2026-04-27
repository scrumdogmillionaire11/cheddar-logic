'use strict';

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  upsertPlayerBlkRates: jest.fn(),
}));

jest.mock('../../utils/with-db-safe', () => ({
  withDbSafe: jest.fn((fn) => fn({ prepare: jest.fn(() => ({ all: jest.fn(() => []), get: jest.fn(() => null) })) })),
}));

const {
  parseSkatersBySituation,
  assertMoneyPuckSchemaIntegrity,
  buildHeaderFingerprint,
} = require('../pull_moneypuck_blk_rates');

describe('pull_moneypuck_blk_rates parser guards', () => {
  test('parseSkatersBySituation accepts aliased blocked-shots column headers', () => {
    const csv = [
      'playerId,name,team,situation,icetime,gamesPlayed,i_f_shotsblocked',
      '8474565,Jaccob Slavin,CAR,5on5,1200,10,24',
      '8474565,Jaccob Slavin,CAR,4on5,300,10,12',
    ].join('\n');

    const { playerMap, blkColumnFound } = parseSkatersBySituation(csv);

    expect(blkColumnFound).toBe(true);
    expect(playerMap.size).toBe(1);
    const row = playerMap.get('8474565');
    expect(row.ev.blk).toBe(24);
    expect(row.pk.blk).toBe(12);
  });

  test('assertMoneyPuckSchemaIntegrity throws on schema drift when required headers are missing', () => {
    const malformedCsv = [
      'player_name,team,gamesPlayed,shotsblockedbyplayer',
      'Jaccob Slavin,CAR,10,25',
    ].join('\n');

    expect(() => assertMoneyPuckSchemaIntegrity(malformedCsv)).toThrow(/SCHEMA_DRIFT/);
  });

  test('buildHeaderFingerprint is deterministic across header ordering changes', () => {
    const fp1 = buildHeaderFingerprint(['playerId', 'situation', 'icetime']);
    const fp2 = buildHeaderFingerprint(['icetime', 'playerId', 'situation']);

    expect(fp1).toBe(fp2);
  });
});
