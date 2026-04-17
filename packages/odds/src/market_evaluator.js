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

const SOFT_LINE_THRESHOLD = 1.5;
const PRICE_ONLY_THRESHOLD_BPS = 800;
const HIGH_DISPERSION_THRESHOLD = 1.5;

function pickBestValue(entries, valueKey, comparator = (candidate, current) => candidate > current) {
  let bestValue = null;
  let bestBook = null;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const candidate = entry?.[valueKey];
    if (!isFiniteNumber(candidate)) continue;
    if (bestValue === null || comparator(candidate, bestValue)) {
      bestValue = candidate;
      bestBook = entry?.book ?? null;
    }
  }

  return {
    value: bestValue,
    book: bestBook,
  };
}

function findEntryByBook(entries, book, valueKey) {
  if (!book) return null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.book !== book) continue;
    if (isFiniteNumber(entry?.[valueKey])) return entry;
  }
  return null;
}

function americanToDecimal(price) {
  if (!isFiniteNumber(price) || price === 0) return null;
  if (price > 0) return Number((1 + price / 100).toFixed(4));
  return Number((1 + 100 / Math.abs(price)).toFixed(4));
}

function decimalDeltaToBps(bestPrice, baselinePrice) {
  const bestDecimal = americanToDecimal(bestPrice);
  const baselineDecimal = americanToDecimal(baselinePrice);
  if (!isFiniteNumber(bestDecimal) || !isFiniteNumber(baselineDecimal)) {
    return null;
  }
  return Math.round((bestDecimal - baselineDecimal) * 10000);
}

function selectMostCommonLine(entries, valueKey) {
  const counts = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const line = entry?.[valueKey];
    if (!isFiniteNumber(line)) continue;
    const key = String(line);
    const existing = counts.get(key) || { line, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }

  let winner = null;
  for (const candidate of counts.values()) {
    if (!winner || candidate.count > winner.count) {
      winner = candidate;
    }
  }

  return winner?.line ?? null;
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

function selectSpreadExecution(entries) {
  const bestLineHome = pickBestValue(entries, 'home_line');
  const bestLineAway = pickBestValue(entries, 'away_line');
  const bestPriceHome = pickBestValue(entries, 'home_price');
  const bestPriceAway = pickBestValue(entries, 'away_price');
  const homeBookEntry = findEntryByBook(
    entries,
    bestPriceHome.book,
    'away_price',
  );
  const awayBookEntry = findEntryByBook(
    entries,
    bestPriceAway.book,
    'home_price',
  );

  return {
    best_line_home: bestLineHome.value,
    best_line_home_book: bestLineHome.book,
    best_line_away: bestLineAway.value,
    best_line_away_book: bestLineAway.book,
    best_price_home: bestPriceHome.value,
    best_price_home_book: bestPriceHome.book,
    best_price_away: bestPriceAway.value,
    best_price_away_book: bestPriceAway.book,
    same_book_away_for_home: homeBookEntry?.away_price ?? null,
    same_book_home_for_away: awayBookEntry?.home_price ?? null,
  };
}

function selectTotalExecution(entries) {
  const bestLineOver = pickBestValue(
    entries,
    'line',
    (candidate, current) => candidate < current,
  );
  const bestLineUnder = pickBestValue(entries, 'line');
  const bestPriceOver = pickBestValue(entries, 'over');
  const bestPriceUnder = pickBestValue(entries, 'under');
  const overBookEntry = findEntryByBook(entries, bestPriceOver.book, 'under');
  const underBookEntry = findEntryByBook(entries, bestPriceUnder.book, 'over');

  return {
    best_line_over: bestLineOver.value,
    best_line_over_book: bestLineOver.book,
    best_line_under: bestLineUnder.value,
    best_line_under_book: bestLineUnder.book,
    best_price_over: bestPriceOver.value,
    best_price_over_book: bestPriceOver.book,
    best_price_under: bestPriceUnder.value,
    best_price_under_book: bestPriceUnder.book,
    same_book_under_for_over: overBookEntry?.under ?? null,
    same_book_over_for_under: underBookEntry?.over ?? null,
  };
}

function selectH2HExecution(entries) {
  const bestPriceHome = pickBestValue(entries, 'home');
  const bestPriceAway = pickBestValue(entries, 'away');
  const homeBookEntry = findEntryByBook(entries, bestPriceHome.book, 'away');
  const awayBookEntry = findEntryByBook(entries, bestPriceAway.book, 'home');

  return {
    best_price_home: bestPriceHome.value,
    best_price_home_book: bestPriceHome.book,
    best_price_away: bestPriceAway.value,
    best_price_away_book: bestPriceAway.book,
    same_book_away_for_home: homeBookEntry?.away ?? null,
    same_book_home_for_away: awayBookEntry?.home ?? null,
  };
}

function selectBestExecution(entries, marketType) {
  const normalizedMarketType = String(marketType || '').toLowerCase();

  if (normalizedMarketType === 'spread' || normalizedMarketType === 'spreads') {
    return selectSpreadExecution(entries);
  }

  if (normalizedMarketType === 'total' || normalizedMarketType === 'totals') {
    return selectTotalExecution(entries);
  }

  if (normalizedMarketType === 'h2h' || normalizedMarketType === 'moneyline') {
    return selectH2HExecution(entries);
  }

  throw new Error(`Unsupported market type for execution: ${marketType}`);
}

function detectSpreadSoftLine(consensus, executionBlock) {
  const homeDelta =
    isFiniteNumber(executionBlock?.best_line_home) &&
    isFiniteNumber(consensus?.consensus_line)
      ? executionBlock.best_line_home - consensus.consensus_line
      : null;
  const awayConsensusLine =
    isFiniteNumber(consensus?.consensus_line) ? -consensus.consensus_line : null;
  const awayDelta =
    isFiniteNumber(executionBlock?.best_line_away) &&
    isFiniteNumber(awayConsensusLine)
      ? executionBlock.best_line_away - awayConsensusLine
      : null;

  if (isFiniteNumber(homeDelta) && homeDelta > SOFT_LINE_THRESHOLD) {
    return {
      misprice_type: 'SOFT_LINE',
      misprice_strength: Number(homeDelta.toFixed(2)),
      outlier_book: executionBlock.best_line_home_book ?? null,
      outlier_delta_vs_consensus: Number(homeDelta.toFixed(2)),
      stale_or_soft_flag: true,
      review_flag: false,
    };
  }

  if (isFiniteNumber(awayDelta) && awayDelta > SOFT_LINE_THRESHOLD) {
    return {
      misprice_type: 'SOFT_LINE',
      misprice_strength: Number(awayDelta.toFixed(2)),
      outlier_book: executionBlock.best_line_away_book ?? null,
      outlier_delta_vs_consensus: Number(awayDelta.toFixed(2)),
      stale_or_soft_flag: true,
      review_flag: false,
    };
  }

  return null;
}

function detectTotalSoftLine(consensus, executionBlock) {
  const overDelta =
    isFiniteNumber(consensus?.consensus_line) &&
    isFiniteNumber(executionBlock?.best_line_over)
      ? consensus.consensus_line - executionBlock.best_line_over
      : null;
  const underDelta =
    isFiniteNumber(executionBlock?.best_line_under) &&
    isFiniteNumber(consensus?.consensus_line)
      ? executionBlock.best_line_under - consensus.consensus_line
      : null;

  if (isFiniteNumber(overDelta) && overDelta > SOFT_LINE_THRESHOLD) {
    return {
      misprice_type: 'SOFT_LINE',
      misprice_strength: Number(overDelta.toFixed(2)),
      outlier_book: executionBlock.best_line_over_book ?? null,
      outlier_delta_vs_consensus: Number(overDelta.toFixed(2)),
      stale_or_soft_flag: true,
      review_flag: false,
    };
  }

  if (isFiniteNumber(underDelta) && underDelta > SOFT_LINE_THRESHOLD) {
    return {
      misprice_type: 'SOFT_LINE',
      misprice_strength: Number(underDelta.toFixed(2)),
      outlier_book: executionBlock.best_line_under_book ?? null,
      outlier_delta_vs_consensus: Number(underDelta.toFixed(2)),
      stale_or_soft_flag: true,
      review_flag: false,
    };
  }

  return null;
}

function detectSpreadPriceOnly(entries) {
  const commonHomeLine = selectMostCommonLine(entries, 'home_line');
  if (!isFiniteNumber(commonHomeLine)) return null;

  const sameLineEntries = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry?.home_line === commonHomeLine && isFiniteNumber(entry?.home_price),
  );
  if (sameLineEntries.length < 2) return null;

  const medianPrice = median(sameLineEntries.map((entry) => entry.home_price));
  const bestPrice = pickBestValue(sameLineEntries, 'home_price');
  const deltaBps = decimalDeltaToBps(bestPrice.value, medianPrice);
  if (!isFiniteNumber(deltaBps) || deltaBps <= PRICE_ONLY_THRESHOLD_BPS) {
    return null;
  }

  return {
    misprice_type: 'PRICE_ONLY',
    misprice_strength: deltaBps,
    outlier_book: bestPrice.book ?? null,
    outlier_delta_vs_consensus: null,
    stale_or_soft_flag: false,
    review_flag: false,
  };
}

function detectTotalPriceOnly(entries) {
  const commonLine = selectMostCommonLine(entries, 'line');
  if (!isFiniteNumber(commonLine)) return null;

  const overEntries = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry?.line === commonLine && isFiniteNumber(entry?.over),
  );
  const underEntries = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry?.line === commonLine && isFiniteNumber(entry?.under),
  );

  const candidates = [];
  if (overEntries.length >= 2) {
    const medianPrice = median(overEntries.map((entry) => entry.over));
    const bestPrice = pickBestValue(overEntries, 'over');
    const deltaBps = decimalDeltaToBps(bestPrice.value, medianPrice);
    if (isFiniteNumber(deltaBps)) {
      candidates.push({ deltaBps, book: bestPrice.book ?? null });
    }
  }

  if (underEntries.length >= 2) {
    const medianPrice = median(underEntries.map((entry) => entry.under));
    const bestPrice = pickBestValue(underEntries, 'under');
    const deltaBps = decimalDeltaToBps(bestPrice.value, medianPrice);
    if (isFiniteNumber(deltaBps)) {
      candidates.push({ deltaBps, book: bestPrice.book ?? null });
    }
  }

  if (candidates.length === 0) return null;
  const winner = candidates.sort((a, b) => b.deltaBps - a.deltaBps)[0];
  if (winner.deltaBps <= PRICE_ONLY_THRESHOLD_BPS) return null;

  return {
    misprice_type: 'PRICE_ONLY',
    misprice_strength: winner.deltaBps,
    outlier_book: winner.book,
    outlier_delta_vs_consensus: null,
    stale_or_soft_flag: false,
    review_flag: false,
  };
}

function detectHighDispersion(consensus) {
  if (
    isFiniteNumber(consensus?.dispersion_stddev) &&
    consensus.dispersion_stddev > HIGH_DISPERSION_THRESHOLD
  ) {
    return {
      misprice_type: 'HIGH_DISPERSION',
      misprice_strength: Number(consensus.dispersion_stddev.toFixed(2)),
      outlier_book: null,
      outlier_delta_vs_consensus: null,
      stale_or_soft_flag: false,
      review_flag: true,
    };
  }

  return null;
}

function detectMisprice(consensus, executionBlock, entries, marketType) {
  const normalizedMarketType = String(marketType || '').toLowerCase();
  let softLine = null;
  let priceOnly = null;

  if (normalizedMarketType === 'spread' || normalizedMarketType === 'spreads') {
    softLine = detectSpreadSoftLine(consensus, executionBlock);
    priceOnly = detectSpreadPriceOnly(entries);
  } else if (
    normalizedMarketType === 'total' ||
    normalizedMarketType === 'totals'
  ) {
    softLine = detectTotalSoftLine(consensus, executionBlock);
    priceOnly = detectTotalPriceOnly(entries);
  } else {
    return {
      is_mispriced: false,
      misprice_type: null,
      misprice_strength: null,
      outlier_book: null,
      outlier_delta_vs_consensus: null,
      stale_or_soft_flag: false,
      review_flag: false,
    };
  }

  const reviewFlag = detectHighDispersion(consensus);
  const winner = softLine || priceOnly || reviewFlag;

  if (!winner) {
    return {
      is_mispriced: false,
      misprice_type: null,
      misprice_strength: null,
      outlier_book: null,
      outlier_delta_vs_consensus: null,
      stale_or_soft_flag: false,
      review_flag: false,
    };
  }

  return {
    is_mispriced: true,
    misprice_type: winner.misprice_type,
    misprice_strength: winner.misprice_strength,
    outlier_book: winner.outlier_book,
    outlier_delta_vs_consensus: winner.outlier_delta_vs_consensus,
    stale_or_soft_flag: winner.stale_or_soft_flag,
    review_flag: winner.review_flag,
  };
}

const PLAYABLE_EDGE_THRESHOLD_PTS = 1.0;

/**
 * Compare model projection against consensus and best-available market lines.
 *
 * Inputs should be normalized to the bettor's side perspective so that
 * positive edge always means "model more bullish on the bet side":
 *   - TOTAL OVER/UNDER:  fairLine = projectedTotal, consensusLine = totalConsensusLine,
 *                        bestLine = total_line_over (OVER) or total_line_under (UNDER)
 *   - SPREAD HOME:       fairLine = projectedMargin, consensusLine = -spread_consensus_line,
 *                        bestLine = -spread_home (negate to get "home must beat X" threshold)
 *   - SPREAD AWAY:       fairLine = -projectedMargin, consensusLine = spread_consensus_line,
 *                        bestLine = -spread_away (negate positive away line)
 */
function compareProjection({ fairLine, consensusLine, bestLine, consensusPrice, bestPrice }) {
  const edgeVsConsensusPts =
    isFiniteNumber(fairLine) && isFiniteNumber(consensusLine)
      ? Number((fairLine - consensusLine).toFixed(2))
      : null;

  const edgeVsBestAvailablePts =
    isFiniteNumber(fairLine) && isFiniteNumber(bestLine)
      ? Number((fairLine - bestLine).toFixed(2))
      : null;

  const executionAlphaPts =
    isFiniteNumber(edgeVsBestAvailablePts) && isFiniteNumber(edgeVsConsensusPts)
      ? Number((edgeVsBestAvailablePts - edgeVsConsensusPts).toFixed(2))
      : null;

  const playableEdge =
    isFiniteNumber(edgeVsConsensusPts) &&
    isFiniteNumber(edgeVsBestAvailablePts) &&
    Math.abs(edgeVsConsensusPts) >= PLAYABLE_EDGE_THRESHOLD_PTS &&
    Math.abs(edgeVsBestAvailablePts) >= PLAYABLE_EDGE_THRESHOLD_PTS &&
    Math.sign(edgeVsConsensusPts) === Math.sign(edgeVsBestAvailablePts);

  return {
    fair_line_from_projection: isFiniteNumber(fairLine) ? fairLine : null,
    edge_vs_consensus_pts: edgeVsConsensusPts,
    edge_vs_best_available_pts: edgeVsBestAvailablePts,
    execution_alpha_pts: executionAlphaPts,
    fair_price_from_projection: null,
    edge_vs_consensus_pct: null,
    edge_vs_best_available_pct: null,
    playable_edge: playableEdge,
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
  compareProjection,
  detectMisprice,
  median,
  selectBestExecution,
  stddev,
};
