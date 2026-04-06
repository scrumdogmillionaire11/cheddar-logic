'use strict';

/**
 * mispricing-scanner.js
 *
 * Pure, stateless book-to-book mispricing detection.
 * No DB reads/writes. No model edge. No recommendations.
 *
 * Exports: scanForMispricing(snapshots, config) → MispricingCandidate[]
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  spread: { watch: 0.5, trigger: 1.0 },
  total:  { watch: 0.5, trigger: 1.0 },
  ml: {
    nearEven: {
      maxAbsPrice:    150,
      watch:          0.10,
      trigger:        0.20,
    },
    big: {
      watch:   0.03,
      trigger: 0.05,
    },
  },
};

const DEFAULT_MIN_BOOKS          = 2;
const DEFAULT_RECENCY_WINDOW_MS  = 30 * 60 * 1000; // 30 minutes

// Forbidden terms in classification / code fields (not book names)
const FORBIDDEN_TERMS = ['bet', 'play', 'recommend'];

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the median of an array of finite numbers, or null if empty.
 */
function median(values) {
  const finite = values.filter(v => typeof v === 'number' && isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Convert American odds to implied probability.
 * Returns null if odds is not a finite number or is 0.
 */
function impliedProbFromAmerican(odds) {
  if (typeof odds !== 'number' || !isFinite(odds) || odds === 0) return null;
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
  return 100 / (odds + 100);
}

// ── Entry normalization ───────────────────────────────────────────────────────

/**
 * Normalise a raw per-book spread entry.
 * Returns { book, home, away, price_home, price_away } with validated numbers,
 * or null if the entry is unusable.
 */
function normalizeSpreadEntry(raw) {
  if (!raw || typeof raw.book !== 'string' || !raw.book) return null;
  const home = parseFinite(raw.home);
  const away = parseFinite(raw.away);
  if (home === null && away === null) {
    console.warn(`[MispricingScanner] WARN: skipping malformed spread entry for book=${raw.book} (no valid lines)`);
    return null;
  }
  return {
    book:        raw.book,
    home:        home,
    away:        away,
    price_home:  parseFinite(raw.price_home),
    price_away:  parseFinite(raw.price_away),
  };
}

/**
 * Normalise a raw per-book total entry.
 */
function normalizeTotalEntry(raw) {
  if (!raw || typeof raw.book !== 'string' || !raw.book) return null;
  const line = parseFinite(raw.line);
  if (line === null) {
    console.warn(`[MispricingScanner] WARN: skipping malformed total entry for book=${raw.book} (no valid line)`);
    return null;
  }
  return {
    book:  raw.book,
    line,
    over:  parseFinite(raw.over),
    under: parseFinite(raw.under),
  };
}

/**
 * Normalise a raw per-book H2H (ML) entry.
 */
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

function parseFinite(val) {
  if (typeof val === 'number' && isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    if (isFinite(n)) return n;
  }
  return null;
}

/**
 * Deduplicate by book name (keep first occurrence) and validate entries.
 */
function deduplicateByBook(entries) {
  const seen = new Set();
  const result = [];
  for (const e of entries) {
    if (!e || seen.has(e.book)) continue;
    seen.add(e.book);
    result.push(e);
  }
  return result;
}

// ── Consensus builder ──────────────────────────────────────────────────────────

/**
 * Build consensus from all entries except sourceBook.
 * Returns null if fewer than minBooks comparison books remain.
 */
function buildSpreadConsensus(entries, sourceBook, minBooks) {
  const others = entries.filter(e => e.book !== sourceBook);
  if (others.length < minBooks) return null;
  return {
    consensus_books:       others.map(e => e.book),
    consensus_line_home:   median(others.map(e => e.home).filter(v => v !== null)),
    consensus_line_away:   median(others.map(e => e.away).filter(v => v !== null)),
    consensus_price_home:  median(others.map(e => e.price_home).filter(v => v !== null)),
    consensus_price_away:  median(others.map(e => e.price_away).filter(v => v !== null)),
  };
}

function buildTotalConsensus(entries, sourceBook, minBooks) {
  const others = entries.filter(e => e.book !== sourceBook);
  if (others.length < minBooks) return null;
  return {
    consensus_books:  others.map(e => e.book),
    consensus_line:   median(others.map(e => e.line)),
    consensus_over:   median(others.map(e => e.over).filter(v => v !== null)),
    consensus_under:  median(others.map(e => e.under).filter(v => v !== null)),
  };
}

function buildH2hConsensus(entries, sourceBook, minBooks) {
  const others = entries.filter(e => e.book !== sourceBook);
  if (others.length < minBooks) return null;
  return {
    consensus_books:  others.map(e => e.book),
    consensus_home:   median(others.map(e => e.home).filter(v => v !== null)),
    consensus_away:   median(others.map(e => e.away).filter(v => v !== null)),
  };
}

// ── Classifiers ───────────────────────────────────────────────────────────────

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
  const validConsensus = consensusPrices.filter(p => p !== null && isFinite(p));
  if (validConsensus.length === 0) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const srcAbs = Math.abs(sourcePrice);
  const consAbsMed = median(validConsensus.map(p => Math.abs(p)));

  const srcImplied = impliedProbFromAmerican(sourcePrice);
  if (srcImplied === null) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }

  const consImplied = validConsensus.map(p => impliedProbFromAmerican(p)).filter(v => v !== null);
  if (consImplied.length === 0) {
    return { threshold_class: 'NONE', implied_edge_pct: null, reason_codes: ['INSUFFICIENT_DATA'] };
  }
  const consImpliedMed = median(consImplied);

  const isNearEven = srcAbs <= thresholds.ml.nearEven.maxAbsPrice &&
                     consAbsMed !== null && consAbsMed <= thresholds.ml.nearEven.maxAbsPrice;

  // Round to 6 decimal places to avoid floating-point boundary issues (e.g. 0.0999... vs 0.10)
  const impliedSpread = Math.round(Math.abs(srcImplied - consImpliedMed) * 1e6) / 1e6;

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
  } else {
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

// ── Invariant guard ───────────────────────────────────────────────────────────

const CLASSIFICATION_FIELDS = [
  'market_type', 'selection', 'edge_type', 'threshold_class',
];

function assertNoForbiddenTerms(candidate) {
  for (const field of CLASSIFICATION_FIELDS) {
    const val = candidate[field];
    if (typeof val === 'string') {
      for (const word of FORBIDDEN_TERMS) {
        if (val.toLowerCase().includes(word)) {
          throw new Error(
            `[MispricingScanner] Invariant violation: candidate.${field}="${val}" contains forbidden term "${word}"`
          );
        }
      }
    }
  }
  for (const code of (candidate.reason_codes || [])) {
    for (const word of FORBIDDEN_TERMS) {
      if (code.toLowerCase().includes(word)) {
        throw new Error(
          `[MispricingScanner] Invariant violation: reason_code="${code}" contains forbidden term "${word}"`
        );
      }
    }
  }
}

// ── Market scanners ───────────────────────────────────────────────────────────

function scanSpreads(snapshot, rawEntries, config) {
  const { thresholds, minBooks } = config;
  const normalized = rawEntries
    .map(normalizeSpreadEntry)
    .filter(Boolean);
  const entries = deduplicateByBook(normalized);
  const candidates = [];

  for (const entry of entries) {
    const consensus = buildSpreadConsensus(entries, entry.book, minBooks);
    if (!consensus) continue;

    // HOME selection
    if (entry.home !== null) {
      const { threshold_class, delta, reason_codes } = classifyLineDelta(
        entry.home, consensus.consensus_line_home, thresholds.spread
      );
      if (threshold_class !== 'NONE') {
        const candidate = {
          game_id:          snapshot.game_id,
          sport:            snapshot.sport,
          market_type:      'SPREAD',
          selection:        'HOME',
          source_book:      entry.book,
          consensus_books:  consensus.consensus_books,
          source_line:      entry.home,
          source_price:     entry.price_home,
          consensus_line:   consensus.consensus_line_home,
          consensus_price:  consensus.consensus_price_home,
          edge_type:        'LINE',
          stale_delta:      null,
          implied_edge_pct: null,
          threshold_class,
          reason_codes,
          captured_at:      snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }

    // AWAY selection
    if (entry.away !== null) {
      const { threshold_class, delta, reason_codes } = classifyLineDelta(
        entry.away, consensus.consensus_line_away, thresholds.spread
      );
      if (threshold_class !== 'NONE') {
        const candidate = {
          game_id:          snapshot.game_id,
          sport:            snapshot.sport,
          market_type:      'SPREAD',
          selection:        'AWAY',
          source_book:      entry.book,
          consensus_books:  consensus.consensus_books,
          source_line:      entry.away,
          source_price:     entry.price_away,
          consensus_line:   consensus.consensus_line_away,
          consensus_price:  consensus.consensus_price_away,
          edge_type:        'LINE',
          stale_delta:      null,
          implied_edge_pct: null,
          threshold_class,
          reason_codes,
          captured_at:      snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function scanTotals(snapshot, rawEntries, config) {
  const { thresholds, minBooks } = config;
  const normalized = rawEntries
    .map(normalizeTotalEntry)
    .filter(Boolean);
  const entries = deduplicateByBook(normalized);
  const candidates = [];

  for (const entry of entries) {
    const consensus = buildTotalConsensus(entries, entry.book, minBooks);
    if (!consensus) continue;

    const { threshold_class, delta, reason_codes } = classifyLineDelta(
      entry.line, consensus.consensus_line, thresholds.total
    );

    if (threshold_class !== 'NONE') {
      // Emit for OVER selection (line-level mispricing)
      const candidate = {
        game_id:          snapshot.game_id,
        sport:            snapshot.sport,
        market_type:      'TOTAL',
        selection:        'OVER',
        source_book:      entry.book,
        consensus_books:  consensus.consensus_books,
        source_line:      entry.line,
        source_price:     entry.over,
        consensus_line:   consensus.consensus_line,
        consensus_price:  consensus.consensus_over,
        edge_type:        'LINE',
        stale_delta:      null,
        implied_edge_pct: null,
        threshold_class,
        reason_codes,
        captured_at:      snapshot.captured_at,
      };
      assertNoForbiddenTerms(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function scanH2h(snapshot, rawEntries, config) {
  const { thresholds, minBooks } = config;
  const normalized = rawEntries
    .map(normalizeH2hEntry)
    .filter(Boolean);
  const entries = deduplicateByBook(normalized);
  const candidates = [];

  for (const entry of entries) {
    const consensus = buildH2hConsensus(entries, entry.book, minBooks);
    if (!consensus) continue;

    // HOME
    if (entry.home !== null) {
      const consensusPrices = entries
        .filter(e => e.book !== entry.book)
        .map(e => e.home)
        .filter(v => v !== null);

      const { threshold_class, implied_edge_pct, reason_codes } = classifyML(
        entry.home, consensusPrices, thresholds
      );

      if (threshold_class !== 'NONE') {
        const candidate = {
          game_id:          snapshot.game_id,
          sport:            snapshot.sport,
          market_type:      'ML',
          selection:        'HOME',
          source_book:      entry.book,
          consensus_books:  consensus.consensus_books,
          source_line:      null,
          source_price:     entry.home,
          consensus_line:   null,
          consensus_price:  consensus.consensus_home,
          edge_type:        'PRICE',
          stale_delta:      null,
          implied_edge_pct,
          threshold_class,
          reason_codes,
          captured_at:      snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }

    // AWAY
    if (entry.away !== null) {
      const consensusPrices = entries
        .filter(e => e.book !== entry.book)
        .map(e => e.away)
        .filter(v => v !== null);

      const { threshold_class, implied_edge_pct, reason_codes } = classifyML(
        entry.away, consensusPrices, thresholds
      );

      if (threshold_class !== 'NONE') {
        const candidate = {
          game_id:          snapshot.game_id,
          sport:            snapshot.sport,
          market_type:      'ML',
          selection:        'AWAY',
          source_book:      entry.book,
          consensus_books:  consensus.consensus_books,
          source_line:      null,
          source_price:     entry.away,
          consensus_line:   null,
          consensus_price:  consensus.consensus_away,
          edge_type:        'PRICE',
          stale_delta:      null,
          implied_edge_pct,
          threshold_class,
          reason_codes,
          captured_at:      snapshot.captured_at,
        };
        assertNoForbiddenTerms(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scan an array of odds snapshot rows for book-to-book mispricing.
 *
 * @param {Array<{game_id: string, sport: string, captured_at: string, raw_data: string}>} snapshots
 * @param {object} [config]
 * @param {number} [config.recencyWindowMs]  - Default: 30 minutes
 * @param {number} [config.minBooks]         - Default: 2
 * @param {object} [config.thresholds]       - Override threshold values
 * @returns {MispricingCandidate[]}
 */
function scanForMispricing(snapshots, config = {}) {
  const recencyWindowMs = config.recencyWindowMs ?? DEFAULT_RECENCY_WINDOW_MS;
  const minBooks        = config.minBooks        ?? DEFAULT_MIN_BOOKS;
  const thresholds      = config.thresholds
    ? mergeThresholds(config.thresholds)
    : DEFAULT_THRESHOLDS;

  const resolvedConfig  = { recencyWindowMs, minBooks, thresholds };
  const nowMs           = Date.now();
  const cutoffMs        = nowMs - recencyWindowMs;

  const candidates = [];

  for (const snapshot of snapshots) {
    try {
      // Recency gate
      const capturedMs = new Date(snapshot.captured_at).getTime();
      if (!isFinite(capturedMs) || capturedMs < cutoffMs) continue;

      // Parse raw_data
      let markets;
      try {
        const parsed = JSON.parse(snapshot.raw_data);
        markets = parsed && parsed.markets ? parsed.markets : {};
      } catch (e) {
        console.warn(`[MispricingScanner] WARN: failed to parse raw_data for game=${snapshot.game_id}: ${e.message}`);
        continue;
      }

      if (Array.isArray(markets.spreads) && markets.spreads.length > 0) {
        candidates.push(...scanSpreads(snapshot, markets.spreads, resolvedConfig));
      }
      if (Array.isArray(markets.totals) && markets.totals.length > 0) {
        candidates.push(...scanTotals(snapshot, markets.totals, resolvedConfig));
      }
      if (Array.isArray(markets.h2h) && markets.h2h.length > 0) {
        candidates.push(...scanH2h(snapshot, markets.h2h, resolvedConfig));
      }
      // PROP: intentionally not handled in v1
    } catch (e) {
      console.warn(`[MispricingScanner] WARN: error scanning game=${snapshot.game_id}: ${e.message}`);
    }
  }

  return candidates;
}

function mergeThresholds(override) {
  return {
    spread: { ...DEFAULT_THRESHOLDS.spread, ...(override.spread || {}) },
    total:  { ...DEFAULT_THRESHOLDS.total,  ...(override.total  || {}) },
    ml: {
      nearEven: { ...DEFAULT_THRESHOLDS.ml.nearEven, ...(override.ml?.nearEven || {}) },
      big:      { ...DEFAULT_THRESHOLDS.ml.big,      ...(override.ml?.big      || {}) },
    },
  };
}

module.exports = { scanForMispricing };
