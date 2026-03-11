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
 * @param {number} params.americanOdds - American odds (e.g., -120, +110)
 * @returns {object} { edge, p_fair, p_implied, confidence }
 */
function computeMoneylineEdge({
  projectionWinProbHome,
  americanOdds,
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
  const p_implied = impliedProbFromAmerican(americanOdds);

  if (p_implied == null) {
    return { edge: null, p_fair, p_implied: null, reason: 'invalid_odds' };
  }

  const edge = p_fair - p_implied;
  return {
    edge: Number(edge.toFixed(4)),
    p_fair: Number(p_fair.toFixed(4)),
    p_implied: Number(p_implied.toFixed(4)),
    confidence: 0.95,
  };
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
  const oddsToUse = isPredictionHome ? spreadPriceHome : spreadPriceAway;
  const p_implied = impliedProbFromAmerican(oddsToUse);

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

  return {
    edge: Number(edge.toFixed(4)),
    edgePoints: Number(edgePoints.toFixed(2)),
    p_fair: Number(p_fair.toFixed(4)),
    p_implied: Number(p_implied.toFixed(4)),
    confidence: 0.85, // spread projections less calibrated than ML
    sigma_used: sigmaMargin,
  };
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
  const oddsToUse = isPredictionOver ? totalPriceOver : totalPriceUnder;
  const p_implied = impliedProbFromAmerican(oddsToUse);

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

  return {
    edge: Number(edge.toFixed(4)),
    edgePoints: Number(edgePoints.toFixed(2)),
    p_fair: Number(p_fair.toFixed(4)),
    p_implied: Number(p_implied.toFixed(4)),
    confidence: 0.88,
    sigma_used: sigmaTotal,
    rail_flags: railFlags,
  };
}

/**
 * Detect sigma by sport (can be tuned later)
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

module.exports = {
  impliedProbFromAmerican,
  normCdf,
  computeMoneylineEdge,
  computeSpreadEdge,
  computeTotalEdge,
  getSigmaDefaults,
};
