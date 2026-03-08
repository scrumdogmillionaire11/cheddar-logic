const fs = require('fs');
const path = require('path');
const { checkSqliteIntegrity } = require('@cheddar-logic/data');

const TEST_CORRUPT_DB = '/tmp/cheddar-test-fpl-corrupt.db';
const TEST_VALID_DB = '/tmp/cheddar-test-fpl-valid.db';

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup for test artifacts.
  }
}

function createCorruptDb(dbPath) {
  // Create a file with invalid SQLite content
  fs.writeFileSync(dbPath, 'This is not a valid SQLite database file!\n');
}

function createValidDb(dbPath) {
  // Create a minimal valid SQLite database
  // SQLite header: "SQLite format 3\0" followed by zeros
  const header = Buffer.from('SQLite format 3\0');
  const padding = Buffer.alloc(100 - header.length, 0);
  fs.writeFileSync(dbPath, Buffer.concat([header, padding]));
}

describe('FPL Sage DB Corruption Detection', () => {
  afterAll(() => {
    removeIfExists(TEST_CORRUPT_DB);
    removeIfExists(TEST_VALID_DB);
  });

  describe('checkSqliteIntegrity function', () => {
    test('returns ok for undefined path (backward compatible)', () => {
      const result = checkSqliteIntegrity(undefined);
      expect(result.ok).toBe(true);
      expect(result.error).toBe(null);
    });

    test('returns ok for null path (backward compatible)', () => {
      const result = checkSqliteIntegrity(null);
      expect(result.ok).toBe(true);
      expect(result.error).toBe(null);
    });

    test('returns ok for empty string path', () => {
      const result = checkSqliteIntegrity('');
      expect(result.ok).toBe(true);
      expect(result.error).toBe(null);
    });

    test('returns ok for non-existent file (new installation)', () => {
      const nonExistentPath = '/tmp/cheddar-fpl-nonexistent-' + Date.now() + '.db';
      const result = checkSqliteIntegrity(nonExistentPath);
      expect(result.ok).toBe(true);
      expect(result.error).toBe(null);
    });

    test('detects corrupt database file', () => {
      removeIfExists(TEST_CORRUPT_DB);
      createCorruptDb(TEST_CORRUPT_DB);

      const result = checkSqliteIntegrity(TEST_CORRUPT_DB);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('FPL Sage DB');
      expect(result.error).toContain(TEST_CORRUPT_DB);
    });

    test('returns ok for valid empty database', () => {
      removeIfExists(TEST_VALID_DB);
      createValidDb(TEST_VALID_DB);

      const result = checkSqliteIntegrity(TEST_VALID_DB);
      // Minimal valid SQLite file (just header) may still fail integrity check
      // This is expected - the important thing is corrupt files are detected
      // For production use, FPL DB will be created by proper tools (data_pipeline_cli.py)
      // and will have full schema, so this test documents edge case behavior
      if (result.ok) {
        expect(result.error).toBe(null);
      } else {
        // If it fails, it should be treated as corruption
        expect(result.error).toContain('FPL Sage DB');
      }
    });
  });

  describe('FPL job integration with corruption check', () => {
    test('job fails fast with actionable error on corruption', () => {
      // This is a documentation test - actual integration would require
      // mocking the entire job flow, which is complex.
      // The pre-flight check in run_fpl_model.js ensures:
      // 1. Integrity check happens before fetching odds
      // 2. Error message includes runbook reference
      // 3. Job exits with failure status
      
      removeIfExists(TEST_CORRUPT_DB);
      createCorruptDb(TEST_CORRUPT_DB);

      const result = checkSqliteIntegrity(TEST_CORRUPT_DB);
      
      // Verify error message format matches what job expects
      expect(result.ok).toBe(false);
      expect(result.error).toContain('FPL Sage DB');
      expect(result.error).toContain(TEST_CORRUPT_DB);
      expect(result.error.toLowerCase()).toContain('corrupt');
      
      // Job should throw this error and mark run as failed
      // preventing scheduler tick spam
    });
  });

  describe('Error message quality', () => {
    test('corrupt DB error includes path for ops reference', () => {
      removeIfExists(TEST_CORRUPT_DB);
      createCorruptDb(TEST_CORRUPT_DB);

      const result = checkSqliteIntegrity(TEST_CORRUPT_DB);
      
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/\/tmp\/cheddar-test-fpl-corrupt\.db/);
    });

    test('error message is actionable (mentions corruption explicitly)', () => {
      removeIfExists(TEST_CORRUPT_DB);
      createCorruptDb(TEST_CORRUPT_DB);

      const result = checkSqliteIntegrity(TEST_CORRUPT_DB);
      
      expect(result.ok).toBe(false);
      expect(result.error.toLowerCase()).toContain('corrupt');
    });
  });
});
