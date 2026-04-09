'use strict';

/**
 * MLB pitcher stats DB queries — WI-0840
 *
 * Provides computeMLBLeagueAverages(db) for nightly dynamic league constants.
 * Falls back to static 2024 values when insufficient current-season rows exist.
 */

// Static 2024 fallback constants
const STATIC_K_PCT  = 0.225;
const STATIC_XFIP   = 4.3;
const STATIC_BB_PCT = 0.085;

const MLB_DYNAMIC_CONSTANTS_MIN_SAMPLE = parseInt(
  process.env.MLB_DYNAMIC_CONSTANTS_MIN_SAMPLE || '50',
  10,
);

/**
 * Compute MLB league-average constants from the current season's mlb_pitcher_stats rows.
 *
 * Returns { kPct, xfip, bbPct, source, n }:
 *   - source='computed'   when n >= MLB_DYNAMIC_CONSTANTS_MIN_SAMPLE (default 50)
 *   - source='static_2024' when fewer rows are available (early season fallback)
 *
 * @param {object} db - better-sqlite3 database handle
 * @returns {{ kPct: number, xfip: number, bbPct: number, source: string, n: number }}
 */
function computeMLBLeagueAverages(db) {
  const currentYear = new Date().getFullYear();

  let row;
  try {
    row = db
      .prepare(
        `SELECT
           COUNT(*)          AS n,
           AVG(season_k_pct) AS avg_k_pct,
           AVG(x_fip)        AS avg_xfip,
           AVG(bb_pct)       AS avg_bb_pct
         FROM mlb_pitcher_stats
         WHERE season = ?
           AND season_k_pct IS NOT NULL`,
      )
      .get(currentYear);
  } catch (_err) {
    // Table may not exist yet (test env, early bootstrap)
    return {
      kPct:   STATIC_K_PCT,
      xfip:   STATIC_XFIP,
      bbPct:  STATIC_BB_PCT,
      source: 'static_2024',
      n:      0,
    };
  }

  const n = row ? Number(row.n || 0) : 0;

  if (n < MLB_DYNAMIC_CONSTANTS_MIN_SAMPLE) {
    return {
      kPct:   STATIC_K_PCT,
      xfip:   STATIC_XFIP,
      bbPct:  STATIC_BB_PCT,
      source: 'static_2024',
      n,
    };
  }

  return {
    kPct:   row.avg_k_pct  != null ? Number(row.avg_k_pct)  : STATIC_K_PCT,
    xfip:   row.avg_xfip   != null ? Number(row.avg_xfip)   : STATIC_XFIP,
    bbPct:  row.avg_bb_pct != null ? Number(row.avg_bb_pct) : STATIC_BB_PCT,
    source: 'computed',
    n,
  };
}

module.exports = { computeMLBLeagueAverages };
