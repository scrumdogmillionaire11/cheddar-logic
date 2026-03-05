const { DEFAULT_CONFIG } = require('./config');
const { computeMu, computeMuFirstPeriod, weightedMean } = require('./mu');
const { isTrending } = require('./trending');
const { computeQuality } = require('./quality');

function normalizeRole(role) {
  if (!role) return 'top6';
  const normalized = String(role).trim();
  return normalized;
}

function normalizeLine(line, mu) {
  if (Number.isFinite(line)) return line;
  if (!Number.isFinite(mu)) return null;
  return Number((mu - 0.5).toFixed(1));
}

function classify({ quality, isTrendingValue, mu, config }) {
  if (quality <= config.classification.hotMaxQuality) return 'HOT';
  if (
    quality <= config.classification.watchMaxQuality ||
    (isTrendingValue && mu >= config.classification.watchMinMu)
  ) {
    return 'WATCH';
  }
  return 'COLD';
}

function computeSogProjection(inputs, overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    trending: { ...DEFAULT_CONFIG.trending, ...(overrides.trending || {}) },
    quality: { ...DEFAULT_CONFIG.quality, ...(overrides.quality || {}) },
    classification: {
      ...DEFAULT_CONFIG.classification,
      ...(overrides.classification || {}),
    },
  };

  const l5Shots = Array.isArray(inputs.l5Shots)
    ? inputs.l5Shots.map((value) => Number(value))
    : [];
  const gamesObserved = Number.isFinite(inputs.gamesObserved)
    ? inputs.gamesObserved
    : l5Shots.length;
  const role = normalizeRole(inputs.role);

  const mu = computeMu({
    l5Shots,
    shotsPer60: inputs.shotsPer60,
    projectedToiMinutes: inputs.projectedToiMinutes,
    opponentFactor: inputs.opponentFactor ?? 1,
    paceFactor: inputs.paceFactor ?? 1,
    isHome: Boolean(inputs.isHome),
    highVolumeThreshold: config.highVolumeThreshold,
    highVolumeRegression: config.highVolumeRegression,
    homeIceBoost: config.homeIceSogBoost,
    l5Weight: config.l5Weight,
    priorWeight: config.priorWeight,
    redistributionBoost: inputs.redistributionBoost ?? 0,
  });

  const muFirstPeriod = computeMuFirstPeriod({
    muFullGame: mu,
    isHome: Boolean(inputs.isHome),
    periodShare: config.periodShare1P,
    homeIceBoost: config.homeIce1PBoost,
  });

  const suggestedLine = normalizeLine(inputs.marketLine, mu);
  const threshold = Number.isFinite(suggestedLine)
    ? Math.floor(suggestedLine) + 1
    : null;

  const trendingValue = isTrending({
    l5Shots,
    suggestedLine,
    minHits: config.trending.minHits,
    meanBuffer: config.trending.meanBuffer,
  });

  const l5Mean = weightedMean(l5Shots);
  const buffer =
    Number.isFinite(l5Mean) && Number.isFinite(suggestedLine)
      ? l5Mean - suggestedLine
      : null;

  const quality = computeQuality({
    l5Shots,
    gamesObserved,
    role,
    buffer,
    config: config.quality,
  });

  const classification = classify({
    quality: quality.quality,
    isTrendingValue: trendingValue,
    mu: mu ?? 0,
    config,
  });

  const reasonCodes = [];
  if (trendingValue) reasonCodes.push('TRENDING');
  if (quality.quality <= config.classification.hotMaxQuality)
    reasonCodes.push('LOW_QUALITY');
  if (mu != null && mu >= config.classification.watchMinMu)
    reasonCodes.push('HIGH_VOLUME');

  return {
    mu,
    mu_first_period: muFirstPeriod,
    suggested_line: suggestedLine,
    threshold,
    classification,
    is_trending: trendingValue,
    data_quality: quality.quality,
    l5_sog: l5Shots,
    role,
    reason_codes: reasonCodes,
    diagnostics: {
      quality_components: quality.components,
      l5_mean: l5Mean == null ? null : Number(l5Mean.toFixed(3)),
    },
  };
}

module.exports = {
  computeSogProjection,
};
