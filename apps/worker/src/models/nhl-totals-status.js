'use strict';

/**
 * Canonical NHL totals surfaced status classifier.
 * Final statuses: PLAY / SLIGHT EDGE / PASS.
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
  } = input || {};

  const safeModelTotal = Number(modelTotal);
  const safeMarketTotal = Number(marketTotal);
  const delta =
    Number.isFinite(safeModelTotal) && Number.isFinite(safeMarketTotal)
      ? safeModelTotal - safeMarketTotal
      : NaN;
  const absDelta = Number.isFinite(delta) ? Math.abs(delta) : NaN;
  const reasonCodes = [];

  if (!hasRequiredInputs || !Number.isFinite(delta) || !Number.isFinite(absDelta)) {
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

  let status;
  if (absDelta >= 1.0) {
    status = 'PLAY';
    reasonCodes.push('BASE_PLAY_DELTA_GTE_1_0');
  } else if (absDelta >= 0.5) {
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

  if (absDelta < 0.5 && status !== 'PASS') {
    status = 'PASS';
    reasonCodes.push('FLOOR_GUARD_FORCE_PASS_DELTA_LT_0_5');
  }

  const explicitlyCapped =
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY') ||
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_INJURY_UNCERTAINTY') ||
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5') ||
    reasonCodes.includes('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_OVER_6_5');

  if (absDelta >= 1.0 && status === 'SLIGHT EDGE' && !explicitlyCapped) {
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

module.exports = {
  classifyNhlTotalsStatus,
};
