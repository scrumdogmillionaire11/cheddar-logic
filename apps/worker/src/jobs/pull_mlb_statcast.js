'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const JOB_NAME = 'pull_mlb_statcast';

// Baseball Savant leaderboard CSV endpoint — no auth required.
// Columns available: player_id, player_name, avg_velocity, whiff_percent
// Reference: WI-0770, also WI-0596 notes in .planning/MLB-research.md
const SAVANT_CSV_URL =
  'https://baseballsavant.mlb.com/statcast_search/csv' +
  '?group_by=name&min_pitches=50&season_type=R' +
  `&year=${new Date().getFullYear()}&player_type=pitcher`;

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url, opts = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
    ...opts,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

/**
 * Parse a CSV string into an array of objects.
 * Handles quoted fields and basic escaping.
 * @param {string} text
 * @returns {object[]}
 */
function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  // Strip BOM / carriage returns
  const headerLine = lines[0].replace(/^\uFEFF/, '').replace(/\r/g, '');
  const headers = headerLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g, '');
    if (!line.trim()) continue;

    // Simple CSV split — handle quoted commas naively
    const values = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { values.push(cur); cur = ''; }
      else { cur += ch; }
    }
    values.push(cur);

    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] ?? null; });
    rows.push(obj);
  }
  return rows;
}

/**
 * Given a CSV row, resolve the player_id field.
 * Baseball Savant uses `player_id` or `pitcher` depending on the endpoint.
 */
function resolvePlayerId(row) {
  const raw = row['player_id'] ?? row['pitcher'] ?? row['mlb_id'] ?? null;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the fastball average velocity from a CSV row.
 * Column name varies by endpoint version.
 */
function resolveAvgVelo(row) {
  const raw =
    row['avg_velocity'] ??
    row['fastball_avg_speed'] ??
    row['ff_avg_speed'] ??
    row['release_speed'] ??
    null;
  if (raw == null || raw === '') return null;
  const n = parseFloat(raw);
  // Sanity: MLB fastball velo between 70–105 mph
  return Number.isFinite(n) && n >= 70 && n <= 105 ? n : null;
}

/**
 * Resolve the swinging-strike (whiff) percent from a CSV row.
 * Always return as a decimal (0–1 range); Savant may provide 0–100 or 0–1.
 */
function resolveWhiffPct(row) {
  const raw =
    row['whiff_percent'] ??
    row['swstr_pct'] ??
    row['swinging_strike_pct'] ??
    null;
  if (raw == null || raw === '') return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  // Savant leaderboard provides 0–100 scale; coerce to 0–1 decimal
  const decimal = n > 1 ? n / 100 : n;
  // Sanity: MLB whiff rate 0.04–0.35
  return decimal >= 0.03 && decimal <= 0.40 ? Math.round(decimal * 10000) / 10000 : null;
}

/**
 * Upsert Statcast-derived fields into mlb_pitcher_stats.
 * Only updates season_avg_velo and season_swstr_pct — never overwrites other fields.
 * Requires the row to already exist (created by pull_mlb_pitcher_stats).
 */
function upsertStatcastRows(db, rows) {
  const update = db.prepare(`
    UPDATE mlb_pitcher_stats
    SET
      season_avg_velo  = COALESCE(?, season_avg_velo),
      season_swstr_pct = COALESCE(?, season_swstr_pct),
      updated_at       = datetime('now')
    WHERE mlb_id = ?
  `);

  let updated = 0;
  for (const row of rows) {
    const changes = update.run(row.season_avg_velo, row.season_swstr_pct, row.mlb_id);
    if (changes.changes > 0) updated += 1;
  }
  return updated;
}

/**
 * Fetch and parse the Baseball Savant pitcher CSV, returning rows ready for upsert.
 * @returns {Promise<Array<{mlb_id: number, season_avg_velo: number|null, season_swstr_pct: number|null}>>}
 */
async function fetchStatcastRows() {
  const response = await fetchJson(SAVANT_CSV_URL);
  const text = await response.text();
  const csvRows = parseCsv(text);

  const result = [];
  for (const row of csvRows) {
    const mlbId = resolvePlayerId(row);
    if (!mlbId) continue;

    const season_avg_velo = resolveAvgVelo(row);
    const season_swstr_pct = resolveWhiffPct(row);

    // Only include rows where at least one field is non-null
    if (season_avg_velo === null && season_swstr_pct === null) continue;

    result.push({ mlb_id: mlbId, season_avg_velo, season_swstr_pct });
  }
  return result;
}

async function pullMlbStatcast({
  jobKey = null,
  dryRun = false,
} = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDbSafe(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, skipped: true, reason: 'already_succeeded' };
    }

    const db = getDatabase();
    insertJobRun(db, jobRunId, JOB_NAME, jobKey ?? `${JOB_NAME}-${todayDateString()}`);

    try {
      console.log(`[${JOB_NAME}] Fetching Baseball Savant pitcher Statcast data...`);
      const rows = await fetchStatcastRows();

      console.log(`[${JOB_NAME}] Parsed ${rows.length} rows from CSV`);
      if (rows.length === 0) {
        console.log(`[${JOB_NAME}] No valid rows — CSV may be empty or field names changed`);
        markJobRunSuccess(db, jobRunId, { rows_parsed: 0, rows_updated: 0 });
        return { success: true, rowsParsed: 0, rowsUpdated: 0 };
      }

      if (dryRun) {
        console.log(`[${JOB_NAME}] DRY RUN — would update ${rows.length} rows`);
        markJobRunSuccess(db, jobRunId, { rows_parsed: rows.length, rows_updated: 0, dry_run: true });
        return { success: true, rowsParsed: rows.length, rowsUpdated: 0, dryRun: true };
      }

      const rowsUpdated = upsertStatcastRows(db, rows);
      console.log(`[${JOB_NAME}] Updated ${rowsUpdated}/${rows.length} pitcher rows with Statcast data`);

      // Verify at least one row was written
      const check = db.prepare(
        'SELECT COUNT(*) as c FROM mlb_pitcher_stats WHERE season_avg_velo IS NOT NULL OR season_swstr_pct IS NOT NULL'
      ).get();
      console.log(`[${JOB_NAME}] Total rows with Statcast data: ${check.c}`);

      markJobRunSuccess(db, jobRunId, { rows_parsed: rows.length, rows_updated: rowsUpdated });
      return { success: true, rowsParsed: rows.length, rowsUpdated };
    } catch (err) {
      console.error(`[${JOB_NAME}] Error:`, err.message);
      try { markJobRunFailure(db, jobRunId, err.message); } catch (_) { /* ignore */ }
      return { success: false, error: err.message };
    }
  });
}

module.exports = { pullMlbStatcast, fetchStatcastRows, parseCsv, resolveAvgVelo, resolveWhiffPct };

// Allow direct invocation
if (require.main === module) {
  pullMlbStatcast({}).then((result) => {
    console.log(`[${JOB_NAME}] Done:`, JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  });
}
