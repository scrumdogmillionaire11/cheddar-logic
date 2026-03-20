function factorial(value) {
  if (value < 0 || !Number.isInteger(value)) return null;
  if (value === 0 || value === 1) return 1;
  let result = 1;
  for (let index = 2; index <= value; index += 1) {
    result *= index;
  }
  return result;
}

function poissonPmf(k, lambda) {
  if (!Number.isInteger(k) || k < 0) return 0;
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0) return 0;
  const denom = factorial(k);
  if (!denom) return 0;
  const probability = (Math.exp(-lambda) * Math.pow(lambda, k)) / denom;
  return Number.isFinite(probability) ? probability : 0;
}

function buildGoalDiffDistribution({ lambda_home, lambda_away, max_goals = 10 }) {
  if (
    typeof lambda_home !== 'number' ||
    !Number.isFinite(lambda_home) ||
    lambda_home < 0 ||
    typeof lambda_away !== 'number' ||
    !Number.isFinite(lambda_away) ||
    lambda_away < 0
  ) {
    return {
      success: false,
      reason_code: 'INVALID_LAMBDAS',
    };
  }

  if (!Number.isInteger(max_goals) || max_goals < 1 || max_goals > 20) {
    return {
      success: false,
      reason_code: 'INVALID_MAX_GOALS',
    };
  }

  const distribution = new Map();
  let totalMass = 0;

  for (let homeGoals = 0; homeGoals <= max_goals; homeGoals += 1) {
    const pHome = poissonPmf(homeGoals, lambda_home);
    for (let awayGoals = 0; awayGoals <= max_goals; awayGoals += 1) {
      const pAway = poissonPmf(awayGoals, lambda_away);
      const probability = pHome * pAway;
      const diff = homeGoals - awayGoals;
      distribution.set(diff, (distribution.get(diff) || 0) + probability);
      totalMass += probability;
    }
  }

  if (totalMass <= 0) {
    return {
      success: false,
      reason_code: 'EMPTY_DISTRIBUTION',
    };
  }

  const normalized = {};
  for (const [diff, probability] of distribution.entries()) {
    normalized[diff] = probability / totalMass;
  }

  return {
    success: true,
    goal_diff_distribution: normalized,
    normalization_mass: totalMass,
    truncated_mass: Math.max(0, 1 - totalMass),
  };
}

module.exports = {
  poissonPmf,
  buildGoalDiffDistribution,
};
