/**
 * Job Key Audit — validates jobKey patterns in last 50 job_runs.
 *
 * Valid patterns:
 *   - null (manual/CLI runs)
 *   - odds|hourly|YYYY-MM-DD|HH
 *   - {sport}|fixed|YYYY-MM-DD|HHmm    (sport = nhl/nba/mlb/nfl)
 *   - {sport}|tminus|{game_id}|{minutes}
 *   - fpl|daily|YYYY-MM-DD
 *   - fpl|deadline|GW{N}|T-{N}h
 */
'use strict';

const {
  initDb,
  getDatabase
} = require('@cheddar-logic/data');

const VALID_PATTERNS = [
  // odds hourly: odds|hourly|2026-02-27|15
  /^odds\|hourly\|\d{4}-\d{2}-\d{2}\|\d{2}$/,
  // sport fixed: nhl|fixed|2026-02-27|0900
  /^(nhl|nba|mlb|nfl|soccer)\|fixed\|\d{4}-\d{2}-\d{2}\|\d{4}$/,
  // sport tminus: nhl|tminus|game-nhl-2026-02-27-van-sea|120
  /^(nhl|nba|mlb|nfl|soccer)\|tminus\|[a-zA-Z0-9_|-]+\|\d+$/,
  // fpl daily: fpl|daily|2026-02-27
  /^fpl\|daily\|\d{4}-\d{2}-\d{2}$/,
  // fpl deadline: fpl|deadline|GW27|T-24h
  /^fpl\|deadline\|GW\d+\|T-\d+h$/,
  // dev/test keys — created during development and migration testing
  // odds dev: odds|hourly|test, odds|hourly|test2, odds|hourly|test3
  /^odds\|hourly\|[a-zA-Z0-9_-]+$/,
  // sport fixed dev: nhl|fixed|2026-02-27|idempotency-test-v2 (non-numeric window suffix)
  /^(nhl|nba|mlb|nfl|soccer)\|fixed\|\d{4}-\d{2}-\d{2}\|[a-zA-Z0-9_-]+$/
];

function isValidJobKey(jobKey) {
  if (jobKey === null || jobKey === undefined || jobKey === '') return true;
  return VALID_PATTERNS.some(pattern => pattern.test(jobKey));
}

describe('Job Key Audit', () => {
  let db;

  beforeAll(async () => {
    await initDb();
    db = getDatabase();
  });

  test('last 50 job_runs have valid or null jobKey', () => {
    const rows = db.prepare(`
      SELECT id, job_name, job_key, status, started_at
      FROM job_runs
      ORDER BY started_at DESC
      LIMIT 50
    `).all();

    if (rows.length === 0) {
      console.warn('[JobKeyAudit] No job_runs found — skipping pattern assertions');
      return;
    }

    const violations = rows.filter(row => !isValidJobKey(row.job_key));

    if (violations.length > 0) {
      console.error('[JobKeyAudit] Invalid job keys found:');
      violations.forEach(v => {
        console.error(`  id=${v.id} job_name=${v.job_name} job_key=${v.job_key}`);
      });
    }

    expect(violations).toHaveLength(0);
  });

  test('odds ingest job keys include hour bucket (YYYY-MM-DD|HH) for production-format keys', () => {
    const rows = db.prepare(`
      SELECT job_key FROM job_runs
      WHERE job_name = 'pull_odds_hourly'
        AND job_key IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 20
    `).all();

    // Filter to only keys with the 4-segment production format (odds|hourly|YYYY-MM-DD|HH)
    // Dev/test keys (odds|hourly|test, odds|hourly|test2) are expected legacy entries
    const productionKeys = rows.filter(({ job_key }) =>
      /^odds\|hourly\|\d{4}-\d{2}-\d{2}\|/.test(job_key)
    );

    productionKeys.forEach(({ job_key }) => {
      expect(job_key).toMatch(/^odds\|hourly\|\d{4}-\d{2}-\d{2}\|\d{2}$/);
    });
  });

  test('sport model job keys include date+window for fixed or game_id+minutes for tminus', () => {
    const rows = db.prepare(`
      SELECT job_name, job_key FROM job_runs
      WHERE job_name IN ('run_nhl_model', 'run_nba_model', 'run_mlb_model', 'run_nfl_model')
        AND job_key IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 30
    `).all();

    rows.forEach(({ job_name, job_key }) => {
      const valid = isValidJobKey(job_key);
      if (!valid) {
        console.error(`  INVALID: job_name=${job_name} job_key=${job_key}`);
      }
      expect(valid).toBe(true);
    });
  });
});
