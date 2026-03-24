/**
 * calibrate_sog_v1_v2.js
 *
 * Read-only calibration study: V1 (recency-decay) vs V2 (rate-weighted Poisson)
 * mu accuracy against settled NHL SOG prop cards from the last 90 days.
 *
 * Produces docs/runbooks/sog-v1-v2-calibration-2026-03.md
 *
 * Usage:
 *   node scripts/calibrate_sog_v1_v2.js [--dry-run]
 *   CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/calibrate_sog_v1_v2.js
 *
 * --dry-run: Print row count and exit without generating report
 *            (useful for CI presence-check without prod DB).
 *
 * Exit codes:
 *   0 = success
 *   1 = CHEDDAR_DB_PATH unset, DB not found, or fatal error
 *
 * NOTE: This script is read-only. It does not write to any DB table.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  initDb,
  getDatabase,
} = require('../packages/data/src/db.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORT_PATH = path.resolve(
  __dirname,
  '../docs/runbooks/sog-v1-v2-calibration-2026-03.md'
);

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Round a number to N decimal places (returns number, not string).
 */
function round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/**
 * Mean Absolute Error of an array of absolute differences.
 */
function mae(diffs) {
  if (diffs.length === 0) return null;
  return diffs.reduce((s, d) => s + d, 0) / diffs.length;
}

/**
 * Compute the edge bucket key: floor((mu - line) * 10) / 10, clamped to [-2.0, +2.0].
 */
function edgeBucket(mu, line) {
  const raw = Math.floor((mu - line) * 10) / 10;
  return Math.max(-2.0, Math.min(2.0, raw));
}

/**
 * Format a bucket key as a string like "+0.3" or "-0.5".
 */
function bucketLabel(b) {
  return (b >= 0 ? '+' : '') + b.toFixed(1);
}

/**
 * Build a calibration table for a given set of rows.
 * Each row must have: { mu, line, won (bool) }
 *
 * Returns array sorted by bucket asc:
 *   { bucket, n, winRate }
 */
function buildCalibrationTable(rows) {
  const buckets = new Map(); // key -> { n, wins }

  for (const row of rows) {
    const bk = edgeBucket(row.mu, row.line);
    const label = bucketLabel(bk);
    if (!buckets.has(label)) {
      buckets.set(label, { bucket: bk, n: 0, wins: 0 });
    }
    const entry = buckets.get(label);
    entry.n += 1;
    if (row.won) entry.wins += 1;
  }

  // Sort by bucket value ascending
  return Array.from(buckets.values()).sort((a, b) => a.bucket - b.bucket);
}

/**
 * Find the lowest positive-edge bucket where actual win_rate >= 0.55 and N >= 10.
 */
function findEdgeMin(table) {
  const candidates = table.filter(
    (row) => row.bucket > 0 && row.n >= 10 && row.wins / row.n >= 0.55
  );
  if (candidates.length === 0) return null;
  // Already sorted ascending — return lowest qualifying bucket
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Report Builder
// ---------------------------------------------------------------------------

function buildReport({
  dbPath,
  totalRows,
  skipCount,
  validRows,
  v1Table,
  v2Table,
  maeV1,
  maeV2,
  edgeMinV1,
  edgeMinV2,
}) {
  const generated = new Date().toISOString();
  const n = validRows.length;
  const nV2 = validRows.filter((r) => r.mu_v2 != null).length;

  const maeV1Str = maeV1 != null ? maeV1.toFixed(3) : 'N/A';
  const maeV2Str = maeV2 != null ? maeV2.toFixed(3) : 'N/A';

  // Which model is more accurate?
  let betterModel;
  if (maeV1 == null && maeV2 == null) {
    betterModel = 'insufficient data to determine';
  } else if (maeV1 == null) {
    betterModel = 'V2';
  } else if (maeV2 == null) {
    betterModel = 'V1';
  } else if (maeV1 < maeV2) {
    betterModel = 'V1 (recency-decay)';
  } else if (maeV2 < maeV1) {
    betterModel = 'V2 (rate-weighted Poisson)';
  } else {
    betterModel = 'tied (MAE equal)';
  }

  // EDGE_MIN recommendation
  function edgeMinSection(label, edgeMinEntry) {
    if (edgeMinEntry == null) {
      return (
        `**Proposed EDGE_MIN (${label}):** insufficient data\n` +
        `**Basis:** No bucket with N >= 10 and win_rate >= 55% found. ` +
        `Recommend re-running after 30+ more settled cards.`
      );
    }
    return (
      `**Proposed EDGE_MIN (${label}):** +${edgeMinEntry.bucket.toFixed(1)} SOG\n` +
      `**Basis:** Lowest positive-edge bucket with win_rate >= 55% and N >= 10 is ` +
      `${bucketLabel(edgeMinEntry.bucket)} ` +
      `(N=${edgeMinEntry.n}, win_rate=${((edgeMinEntry.wins / edgeMinEntry.n) * 100).toFixed(1)}%).`
    );
  }

  // Calibration table markdown
  function calTable(rows) {
    if (rows.length === 0) {
      return '| — | — | — | No data |\n';
    }
    return rows
      .map((r) => {
        const wr =
          r.n > 0 ? ((r.wins / r.n) * 100).toFixed(1) + '%' : '—';
        return `| ${bucketLabel(r.bucket)} | ${r.n} | ${wr} | |`;
      })
      .join('\n');
  }

  const noDataNote =
    n === 0
      ? '\n> **Note:** No settled data available in this environment. ' +
        'Run with `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/calibrate_sog_v1_v2.js` ' +
        'to populate with real data.\n'
      : '';

  return `# SOG V1 vs V2 Mu Calibration Study — March 2026

**Generated:** ${generated}
**DB:** ${dbPath}
**Window:** Last 90 days
${noDataNote}
## Summary

| Metric | V1 (recency-decay) | V2 (rate-weighted Poisson) |
|--------|-------------------|---------------------------|
| Cards analyzed | ${n} | ${nV2} |
| MAE | ${maeV1Str} | ${maeV2Str} |
| Skipped (missing data) | ${skipCount} | — |

## Calibration Table — V1

Bucket = floor(mu_v1 - line, 1 decimal). Win rate = fraction of settled cards
where the bet won.

| Edge Bucket | N | Win Rate | Notes |
|-------------|---|----------|-------|
${calTable(v1Table)}

## Calibration Table — V2

| Edge Bucket | N | Win Rate | Notes |
|-------------|---|----------|-------|
${calTable(v2Table)}

## Recommendation

**More accurate model:** ${betterModel}
**Basis:** MAE V1=${maeV1Str}, MAE V2=${maeV2Str}

${edgeMinSection('V1', edgeMinV1)}

${edgeMinSection('V2', edgeMinV2)}

## Methodology

- Data source: card_payloads JOIN card_results (status=settled, result=win|loss) JOIN game_results
- V1 mu: payload_data.decision.projection
- V2 mu: payload_data.decision.v2.sog_mu (only cards where non-null)
- Actual SOG: game_results.metadata.playerShots.fullGameByPlayerId[player_id]
- Bucketing: floor((mu - line) * 10) / 10 (0.1 SOG increments)
- Win rate threshold for EDGE_MIN: 55% with N >= 10
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dbPath = process.env.CHEDDAR_DB_PATH;

  if (!dbPath) {
    console.error('[calibrate_sog_v1_v2] ERROR: CHEDDAR_DB_PATH is not set.');
    console.error(
      '  Set it to the path of the SQLite DB file, e.g.:\n' +
      '  CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/calibrate_sog_v1_v2.js'
    );
    process.exit(1);
  }

  // Initialise DB
  try {
    await initDb();
  } catch (err) {
    console.error('[calibrate_sog_v1_v2] ERROR: Could not open database.');
    console.error('  CHEDDAR_DB_PATH:', dbPath);
    console.error('  Details:', err.message);
    process.exit(1);
  }

  const db = getDatabase();
  if (!db) {
    console.error('[calibrate_sog_v1_v2] ERROR: Database handle is null after init.');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Query: settled NHL SOG cards (last 90 days) joined with game results
  // ---------------------------------------------------------------------------

  const QUERY = `
    SELECT
      cp.id          AS card_id,
      cp.game_id,
      cp.payload_data,
      cr.result,
      cr.status,
      gr.metadata    AS game_metadata
    FROM card_payloads cp
    JOIN card_results cr ON cr.card_id = cp.id
    JOIN game_results gr ON gr.game_id = cp.game_id
    WHERE cp.sport = 'NHL'
      AND cp.card_type = 'nhl-player-shots'
      AND cr.status = 'settled'
      AND cr.result IN ('win', 'loss')
      AND datetime(cp.created_at) >= datetime('now', '-90 days')
  `;

  let rawRows;
  try {
    rawRows = db.prepare(QUERY).all();
  } catch (err) {
    // If tables don't exist (e.g. empty dev/CI DB), treat as 0 rows rather than
    // hard-failing so --dry-run can still report a clean row count of 0.
    if (err.message && err.message.includes('no such table')) {
      console.warn('[calibrate_sog_v1_v2] WARN: Required tables not found — DB appears empty.');
      rawRows = [];
    } else {
      console.error('[calibrate_sog_v1_v2] ERROR: Query failed:', err.message);
      process.exit(1);
    }
  }

  const totalRows = rawRows.length;

  if (DRY_RUN) {
    console.log('[calibrate_sog_v1_v2] --dry-run mode');
    console.log(`  Total rows matched: ${totalRows}`);
    console.log('  (No report generated in dry-run mode.)');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Per-row extraction
  // ---------------------------------------------------------------------------

  let skipCount = 0;
  const validRows = [];

  for (const row of rawRows) {
    let payload, gameMeta;

    try {
      payload = JSON.parse(row.payload_data);
    } catch (_) {
      skipCount++;
      continue;
    }

    try {
      gameMeta = JSON.parse(row.game_metadata);
    } catch (_) {
      skipCount++;
      continue;
    }

    const mu_v1 = payload.decision?.projection;
    const mu_v2 = payload.decision?.v2?.sog_mu ?? null;
    const line = payload.play?.selection?.line;
    const player_id = payload.play?.player_id;
    const period = payload.play?.period; // 'full_game' | '1p'

    // Skip if V1 mu or line are missing/NaN
    if (mu_v1 == null || isNaN(mu_v1) || line == null || isNaN(line)) {
      skipCount++;
      continue;
    }

    // Derive actual SOG from game_metadata
    let actual_sog;
    if (period === '1p' || period === 'first_period') {
      actual_sog = gameMeta?.playerShots?.firstPeriodByPlayerId?.[player_id];
    } else {
      actual_sog = gameMeta?.playerShots?.fullGameByPlayerId?.[player_id];
    }

    if (actual_sog == null || isNaN(actual_sog)) {
      skipCount++;
      continue;
    }

    const won = row.result === 'win';

    validRows.push({
      mu_v1,
      mu_v2,
      line,
      actual_sog,
      won,
    });
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  // MAE V1
  const v1Diffs = validRows.map((r) => Math.abs(r.mu_v1 - r.actual_sog));
  const maeV1 = mae(v1Diffs);

  // MAE V2 — only rows where mu_v2 is non-null
  const v2Rows = validRows.filter((r) => r.mu_v2 != null);
  const v2Diffs = v2Rows.map((r) => Math.abs(r.mu_v2 - r.actual_sog));
  const maeV2 = mae(v2Diffs);

  // Calibration tables
  const v1CalibRows = validRows.map((r) => ({ mu: r.mu_v1, line: r.line, won: r.won }));
  const v2CalibRows = v2Rows.map((r) => ({ mu: r.mu_v2, line: r.line, won: r.won }));

  const v1Table = buildCalibrationTable(v1CalibRows);
  const v2Table = buildCalibrationTable(v2CalibRows);

  // EDGE_MIN heuristics
  const edgeMinV1 = findEdgeMin(v1Table);
  const edgeMinV2 = findEdgeMin(v2Table);

  // ---------------------------------------------------------------------------
  // Print summary to stdout
  // ---------------------------------------------------------------------------

  console.log('[calibrate_sog_v1_v2] Run complete');
  console.log(`  DB: ${dbPath}`);
  console.log(`  Total rows: ${totalRows} | Skipped: ${skipCount} | Valid: ${validRows.length}`);
  console.log(`  V2 rows (non-null mu_v2): ${v2Rows.length}`);
  console.log(`  MAE V1: ${maeV1 != null ? maeV1.toFixed(3) : 'N/A'}`);
  console.log(`  MAE V2: ${maeV2 != null ? maeV2.toFixed(3) : 'N/A'}`);
  console.log(`  EDGE_MIN V1: ${edgeMinV1 ? '+' + edgeMinV1.bucket.toFixed(1) : 'insufficient data'}`);
  console.log(`  EDGE_MIN V2: ${edgeMinV2 ? '+' + edgeMinV2.bucket.toFixed(1) : 'insufficient data'}`);

  // ---------------------------------------------------------------------------
  // Generate report
  // ---------------------------------------------------------------------------

  const report = buildReport({
    dbPath,
    totalRows,
    skipCount,
    validRows,
    v1Table,
    v2Table,
    maeV1,
    maeV2,
    edgeMinV1,
    edgeMinV2,
  });

  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`  Report written: ${REPORT_PATH}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[calibrate_sog_v1_v2] Unhandled error:', err);
  process.exit(1);
});
