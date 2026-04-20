'use strict';

const DEFAULT_THRESHOLDS = {
  over:  { play: 1.0, slightEdge: 0.5 },
  under: { play: 1.0, slightEdge: 0.5 },
};

/**
 * Stage A: pure forecast envelope from model and market totals.
 * Returns { modelTotal, marketTotal, delta, absDelta, forecastValid }.
 */
function computeNhl1pForecast({ modelTotal, marketTotal, hasRequiredInputs = true } = {}) {
  const safeModelTotal = Number(modelTotal);
  const safeMarketTotal = Number(marketTotal);
  const delta =
    Number.isFinite(safeModelTotal) && Number.isFinite(safeMarketTotal)
      ? safeModelTotal - safeMarketTotal
      : NaN;
  const absDelta = Number.isFinite(delta) ? Math.abs(delta) : NaN;
  return {
    modelTotal: safeModelTotal,
    marketTotal: safeMarketTotal,
    delta,
    absDelta,
    forecastValid: Boolean(hasRequiredInputs) && Number.isFinite(delta),
  };
}

/**
 * Canonical NHL totals surfaced status classifier.
 * Final statuses: PLAY / SLIGHT EDGE / PASS.
 *
 * Accepts optional `forecast` (Stage A output) to skip internal recomputation,
 * and optional `thresholds` for per-side calibration.
 */
function classifyNhlTotalsStatus(input) {
  const {
    side,
    modelTotal,
    marketTotal,
    integrityOk,
    goaliesConfirmedHome,
    goaliesConfirmedAway,
    majorInjuryUncertainty,
    accelerantScore = null,
    hasRequiredInputs = true,
    forecast = null,
    thresholds = null,
  } = input || {};

  // Stage A: use provided forecast or compute inline for backward compat.
  const forecastEnvelope =
    forecast ?? computeNhl1pForecast({ modelTotal, marketTotal, hasRequiredInputs });
  const { delta, absDelta } = forecastEnvelope;
  const forecastInvalid = forecast
    ? !forecast.forecastValid
    : !hasRequiredInputs || !Number.isFinite(delta) || !Number.isFinite(absDelta);
  const reasonCodes = [];

  if (forecastInvalid) {
    return {
      status: 'PASS',
      delta,
      absDelta,
      reasonCodes: ['PASS_MISSING_REQUIRED_INPUTS'],
    };
  }

  if (!integrityOk) {
    return {
      status: 'PASS',
      delta,
      absDelta,
      reasonCodes: ['PASS_INTEGRITY_BLOCK'],
    };
  }

  if ((side === 'OVER' && delta <= 0) || (side === 'UNDER' && delta >= 0)) {
    return {
      status: 'PASS',
      delta,
      absDelta,
      reasonCodes: ['PASS_DIRECTION_MISMATCH'],
    };
  }

  // Stage B: side policy with per-side calibration thresholds.
  const sideKey = (side || '').toLowerCase();
  const sideThresholds =
    thresholds?.[sideKey] ?? DEFAULT_THRESHOLDS[sideKey] ?? DEFAULT_THRESHOLDS.over;
  const playThreshold = sideThresholds.play;
  const slightEdgeThreshold = sideThresholds.slightEdge;

  let status;
  if (absDelta >= playThreshold) {
    status = 'PLAY';
    reasonCodes.push('BASE_PLAY_DELTA_GTE_1_0');
  } else if (absDelta >= slightEdgeThreshold) {
    status = 'SLIGHT EDGE';
    reasonCodes.push('BASE_SLIGHT_EDGE_DELTA_GTE_0_5');
  } else {
    status = 'PASS';
    reasonCodes.push('BASE_PASS_DELTA_LT_0_5');
  }

  const bothGoaliesConfirmed = Boolean(goaliesConfirmedHome) && Boolean(goaliesConfirmedAway);
  if (!bothGoaliesConfirmed) {
    reasonCodes.push('CAP_GOALIES_UNCONFIRMED');
    if (status === 'PLAY') {
      status = 'SLIGHT EDGE';
      reasonCodes.push('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY');
    }
  }

  if (majorInjuryUncertainty) {
    reasonCodes.push('CAP_MAJOR_INJURY_UNCERTAINTY');
    if (status === 'PLAY') {
      status = 'SLIGHT EDGE';
      reasonCodes.push('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_INJURY_UNCERTAINTY');
    } else if (status === 'SLIGHT EDGE' && absDelta < 0.7) {
      status = 'PASS';
      reasonCodes.push('DOWNGRADE_SLIGHT_EDGE_TO_PASS_INJURY_UNCERTAINTY_THIN_EDGE');
    }
  }

  if (side === 'UNDER' && marketTotal === 5.5) {
    reasonCodes.push('FRAGILITY_UNDER_5_5');
    if (status === 'PLAY') {
      status = 'SLIGHT EDGE';
      reasonCodes.push('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5');
    } else if (status === 'SLIGHT EDGE') {
      status = 'PASS';
      reasonCodes.push('DOWNGRADE_SLIGHT_EDGE_TO_PASS_UNDER_5_5');
    }
  }

  if (side === 'OVER' && marketTotal >= 6.5) {
    const accel = Number.isFinite(Number(accelerantScore)) ? Number(accelerantScore) : 0;
    if (accel < 0.2) {
      reasonCodes.push('FRAGILITY_OVER_6_5_ACCELERANT_BELOW_0_20');
      if (status === 'PLAY') {
        status = 'SLIGHT EDGE';
        reasonCodes.push('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_OVER_6_5');
      } else if (status === 'SLIGHT EDGE') {
        status = 'PASS';
        reasonCodes.push('DOWNGRADE_SLIGHT_EDGE_TO_PASS_OVER_6_5');
      }
    } else {
      reasonCodes.push('OVER_6_5_ACCELERANT_OK');
    }
  }

  if (absDelta < slightEdgeThreshold && status !== 'PASS') {
    status = 'PASS';
    reasonCodes.push('FLOOR_GUARD_FORCE_PASS_DELTA_LT_0_5');
  }

  const explicitlyCapped =
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY') ||
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_INJURY_UNCERTAINTY') ||
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5') ||
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_OVER_6_5');

  if (absDelta >= playThreshold && status === 'SLIGHT EDGE' && !explicitlyCapped) {
    status = 'PLAY';
    reasonCodes.push('ANTI_FLATTENING_RESTORE_PLAY');
  }

  return {
    status,
    delta,
    absDelta,
    reasonCodes,
  };
}

const BUCKET_THRESHOLDS = {
  // market_1p_total [1.0, 1.5)  — historically weakest OVER bucket
  '1.0-1.4': { over: { play: 1.5, slightEdge: 0.8 }, under: { play: 1.0, slightEdge: 0.5 } },
  // market_1p_total [1.5, 2.0)  — moderately weak OVER bucket
  '1.5-1.9': { over: { play: 1.2, slightEdge: 0.6 }, under: { play: 1.0, slightEdge: 0.5 } },
  // market_1p_total [2.0, 2.2)  — near-average; default thresholds
  '2.0-2.19': { over: { play: 1.0, slightEdge: 0.5 }, under: { play: 1.0, slightEdge: 0.5 } },
  // market_1p_total >= 2.2      — high-scoring; default thresholds
  '2.20+':    { over: { play: 1.0, slightEdge: 0.5 }, under: { play: 1.0, slightEdge: 0.5 } },
};

/**
 * Returns per-side threshold config for the given market 1P total bucket.
 * Returns null if marketTotal is not finite (caller omits thresholds → defaults apply).
 */
function get1pBucketThresholds(marketTotal) {
  if (marketTotal == null || !Number.isFinite(Number(marketTotal))) return null;
  const t = Number(marketTotal);
  if (t < 1.5)  return BUCKET_THRESHOLDS['1.0-1.4'];
  if (t < 2.0)  return BUCKET_THRESHOLDS['1.5-1.9'];
  if (t < 2.2)  return BUCKET_THRESHOLDS['2.0-2.19'];
  return BUCKET_THRESHOLDS['2.20+'];
}

module.exports = {
  classifyNhlTotalsStatus,
  computeNhl1pForecast,
  get1pBucketThresholds,
};
