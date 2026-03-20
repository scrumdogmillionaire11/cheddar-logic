'use strict';

/**
 * Unit tests for ingest_nst_pp_rates.js
 *
 * Tests:
 * 1. parseCsv parses a minimal NST-style CSV into row objects
 * 2. ingestNstPpRates inserts rows for players with PPTOI > 0
 * 3. ingestNstPpRates skips rows with PPTOI = 0
 * 4. ingestNstPpRates skips rows with invalid/missing PPTOI
 * 5. ingestNstPpRates correctly derives pp_shots_per60 = (SOG / PPTOI) * 60
 * 6. ingestNstPpRates throws when --file is missing
 * 7. ingestNstPpRates throws when file does not exist
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- Mock @cheddar-logic/data ----
const mockUpsertRun = jest.fn();
const mockGetPrepare = jest.fn();

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(() => ({
    prepare: mockGetPrepare,
  })),
}));

const { parseCsv, ingestNstPpRates } = require('../ingest_nst_pp_rates');

// Helper: write a temp CSV and return its path
function writeTempCsv(content) {
  const tmp = path.join(os.tmpdir(), `nst-test-${Date.now()}.csv`);
  fs.writeFileSync(tmp, content, 'utf8');
  return tmp;
}

// Helper: set up mockGetPrepare to capture upsert calls
function setupUpsertMock() {
  mockGetPrepare.mockReset();
  mockUpsertRun.mockReset();
  mockGetPrepare.mockReturnValue({ run: mockUpsertRun });
}

describe('parseCsv', () => {
  test('parses header + data rows into objects', () => {
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\nNathan MacKinnon,8477492,COL,60,2.5,90\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Player: 'Nathan MacKinnon',
      PlayerID: '8477492',
      Team: 'COL',
      PPTOI: '2.5',
      SOG: '90',
    });
  });

  test('returns empty array for CSV with only header', () => {
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(0);
  });

  test('handles quoted fields with commas', () => {
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\n"Smith, Jr.",8477001,TOR,50,1.8,40\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].Player).toBe('Smith, Jr.');
  });
});

describe('ingestNstPpRates', () => {
  beforeEach(() => {
    setupUpsertMock();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('throws when filePath is not provided', () => {
    expect(() => ingestNstPpRates({})).toThrow('--file argument is required');
  });

  test('throws when file does not exist', () => {
    expect(() =>
      ingestNstPpRates({ filePath: '/tmp/nonexistent-nst-file.csv' }),
    ).toThrow('file not found');
  });

  test('inserts rows for players with positive PPTOI', () => {
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\nNathan MacKinnon,8477492,COL,60,2.5,90\n';
    const filePath = writeTempCsv(csv);

    const result = ingestNstPpRates({ filePath, season: '20242025' });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockUpsertRun).toHaveBeenCalledTimes(1);

    // Verify pp_shots_per60 calculation: (90 / 2.5) * 60 = 2160
    const callArgs = mockUpsertRun.mock.calls[0];
    expect(callArgs[0]).toBe('8477492');          // nhl_player_id
    expect(callArgs[1]).toBe('Nathan MacKinnon'); // player_name
    expect(callArgs[2]).toBe('COL');              // team
    expect(callArgs[3]).toBe('20242025');         // season
    expect(callArgs[4]).toBeCloseTo(2160, 1);     // pp_shots_per60 = (90/2.5)*60
    expect(callArgs[5]).toBe(2.5);               // pp_toi_per60

    fs.unlinkSync(filePath);
  });

  test('derives pp_shots_per60 correctly: (SOG / PPTOI) * 60', () => {
    // 12 PP shots / 3.0 avg PPTOI * 60 = 240 per60
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\nAlex Ovechkin,8471214,WSH,50,3.0,12\n';
    const filePath = writeTempCsv(csv);

    ingestNstPpRates({ filePath, season: '20242025' });

    const callArgs = mockUpsertRun.mock.calls[0];
    expect(callArgs[4]).toBeCloseTo(240, 1); // (12/3.0)*60 = 240

    fs.unlinkSync(filePath);
  });

  test('skips rows with PPTOI = 0', () => {
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\nNon PP Player,9999999,BOS,50,0,0\n';
    const filePath = writeTempCsv(csv);

    const result = ingestNstPpRates({ filePath, season: '20242025' });

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockUpsertRun).not.toHaveBeenCalled();

    fs.unlinkSync(filePath);
  });

  test('skips rows with missing/invalid PPTOI', () => {
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\nBad Player,8888888,NYR,50,,20\n';
    const filePath = writeTempCsv(csv);

    const result = ingestNstPpRates({ filePath, season: '20242025' });

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockUpsertRun).not.toHaveBeenCalled();

    fs.unlinkSync(filePath);
  });

  test('processes multiple rows, skipping non-PP players', () => {
    const csv = [
      'Player,PlayerID,Team,GP,PPTOI,SOG',
      'PP Player A,8477492,COL,60,2.5,90',
      'Non PP Player,9999999,BOS,50,0,0',
      'PP Player B,8471214,WSH,50,3.0,12',
    ].join('\n') + '\n';
    const filePath = writeTempCsv(csv);

    const result = ingestNstPpRates({ filePath, season: '20242025' });

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(mockUpsertRun).toHaveBeenCalledTimes(2);

    fs.unlinkSync(filePath);
  });

  test('uses NHL_CURRENT_SEASON env var as default season', () => {
    process.env.NHL_CURRENT_SEASON = '20252026';
    const csv = 'Player,PlayerID,Team,GP,PPTOI,SOG\nTest Player,1234567,EDM,50,1.5,30\n';
    const filePath = writeTempCsv(csv);

    ingestNstPpRates({ filePath });

    const callArgs = mockUpsertRun.mock.calls[0];
    expect(callArgs[3]).toBe('20252026'); // season from env

    delete process.env.NHL_CURRENT_SEASON;
    fs.unlinkSync(filePath);
  });
});
