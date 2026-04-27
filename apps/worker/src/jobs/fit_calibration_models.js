'use strict';

/**
 * WI-0831: Daily fit job for per-market isotonic calibration models.
 *
 * Reads calibration_predictions (market, fair_prob, outcome) grouped by market.
 * For each market with >= 30 resolved samples:
 *   1. Fits isotonic regression (PAV) on sorted (fair_prob, outcome) pairs
 *   2. Computes isotonic Brier score
 *   3. Upserts into calibration_models table
 *
 * Market keys align with calibration-utils.js THRESHOLDS token format:
 *   NHL_TOTAL, NBA_TOTAL, MLB_F5_TOTAL, SPREAD, ML
 *
 * Sport is inferred from the market key:
 *   NHL_* → 'NHL', NBA_* → 'NBA', MLB_* → 'MLB', SPREAD/ML → 'ALL'
 */

const { getDatabase } = require('@cheddar-logic/data');
const { fitIsotonic, applyCalibration } = require('../utils/calibration');

const MIN_SAMPLES = 30;

/**
 * Derive sport string from market key token.
 * @param {string} market
 * @returns {string}
 */
function sportFromMarket(market) {
  const token = String(market).toUpperCase();
  if (token.startsWith('NHL')) return 'NHL';
  if (token.startsWith('NBA')) return 'NBA';
  if (token.startsWith('MLB')) return 'MLB';
  return 'ALL';
}

/**
 * Compute Brier score of calibrated probabilities vs outcomes.
 * @param {number[]} xs
 * @param {number[]} ys
 * @param {{ x: number, y: number }[]} breakpoints
 * @returns {number}
 */
function brierScore(xs, ys, breakpoints) {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    const { calibratedProb } = applyCalibration(xs[i], breakpoints);
    sum += (calibratedProb - ys[i]) ** 2;
  }
  return sum / xs.length;
}

/**
 * Run the calibration fit job.
 * @param {import('better-sqlite3').Database} [dbOverride] - Optional DB handle; falls back to getDatabase()
 */
async function run(dbOverride) {
  const db = dbOverride || getDatabase();
  // Check that calibration_predictions table exists
  const tableCheck = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_predictions'",
    )
    .get();
  if (!tableCheck) {
    console.log('[CAL_FIT] calibration_predictions table not found — skipping');
    return;
  }

  // Check that calibration_models table exists (migration 071 applied)
  const modelsTableCheck = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_models'",
    )
    .get();
  if (!modelsTableCheck) {
    console.log('[CAL_FIT] calibration_models table not found — migration 071 not yet applied, skipping');
    return;
  }

  // Get distinct markets with resolved outcomes
  const markets = db
    .prepare(
      `SELECT DISTINCT market
       FROM calibration_predictions
       WHERE outcome IS NOT NULL
       ORDER BY market ASC`,
    )
    .all()
    .map((row) => String(row.market).trim().toUpperCase())
    .filter(Boolean);

  if (markets.length === 0) {
    console.log('[CAL_FIT] no markets with resolved outcomes found — skipping');
    return;
  }

  const shadowTableCheck = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_models_shadow'")
    .get();
  const hasShadowTable = !!shadowTableCheck;

  const upsertShadow = hasShadowTable
    ? db.prepare(`
        INSERT INTO calibration_models_shadow (sport, market_type, fitted_at, breakpoints_json, n_samples, isotonic_brier, promoted, promoted_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(sport, market_type) DO UPDATE SET
          fitted_at        = excluded.fitted_at,
          breakpoints_json = excluded.breakpoints_json,
          n_samples        = excluded.n_samples,
          isotonic_brier   = excluded.isotonic_brier,
          promoted         = 0,
          promoted_at      = NULL
      `)
    : null;

  const promoteToLive = db.prepare(`
    INSERT INTO calibration_models (sport, market_type, fitted_at, breakpoints_json, n_samples, isotonic_brier)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, market_type) DO UPDATE SET
      fitted_at        = excluded.fitted_at,
      breakpoints_json = excluded.breakpoints_json,
      n_samples        = excluded.n_samples,
      isotonic_brier   = excluded.isotonic_brier
  `);

  const markShadowPromoted = hasShadowTable
    ? db.prepare(`
        UPDATE calibration_models_shadow
        SET promoted = 1, promoted_at = ?
        WHERE sport = ? AND market_type = ?
      `)
    : null;

  const getIncumbentBrier = db.prepare(
    `SELECT isotonic_brier FROM calibration_models WHERE sport = ? AND market_type = ?`,
  );

  const PROMOTE_EPSILON = 0.0001;

  const fittedAt = new Date().toISOString();
  const runUpserts = db.transaction((rows) => {
    for (const row of rows) {
      if (upsertShadow) {
        upsertShadow.run(row.sport, row.marketType, fittedAt, row.breakpointsJson, row.nSamples, row.isotonicBrier);
      }

      const incumbent = getIncumbentBrier.get(row.sport, row.marketType);
      const incumbentBrier = incumbent?.isotonic_brier ?? null;
      const shouldPromote = incumbentBrier === null || (incumbentBrier - row.isotonicBrier) >= PROMOTE_EPSILON;

      if (shouldPromote) {
        promoteToLive.run(row.sport, row.marketType, fittedAt, row.breakpointsJson, row.nSamples, row.isotonicBrier);
        if (markShadowPromoted) markShadowPromoted.run(fittedAt, row.sport, row.marketType);
        console.log(
          `[CAL_FIT] promoted sport=${row.sport} market=${row.marketType} incumbent_brier=${incumbentBrier?.toFixed(4) ?? 'none'} new_brier=${row.isotonicBrier.toFixed(4)}`,
        );
      } else {
        console.log(
          `[CAL_FIT] skipped promotion sport=${row.sport} market=${row.marketType} — new brier=${row.isotonicBrier.toFixed(4)} not better than incumbent ${incumbentBrier.toFixed(4)} by epsilon=${PROMOTE_EPSILON}`,
        );
      }
    }
  });

  const results = [];

  for (const market of markets) {
    // Fetch all resolved rows for this market, ordered by fair_prob
    const rows = db
      .prepare(
        `SELECT fair_prob, outcome
         FROM calibration_predictions
         WHERE market = ?
           AND outcome IS NOT NULL
           AND fair_prob IS NOT NULL
           AND (model_status IS NULL OR model_status != 'SYNTHETIC_FALLBACK')
         ORDER BY fair_prob ASC`,
      )
      .all(market);

    const nSamples = rows.length;
    if (nSamples < MIN_SAMPLES) {
      console.log(`[CAL_FIT] skipped ${market} — only ${nSamples} samples (min=${MIN_SAMPLES})`);
      continue;
    }

    const xs = rows.map((r) => r.fair_prob);
    const ys = rows.map((r) => r.outcome);

    let breakpoints;
    try {
      breakpoints = fitIsotonic(xs, ys);
    } catch (err) {
      console.error(`[CAL_FIT] fitIsotonic failed for ${market}: ${err.message}`);
      continue;
    }

    const isotonicBrier = brierScore(xs, ys, breakpoints);
    const sport = sportFromMarket(market);
    const breakpointsJson = JSON.stringify(breakpoints);

    results.push({
      sport,
      marketType: market,
      breakpointsJson,
      nSamples,
      isotonicBrier,
    });

    console.log(
      `[CAL_FIT] fitted sport=${sport} market=${market} n=${nSamples} isotonic_brier=${isotonicBrier.toFixed(4)}`,
    );
  }

  if (results.length > 0) {
    runUpserts(results);
    console.log(`[CAL_FIT] upserted ${results.length} calibration model(s)`);
  } else {
    console.log('[CAL_FIT] no markets had sufficient samples for fitting');
  }
}

module.exports = { run };
