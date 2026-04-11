'use strict';

/**
 * WI-0829: Residual projection validation job.
 *
 * Reads 30 days of clv_entries with resolved outcomes and residual values.
 * Computes:
 *   1. Pearson correlation of residual vs CLV (closing line value)
 *   2. Hit rate stratified by residual quartile (Q1 bottom 25%, Q4 top 25%)
 *
 * If Q4 hit rate - Q1 hit rate < 0.04, residual has no predictive value → flag.
 *
 * Runs daily at 04:30 ET after CLV snapshot completes.
 */

require('dotenv').config();
const { getDatabase } = require('@cheddar-logic/data');

/**
 * Compute Pearson correlation between two arrays.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number} Pearson r in [-1, 1]
 */
function computePearson(xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
    sumY2 += ys[i] * ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const num = sumXY - n * meanX * meanY;
  const denomX = Math.sqrt(Math.max(0, sumX2 - n * meanX * meanX));
  const denomY = Math.sqrt(Math.max(0, sumY2 - n * meanY * meanY));
  if (denomX === 0 || denomY === 0) return 0;
  return num / (denomX * denomY);
}

/**
 * Run the residual validation job.
 * @param {import('better-sqlite3').Database} [dbOverride] - Optional DB handle; falls back to getDatabase()
 * @returns {Promise<{ pearsonR: number, hitRateQ1: number, hitRateQ4: number, n: number } | { skipped: true }>}
 */
async function run(dbOverride) {
  const db = dbOverride || getDatabase();

  // Check table exists
  const tableCheck = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='clv_entries'")
    .get();
  if (!tableCheck) {
    console.log('[RESIDUAL_VAL] clv_entries table not found — skipping');
    return { skipped: true };
  }

  // Check residual column exists (migration 072 applied)
  let residualColumnExists = false;
  try {
    db.prepare('SELECT residual FROM clv_entries LIMIT 0').run();
    residualColumnExists = true;
  } catch (_e) {
    console.log('[RESIDUAL_VAL] residual column not yet present in clv_entries (migration 072 not applied) — skipping');
    return { skipped: true };
  }

  if (!residualColumnExists) {
    return { skipped: true };
  }

  const rows = db
    .prepare(
      `SELECT residual, clv, outcome
       FROM clv_entries
       WHERE outcome IS NOT NULL
         AND residual IS NOT NULL
         AND clv IS NOT NULL
         AND created_at >= datetime('now', '-30 days')`,
    )
    .all();

  if (rows.length < 20) {
    console.log(`[RESIDUAL_VAL] insufficient data for validation (n=${rows.length}, min=20)`);
    return { skipped: true };
  }

  // Pearson r between residual and clv
  const pearsonR = computePearson(
    rows.map((r) => r.residual),
    rows.map((r) => r.clv),
  );

  // Quartile hit rate (outcome = 1 is win)
  const sorted = [...rows].sort((a, b) => a.residual - b.residual);
  const q = Math.floor(sorted.length / 4);
  const q1 = sorted.slice(0, q);
  const q4 = sorted.slice(sorted.length - q);
  const hitRate = (arr) => (arr.length > 0 ? arr.filter((r) => r.outcome === 1).length / arr.length : 0);
  const hitRateQ1 = hitRate(q1);
  const hitRateQ4 = hitRate(q4);
  const delta = hitRateQ4 - hitRateQ1;

  if (delta < 0.04) {
    console.warn(
      '[RESIDUAL_VAL] residual has no predictive value: Q4-Q1 delta=',
      delta.toFixed(3),
    );
  }

  console.log('[RESIDUAL_VAL]', {
    pearson_r: pearsonR.toFixed(4),
    hit_rate_q1: hitRateQ1.toFixed(3),
    hit_rate_q4: hitRateQ4.toFixed(3),
    n: rows.length,
  });

  return { pearsonR, hitRateQ1, hitRateQ4, n: rows.length };
}

module.exports = { run };

// Allow direct execution: node src/jobs/run_residual_validation.js
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[RESIDUAL_VAL] fatal error:', err);
      process.exit(1);
    });
}
