/**
 * Edge Calculation Library
 *
 * Computes probability edges (0-1 scale) for all market types.
 * Edge = p_fair - p_implied
 *
 * Ranges: roughly [-1, +1], thresholds in canonical-decision use 0.02-0.025 (2-2.5%)
 *
 * All computation uses Normal approximation for projections vs market lines.
 */

/**
 * Convert American odds to implied probability
 * @param {number} odds - American format (-120, +110, etc)
 * @returns {number|null} - Probability 0-1, or null if invalid
 */
function impliedProbFromAmerican(odds) {
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/**
 * Remove bookmaker vig from two-sided market probabilities.
 * Formula: p_home_nv = p_home_raw / (p_home_raw + p_away_raw)
 *
 * At -110/-110: raw implied = 0.5238 each, total = 1.0476
 * No-vig: 0.5238 / 1.0476 = 0.5 each — correct fair-price baseline.
 *
 * @param {number} priceHome - American odds for home side
 * @param {number} priceAway - American odds for away side
 * @returns {{ home: number, away: number } | null}
 */
function noVigImplied(priceHome, priceAway) {
  const pHome = impliedProbFromAmerican(priceHome);
  const pAway = impliedProbFromAmerican(priceAway);
  if (pHome == null || pAway == null) return null;
  const total = pHome + pAway;
  return { home: pHome / total, away: pAway / total };
}

/**
 * Inverse normal CDF (probit function) — Abramowitz & Stegun 26.2.17
 * Max |error| < 4.5e-4 for 0 < p < 1.
 * Inverse of normCdf: invNormCdf(normCdf(z)) ≈ z
 * @param {number} p - Probability (0, 1)
 * @returns {number} - Standard normal variate z such that Φ(z) = p
 */
function invNormCdf(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [2.515517, 0.802853, 0.010328];
  const b = [1.432788, 0.189269, 0.001308];
  const q = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(q));
  const z =
    t - (a[0] + a[1] * t + a[2] * t * t) / (1 + b[0] * t + b[1] * t * t + b[2] * t * t * t);
  return p < 0.5 ? -z : z;
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun)
 * @param {number} z - Standard normal variate
 * @returns {number} - Φ(z), probability
 */
function normCdf(z) {
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228;

  if (z < 0) {
    return 1 - normCdf(-z);
  }

  const t = 1 / (1 + p * z);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  return (
    1 -
    c *
      Math.exp((-z * z) / 2) *
      (b1 * t + b2 * t2 + b3 * t3 + b4 * t4 + b5 * t5)
  );
}

/**
 * Compute moneyline edge
 * @param {object} params
 * @param {number} params.projectionWinProbHome - Fair win prob for home (0-1)
 * @param {number} params.americanOdds - American odds for the predicted side
 * @param {number} [params.priceOpposite] - American odds for the opposite side (enables vig removal)
 * @param {boolean} params.isPredictionHome - true if betting home, false if away
 * @returns {object} { edge, p_fair, p_implied, confidence [, VIG_REMOVAL_SKIPPED] }
 */
function computeMoneylineEdge({
  projectionWinProbHome,
  americanOdds,
  priceOpposite,
  isPredictionHome = true,
}) {
  if (
    !Number.isFinite(projectionWinProbHome) ||
    !Number.isFinite(americanOdds)
  ) {
    return {
      edge: null,
      p_fair: null,
      p_implied: null,
      reason: 'missing_projection_or_odds',
    };
  }

  const p_fair = isPredictionHome
    ? projectionWinProbHome
    : 1 - projectionWinProbHome;

  // Use vig-removed implied probability when both sides are available
  const priceHome = isPredictionHome ? americanOdds : priceOpposite;
  const priceAway = isPredictionHome ? priceOpposite : americanOdds;
  const noVig = noVigImplied(priceHome, priceAway);

  let p_implied;
  let vigRemovalSkipped = false;
  if (noVig != null) {
    p_implied = isPredictionHome ? noVig.home : noVig.away;
  } else {
    p_implied = impliedProbFromAmerican(americanOdds);
    vigRemovalSkipped = true;
  }

  if (p_implied == null) {
    return { edge: null, p_fair, p_implied: null, reason: 'invalid_odds' };
  }

  const edge = p_fair - p_implied;
  const result = {
    edge: Number(edge.toFixed(4)),
    p_fair: Number(p_fair.toFixed(4)),
    p_implied: Number(p_implied.toFixed(4)),
    confidence: 0.95,
  };
  if (vigRemovalSkipped) result.VIG_REMOVAL_SKIPPED = true;
  return result;
}

/**
 * Compute spread edge (home vs away)
 * @param {object} params
 * @param {number} params.projectionMarginHome - Home score - away score (fair projection)
 * @param {number} params.spreadLine - Spread line (e.g., -6.5 for home favored)
 * @param {number} params.spreadPriceHome - Price for home side (e.g., -110)
 * @param {number} params.spreadPriceAway - Price for away side (e.g., -110)
 * @param {number} params.sigmaMargin - Standard deviation (NBA ~12, NCAAM ~11)
 * @param {boolean} params.isPredictionHome - true if betting home, false if away
 * @returns {object} { edge, edgePoints, p_fair, p_implied, confidence, sigma_used }
 */
function computeSpreadEdge({
  projectionMarginHome,
  spreadLine,
  spreadPriceHome,
  spreadPriceAway,
  sigmaMargin = 12,
  isPredictionHome = true,
}) {
  if (!Number.isFinite(projectionMarginHome) || !Number.isFinite(spreadLine)) {
    return {
      edge: null,
      edgePoints: null,
      p_fair: null,
      p_implied: null,
      reason: 'missing_projection_or_line',
    };
  }

  const mu = projectionMarginHome;
  const S = spreadLine; // e.g., -6.5
  const T = -S; // cover threshold (e.g., 6.5)

  // Probability home covers
  const p_home_cover = 1 - normCdf((T - mu) / sigmaMargin);

  // Select based on prediction
  const p_fair = isPredictionHome ? p_home_cover : 1 - p_home_cover;

  // Use vig-removed implied probability when both sides are available
  const noVig = noVigImplied(spreadPriceHome, spreadPriceAway);
  let p_implied;
  let vigRemovalSkipped = false;
  if (noVig != null) {
    p_implied = isPredictionHome ? noVig.home : noVig.away;
  } else {
    const oddsToUse = isPredictionHome ? spreadPriceHome : spreadPriceAway;
    p_implied = impliedProbFromAmerican(oddsToUse);
    vigRemovalSkipped = true;
  }

  if (p_implied == null) {
    return {
      edge: null,
      edgePoints: mu - T,
      p_fair,
      p_implied: null,
      reason: 'invalid_spread_odds',
    };
  }

  const edge = p_fair - p_implied;
  const edgePoints = mu - T;

  const result = {
    edge: Number(edge.toFixed(4)),
    edgePoints: Number(edgePoints.toFixed(2)),
    p_fair: Number(p_fair.toFixed(4)),
    p_implied: Number(p_implied.toFixed(4)),
    confidence: 0.85, // spread projections less calibrated than ML
    sigma_used: sigmaMargin,
  };
  if (vigRemovalSkipped) result.VIG_REMOVAL_SKIPPED = true;
  return result;
}

/**
 * Compute total edge (over vs under)
 * @param {object} params
 * @param {number} params.projectionTotal - Fair projected total (e.g., 238.5)
 * @param {number} params.totalLine - Market total line (e.g., 238.5)
 * @param {number} params.totalPriceOver - Over price (e.g., -110)
 * @param {number} params.totalPriceUnder - Under price (e.g., -110)
 * @param {number} params.sigmaTotal - Standard deviation (NBA ~14, NCAAM ~13, NHL ~1.8)
 * @param {boolean} params.isPredictionOver - true if betting over, false if under
 * @returns {object} { edge, edgePoints, p_fair, p_implied, confidence, sigma_used }
 */
function computeTotalEdge({
  projectionTotal,
  totalLine,
  totalPriceOver,
  totalPriceUnder,
  sigmaTotal = 14,
  isPredictionOver = true,
}) {
  if (!Number.isFinite(projectionTotal) || !Number.isFinite(totalLine)) {
    return {
      edge: null,
      edgePoints: null,
      p_fair: null,
      p_implied: null,
      reason: 'missing_projection_or_line',
    };
  }

  const mu = projectionTotal;
  const L = totalLine;
  const isNhlStyleTotal = sigmaTotal <= 3;
  const adjustedLine = isNhlStyleTotal ? L + 0.5 : L;

  // Probability over
  const p_over = 1 - normCdf((adjustedLine - mu) / sigmaTotal);

  // Select based on prediction
  let p_fair = isPredictionOver ? p_over : 1 - p_over;
  const railFlags = [];
  if (isNhlStyleTotal) {
    const clampedFair = Math.min(Math.max(p_fair, 0.25), 0.75);
    if (clampedFair !== p_fair) {
      railFlags.push('UNREALISTIC_TOTAL_PROBABILITY');
      p_fair = clampedFair;
    }
  }
  // Use vig-removed implied probability when both sides are available
  const noVig = noVigImplied(totalPriceOver, totalPriceUnder);
  let p_implied;
  let vigRemovalSkipped = false;
  if (noVig != null) {
    p_implied = isPredictionOver ? noVig.home : noVig.away;
  } else {
    const oddsToUse = isPredictionOver ? totalPriceOver : totalPriceUnder;
    p_implied = impliedProbFromAmerican(oddsToUse);
    vigRemovalSkipped = true;
  }

  if (p_implied == null) {
    return {
      edge: null,
      edgePoints: mu - L,
      p_fair,
      p_implied: null,
      reason: 'invalid_total_odds',
      rail_flags: railFlags,
    };
  }

  let edge = p_fair - p_implied;
  if (isNhlStyleTotal && Math.abs(edge) > 0.18) {
    edge = Math.sign(edge) * 0.18;
    railFlags.push('EDGE_SANITY_CLAMP_APPLIED');
  }
  const edgePoints = mu - L;

  const result = {
    edge: Number(edge.toFixed(4)),
    edgePoints: Number(edgePoints.toFixed(2)),
    p_fair: Number(p_fair.toFixed(4)),
    p_implied: Number(p_implied.toFixed(4)),
    confidence: 0.88,
    sigma_used: sigmaTotal,
    rail_flags: railFlags,
  };
  if (vigRemovalSkipped) result.VIG_REMOVAL_SKIPPED = true;
  return result;
}

/**
 * Detect sigma by sport — FALLBACK values only.
 *
 * These are FALLBACK values used when empirical computation is unavailable.
 * Current calibration notes:
 *   - NBA margin=12 (set ~2024, uncalibrated — no lineage in codebase)
 *   - NBA total=14  (set ~2024, uncalibrated — no lineage in codebase)
 * Live callers should prefer computeSigmaFromHistory() to get empirically
 * derived values from game_results. These constants are last-resort fallbacks.
 *
 * @param {string} sport - Sport string (NBA, NCAAM, NHL, NFL, MLB)
 * @returns {{ margin: number, total: number }}
 */
function getSigmaDefaults(sport) {
  const sigmaMap = {
    NBA: { margin: 12, total: 14 },
    NCAAM: { margin: 11, total: 13 },
    NHL: { margin: 2.0, total: 2.0 },
    NFL: { margin: 14, total: 16 },
    MLB: { margin: 4, total: 9.5 },
  };
  return sigmaMap[sport?.toUpperCase()] || { margin: 12, total: 14 };
}

/**
 * Compute population standard deviation from an array of numbers.
 * @param {number[]} values
 * @returns {number}
 */
function _populationStdDev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Compute empirical sigma (spread and total) from settled game history.
 *
 * Queries game_results for the last windowGames settled games for the given sport,
 * then computes population std-dev of score margins (home - away) and totals
 * (home + away). Falls back to getSigmaDefaults() when fewer than 20 games exist
 * or on any DB error.
 *
 * Uses better-sqlite3 synchronous API: db.prepare(...).all(...).
 *
 * @param {object} params
 * @param {string} params.sport - Sport string (e.g. 'NBA')
 * @param {string} [params.marketType] - 'SPREAD' | 'TOTAL' | omit for both
 * @param {object} params.db - better-sqlite3 database instance
 * @param {number} [params.windowGames=60] - Rolling window size
 * @returns {{ margin: number, total: number, sigma_source: 'computed'|'fallback', games_sampled?: number }}
 */
function computeSigmaFromHistory({ sport, marketType, db, windowGames = 60 } = {}) {
  const fallback = { ...getSigmaDefaults(sport), sigma_source: 'fallback' };

  try {
    const rows = db.prepare(`
      SELECT final_score_home, final_score_away
      FROM game_results
      WHERE sport = ?
        AND status = 'final'
        AND final_score_home IS NOT NULL
        AND final_score_away IS NOT NULL
      ORDER BY settled_at DESC
      LIMIT ?
    `).all(sport?.toUpperCase?.() ?? sport, windowGames);

    if (!rows || rows.length < 20) {
      return fallback;
    }

    const margins = rows.map((g) => g.final_score_home - g.final_score_away);
    const totals = rows.map((g) => g.final_score_home + g.final_score_away);

    const computedMarginSigma = Number(_populationStdDev(margins).toFixed(4));
    const computedTotalSigma = Number(_populationStdDev(totals).toFixed(4));

    return {
      margin: computedMarginSigma,
      total: computedTotalSigma,
      sigma_source: 'computed',
      games_sampled: rows.length,
    };
  } catch (_err) {
    return fallback;
  }
}

module.exports = {
  impliedProbFromAmerican,
  noVigImplied,
  normCdf,
  invNormCdf,
  computeMoneylineEdge,
  computeSpreadEdge,
  computeTotalEdge,
  getSigmaDefaults,
  computeSigmaFromHistory,
};
