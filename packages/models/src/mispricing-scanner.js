'use strict';

/**
 * mispricing-scanner.js
 *
 * Pure, stateless book-to-book discrepancy detection.
 * No DB reads/writes. No model edge. No recommendations.
 */

const DEFAULT_THRESHOLDS = {
  spread: { watch: 0.5, trigger: 1.0 },
  total:  { watch: 0.5, trigger: 1.0 },
  ml: {
    nearEven: {
      maxAbsPrice: 150,
      watch: 0.01,
      trigger: 0.02,
    },
    big: {
      watch: 0.03,
      trigger: 0.05,
    },
  },
};

const DEFAULT_MIN_BOOKS_LINE = 3;
const DEFAULT_MIN_BOOKS_PRICE = 2;
const DEFAULT_RECENCY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

const FORBIDDEN_TERMS = ['bet', 'play', 'recommend'];
const CLASSIFICATION_FIELDS = [
  'market_type', 'selection', 'edge_type', 'threshold_class',
  'market', 'direction', 'side', 'tier',
];

function median(values) {
  const finite = values.filter(v => typeof v === 'number' && isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundTo(value, places = 6) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

function impliedProbFromAmerican(odds) {
  if (typeof odds !== 'number' || !isFinite(odds) || odds === 0) return null;
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
  return 100 / (odds + 100);
}

function parseFinite(val) {
  if (typeof val === 'number' && isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    if (isFinite(n)) return n;
  }
  return null;
}

function pickFirstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function normalizeSpreadEntry(raw) {
  if (!raw || typeof raw.book !== 'string' || !raw.book) return null;
  const home = parseFinite(raw.home);
  const away = parseFinite(raw.away);
  if (home === null && away === null) {
    console.warn(`[MispricingScanner] WARN: skipping malformed spread entry for book=${raw.book} (no valid lines)`);
    return null;
  }
  return {
    book: raw.book,
    home,
    away,
    price_home: parseFinite(raw.price_home),
    price_away: parseFinite(raw.price_away),
  };
}

function normalizeTotalEntry(raw) {
  if (!raw || typeof raw.book !== 'string' || !raw.book) return null;
  const line = parseFinite(raw.line);
  if (line === null) {
    console.warn(`[MispricingScanner] WARN: skipping malformed total entry for book=${raw.book} (no valid line)`);
    return null;
  }
  return {
    book: raw.book,
    line,
    over: parseFinite(raw.over),
    under: parseFinite(raw.under),
  };
}

function normalizeH2hEntry(raw) {
  if (!raw || typeof raw.book !== 'string' || !raw.book) return null;
  const home = parseFinite(raw.home);
  const away = parseFinite(raw.away);
  if (home === null && away === null) {
    console.warn(`[MispricingScanner] WARN: skipping malformed h2h entry for book=${raw.book} (no valid prices)`);
    return null;
  }
  return { book: raw.book, home, away };
}

function deduplicateByBook(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry.book)) continue;
    seen.add(entry.book);
    result.push(entry);
  }
  return result;
}

function buildSpreadConsensus(entries, sourceBook, minBooks) {
  if (entries.length < minBooks) return null;
  const others = entries.filter(entry => entry.book !== sourceBook);
  if (others.length === 0) return null;
  return {
    consensus_books: others.map(entry => entry.book),
    consensus_line_home: median(others.map(entry => entry.home).filter(value => value !== null)),
    consensus_line_away: median(others.map(entry => entry.away).filter(value => value !== null)),
    consensus_price_home: median(others.map(entry => entry.price_home).filter(value => value !== null)),
    consensus_price_away: median(others.map(entry => entry.price_away).filter(value => value !== null)),
  };
}

function buildTotalConsensus(entries, sourceBook, minBooks) {
  if (entries.length < minBooks) return null;
  const others = entries.filter(entry => entry.book !== sourceBook);
  if (others.length === 0) return null;
  return {
    consensus_books: others.map(entry => entry.book),
    consensus_line: median(others.map(entry => entry.line)),
    consensus_over: median(others.map(entry => entry.over).filter(value => value !== null)),
    consensus_under: median(others.map(entry => entry.under).filter(value => value !== null)),
  };
}

function buildH2hConsensus(entries, sourceBook, minBooks) {
  if (entries.length < minBooks) return null;
  const others = entries.filter(entry => entry.book !== sourceBook);
  if (others.length === 0) return null;
  return {
    consensus_books: others.map(entry => entry.book),
    consensus_home: median(others.map(entry => entry.home).filter(value => value !== null)),
    consensus_away: median(others.map(entry => entry.away).filter(value => value !== null)),
  };
}

function classifyLineDelta(sourceLine, consensusLine, thresholds) {
  if (sourceLine === null || consensusLine === null) {
    return { threshold_class: 'NONE', delta: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const delta = Math.abs(sourceLine - consensusLine);
  let threshold_class = 'NONE';
  const reason_codes = [];

  if (delta >= thresholds.trigger) {
    threshold_class = 'TRIGGER';
    reason_codes.push('LINE_DELTA_TRIGGER');
  } else if (delta >= thresholds.watch) {
    threshold_class = 'WATCH';
    reason_codes.push('LINE_DELTA_WATCH');
  }

  return { threshold_class, delta, reason_codes };
}

function classifyML(sourcePrice, consensusPrices, thresholds) {
  if (sourcePrice === null) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const validConsensus = consensusPrices.filter(price => price !== null && isFinite(price));
  if (validConsensus.length === 0) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const srcImplied = impliedProbFromAmerican(sourcePrice);
  if (srcImplied === null) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const consensusImplied = validConsensus
    .map(price => impliedProbFromAmerican(price))
    .filter(value => value !== null);
  if (consensusImplied.length === 0) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const impliedSpread = roundTo(Math.abs(srcImplied - median(consensusImplied)));
  const sourceAbs = Math.abs(sourcePrice);
  const consensusAbs = median(validConsensus.map(price => Math.abs(price)));
  const isNearEven = sourceAbs <= thresholds.ml.nearEven.maxAbsPrice &&
    consensusAbs !== null &&
    consensusAbs <= thresholds.ml.nearEven.maxAbsPrice;

  let threshold_class = 'NONE';
  const reason_codes = [];

  if (isNearEven) {
    if (impliedSpread >= thresholds.ml.nearEven.trigger) {
      threshold_class = 'TRIGGER';
      reason_codes.push('ML_NEAR_EVEN_TRIGGER');
    } else if (impliedSpread >= thresholds.ml.nearEven.watch) {
      threshold_class = 'WATCH';
      reason_codes.push('ML_NEAR_EVEN_WATCH');
    }
  } else if (impliedSpread !== null) {
    if (impliedSpread >= thresholds.ml.big.trigger) {
      threshold_class = 'TRIGGER';
      reason_codes.push('ML_BIG_TRIGGER');
    } else if (impliedSpread >= thresholds.ml.big.watch) {
      threshold_class = 'WATCH';
      reason_codes.push('ML_BIG_WATCH');
    }
  }

  return { threshold_class, implied_edge_pct: impliedSpread, reason_codes };
}

function classifyPriceGap(bestPrice, worstPrice, thresholds) {
  const bestImplied = impliedProbFromAmerican(bestPrice);
  const worstImplied = impliedProbFromAmerican(worstPrice);
  if (bestImplied === null || worstImplied === null) {
    return { threshold_class: 'NONE', implied_edge_pct: null };
  }

  const impliedSpread = roundTo(Math.abs(bestImplied - worstImplied));
  const isNearEven = Math.abs(bestPrice) <= thresholds.ml.nearEven.maxAbsPrice &&
    Math.abs(worstPrice) <= thresholds.ml.nearEven.maxAbsPrice;

  let threshold_class = 'NONE';
  if (isNearEven) {
    if (impliedSpread >= thresholds.ml.nearEven.trigger) {
      threshold_class = 'TRIGGER';
    } else if (impliedSpread >= thresholds.ml.nearEven.watch) {
      threshold_class = 'WATCH';
    }
  } else if (impliedSpread !== null) {
    if (impliedSpread >= thresholds.ml.big.trigger) {
      threshold_class = 'TRIGGER';
    } else if (impliedSpread >= thresholds.ml.big.watch) {
      threshold_class = 'WATCH';
    }
  }

  return { threshold_class, implied_edge_pct: impliedSpread };
}

function assertNoForbiddenTerms(candidate) {
  for (const field of CLASSIFICATION_FIELDS) {
    const value = candidate[field];
    if (typeof value !== 'string') continue;
    for (const word of FORBIDDEN_TERMS) {
      if (value.toLowerCase().includes(word)) {
        throw new Error(
          `[MispricingScanner] Invariant violation: candidate.${field}="${value}" contains forbidden term "${word}"`
        );
      }
    }
  }

  for (const code of candidate.reason_codes || []) {
    for (const word of FORBIDDEN_TERMS) {
      if (typeof code === 'string' && code.toLowerCase().includes(word)) {
        throw new Error(
          `[MispricingScanner] Invariant violation: reason_code="${code}" contains forbidden term "${word}"`
        );
      }
    }
  }
}

function extractSnapshotContext(payload) {
  const teamList = Array.isArray(payload?.teams) ? payload.teams : [];
  return {
    homeTeam: pickFirstString([
      payload?.homeTeam,
      payload?.home_team,
      payload?.home?.name,
      payload?.teams?.home?.name,
      teamList[0]?.name,
    ]),
    awayTeam: pickFirstString([
      payload?.awayTeam,
      payload?.away_team,
      payload?.away?.name,
      payload?.teams?.away?.name,
      teamList[1]?.name,
    ]),
    commenceTime: pickFirstString([
      payload?.commenceTime,
      payload?.commence_time,
      payload?.gameTimeUtc,
      payload?.game_time_utc,
      payload?.gameTime,
    ]),
  };
}

function parseSnapshotPayload(snapshot) {
  try {
    const payload = typeof snapshot.raw_data === 'string'
      ? JSON.parse(snapshot.raw_data)
      : (snapshot.raw_data || {});
    return {
      markets: payload && payload.markets ? payload.markets : {},
      context: extractSnapshotContext(payload),
    };
  } catch (error) {
    console.warn(`[MispricingScanner] WARN: failed to parse raw_data for game=${snapshot.game_id}: ${error.message}`);
    return null;
  }
}

function scanRecentSnapshots(snapshots, recencyWindowMs, scanSnapshot) {
  const cutoffMs = Date.now() - recencyWindowMs;
  const results = [];

  for (const snapshot of snapshots) {
    try {
      const capturedMs = new Date(snapshot.captured_at).getTime();
      if (!isFinite(capturedMs) || capturedMs < cutoffMs) continue;

      const parsed = parseSnapshotPayload(snapshot);
      if (!parsed) continue;

      const snapshotResults = scanSnapshot(snapshot, parsed.markets, parsed.context);
      if (Array.isArray(snapshotResults) && snapshotResults.length > 0) {
        results.push(...snapshotResults);
      }
    } catch (error) {
      console.warn(`[MispricingScanner] WARN: error scanning game=${snapshot.game_id}: ${error.message}`);
    }
  }

  return results;
}

function mergeThresholds(override) {
  return {
    spread: { ...DEFAULT_THRESHOLDS.spread, ...(override?.spread || {}) },
    total: { ...DEFAULT_THRESHOLDS.total, ...(override?.total || {}) },
    ml: {
      nearEven: { ...DEFAULT_THRESHOLDS.ml.nearEven, ...(override?.ml?.nearEven || {}) },
      big: { ...DEFAULT_THRESHOLDS.ml.big, ...(override?.ml?.big || {}) },
    },
  };
}

function resolveThresholds(config) {
  return config.thresholds ? mergeThresholds(config.thresholds) : DEFAULT_THRESHOLDS;
}

function resolveLineScanConfig(config = {}) {
  return {
    recencyWindowMs: config.recencyWindowMs ?? DEFAULT_RECENCY_WINDOW_MS,
    minBooks: config.minBooks ?? DEFAULT_MIN_BOOKS_LINE,
    thresholds: resolveThresholds(config),
  };
}

function resolveOddsScanConfig(config = {}) {
  return {
    recencyWindowMs: config.recencyWindowMs ?? DEFAULT_RECENCY_WINDOW_MS,
    minBooks: config.minBooks ?? DEFAULT_MIN_BOOKS_PRICE,
    thresholds: resolveThresholds(config),
  };
}

function resolveLegacyConfig(config = {}) {
  return {
    recencyWindowMs: config.recencyWindowMs ?? DEFAULT_RECENCY_WINDOW_MS,
    lineMinBooks: config.minBooksLine ?? config.minBooks ?? DEFAULT_MIN_BOOKS_LINE,
    priceMinBooks: config.minBooksPrice ?? config.minBooks ?? DEFAULT_MIN_BOOKS_PRICE,
    thresholds: resolveThresholds(config),
  };
}

function toLineGap(snapshot, context, market, gap) {
  const candidate = {
    gameId: snapshot.game_id,
    sport: snapshot.sport,
    homeTeam: context.homeTeam,
    awayTeam: context.awayTeam,
    commenceTime: context.commenceTime,
    market,
    outlierBook: gap.outlierBook,
    outlierLine: gap.outlierLine,
    consensusLine: gap.consensusLine,
    delta: gap.delta,
    direction: gap.direction,
    tier: gap.tier,
    capturedAt: snapshot.captured_at,
  };
  assertNoForbiddenTerms(candidate);
  return candidate;
}

function toOddsGap(snapshot, context, market, gap) {
  const candidate = {
    gameId: snapshot.game_id,
    sport: snapshot.sport,
    homeTeam: context.homeTeam,
    awayTeam: context.awayTeam,
    commenceTime: context.commenceTime,
    market,
    line: gap.line,
    side: gap.side,
    bestBook: gap.bestBook,
    bestPrice: gap.bestPrice,
    worstBook: gap.worstBook,
    worstPrice: gap.worstPrice,
    impliedEdgePct: gap.impliedEdgePct,
    tier: gap.tier,
    capturedAt: snapshot.captured_at,
  };
  assertNoForbiddenTerms(candidate);
  return candidate;
}

function createSpreadLineGap(snapshot, context, entry, consensus, thresholds) {
  if (entry.home !== null && consensus.consensus_line_home !== null) {
    const lineResult = classifyLineDelta(entry.home, consensus.consensus_line_home, thresholds.spread);
    if (lineResult.threshold_class === 'NONE') return null;

    const direction = entry.home > consensus.consensus_line_home ? 'home' : 'away';
    const outlierLine = direction === 'home'
      ? entry.home
      : (entry.away ?? entry.home);
    const consensusLine = direction === 'home'
      ? consensus.consensus_line_home
      : (consensus.consensus_line_away ?? consensus.consensus_line_home);

    return toLineGap(snapshot, context, 'spread', {
      outlierBook: entry.book,
      outlierLine,
      consensusLine,
      delta: lineResult.delta,
      direction,
      tier: lineResult.threshold_class,
    });
  }

  if (entry.away !== null && consensus.consensus_line_away !== null) {
    const lineResult = classifyLineDelta(entry.away, consensus.consensus_line_away, thresholds.spread);
    if (lineResult.threshold_class === 'NONE') return null;

    const direction = entry.away > consensus.consensus_line_away ? 'away' : 'home';
    const outlierLine = direction === 'away'
      ? entry.away
      : (entry.home ?? entry.away);
    const consensusLine = direction === 'away'
      ? consensus.consensus_line_away
      : (consensus.consensus_line_home ?? consensus.consensus_line_away);

    return toLineGap(snapshot, context, 'spread', {
      outlierBook: entry.book,
      outlierLine,
      consensusLine,
      delta: lineResult.delta,
      direction,
      tier: lineResult.threshold_class,
    });
  }

  return null;
}

function createTotalLineGap(snapshot, context, entry, consensus, thresholds) {
  const lineResult = classifyLineDelta(entry.line, consensus.consensus_line, thresholds.total);
  if (lineResult.threshold_class === 'NONE') return null;

  return toLineGap(snapshot, context, 'total', {
    outlierBook: entry.book,
    outlierLine: entry.line,
    consensusLine: consensus.consensus_line,
    delta: lineResult.delta,
    direction: entry.line < consensus.consensus_line ? 'over' : 'under',
    tier: lineResult.threshold_class,
  });
}

function groupEntriesByLine(entries, lineField) {
  const groups = new Map();

  for (const entry of entries) {
    const line = entry[lineField];
    if (line === null) continue;
    const key = String(line);
    if (!groups.has(key)) {
      groups.set(key, { line, entries: [] });
    }
    groups.get(key).entries.push(entry);
  }

  return [...groups.values()];
}

function findDominantLineGroup(entries, lineField) {
  const groups = groupEntriesByLine(entries, lineField)
    .filter(group => group.entries.length > 0)
    .sort((a, b) => b.entries.length - a.entries.length);

  if (groups.length <= 1) return null;
  if (groups[0].entries.length === groups[1].entries.length) return null;
  return groups[0];
}

function findBestAndWorstPrice(entries, priceField) {
  let bestEntry = null;
  let worstEntry = null;

  for (const entry of entries) {
    const price = entry[priceField];
    if (price === null) continue;
    if (!bestEntry || price > bestEntry[priceField]) bestEntry = entry;
    if (!worstEntry || price < worstEntry[priceField]) worstEntry = entry;
  }

  if (!bestEntry || !worstEntry) return null;
  if (bestEntry[priceField] === worstEntry[priceField]) return null;

  return {
    bestBook: bestEntry.book,
    bestPrice: bestEntry[priceField],
    worstBook: worstEntry.book,
    worstPrice: worstEntry[priceField],
  };
}

function createOddsGap(snapshot, context, market, side, line, entries, priceField, thresholds) {
  const pricing = findBestAndWorstPrice(entries, priceField);
  if (!pricing) return null;

  const priceResult = classifyPriceGap(pricing.bestPrice, pricing.worstPrice, thresholds);
  if (priceResult.threshold_class === 'NONE') return null;

  return toOddsGap(snapshot, context, market, {
    line,
    side,
    bestBook: pricing.bestBook,
    bestPrice: pricing.bestPrice,
    worstBook: pricing.worstBook,
    worstPrice: pricing.worstPrice,
    impliedEdgePct: priceResult.implied_edge_pct,
    tier: priceResult.threshold_class,
  });
}

function scanSpreadLineDiscrepancies(snapshot, context, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeSpreadEntry).filter(Boolean));
  if (entries.length < config.minBooks) return [];

  const dominantGroup = findDominantLineGroup(entries, 'home') || findDominantLineGroup(entries, 'away');
  if (!dominantGroup) return [];

  const dominantBooks = new Set(dominantGroup.entries.map(entry => entry.book));
  const consensus = {
    consensus_line_home: median(dominantGroup.entries.map(entry => entry.home).filter(value => value !== null)),
    consensus_line_away: median(dominantGroup.entries.map(entry => entry.away).filter(value => value !== null)),
  };

  return entries
    .filter(entry => !dominantBooks.has(entry.book))
    .map(entry => createSpreadLineGap(snapshot, context, entry, consensus, config.thresholds))
    .filter(Boolean);
}

function scanTotalLineDiscrepancies(snapshot, context, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeTotalEntry).filter(Boolean));
  if (entries.length < config.minBooks) return [];

  const dominantGroup = findDominantLineGroup(entries, 'line');
  if (!dominantGroup) return [];

  const dominantBooks = new Set(dominantGroup.entries.map(entry => entry.book));
  const consensus = {
    consensus_line: median(dominantGroup.entries.map(entry => entry.line)),
  };

  return entries
    .filter(entry => !dominantBooks.has(entry.book))
    .map(entry => createTotalLineGap(snapshot, context, entry, consensus, config.thresholds))
    .filter(Boolean);
}

function scanSpreadOddsDiscrepancies(snapshot, context, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeSpreadEntry).filter(Boolean));
  const oddsGaps = [];

  for (const group of groupEntriesByLine(entries, 'home')) {
    if (group.entries.length < config.minBooks) continue;
    const oddsGap = createOddsGap(snapshot, context, 'spread', 'home', group.line, group.entries, 'price_home', config.thresholds);
    if (oddsGap) oddsGaps.push(oddsGap);
  }

  for (const group of groupEntriesByLine(entries, 'away')) {
    if (group.entries.length < config.minBooks) continue;
    const oddsGap = createOddsGap(snapshot, context, 'spread', 'away', group.line, group.entries, 'price_away', config.thresholds);
    if (oddsGap) oddsGaps.push(oddsGap);
  }

  return oddsGaps;
}

function scanTotalOddsDiscrepancies(snapshot, context, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeTotalEntry).filter(Boolean));
  const oddsGaps = [];

  for (const group of groupEntriesByLine(entries, 'line')) {
    if (group.entries.length < config.minBooks) continue;

    const overGap = createOddsGap(snapshot, context, 'total', 'over', group.line, group.entries, 'over', config.thresholds);
    if (overGap) oddsGaps.push(overGap);

    const underGap = createOddsGap(snapshot, context, 'total', 'under', group.line, group.entries, 'under', config.thresholds);
    if (underGap) oddsGaps.push(underGap);
  }

  return oddsGaps;
}

function scanMoneylineOddsDiscrepancies(snapshot, context, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeH2hEntry).filter(Boolean));
  if (entries.length < config.minBooks) return [];

  const oddsGaps = [];
  const homeGap = createOddsGap(snapshot, context, 'moneyline', 'home', null, entries, 'home', config.thresholds);
  if (homeGap) oddsGaps.push(homeGap);

  const awayGap = createOddsGap(snapshot, context, 'moneyline', 'away', null, entries, 'away', config.thresholds);
  if (awayGap) oddsGaps.push(awayGap);

  return oddsGaps;
}

function scanSpreads(snapshot, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeSpreadEntry).filter(Boolean));
  const candidates = [];

  for (const entry of entries) {
    const consensus = buildSpreadConsensus(entries, entry.book, config.minBooks);
    if (!consensus) continue;

    if (entry.home !== null) {
      const result = classifyLineDelta(entry.home, consensus.consensus_line_home, config.thresholds.spread);
      if (result.threshold_class !== 'NONE') {
        const candidate = {
          game_id: snapshot.game_id,
          sport: snapshot.sport,
          market_type: 'SPREAD',
          selection: 'HOME',
          source_book: entry.book,
          consensus_books: consensus.consensus_books,
          source_line: entry.home,
          source_price: entry.price_home,
          consensus_line: consensus.consensus_line_home,
          consensus_price: consensus.consensus_price_home,
          edge_type: 'LINE',
          stale_delta: null,
          implied_edge_pct: null,
          threshold_class: result.threshold_class,
          reason_codes: result.reason_codes,
          captured_at: snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }

    if (entry.away !== null) {
      const result = classifyLineDelta(entry.away, consensus.consensus_line_away, config.thresholds.spread);
      if (result.threshold_class !== 'NONE') {
        const candidate = {
          game_id: snapshot.game_id,
          sport: snapshot.sport,
          market_type: 'SPREAD',
          selection: 'AWAY',
          source_book: entry.book,
          consensus_books: consensus.consensus_books,
          source_line: entry.away,
          source_price: entry.price_away,
          consensus_line: consensus.consensus_line_away,
          consensus_price: consensus.consensus_price_away,
          edge_type: 'LINE',
          stale_delta: null,
          implied_edge_pct: null,
          threshold_class: result.threshold_class,
          reason_codes: result.reason_codes,
          captured_at: snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function scanTotals(snapshot, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeTotalEntry).filter(Boolean));
  const candidates = [];

  for (const entry of entries) {
    const consensus = buildTotalConsensus(entries, entry.book, config.minBooks);
    if (!consensus) continue;

    const result = classifyLineDelta(entry.line, consensus.consensus_line, config.thresholds.total);
    if (result.threshold_class === 'NONE') continue;

    const candidate = {
      game_id: snapshot.game_id,
      sport: snapshot.sport,
      market_type: 'TOTAL',
      selection: 'OVER',
      source_book: entry.book,
      consensus_books: consensus.consensus_books,
      source_line: entry.line,
      source_price: entry.over,
      consensus_line: consensus.consensus_line,
      consensus_price: consensus.consensus_over,
      edge_type: 'LINE',
      stale_delta: null,
      implied_edge_pct: null,
      threshold_class: result.threshold_class,
      reason_codes: result.reason_codes,
      captured_at: snapshot.captured_at,
    };
    assertNoForbiddenTerms(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

function scanH2h(snapshot, rawEntries, config) {
  const entries = deduplicateByBook(rawEntries.map(normalizeH2hEntry).filter(Boolean));
  const candidates = [];

  for (const entry of entries) {
    const consensus = buildH2hConsensus(entries, entry.book, config.minBooks);
    if (!consensus) continue;

    if (entry.home !== null) {
      const consensusPrices = entries
        .filter(other => other.book !== entry.book)
        .map(other => other.home)
        .filter(value => value !== null);

      const result = classifyML(entry.home, consensusPrices, config.thresholds);
      if (result.threshold_class !== 'NONE') {
        const candidate = {
          game_id: snapshot.game_id,
          sport: snapshot.sport,
          market_type: 'ML',
          selection: 'HOME',
          source_book: entry.book,
          consensus_books: consensus.consensus_books,
          source_line: null,
          source_price: entry.home,
          consensus_line: null,
          consensus_price: consensus.consensus_home,
          edge_type: 'PRICE',
          stale_delta: null,
          implied_edge_pct: result.implied_edge_pct,
          threshold_class: result.threshold_class,
          reason_codes: result.reason_codes,
          captured_at: snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }

    if (entry.away !== null) {
      const consensusPrices = entries
        .filter(other => other.book !== entry.book)
        .map(other => other.away)
        .filter(value => value !== null);

      const result = classifyML(entry.away, consensusPrices, config.thresholds);
      if (result.threshold_class !== 'NONE') {
        const candidate = {
          game_id: snapshot.game_id,
          sport: snapshot.sport,
          market_type: 'ML',
          selection: 'AWAY',
          source_book: entry.book,
          consensus_books: consensus.consensus_books,
          source_line: null,
          source_price: entry.away,
          consensus_line: null,
          consensus_price: consensus.consensus_away,
          edge_type: 'PRICE',
          stale_delta: null,
          implied_edge_pct: result.implied_edge_pct,
          threshold_class: result.threshold_class,
          reason_codes: result.reason_codes,
          captured_at: snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function scanLineDiscrepancies(snapshots, config = {}) {
  const resolvedConfig = resolveLineScanConfig(config);

  return scanRecentSnapshots(snapshots, resolvedConfig.recencyWindowMs, (snapshot, markets, context) => {
    const results = [];

    if (Array.isArray(markets.spreads) && markets.spreads.length > 0) {
      results.push(...scanSpreadLineDiscrepancies(snapshot, context, markets.spreads, resolvedConfig));
    }
    if (Array.isArray(markets.totals) && markets.totals.length > 0) {
      results.push(...scanTotalLineDiscrepancies(snapshot, context, markets.totals, resolvedConfig));
    }

    return results;
  });
}

function scanOddsDiscrepancies(snapshots, config = {}) {
  const resolvedConfig = resolveOddsScanConfig(config);

  return scanRecentSnapshots(snapshots, resolvedConfig.recencyWindowMs, (snapshot, markets, context) => {
    const results = [];

    if (Array.isArray(markets.spreads) && markets.spreads.length > 0) {
      results.push(...scanSpreadOddsDiscrepancies(snapshot, context, markets.spreads, resolvedConfig));
    }
    if (Array.isArray(markets.totals) && markets.totals.length > 0) {
      results.push(...scanTotalOddsDiscrepancies(snapshot, context, markets.totals, resolvedConfig));
    }
    if (Array.isArray(markets.h2h) && markets.h2h.length > 0) {
      results.push(...scanMoneylineOddsDiscrepancies(snapshot, context, markets.h2h, resolvedConfig));
    }

    return results;
  });
}

function scanForMispricing(snapshots, config = {}) {
  const resolvedConfig = resolveLegacyConfig(config);
  const lineConfig = {
    minBooks: resolvedConfig.lineMinBooks,
    thresholds: resolvedConfig.thresholds,
  };
  const priceConfig = {
    minBooks: resolvedConfig.priceMinBooks,
    thresholds: resolvedConfig.thresholds,
  };

  return scanRecentSnapshots(snapshots, resolvedConfig.recencyWindowMs, (snapshot, markets) => {
    const candidates = [];

    if (Array.isArray(markets.spreads) && markets.spreads.length > 0) {
      candidates.push(...scanSpreads(snapshot, markets.spreads, lineConfig));
    }
    if (Array.isArray(markets.totals) && markets.totals.length > 0) {
      candidates.push(...scanTotals(snapshot, markets.totals, lineConfig));
    }
    if (Array.isArray(markets.h2h) && markets.h2h.length > 0) {
      candidates.push(...scanH2h(snapshot, markets.h2h, priceConfig));
    }

    return candidates;
  });
}

module.exports = {
  scanForMispricing,
  scanLineDiscrepancies,
  scanOddsDiscrepancies,
};
