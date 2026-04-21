'use strict';

/**
 * WI-0829: Residual projection layer for NHL and NBA total markets.
 *
 * Computes the model's expected deviation from the market consensus line.
 * Runs in parallel with the existing signal so residual predictive value
 * can be validated before replacing current logic.
 *
 * Uses Abramowitz–Stegun polynomial approximation for erf (no external deps).
 */

/**
 * Compute edge residual between model fair line and market consensus line.
 *
 * A positive residual on OVER means the model thinks the total is higher
 * than the market. The key question is whether this signal has CLV.
 *
 * @param {number|null} modelFairLine   - model's fair-value total/margin
 * @param {number|null} consensusLine   - market consensus line (vig-free midpoint)
 * @param {'OVER'|'UNDER'|'HOME'|'AWAY'} side
 * @param {number} [sigma]              - market uncertainty (used to convert line delta to prob)
 * @returns {{ residual: number, residualProb: number, direction: 'OVER'|'UNDER'|'HOME'|'AWAY'|'NEUTRAL', source: 'MODEL_VS_MARKET' } | null}
 */
function computeResidual(modelFairLine, consensusLine, side, sigma = 1.8) {
  if (modelFairLine === null || consensusLine === null) return null;

  const residual = modelFairLine - consensusLine;

  // Convert line residual to probability using normal CDF
  // P(outcome > consensusLine) when model thinks fair line is modelFairLine
  const z = residual / sigma;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z));
  const cdfValue = 0.5 * (1 + (z >= 0 ? erf : -erf));
  // P(OVER) = P(actual > line) ≈ 1 - CDF(line | model distribution)
  const overProb = 1 - cdfValue;

  const direction = Math.abs(residual) < 0.15
    ? 'NEUTRAL'
    : residual > 0
      ? (side === 'HOME' ? 'HOME' : 'OVER')
      : (side === 'HOME' ? 'AWAY' : 'UNDER');

  return {
    residual: Math.round(residual * 1000) / 1000,
    residualProb: Math.round(overProb * 10000) / 10000,
    direction,
    source: 'MODEL_VS_MARKET',
  };
}

// WI-1024: NBA residual correction layer.
// Learns team/pace/band-specific biases from settled NBA totals history.
// Applies shrinkage and segment cap so it corrects persistent patterns
// without overfitting noise.

const NBA_RESIDUAL_COMBINED_CEILING = 6.0;
const NBA_RESIDUAL_SEGMENT_CAP = 5.0;
const NBA_RESIDUAL_SHRINKAGE_DENOMINATOR = 30;

/**
 * Segment levels for NBA residual correction, in hierarchy order.
 * The first level with sufficient samples wins.
 */
const NBA_RESIDUAL_SEGMENTS = [
  {
    source: 'full',
    minSamples: 15,
    extraFilters: (params) => {
      const filters = [];
      const values = [];
      if (params.paceTier) {
        filters.push('AND pace_tier = ?');
        values.push(params.paceTier);
      }
      if (params.totalBand) {
        filters.push('AND total_band = ?');
        values.push(params.totalBand);
      }
      if (params.month) {
        filters.push("AND strftime('%m', COALESCE(game_date, settled_at)) = ?");
        values.push(params.month);
      }
      return { filters, values };
    },
    segmentDesc: (params) =>
      `team × paceTier(${params.paceTier}) × totalBand(${params.totalBand}) × month(${params.month})`,
  },
  {
    source: 'team_pace_band',
    minSamples: 15,
    extraFilters: (params) => {
      const filters = [];
      const values = [];
      if (params.paceTier) {
        filters.push('AND pace_tier = ?');
        values.push(params.paceTier);
      }
      if (params.totalBand) {
        filters.push('AND total_band = ?');
        values.push(params.totalBand);
      }
      return { filters, values };
    },
    segmentDesc: (params) =>
      `team × paceTier(${params.paceTier}) × totalBand(${params.totalBand})`,
  },
  {
    source: 'team_band',
    minSamples: 15,
    extraFilters: (params) => {
      const filters = [];
      const values = [];
      if (params.totalBand) {
        filters.push('AND total_band = ?');
        values.push(params.totalBand);
      }
      return { filters, values };
    },
    segmentDesc: (params) => `team × totalBand(${params.totalBand})`,
  },
  {
    source: 'team',
    minSamples: 10,
    extraFilters: () => ({ filters: [], values: [] }),
    segmentDesc: () => 'team',
  },
];

/**
 * Build the parameterized SQL query for a given segment level.
 * Returns { sql, params }.
 */
function buildResidualQuery(homeTeam, awayTeam, extraFilters, extraValues) {
  const sql = `
    SELECT AVG(actual_total - raw_total) AS mean_residual, COUNT(*) AS n
    FROM projection_accuracy_line_evals
    WHERE sport = 'nba'
      AND market_family = 'NBA_TOTAL'
      AND actual_total IS NOT NULL
      AND raw_total IS NOT NULL
      AND settled_at < datetime('now')
      AND (home_team = ? OR away_team = ?)
      ${extraFilters.join('\n      ')}
  `;
  return { sql, params: [homeTeam, awayTeam, ...extraValues] };
}

/**
 * computeNbaResidualCorrection
 *
 * Computes a residual correction term for NBA total projections using
 * a 5-level segment hierarchy with mandatory shrinkage and a segment cap.
 *
 * @param {object} opts
 * @param {object} opts.db - better-sqlite3 database instance
 * @param {string} opts.homeTeam
 * @param {string} opts.awayTeam
 * @param {string|null} opts.paceTier
 * @param {string|null} opts.totalBand
 * @param {string|null} opts.month - zero-padded month string, e.g. '04'
 * @param {number|null|undefined} opts.globalBias - WI-1020 rolling bias (points)
 * @param {object} [opts.logger=console]
 * @returns {{ correction: number, source: string, samples: number, segment: string, shrinkage_factor: number }}
 */
async function computeNbaResidualCorrection({
  db,
  homeTeam,
  awayTeam,
  paceTier,
  totalBand,
  month,
  globalBias,
  logger = console,
} = {}) {
  const noBias = globalBias === null || globalBias === undefined || !Number.isFinite(globalBias);
  const effectiveGlobalBias = noBias ? 0 : globalBias;
  const hasGlobal = !noBias;

  const params = { homeTeam, awayTeam, paceTier, totalBand, month };

  // Attempt each segment level in hierarchy order.
  for (const level of NBA_RESIDUAL_SEGMENTS) {
    const { filters, values } = level.extraFilters(params);
    const { sql, params: queryParams } = buildResidualQuery(homeTeam, awayTeam, filters, values);

    let row = null;
    try {
      const stmt = db.prepare(sql);
      row = typeof stmt.get === 'function'
        ? stmt.get(...queryParams)
        : (typeof stmt.all === 'function' ? stmt.all(...queryParams)[0] : null);
    } catch (err) {
      logger.warn?.(`[NBAModel] [RESIDUAL] db query failed: ${err.message}`);
      return { correction: 0, source: 'none', samples: 0, segment: 'none', shrinkage_factor: 0 };
    }

    const n = Number.isFinite(Number(row?.n)) ? Number(row.n) : 0;
    const meanResidual = Number.isFinite(Number(row?.mean_residual)) ? Number(row.mean_residual) : null;

    if (n < level.minSamples || meanResidual === null) continue;

    const shrinkage = Math.min(1, n / NBA_RESIDUAL_SHRINKAGE_DENOMINATOR);
    const rawCorrection = meanResidual * shrinkage + effectiveGlobalBias * (1 - shrinkage);

    let correction = rawCorrection;
    if (Math.abs(rawCorrection) > NBA_RESIDUAL_SEGMENT_CAP) {
      const clamped = Math.max(-NBA_RESIDUAL_SEGMENT_CAP, Math.min(NBA_RESIDUAL_SEGMENT_CAP, rawCorrection));
      logger.log?.(
        `[NBAModel] [RESIDUAL] segment correction clamped from ${rawCorrection.toFixed(2)} to ±${NBA_RESIDUAL_SEGMENT_CAP.toFixed(1)}`,
      );
      correction = clamped;
    }

    const segmentDesc = level.segmentDesc(params);
    logger.log?.(
      `[NBAModel] [RESIDUAL] source=${level.source} samples=${n} shrinkage=${shrinkage.toFixed(2)} correction=${correction >= 0 ? '+' : ''}${correction.toFixed(1)}`,
    );

    return {
      correction,
      source: level.source,
      samples: n,
      segment: segmentDesc,
      shrinkage_factor: shrinkage,
    };
  }

  // Global fallback: no qualifying segment found.
  if (hasGlobal) {
    logger.log?.(`[NBAModel] [RESIDUAL] source=global (fallback) samples=0`);
    return {
      correction: effectiveGlobalBias,
      source: 'global',
      samples: 0,
      segment: 'global',
      shrinkage_factor: 0,
    };
  }

  // No data at all.
  return { correction: 0, source: 'none', samples: 0, segment: 'none', shrinkage_factor: 0 };
}

/**
 * Enforce combined ceiling: |rollingBias + residualCorrection| must not exceed 6.0.
 * Scales only the residual term; preserves rollingBias exactly.
 *
 * @param {number} rollingBias
 * @param {number} residualCorrection
 * @returns {number} bounded residualCorrection
 */
function applyNbaResidualCombinedCeiling(rollingBias, residualCorrection) {
  const combined = rollingBias + residualCorrection;
  if (Math.abs(combined) <= NBA_RESIDUAL_COMBINED_CEILING) return residualCorrection;
  const sign = combined >= 0 ? 1 : -1;
  return NBA_RESIDUAL_COMBINED_CEILING * sign - rollingBias;
}

module.exports = {
  computeResidual,
  computeNbaResidualCorrection,
  applyNbaResidualCombinedCeiling,
};
