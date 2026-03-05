function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function variance(values) {
  const avg = mean(values);
  if (avg == null) return null;
  const total = values.reduce((sum, value) => sum + (value - avg) ** 2, 0);
  return total / values.length;
}

function coefficientOfVariation(values) {
  const avg = mean(values);
  if (avg == null || avg === 0) return null;
  const varValue = variance(values);
  if (varValue == null) return null;
  return Math.sqrt(varValue) / Math.abs(avg);
}

function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function scoreSampleIntegrity(gamesObserved, sampleMax = 5) {
  if (!Number.isFinite(gamesObserved) || gamesObserved <= 0) return 0;
  return clamp(gamesObserved / sampleMax, 0, 1);
}

function scoreVariancePreference(cv, config) {
  if (!Number.isFinite(cv)) return 0.5;
  if (cv <= config.varianceCvLow) return 0.5;
  if (cv <= config.varianceCvSweetHigh) return 1.0;
  if (cv <= config.varianceCvHigh) return 0.6;
  return 0.3;
}

function scoreRole(role, roleWeights) {
  if (!role) return roleWeights.top6;
  const key = String(role);
  return roleWeights[key] ?? roleWeights.top6;
}

function scoreConservatism(buffer, config) {
  if (!Number.isFinite(buffer)) return 0.5;
  if (buffer >= config.bufferHigh) return 1.0;
  if (buffer < config.bufferLow) return 0.25;
  return 0.6;
}

function computeQuality({ l5Shots, gamesObserved, role, buffer, config }) {
  const sampleScore = scoreSampleIntegrity(
    gamesObserved,
    config.sampleGamesMax,
  );
  const cv = coefficientOfVariation(l5Shots);
  const varianceScore = scoreVariancePreference(cv, config);
  const roleScore = scoreRole(role, config.roleWeights);
  const bufferScore = scoreConservatism(buffer, config);

  const quality = (sampleScore + varianceScore + roleScore + bufferScore) / 4;

  return {
    quality: Number(quality.toFixed(3)),
    components: {
      sampleScore: Number(sampleScore.toFixed(3)),
      varianceScore: Number(varianceScore.toFixed(3)),
      roleScore: Number(roleScore.toFixed(3)),
      bufferScore: Number(bufferScore.toFixed(3)),
      cv: cv == null ? null : Number(cv.toFixed(3)),
    },
  };
}

module.exports = {
  computeQuality,
};
