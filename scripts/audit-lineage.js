/**
 * audit-lineage.js
 *
 * Reproducible per-record lineage coverage report for WI-0448.
 *
 * Usage:
 *   node scripts/audit-lineage.js
 *   node scripts/audit-lineage.js > /tmp/lineage-audit-$(date +%Y%m%d).txt
 *
 * Exit codes:
 *   0 = success (including empty DB)
 *   1 = DB not found or fatal error
 */

'use strict';

// dotenv is not available at repo root — rely on CHEDDAR_DB_PATH being set in
// the calling environment (shell, systemd unit, or sourced .env file).
// To load env from file before running: set -a; source .env; set +a; node scripts/audit-lineage.js

const {
  initDb,
  getDatabase,
  closeDatabase,
} = require('../packages/data/src/db.js');

// Expected sport x market_type pairs per TRACKING_DIMENSIONS.md
const EXPECTED_SPORT_MARKET_PAIRS = [
  ['NHL', 'moneyline'],
  ['NHL', 'spread'],
  ['NHL', 'puck_line'],
  ['NHL', 'total'],
  ['NBA', 'moneyline'],
  ['NBA', 'spread'],
  ['NBA', 'total'],
  ['NCAAM', 'moneyline'],
  ['NCAAM', 'spread'],
  ['NCAAM', 'total'],
  ['MLB', 'moneyline'],
  ['MLB', 'spread'],
  ['MLB', 'total'],
  ['NFL', 'moneyline'],
  ['NFL', 'spread'],
  ['NFL', 'total'],
];

async function main() {
  // Initialize DB
  try {
    await initDb();
  } catch (err) {
    console.error('[audit-lineage] ERROR: Could not open database.');
    console.error('  Make sure CHEDDAR_DB_PATH is set and the DB file exists.');
    console.error('  Details:', err.message);
    process.exit(1);
  }

  const client = getDatabase();
  if (!client) {
    console.error('[audit-lineage] ERROR: Database handle is null after init.');
    console.error('  Check CHEDDAR_DB_PATH environment variable.');
    process.exit(1);
  }

  // Check that card_results table exists
  let tablesExist = false;
  try {
    const tableCheck = client
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('card_results', 'card_payloads')`,
      )
      .all();
    tablesExist = tableCheck.length >= 2;
  } catch (err) {
    console.error('[audit-lineage] ERROR: Could not query sqlite_master:', err.message);
    closeDatabase();
    process.exit(1);
  }

  if (!tablesExist) {
    console.log('=== LINEAGE COVERAGE REPORT ===');
    console.log('Total records: 0 (tables not yet created)');
    console.log('');
    console.log('=== RECORDS WITH MISSING LINEAGE (sample up to 20) ===');
    console.log('(no records)');
    console.log('');
    console.log('=== SEGMENTATION BUCKET COVERAGE ===');
    console.log('(no records)');
    closeDatabase();
    return;
  }

  // Fetch the last 500 card_results joined with card_payloads
  let rows;
  try {
    rows = client
      .prepare(
        `
        SELECT
          cr.id          AS result_id,
          cr.card_id,
          cr.game_id,
          cr.sport,
          cr.card_type,
          cr.recommended_bet_type,
          cr.status,
          cr.result,
          cr.created_at,
          cp.payload_data,
          cp.model_output_ids
        FROM card_results cr
        LEFT JOIN card_payloads cp ON cp.id = cr.card_id
        ORDER BY cr.created_at DESC
        LIMIT 500
        `,
      )
      .all();
  } catch (err) {
    console.error('[audit-lineage] ERROR: Query failed:', err.message);
    closeDatabase();
    process.exit(1);
  }

  const total = rows.length;

  // Per-record lineage check
  let sportPresent = 0;
  let marketTypePresent = 0;
  let callActionPresent = 0;
  let projectionSourcePresent = 0;
  let driverContextPresent = 0;
  let fullLineage = 0;

  const missingRows = [];

  for (const row of rows) {
    let payload = null;
    if (row.payload_data) {
      try {
        payload = JSON.parse(row.payload_data);
      } catch {
        payload = null;
      }
    }

    // 1. sport: cr.sport non-null
    const hasSport = Boolean(row.sport && row.sport.trim());

    // 2. market_type: cr.recommended_bet_type non-null and not 'unknown'
    const rbt = row.recommended_bet_type;
    const hasMarketType =
      Boolean(rbt && rbt.trim()) && rbt.toLowerCase() !== 'unknown';

    // 3. call_action: payload_data.decision_v2.official_status present
    const officialStatus = payload?.decision_v2?.official_status;
    const hasCallAction =
      officialStatus === 'PLAY' ||
      officialStatus === 'LEAN' ||
      officialStatus === 'PASS';

    // 4. projection_source: payload_data.meta.inference_source OR model_output_ids non-null
    const inferenceSource = payload?.meta?.inference_source;
    const hasProjectionSource =
      Boolean(inferenceSource && String(inferenceSource).trim()) ||
      Boolean(row.model_output_ids && String(row.model_output_ids).trim());

    // 5. driver_context: payload_data.decision_v2.drivers_used non-empty array
    const driversUsed = payload?.decision_v2?.drivers_used;
    const hasDriverContext =
      Array.isArray(driversUsed) && driversUsed.length > 0;

    if (hasSport) sportPresent++;
    if (hasMarketType) marketTypePresent++;
    if (hasCallAction) callActionPresent++;
    if (hasProjectionSource) projectionSourcePresent++;
    if (hasDriverContext) driverContextPresent++;

    const hasAll =
      hasSport &&
      hasMarketType &&
      hasCallAction &&
      hasProjectionSource &&
      hasDriverContext;
    if (hasAll) fullLineage++;

    if (!hasAll && missingRows.length < 20) {
      const missing = [];
      if (!hasSport) missing.push('sport');
      if (!hasMarketType) missing.push('market_type');
      if (!hasCallAction) missing.push('call_action');
      if (!hasProjectionSource) missing.push('projection_source');
      if (!hasDriverContext) missing.push('driver_context');
      missingRows.push({
        result_id: row.result_id,
        game_id: row.game_id,
        sport: row.sport || '(null)',
        card_type: row.card_type || '(null)',
        missing_fields: missing.join(', '),
      });
    }
  }

  function pct(n, total) {
    if (total === 0) return '  N/A';
    return String(Math.round((n / total) * 100)).padStart(3) + '%';
  }

  // ─── SECTION A: Coverage Summary ───────────────────────────────────────────
  console.log('=== LINEAGE COVERAGE REPORT ===');
  console.log(`Total records: ${total}`);

  if (total === 0) {
    console.log('sport present:           0/0 (N/A)');
    console.log('market_type present:     0/0 (N/A)');
    console.log('call_action present:     0/0 (N/A)');
    console.log('projection_source:       0/0 (N/A)');
    console.log('driver_context:          0/0 (N/A)');
    console.log('Full lineage (all 5):    0/0 (N/A)');
  } else {
    console.log(
      `sport present:           ${sportPresent}/${total} (${pct(sportPresent, total)})`,
    );
    console.log(
      `market_type present:     ${marketTypePresent}/${total} (${pct(marketTypePresent, total)})`,
    );
    console.log(
      `call_action present:     ${callActionPresent}/${total} (${pct(callActionPresent, total)})`,
    );
    console.log(
      `projection_source:       ${projectionSourcePresent}/${total} (${pct(projectionSourcePresent, total)})`,
    );
    console.log(
      `driver_context:          ${driverContextPresent}/${total} (${pct(driverContextPresent, total)})`,
    );
    console.log(
      `Full lineage (all 5):    ${fullLineage}/${total} (${pct(fullLineage, total)})`,
    );
  }

  // ─── SECTION B: Gap Table ──────────────────────────────────────────────────
  console.log('');
  console.log('=== RECORDS WITH MISSING LINEAGE (sample up to 20) ===');
  if (missingRows.length === 0) {
    console.log('(all records have full lineage)');
  } else {
    const colW = {
      result_id: Math.max(9, ...missingRows.map((r) => r.result_id.length)),
      game_id: Math.max(7, ...missingRows.map((r) => r.game_id.length)),
      sport: Math.max(5, ...missingRows.map((r) => r.sport.length)),
      card_type: Math.max(9, ...missingRows.map((r) => r.card_type.length)),
      missing: Math.max(14, ...missingRows.map((r) => r.missing_fields.length)),
    };

    const header =
      'result_id'.padEnd(colW.result_id) +
      ' | ' +
      'game_id'.padEnd(colW.game_id) +
      ' | ' +
      'sport'.padEnd(colW.sport) +
      ' | ' +
      'card_type'.padEnd(colW.card_type) +
      ' | ' +
      'missing_fields';
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const r of missingRows) {
      console.log(
        r.result_id.padEnd(colW.result_id) +
          ' | ' +
          r.game_id.padEnd(colW.game_id) +
          ' | ' +
          r.sport.padEnd(colW.sport) +
          ' | ' +
          r.card_type.padEnd(colW.card_type) +
          ' | ' +
          r.missing_fields,
      );
    }
  }

  // ─── SECTION C: Segmentation Bucket Coverage ───────────────────────────────
  console.log('');
  console.log('=== SEGMENTATION BUCKET COVERAGE ===');

  let bucketRows;
  try {
    bucketRows = client
      .prepare(
        `
        SELECT
          UPPER(COALESCE(cr.sport, '(null)')) AS sport,
          LOWER(COALESCE(cr.recommended_bet_type, '(null)')) AS market_type,
          COUNT(*) AS record_count
        FROM card_results cr
        GROUP BY sport, market_type
        ORDER BY sport ASC, record_count DESC
        `,
      )
      .all();
  } catch (err) {
    console.log('(could not query bucket coverage:', err.message + ')');
    closeDatabase();
    return;
  }

  if (bucketRows.length === 0) {
    console.log('(no records in card_results)');
  } else {
    // Actual pairs observed
    const actualSet = new Set(
      bucketRows.map((r) => `${r.sport}|${r.market_type}`),
    );

    // Print observed buckets
    console.log('Observed sport x market_type pairs:');
    let currentSport = null;
    for (const r of bucketRows) {
      if (r.sport !== currentSport) {
        currentSport = r.sport;
        console.log(`  ${r.sport}:`);
      }
      console.log(`    ${r.market_type}: ${r.record_count} records`);
    }

    // Compare against expected
    console.log('');
    console.log('Expected vs observed (per TRACKING_DIMENSIONS.md):');
    const presentPairs = [];
    const missingPairs = [];
    for (const [sport, mkt] of EXPECTED_SPORT_MARKET_PAIRS) {
      const key = `${sport}|${mkt}`;
      if (actualSet.has(key)) {
        presentPairs.push(`${sport} x ${mkt}`);
      } else {
        missingPairs.push(`${sport} x ${mkt}`);
      }
    }
    if (presentPairs.length > 0) {
      console.log(`  Present (${presentPairs.length}): ${presentPairs.join(', ')}`);
    }
    if (missingPairs.length > 0) {
      console.log(`  Missing (${missingPairs.length}): ${missingPairs.join(', ')}`);
      console.log(
        '  Note: missing pairs may indicate no records yet or an unexpected market_type value.',
      );
    }
    if (missingPairs.length === 0) {
      console.log('  All expected pairs are present.');
    }
  }

  closeDatabase();
}

main().catch((err) => {
  console.error('[audit-lineage] FATAL:', err.message || err);
  process.exit(1);
});
