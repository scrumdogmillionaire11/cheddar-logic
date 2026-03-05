function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function isTrending({ l5Shots, suggestedLine, minHits = 4, meanBuffer = 1.0 }) {
  if (!Array.isArray(l5Shots) || l5Shots.length === 0) return false;
  if (!Number.isFinite(suggestedLine)) return false;

  const threshold = Math.floor(suggestedLine) + 1;
  const hits = l5Shots.filter((value) => value >= threshold).length;
  const minValue = Math.min(...l5Shots);
  const avg = mean(l5Shots);

  if (avg == null) return false;

  return (
    hits >= minHits &&
    minValue >= threshold - 1 &&
    avg - suggestedLine >= meanBuffer
  );
}

module.exports = {
  isTrending,
  mean,
};
