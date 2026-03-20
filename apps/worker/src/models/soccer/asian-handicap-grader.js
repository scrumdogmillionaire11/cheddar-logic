const EPSILON = 1e-9;

function isNearlyInteger(value) {
  return Math.abs(value - Math.round(value)) < EPSILON;
}

function normalizeHandicap(handicap) {
  if (typeof handicap !== 'number' || !Number.isFinite(handicap)) {
    return { success: false, reason_code: 'INVALID_HANDICAP_VALUE' };
  }

  const scaled = handicap * 4;
  if (!isNearlyInteger(scaled)) {
    return { success: false, reason_code: 'INVALID_HANDICAP_LINE' };
  }

  const roundedScaled = Math.round(scaled);
  const normalized = roundedScaled / 4;
  const absRemainder = Math.abs(normalized % 1);

  if (Math.abs(normalized) < EPSILON) {
    return { success: true, handicap: 0, line_type: 'ZERO' };
  }

  if (Math.abs(absRemainder - 0.25) < EPSILON || Math.abs(absRemainder - 0.75) < EPSILON) {
    return { success: true, handicap: normalized, line_type: 'QUARTER' };
  }

  if (Math.abs(absRemainder - 0.5) < EPSILON) {
    return { success: true, handicap: normalized, line_type: 'HALF' };
  }

  if (isNearlyInteger(normalized)) {
    return { success: true, handicap: normalized, line_type: 'WHOLE' };
  }

  return { success: false, reason_code: 'INVALID_HANDICAP_LINE' };
}

function gradeSingleLine(goalDiff, handicap) {
  const adjustedDiff = goalDiff + handicap;
  if (adjustedDiff > EPSILON) return { adjustedDiff, outcome: 'win' };
  if (adjustedDiff < -EPSILON) return { adjustedDiff, outcome: 'loss' };
  return { adjustedDiff, outcome: 'push' };
}

function deriveQuarterSplitLines(handicap) {
  const absLine = Math.abs(handicap);
  const sign = handicap >= 0 ? 1 : -1;
  const floorLine = Math.floor(absLine);
  const fraction = Number((absLine - floorLine).toFixed(2));

  if (Math.abs(fraction - 0.25) < EPSILON) {
    return [sign * floorLine, sign * (floorLine + 0.5)];
  }

  if (Math.abs(fraction - 0.75) < EPSILON) {
    return [sign * (floorLine + 0.5), sign * (floorLine + 1)];
  }

  return null;
}

function combineQuarterOutcomes(firstOutcome, secondOutcome) {
  const sorted = [firstOutcome, secondOutcome].sort();
  const key = sorted.join('|');

  if (key === 'win|win') return 'full_win';
  if (key === 'push|win') return 'half_win';
  if (key === 'loss|push') return 'half_loss';
  if (key === 'loss|loss') return 'full_loss';

  return null;
}

function gradeAsianHandicap({ team_goals, opponent_goals, handicap }) {
  if (!Number.isInteger(team_goals) || !Number.isInteger(opponent_goals)) {
    return {
      success: false,
      reason_code: 'INVALID_GOAL_INPUT',
    };
  }

  const handicapMeta = normalizeHandicap(handicap);
  if (!handicapMeta.success) {
    return handicapMeta;
  }

  const goalDiff = team_goals - opponent_goals;
  const adjusted_diff = Number((goalDiff + handicapMeta.handicap).toFixed(4));

  if (handicapMeta.line_type === 'QUARTER') {
    const splitLines = deriveQuarterSplitLines(handicapMeta.handicap);
    if (!splitLines) {
      return {
        success: false,
        reason_code: 'INVALID_HANDICAP_LINE',
      };
    }

    const firstLeg = gradeSingleLine(goalDiff, splitLines[0]);
    const secondLeg = gradeSingleLine(goalDiff, splitLines[1]);
    const outcome = combineQuarterOutcomes(firstLeg.outcome, secondLeg.outcome);

    if (!outcome) {
      return {
        success: false,
        reason_code: 'INVALID_QUARTER_COMBINATION',
      };
    }

    return {
      success: true,
      line_type: handicapMeta.line_type,
      handicap: handicapMeta.handicap,
      adjusted_diff,
      outcome,
      split_handicaps: splitLines,
      split_results: [
        { handicap: splitLines[0], adjusted_diff: Number(firstLeg.adjustedDiff.toFixed(4)), outcome: firstLeg.outcome },
        { handicap: splitLines[1], adjusted_diff: Number(secondLeg.adjustedDiff.toFixed(4)), outcome: secondLeg.outcome },
      ],
    };
  }

  const single = gradeSingleLine(goalDiff, handicapMeta.handicap);
  const outcome =
    handicapMeta.line_type === 'HALF'
      ? (single.outcome === 'win' ? 'win' : 'loss')
      : single.outcome;

  return {
    success: true,
    line_type: handicapMeta.line_type,
    handicap: handicapMeta.handicap,
    adjusted_diff,
    outcome,
  };
}

module.exports = {
  gradeAsianHandicap,
  normalizeHandicap,
};
