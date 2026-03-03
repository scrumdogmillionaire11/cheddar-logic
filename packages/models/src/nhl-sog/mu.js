function weightedMean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const weights = values.map((_, idx) => idx + 1);
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0) return null;
  const total = values.reduce((sum, value, idx) => sum + value * weights[idx], 0);
  return total / weightSum;
}

function clampNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function computePriorShotsPerGame(shotsPer60, projectedToiMinutes) {
  if (!Number.isFinite(shotsPer60) || !Number.isFinite(projectedToiMinutes)) return null;
  return (shotsPer60 * projectedToiMinutes) / 60;
}

function computeMu({
  l5Shots,
  shotsPer60,
  projectedToiMinutes,
  opponentFactor = 1,
  paceFactor = 1,
  isHome = false,
  highVolumeThreshold = 4.5,
  highVolumeRegression = 0.9,
  homeIceBoost = 1.05,
  l5Weight = 0.65,
  priorWeight = 0.35,
  redistributionBoost = 0
}) {
  const l5 = weightedMean(l5Shots);
  const prior = computePriorShotsPerGame(shotsPer60, projectedToiMinutes);
  if (l5 == null && prior == null) return null;

  const l5Value = l5 == null ? 0 : l5;
  const priorValue = prior == null ? 0 : prior;
  const l5WeightAdj = l5 == null ? 0 : l5Weight;
  const priorWeightAdj = prior == null ? 0 : priorWeight;
  const weightSum = l5WeightAdj + priorWeightAdj || 1;

  const muBase = (l5Value * l5WeightAdj + priorValue * priorWeightAdj) / weightSum;
  let mu = muBase * clampNumber(opponentFactor, 1) * clampNumber(paceFactor, 1);

  if (isHome) mu *= homeIceBoost;

  if (mu > highVolumeThreshold) {
    mu *= highVolumeRegression;
  }

  if (Number.isFinite(redistributionBoost) && redistributionBoost > 0) {
    mu += redistributionBoost;
  }

  return Number(mu.toFixed(3));
}

function computeMuFirstPeriod({
  muFullGame,
  isHome = false,
  periodShare = 0.32,
  homeIceBoost = 1.03
}) {
  if (!Number.isFinite(muFullGame)) return null;
  let mu = muFullGame * periodShare;
  if (isHome) mu *= homeIceBoost;
  return Number(mu.toFixed(3));
}

module.exports = {
  computeMu,
  computeMuFirstPeriod,
  computePriorShotsPerGame,
  weightedMean
};
