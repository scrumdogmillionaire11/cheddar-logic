const { buildGoalDiffDistribution } = require('./goal-distribution');
const { gradeAsianHandicap, normalizeHandicap } = require('./asian-handicap-grader');

function americanToDecimal(americanOdds) {
  if (typeof americanOdds !== 'number' || !Number.isFinite(americanOdds) || americanOdds === 0) {
    return null;
  }
  if (americanOdds > 0) return 1 + americanOdds / 100;
  return 1 + 100 / Math.abs(americanOdds);
}

function impliedProbabilityFromAmerican(americanOdds) {
  const decimal = americanToDecimal(americanOdds);
  if (!decimal) return null;
  return 1 / decimal;
}

function removeVigTwoWay(priceA, priceB) {
  const pA = impliedProbabilityFromAmerican(priceA);
  const pB = impliedProbabilityFromAmerican(priceB);

  if (
    typeof pA !== 'number' ||
    !Number.isFinite(pA) ||
    pA <= 0 ||
    typeof pB !== 'number' ||
    !Number.isFinite(pB) ||
    pB <= 0
  ) {
    return {
      success: false,
      reason_code: 'INVALID_MARKET_PRICES',
    };
  }

  const sum = pA + pB;
  return {
    success: true,
    implied_prob_a: pA,
    implied_prob_b: pB,
    normalized_prob_a: pA / sum,
    normalized_prob_b: pB / sum,
    overround: sum,
  };
}

function sideAdjustedDiff(rawGoalDiff, side) {
  return side === 'AWAY' ? -rawGoalDiff : rawGoalDiff;
}

function buildSettlementFromDistribution({ distribution, side, handicap }) {
  const settlements = {
    P_win: 0,
    P_push: 0,
    P_loss: 0,
    P_full_win: 0,
    P_half_win: 0,
    P_half_loss: 0,
    P_full_loss: 0,
  };

  for (const [diffKey, probability] of Object.entries(distribution)) {
    const homeGoalDiff = Number(diffKey);
    const perspectiveDiff = sideAdjustedDiff(homeGoalDiff, side);
    const teamGoals = perspectiveDiff >= 0 ? perspectiveDiff : 0;
    const opponentGoals = perspectiveDiff >= 0 ? 0 : Math.abs(perspectiveDiff);

    const graded = gradeAsianHandicap({
      team_goals: teamGoals,
      opponent_goals: opponentGoals,
      handicap,
    });

    if (!graded.success) {
      return {
        success: false,
        reason_code: graded.reason_code || 'GRADING_FAILED',
      };
    }

    if (graded.outcome === 'win') settlements.P_win += probability;
    if (graded.outcome === 'push') settlements.P_push += probability;
    if (graded.outcome === 'loss') settlements.P_loss += probability;

    if (graded.outcome === 'full_win') settlements.P_full_win += probability;
    if (graded.outcome === 'half_win') settlements.P_half_win += probability;
    if (graded.outcome === 'half_loss') settlements.P_half_loss += probability;
    if (graded.outcome === 'full_loss') settlements.P_full_loss += probability;
  }

  if (
    settlements.P_full_win > 0 ||
    settlements.P_half_win > 0 ||
    settlements.P_half_loss > 0 ||
    settlements.P_full_loss > 0
  ) {
    settlements.P_win = settlements.P_full_win + (settlements.P_half_win * 0.5);
    settlements.P_push = (settlements.P_half_win * 0.5) + (settlements.P_half_loss * 0.5);
    settlements.P_loss = settlements.P_full_loss + (settlements.P_half_loss * 0.5);
  }

  const total = settlements.P_win + settlements.P_push + settlements.P_loss;
  if (total > 0) {
    settlements.P_win /= total;
    settlements.P_push /= total;
    settlements.P_loss /= total;

    settlements.P_full_win /= total;
    settlements.P_half_win /= total;
    settlements.P_half_loss /= total;
    settlements.P_full_loss /= total;
  }

  return {
    success: true,
    ...settlements,
  };
}

function toAmericanFromProbability(probability) {
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }
  if (probability >= 0.5) {
    return Math.round(-(probability / (1 - probability)) * 100);
  }
  return Math.round(((1 - probability) / probability) * 100);
}

function calculateExpectedValue({ lineType, probabilities, offeredPrice }) {
  const decimalOdds = americanToDecimal(offeredPrice);
  if (!decimalOdds) return null;

  const unitProfit = decimalOdds - 1;
  if (lineType === 'QUARTER') {
    return (
      (probabilities.P_full_win * unitProfit) +
      (probabilities.P_half_win * (unitProfit / 2)) +
      (probabilities.P_half_loss * -0.5) +
      (probabilities.P_full_loss * -1)
    );
  }

  return (probabilities.P_win * unitProfit) - probabilities.P_loss;
}

function priceAsianHandicap({
  lambda_home,
  lambda_away,
  line,
  side,
  offered_price,
  opposite_price,
  max_goals = 10,
}) {
  const normalizedLine = normalizeHandicap(line);
  if (!normalizedLine.success) {
    return normalizedLine;
  }

  const normalizedSide = String(side || '').toUpperCase();
  if (normalizedSide !== 'HOME' && normalizedSide !== 'AWAY') {
    return {
      success: false,
      reason_code: 'INVALID_SIDE',
    };
  }

  const goalDiffResult = buildGoalDiffDistribution({ lambda_home, lambda_away, max_goals });
  if (!goalDiffResult.success) {
    return goalDiffResult;
  }

  const settlement = buildSettlementFromDistribution({
    distribution: goalDiffResult.goal_diff_distribution,
    side: normalizedSide,
    handicap: normalizedLine.handicap,
  });

  if (!settlement.success) {
    return settlement;
  }

  const vigResult = removeVigTwoWay(offered_price, opposite_price);
  const modelNoPushProb =
    settlement.P_win + settlement.P_loss > 0
      ? settlement.P_win / (settlement.P_win + settlement.P_loss)
      : null;

  const expectedValue = calculateExpectedValue({
    lineType: normalizedLine.line_type,
    probabilities: settlement,
    offeredPrice: offered_price,
  });

  return {
    success: true,
    line: normalizedLine.handicap,
    line_type: normalizedLine.line_type,
    side: normalizedSide,
    fair_line: normalizedLine.handicap,
    implied: vigResult.success
      ? {
          normalized_selected: vigResult.normalized_prob_a,
          normalized_opposite: vigResult.normalized_prob_b,
          overround: vigResult.overround,
        }
      : null,
    probabilities: {
      P_win: settlement.P_win,
      P_push: settlement.P_push,
      P_loss: settlement.P_loss,
      P_full_win: settlement.P_full_win,
      P_half_win: settlement.P_half_win,
      P_half_loss: settlement.P_half_loss,
      P_full_loss: settlement.P_full_loss,
    },
    model_prob_no_push: modelNoPushProb,
    fair_price_american: modelNoPushProb !== null ? toAmericanFromProbability(modelNoPushProb) : null,
    edge_no_push:
      modelNoPushProb !== null && vigResult.success
        ? modelNoPushProb - vigResult.normalized_prob_a
        : null,
    expected_value: Number.isFinite(expectedValue) ? Number(expectedValue.toFixed(6)) : null,
    distribution: {
      normalization_mass: goalDiffResult.normalization_mass,
      truncated_mass: goalDiffResult.truncated_mass,
    },
  };
}

module.exports = {
  americanToDecimal,
  impliedProbabilityFromAmerican,
  removeVigTwoWay,
  priceAsianHandicap,
};
