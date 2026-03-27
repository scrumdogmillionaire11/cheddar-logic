function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function toSortedNumbers(values) {
  return values.filter(isFiniteNumber).sort((a, b) => a - b);
}

function median(values) {
  const sorted = toSortedNumbers(values);
  if (sorted.length === 0) return null;

  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(4));
}

function stddev(values) {
  const numbers = values.filter(isFiniteNumber);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return 0;

  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const variance =
    numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    numbers.length;

  return Number(Math.sqrt(variance).toFixed(4));
}

function classifyLineConfidence(bookCount, dispersion) {
  if (bookCount >= 4 && dispersion !== null && dispersion <= 0.5) {
    return 'high';
  }

  if (bookCount >= 2 || (dispersion !== null && dispersion <= 1.0)) {
    return 'medium';
  }

  return 'low';
}

function classifyPriceConfidence(bookCount, dispersion) {
  if (bookCount >= 4 && dispersion !== null && dispersion <= 20) {
    return 'high';
  }

  if (bookCount >= 2 || (dispersion !== null && dispersion <= 40)) {
    return 'medium';
  }

  return 'low';
}

function buildSpreadConsensus(entries) {
  const usableEntries = Array.isArray(entries)
    ? entries.filter(
        (entry) =>
          isFiniteNumber(entry?.home_line) &&
          isFiniteNumber(entry?.away_line) &&
          (isFiniteNumber(entry?.home_price) || isFiniteNumber(entry?.away_price)),
      )
    : [];

  const lines = usableEntries.map((entry) => entry.home_line);
  const dispersion = stddev(lines);

  return {
    consensus_line: median(lines),
    consensus_price_home: median(
      usableEntries.map((entry) => entry.home_price),
    ),
    consensus_price_away: median(
      usableEntries.map((entry) => entry.away_price),
    ),
    source_book_count: usableEntries.length,
    dispersion_stddev: dispersion,
    consensus_confidence: classifyLineConfidence(
      usableEntries.length,
      dispersion,
    ),
  };
}

function buildTotalConsensus(entries) {
  const usableEntries = Array.isArray(entries)
    ? entries.filter(
        (entry) =>
          isFiniteNumber(entry?.line) &&
          (isFiniteNumber(entry?.over) || isFiniteNumber(entry?.under)),
      )
    : [];

  const lines = usableEntries.map((entry) => entry.line);
  const dispersion = stddev(lines);

  return {
    consensus_line: median(lines),
    consensus_price_over: median(usableEntries.map((entry) => entry.over)),
    consensus_price_under: median(usableEntries.map((entry) => entry.under)),
    source_book_count: usableEntries.length,
    dispersion_stddev: dispersion,
    consensus_confidence: classifyLineConfidence(
      usableEntries.length,
      dispersion,
    ),
  };
}

function buildH2HConsensus(entries) {
  const usableEntries = Array.isArray(entries)
    ? entries.filter(
        (entry) =>
          isFiniteNumber(entry?.home) || isFiniteNumber(entry?.away),
      )
    : [];

  const homeDispersion = stddev(usableEntries.map((entry) => entry.home));
  const awayDispersion = stddev(usableEntries.map((entry) => entry.away));
  const priceDispersionCandidates = [homeDispersion, awayDispersion].filter(
    isFiniteNumber,
  );
  const priceDispersion =
    priceDispersionCandidates.length > 0
      ? Math.max(...priceDispersionCandidates)
      : null;

  return {
    consensus_price_home: median(usableEntries.map((entry) => entry.home)),
    consensus_price_away: median(usableEntries.map((entry) => entry.away)),
    source_book_count: usableEntries.length,
    dispersion_stddev: null,
    consensus_confidence: classifyPriceConfidence(
      usableEntries.length,
      priceDispersion,
    ),
  };
}

function buildConsensus(entries, marketType) {
  const normalizedMarketType = String(marketType || '').toLowerCase();

  if (normalizedMarketType === 'spread' || normalizedMarketType === 'spreads') {
    return buildSpreadConsensus(entries);
  }

  if (normalizedMarketType === 'total' || normalizedMarketType === 'totals') {
    return buildTotalConsensus(entries);
  }

  if (normalizedMarketType === 'h2h' || normalizedMarketType === 'moneyline') {
    return buildH2HConsensus(entries);
  }

  throw new Error(`Unsupported market type for consensus: ${marketType}`);
}

module.exports = {
  buildConsensus,
  median,
  stddev,
};
