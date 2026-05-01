'use strict';

const DEFAULT_THRESHOLDS = {
  over:  { play: 1.0, slightEdge: 0.5 },
  under: { play: 1.0, slightEdge: 0.5 },
};

const RAW_DELTA_EPSILON       = 0.15;
const RAW_DELTA_WEAK_EDGE_MAX = 0.35;
const MIN_DIRECTIONAL_EDGE    = 0.50;
const STRONG_DRIVER_THRESHOLD = 0.65;
const DIVERGENCE_PENALTY_ABS  = 0.15;

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
    driverDirection = null,
    driverScore = null,
  } = input || {};

  // Stage A: use provided forecast or compute inline for backward compat.
  const forecastEnvelope =
    forecast ?? computeNhl1pForecast({ modelTotal, marketTotal, hasRequiredInputs });
  const { delta, absDelta: rawAbsDelta } = forecastEnvelope;
  const forecastInvalid = forecast
    ? !forecast.forecastValid
    : !hasRequiredInputs || !Number.isFinite(delta) || !Number.isFinite(rawAbsDelta);
  const reasonCodes = [];
  const flags = [];

  if (forecastInvalid) {
    return {
      status: 'PASS',
      delta,
      absDelta: rawAbsDelta,
      reasonCodes: ['PASS_MISSING_REQUIRED_INPUTS'],
      flags,
    };
  }

  if (!integrityOk) {
    return {
      status: 'PASS',
      delta,
      absDelta: rawAbsDelta,
      reasonCodes: ['PASS_INTEGRITY_BLOCK'],
      flags,
    };
  }

  let absDelta = rawAbsDelta;

  if (process.env.NHL_TOTALS_RAW_DELTA_AUTHORITY === 'true') {
    // Derive direction from raw delta; 'NONE' when within epsilon neutral zone.
    const rawSide = delta > RAW_DELTA_EPSILON ? 'OVER' : delta < -RAW_DELTA_EPSILON ? 'UNDER' : 'NONE';

    // Rule 1: delta within epsilon neutral zone — no directional edge.
    if (rawAbsDelta < RAW_DELTA_EPSILON) {
      return {
        status: 'PASS',
        delta,
        absDelta: rawAbsDelta,
        reasonCodes: ['PASS_NO_DIRECTIONAL_EDGE'],
        flags,
      };
    }

    // Rule 2: strong cross-market driver contradicts raw direction on a weak edge.
    if (
      driverDirection != null &&
      driverDirection !== rawSide &&
      Number(driverScore) >= STRONG_DRIVER_THRESHOLD &&
      rawAbsDelta <= RAW_DELTA_WEAK_EDGE_MAX
    ) {
      return {
        status: 'PASS',
        delta,
        absDelta: rawAbsDelta,
        reasonCodes: ['PASS_SIGNAL_DIVERGENCE'],
        flags,
      };
    }

    // Rule 3: driver contradicts raw direction and edge is below min threshold.
    if (
      driverDirection != null &&
      driverDirection !== rawSide &&
      rawAbsDelta < MIN_DIRECTIONAL_EDGE
    ) {
      return {
        status: 'PASS',
        delta,
        absDelta: rawAbsDelta,
        reasonCodes: ['PASS_LOW_CONSENSUS'],
        flags,
      };
    }

    // Rule 4: driver contradicts raw direction but edge clears min threshold — penalize and continue.
    if (driverDirection != null && driverDirection !== rawSide) {
      absDelta = rawAbsDelta - DIVERGENCE_PENALTY_ABS;
      flags.push('SIGNAL_DIVERGENCE');
    }
  } else {
    // Legacy: direction determined by the side input parameter.
    if ((side === 'OVER' && delta <= 0) || (side === 'UNDER' && delta >= 0)) {
      return {
        status: 'PASS',
        delta,
        absDelta: rawAbsDelta,
        reasonCodes: ['PASS_DIRECTION_MISMATCH'],
        flags,
      };
    }
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
    flags,
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
  RAW_DELTA_EPSILON,
  RAW_DELTA_WEAK_EDGE_MAX,
  MIN_DIRECTIONAL_EDGE,
  STRONG_DRIVER_THRESHOLD,
  DIVERGENCE_PENALTY_ABS,
};
