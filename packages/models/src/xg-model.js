'use strict';

const LEAGUE_HOME_ADJUSTMENTS = {
  EPL: 0.12,
  MLS: 0.09,
  UCL: 0.1,
};

const LEAGUE_SIGMA = {
  EPL: 1.18,
  MLS: 1.24,
  UCL: 1.15,
};

const DEFAULT_MAX_GOALS = 10;

function normalizeLeague(league) {
  return String(league || '').trim().toUpperCase();
}

function clampLambda(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
}

function factorial(n) {
  if (!Number.isInteger(n) || n < 0) return NaN;
  if (n <= 1) return 1;

  let result = 1;
  for (let index = 2; index <= n; index += 1) {
    result *= index;
  }
  return result;
}

function poissonPmf(k, lambda) {
  const goals = Number(k);
  const mean = clampLambda(lambda);
  if (!Number.isInteger(goals) || goals < 0) return 0;
  if (mean === 0) return goals === 0 ? 1 : 0;

  const denominator = factorial(goals);
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;

  return (Math.exp(-mean) * (mean ** goals)) / denominator;
}

function getLeagueSigma(league) {
  const normalizedLeague = normalizeLeague(league);
  return LEAGUE_SIGMA[normalizedLeague] || 1.2;
}

function applyLeagueHomeAdj(xg, league) {
  const normalizedLeague = normalizeLeague(league);
  const homeAdj = LEAGUE_HOME_ADJUSTMENTS[normalizedLeague] || 0;
  return clampLambda(xg) + homeAdj;
}

function buildPoissonDistribution(lambda, maxGoals = DEFAULT_MAX_GOALS) {
  const safeMax = Number.isInteger(maxGoals) && maxGoals > 0 ? maxGoals : DEFAULT_MAX_GOALS;

  const probabilities = [];
  let running = 0;

  for (let goals = 0; goals < safeMax; goals += 1) {
    const probability = poissonPmf(goals, lambda);
    probabilities.push(probability);
    running += probability;
  }

  probabilities.push(Math.max(0, 1 - running));
  return probabilities;
}

function normalizeProbTriplet({ homeWin, draw, awayWin }) {
  const total = homeWin + draw + awayWin;
  if (!Number.isFinite(total) || total <= 0) {
    return { homeWin: 0, draw: 0, awayWin: 0 };
  }

  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
  };
}

function computeXgWinProbs({ homeXg, awayXg, league, maxGoals = DEFAULT_MAX_GOALS }) {
  const homeLambda = applyLeagueHomeAdj(homeXg, league);
  const awayLambda = clampLambda(awayXg);

  const homeDistribution = buildPoissonDistribution(homeLambda, maxGoals);
  const awayDistribution = buildPoissonDistribution(awayLambda, maxGoals);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let homeGoals = 0; homeGoals < homeDistribution.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < awayDistribution.length; awayGoals += 1) {
      const probability = homeDistribution[homeGoals] * awayDistribution[awayGoals];
      if (homeGoals > awayGoals) {
        homeWin += probability;
      } else if (homeGoals === awayGoals) {
        draw += probability;
      } else {
        awayWin += probability;
      }
    }
  }

  return normalizeProbTriplet({ homeWin, draw, awayWin });
}

function computeXgTotalProb({
  homeXg,
  awayXg,
  totalLine,
  direction,
  league,
  maxGoals = DEFAULT_MAX_GOALS,
}) {
  const line = Number(totalLine);
  if (!Number.isFinite(line)) {
    throw new Error('computeXgTotalProb requires a numeric totalLine');
  }

  const homeLambda = applyLeagueHomeAdj(homeXg, league);
  const awayLambda = clampLambda(awayXg);

  const homeDistribution = buildPoissonDistribution(homeLambda, maxGoals);
  const awayDistribution = buildPoissonDistribution(awayLambda, maxGoals);

  let over = 0;
  let under = 0;

  for (let homeGoals = 0; homeGoals < homeDistribution.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < awayDistribution.length; awayGoals += 1) {
      const totalGoals = homeGoals + awayGoals;
      const probability = homeDistribution[homeGoals] * awayDistribution[awayGoals];
      if (totalGoals > line) {
        over += probability;
      } else if (totalGoals < line) {
        under += probability;
      }
    }
  }

  const safeDirection = String(direction || '').trim().toLowerCase();
  if (safeDirection === 'over') return over;
  if (safeDirection === 'under') return under;

  return { over, under };
}

module.exports = {
  poissonPmf,
  computeXgWinProbs,
  computeXgTotalProb,
  applyLeagueHomeAdj,
  getLeagueSigma,
};
