'use strict';

const { resolveMLBModelSignal } = require('../../models/mlb-model');
const { resolveGoalieComposite } = require('../../models/nhl-pace-model');

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, digits = 4) {
  if (!isFiniteNumber(value)) return null;
  return Number(value.toFixed(digits));
}

function median(values) {
  const numbers = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 1) return numbers[middle];
  return round((numbers[middle - 1] + numbers[middle]) / 2);
}

function stddev(values) {
  const numbers = values.filter(isFiniteNumber);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return 0;
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const variance =
    numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numbers.length;
  return round(Math.sqrt(variance));
}

function americanToImplied(price) {
  if (!isFiniteNumber(price) || price === 0) return null;
  if (price > 0) return round(100 / (price + 100), 6);
  return round(Math.abs(price) / (Math.abs(price) + 100), 6);
}

function removeVig(priceA, priceB) {
  const impliedA = americanToImplied(priceA);
  const impliedB = americanToImplied(priceB);
  if (!isFiniteNumber(impliedA) || !isFiniteNumber(impliedB)) {
    return { fairProbA: null, fairProbB: null };
  }
  const total = impliedA + impliedB;
  if (!isFiniteNumber(total) || total <= 0) {
    return { fairProbA: null, fairProbB: null };
  }
  return {
    fairProbA: round(impliedA / total, 6),
    fairProbB: round(impliedB / total, 6),
  };
}

// Compute median of implied probabilities from an array of American-odds prices.
// Avoids the mixed-sign discontinuity: median([-105, -105, -102, 100, 100, 105])
// lands near 0 on the American scale (=> 0.99% implied), but the median of the
// corresponding implied probs is a well-behaved ~50%.
function medianImplied(prices) {
  return median(prices.map(americanToImplied));
}

// removeVig variant that accepts already-computed implied probabilities.
// Used in scoreCandidate to bypass re-conversion from American odds.
function removeVigFromImplied(impliedA, impliedB) {
  if (!isFiniteNumber(impliedA) || !isFiniteNumber(impliedB)) {
    return { fairProbA: null, fairProbB: null };
  }
  const total = impliedA + impliedB;
  if (!isFiniteNumber(total) || total <= 0) {
    return { fairProbA: null, fairProbB: null };
  }
  return {
    fairProbA: round(impliedA / total, 6),
    fairProbB: round(impliedB / total, 6),
  };
}

// Sport+market noise floors. Each value is the minimum gross edge required
// for a candidate to be distinguishable from model estimation error.
// All values are independently env-var overridable.
const NOISE_FLOORS = {
  MLB: {
    MONEYLINE: Number(process.env.POTD_NOISE_FLOOR_MLB_ML     || 0.03),
    SPREAD:    Number(process.env.POTD_NOISE_FLOOR_MLB_SPREAD  || 0.025),
  },
  NHL: {
    MONEYLINE: Number(process.env.POTD_NOISE_FLOOR_NHL_ML     || 0.02),
    SPREAD:    Number(process.env.POTD_NOISE_FLOOR_NHL_SPREAD  || 0.02),
  },
  NBA: {
    MONEYLINE: Number(process.env.POTD_NOISE_FLOOR_NBA_ML     || 0.025),
    SPREAD:    Number(process.env.POTD_NOISE_FLOOR_NBA_SPREAD  || 0.02),
    TOTAL:     Number(process.env.POTD_NOISE_FLOOR_NBA_TOTAL   || 0.02),
  },
};

// Canonical per-sport/market edge source contract (WI-1032).
// MODEL = edge derived from a calibrated predictive model.
// CONSENSUS_FALLBACK = edge derived from market devigging (best book vs consensus).
// Update this table when a new model signal is wired in for a market.
// After WI-1030 ships, update NBA TOTAL to 'MODEL'.
const EDGE_SOURCE_CONTRACT = Object.freeze({
  MLB: Object.freeze({ MONEYLINE: 'MODEL', SPREAD: 'CONSENSUS_FALLBACK', TOTAL: 'CONSENSUS_FALLBACK' }),
  NHL: Object.freeze({ MONEYLINE: 'MODEL', SPREAD: 'CONSENSUS_FALLBACK', TOTAL: 'CONSENSUS_FALLBACK' }),
  NBA: Object.freeze({ MONEYLINE: 'CONSENSUS_FALLBACK', SPREAD: 'CONSENSUS_FALLBACK', TOTAL: 'MODEL' }),
  NFL: Object.freeze({ MONEYLINE: 'CONSENSUS_FALLBACK', SPREAD: 'CONSENSUS_FALLBACK', TOTAL: 'CONSENSUS_FALLBACK' }),
});

/**
 * Returns 'MODEL', 'CONSENSUS_FALLBACK', or 'UNKNOWN' for the given sport+market.
 * Strips API-prefix variants (BASEBALL_, ICEHOCKEY_, BASKETBALL_, AMERICANFOOTBALL_).
 */
function resolveEdgeSourceContract(sport, marketType) {
  const sportKey = String(sport || '')
    .toUpperCase()
    .replace('BASEBALL_', '')
    .replace('ICEHOCKEY_', '')
    .replace('BASKETBALL_', '')
    .replace('AMERICANFOOTBALL_', '');
  const marketKey = String(marketType || '').toUpperCase();
  return EDGE_SOURCE_CONTRACT[sportKey]?.[marketKey] ?? 'UNKNOWN';
}

/**
 * Returns the minimum gross edge (noise floor) for a sport+market combination.
 * Strips API-prefixes (BASEBALL_, ICEHOCKEY_, BASKETBALL_) before lookup.
 * Falls back to globalFallback (default 0.02) for unknown sport/market pairs.
 */
function resolveNoiseFloor(sport, marketType, globalFallback = 0.02) {
  const sportKey = String(sport || '')
    .toUpperCase()
    .replace('BASEBALL_', '')
    .replace('ICEHOCKEY_', '')
    .replace('BASKETBALL_', '');
  const marketKey = String(marketType || '').toUpperCase();
  return NOISE_FLOORS[sportKey]?.[marketKey] ?? globalFallback;
}

function confidenceThreshold(minConfidence) {
  if (typeof minConfidence === 'number') return minConfidence;
  const token = String(minConfidence || 'HIGH').trim().toUpperCase();
  if (token === 'ELITE') return 0.75;
  if (token === 'HIGH') return 0.5;
  return 0;
}

function confidenceLabel(score) {
  if (!isFiniteNumber(score)) return 'LOW';
  if (score >= 0.75) return 'ELITE';
  if (score >= 0.5) return 'HIGH';
  return 'LOW';
}

function confidenceMultiplier(label) {
  return { ELITE: 1.0, HIGH: 0.85, MEDIUM: 0.65, LOW: 0.40 }[label] ?? 0.85;
}

function isMlbSport(sport) {
  const token = String(sport || '').trim().toUpperCase();
  return token === 'MLB' || token === 'BASEBALL_MLB';
}

function isNhlSport(sport) {
  const token = String(sport || '').trim().toUpperCase();
  return token === 'NHL' || token === 'ICEHOCKEY_NHL';
}

function resolveNHLModelSignal(game) {
  const snap = game?.nhlSnapshot;
  if (!snap) return null;
  const home = snap.homeGoalie ?? {};
  const away = snap.awayGoalie ?? {};
  const homeHasData = home.savePct != null || home.gsax != null;
  const awayHasData = away.savePct != null || away.gsax != null;
  if (!homeHasData && !awayHasData) return null;

  // Use neutral composite (0.5) for a side with no data
  const homeComposite = homeHasData
    ? resolveGoalieComposite(home.savePct, home.gsax)
    : { composite: 0.5 };
  const awayComposite = awayHasData
    ? resolveGoalieComposite(away.savePct, away.gsax)
    : { composite: 0.5 };

  const goalieEdgeDelta = clamp(
    homeComposite.composite - awayComposite.composite,
    -0.06,
    0.06
  );

  // consensusImpliedHome: median of implied probs from h2h home prices
  // Raw h2h rows use { home, away } field names (not homePrice/awayPrice).
  const h2hRows = game.market?.h2h || [];
  const homePrices = h2hRows.map((r) => r?.home ?? r?.homePrice).filter(isFiniteNumber);
  const awayPrices = h2hRows.map((r) => r?.away ?? r?.awayPrice).filter(isFiniteNumber);
  const rawHomeImplied = medianImplied(homePrices);
  const rawAwayImplied = medianImplied(awayPrices);
  if (!isFiniteNumber(rawHomeImplied) || !isFiniteNumber(rawAwayImplied)) return null;
  const { fairProbA: consensusImpliedHome } = removeVigFromImplied(rawHomeImplied, rawAwayImplied);
  if (!isFiniteNumber(consensusImpliedHome)) return null;

  const homeModelWinProb = clamp(consensusImpliedHome + goalieEdgeDelta, 0.05, 0.95);
  const projection_source =
    homeHasData && awayHasData ? 'NHL_GOALIE_COMPOSITE' : 'NHL_GOALIE_PARTIAL';

  return { homeModelWinProb: round(homeModelWinProb, 6), projection_source };
}

function resolveNBAModelSignal(game) {
  const snap = game?.nbaSnapshot;
  if (!snap || !Number.isFinite(snap.totalProjection)) return null;
  return {
    totalProjection: snap.totalProjection,
    projection_source: snap.projection_source ?? 'NBA_TOTALS_MODEL',
  };
}

function toSelectionLabel({ selection, homeTeam, awayTeam, line }) {
  if (selection === 'HOME') {
    return `${homeTeam}${isFiniteNumber(line) ? ` ${line > 0 ? '+' : ''}${line}` : ''}`.trim();
  }
  if (selection === 'AWAY') {
    return `${awayTeam}${isFiniteNumber(line) ? ` ${line > 0 ? '+' : ''}${line}` : ''}`.trim();
  }
  if (selection === 'OVER' || selection === 'UNDER') {
    return `${selection} ${line}`;
  }
  return selection;
}

function selectBestRow(rows, { lineKey = null, priceKey, linePreference = 'higher' }) {
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const price = row?.[priceKey];
    if (!isFiniteNumber(price)) continue;
    const line = lineKey ? row?.[lineKey] : null;
    if (lineKey && !isFiniteNumber(line)) continue;
    if (!best) {
      best = { row, line, price };
      continue;
    }
    const betterLine =
      !lineKey
        ? false
        : linePreference === 'lower'
          ? line < best.line
          : line > best.line;
    const tiedLine = !lineKey || line === best.line;
    const betterPrice = price > best.price;
    if (betterLine || (tiedLine && betterPrice)) {
      best = { row, line, price };
    }
  }
  return best;
}

function computeConsensus(entries, marketType) {
  const rows = Array.isArray(entries) ? entries : [];
  if (marketType === 'SPREAD') {
    return {
      homeLine: median(rows.map((row) => row.home_line)),
      awayLine: median(rows.map((row) => row.away_line)),
      homePrice: median(rows.map((row) => row.home_price)),
      awayPrice: median(rows.map((row) => row.away_price)),
      homeImplied: medianImplied(rows.map((row) => row.home_price)),
      awayImplied: medianImplied(rows.map((row) => row.away_price)),
    };
  }
  if (marketType === 'TOTAL') {
    return {
      line: median(rows.map((row) => row.line)),
      overPrice: median(rows.map((row) => row.over)),
      underPrice: median(rows.map((row) => row.under)),
      overImplied: medianImplied(rows.map((row) => row.over)),
      underImplied: medianImplied(rows.map((row) => row.under)),
    };
  }
  return {
    homePrice: median(rows.map((row) => row.home)),
    awayPrice: median(rows.map((row) => row.away)),
    homeImplied: medianImplied(rows.map((row) => row.home)),
    awayImplied: medianImplied(rows.map((row) => row.away)),
  };
}

function buildMarketConsensusScore({ lineValues = [], priceValues = [], sourceCount, marketType }) {
  const lineDispersion = stddev(lineValues);
  const priceDispersion = stddev(priceValues);
  const sourceScore = clamp(((sourceCount || 0) - 1) / 4, 0, 1);

  // Fixed-line markets (e.g. MLB runline +-1.5, NHL puck line +-1.5) always have
  // zero line dispersion. Treat them like MONEYLINE so they don't receive an
  // unearned lineScore=1.0 boost; score on price quality only instead.
  const isFixedLine =
    marketType !== 'MONEYLINE' &&
    lineValues.length > 1 &&
    lineDispersion === 0 &&
    lineValues.every((v) => isFiniteNumber(v) && Math.abs(v) === 1.5);

  const effectiveType = isFixedLine ? 'MONEYLINE' : marketType;

  const lineScale = effectiveType === 'MONEYLINE' ? 1 : 1.5;
  const lineScore =
    effectiveType === 'MONEYLINE'
      ? null
      : lineDispersion === null
        ? 0.5
        : clamp(1 - lineDispersion / lineScale, 0, 1);
  const priceScore =
    priceDispersion === null
      ? 0.5
      : clamp(1 - priceDispersion / 40, 0, 1);

  if (effectiveType === 'MONEYLINE') {
    return round(priceScore * 0.7 + sourceScore * 0.3, 6);
  }

  return round((lineScore * 0.55) + (priceScore * 0.2) + (sourceScore * 0.25), 6);
}

function buildSpreadCandidates(game) {
  const rows = Array.isArray(game?.market?.spreads) ? game.market.spreads : [];
  const consensus = computeConsensus(rows, 'SPREAD');
  const homeBest = selectBestRow(rows, {
    lineKey: 'home_line',
    priceKey: 'home_price',
    linePreference: 'higher',
  });
  const awayBest = selectBestRow(rows, {
    lineKey: 'away_line',
    priceKey: 'away_price',
    linePreference: 'higher',
  });

  const candidates = [];
  if (homeBest) {
    candidates.push({
      gameId: game.gameId,
      sport: game.sport,
      home_team: game.homeTeam,
      away_team: game.awayTeam,
      commence_time: game.gameTimeUtc,
      marketType: 'SPREAD',
      selection: 'HOME',
      selectionLabel: toSelectionLabel({
        selection: 'HOME',
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        line: homeBest.line,
      }),
      line: homeBest.line,
      price: homeBest.price,
      oddsContext: {
        bookmaker: homeBest.row.book || null,
        spread_home: homeBest.line,
        spread_away: isFiniteNumber(homeBest.line) ? round(homeBest.line * -1) : null,
        spread_price_home: homeBest.price,
        spread_price_away: isFiniteNumber(homeBest.row.away_price) ? homeBest.row.away_price : consensus.awayPrice,
        captured_at: game.capturedAtUtc || new Date().toISOString(),
        market_rows: rows,
      },
      consensusLine: consensus.homeLine,
      consensusPrice: consensus.homePrice,
      counterpartConsensusPrice: consensus.awayPrice,
      consensusImplied: consensus.homeImplied,
      counterpartConsensusImplied: consensus.awayImplied,
      comparableLines: rows.map((row) => row.home_line),
      comparablePrices: rows.map((row) => row.home_price),
      sourceCount: rows.length,
    });
  }
  if (awayBest) {
    candidates.push({
      gameId: game.gameId,
      sport: game.sport,
      home_team: game.homeTeam,
      away_team: game.awayTeam,
      commence_time: game.gameTimeUtc,
      marketType: 'SPREAD',
      selection: 'AWAY',
      selectionLabel: toSelectionLabel({
        selection: 'AWAY',
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        line: awayBest.line,
      }),
      line: awayBest.line,
      price: awayBest.price,
      oddsContext: {
        bookmaker: awayBest.row.book || null,
        spread_home: isFiniteNumber(awayBest.line) ? round(awayBest.line * -1) : null,
        spread_away: awayBest.line,
        spread_price_home: isFiniteNumber(awayBest.row.home_price) ? awayBest.row.home_price : consensus.homePrice,
        spread_price_away: awayBest.price,
        captured_at: game.capturedAtUtc || new Date().toISOString(),
        market_rows: rows,
      },
      consensusLine: consensus.awayLine,
      consensusPrice: consensus.awayPrice,
      counterpartConsensusPrice: consensus.homePrice,
      consensusImplied: consensus.awayImplied,
      counterpartConsensusImplied: consensus.homeImplied,
      comparableLines: rows.map((row) => row.away_line),
      comparablePrices: rows.map((row) => row.away_price),
      sourceCount: rows.length,
    });
  }

  return candidates;
}

function buildTotalCandidates(game) {
  const rows = Array.isArray(game?.market?.totals) ? game.market.totals : [];
  const consensus = computeConsensus(rows, 'TOTAL');
  const overBest = selectBestRow(rows, {
    lineKey: 'line',
    priceKey: 'over',
    linePreference: 'lower',
  });
  const underBest = selectBestRow(rows, {
    lineKey: 'line',
    priceKey: 'under',
    linePreference: 'higher',
  });

  const candidates = [];
  if (overBest) {
    candidates.push({
      gameId: game.gameId,
      sport: game.sport,
      home_team: game.homeTeam,
      away_team: game.awayTeam,
      commence_time: game.gameTimeUtc,
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: toSelectionLabel({
        selection: 'OVER',
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        line: overBest.line,
      }),
      line: overBest.line,
      price: overBest.price,
      oddsContext: {
        bookmaker: overBest.row.book || null,
        total: overBest.line,
        total_price_over: overBest.price,
        total_price_under: isFiniteNumber(overBest.row.under) ? overBest.row.under : consensus.underPrice,
        captured_at: game.capturedAtUtc || new Date().toISOString(),
        market_rows: rows,
      },
      consensusLine: consensus.line,
      consensusPrice: consensus.overPrice,
      counterpartConsensusPrice: consensus.underPrice,
      consensusImplied: consensus.overImplied,
      counterpartConsensusImplied: consensus.underImplied,
      comparableLines: rows.map((row) => row.line),
      comparablePrices: rows.map((row) => row.over),
      sourceCount: rows.length,
    });
  }
  if (underBest) {
    candidates.push({
      gameId: game.gameId,
      sport: game.sport,
      home_team: game.homeTeam,
      away_team: game.awayTeam,
      commence_time: game.gameTimeUtc,
      marketType: 'TOTAL',
      selection: 'UNDER',
      selectionLabel: toSelectionLabel({
        selection: 'UNDER',
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        line: underBest.line,
      }),
      line: underBest.line,
      price: underBest.price,
      oddsContext: {
        bookmaker: underBest.row.book || null,
        total: underBest.line,
        total_price_over: isFiniteNumber(underBest.row.over) ? underBest.row.over : consensus.overPrice,
        total_price_under: underBest.price,
        captured_at: game.capturedAtUtc || new Date().toISOString(),
        market_rows: rows,
      },
      consensusLine: consensus.line,
      consensusPrice: consensus.underPrice,
      counterpartConsensusPrice: consensus.overPrice,
      consensusImplied: consensus.underImplied,
      counterpartConsensusImplied: consensus.overImplied,
      comparableLines: rows.map((row) => row.line),
      comparablePrices: rows.map((row) => row.under),
      sourceCount: rows.length,
    });
  }

  return candidates;
}

function buildMoneylineCandidates(game) {
  const rows = Array.isArray(game?.market?.h2h) ? game.market.h2h : [];
  const consensus = computeConsensus(rows, 'MONEYLINE');
  const homeBest = selectBestRow(rows, { priceKey: 'home' });
  const awayBest = selectBestRow(rows, { priceKey: 'away' });

  const candidates = [];
  if (homeBest) {
    candidates.push({
      gameId: game.gameId,
      sport: game.sport,
      home_team: game.homeTeam,
      away_team: game.awayTeam,
      commence_time: game.gameTimeUtc,
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: game.homeTeam,
      line: null,
      price: homeBest.price,
      oddsContext: {
        bookmaker: homeBest.row.book || null,
        h2h_home: homeBest.price,
        h2h_away: isFiniteNumber(homeBest.row.away) ? homeBest.row.away : consensus.awayPrice,
        captured_at: game.capturedAtUtc || new Date().toISOString(),
        market_rows: rows,
      },
      consensusLine: null,
      consensusPrice: consensus.homePrice,
      counterpartConsensusPrice: consensus.awayPrice,
      consensusImplied: consensus.homeImplied,
      counterpartConsensusImplied: consensus.awayImplied,
      comparableLines: [],
      comparablePrices: rows.map((row) => row.home),
      sourceCount: rows.length,
    });
  }
  if (awayBest) {
    candidates.push({
      gameId: game.gameId,
      sport: game.sport,
      home_team: game.homeTeam,
      away_team: game.awayTeam,
      commence_time: game.gameTimeUtc,
      marketType: 'MONEYLINE',
      selection: 'AWAY',
      selectionLabel: game.awayTeam,
      line: null,
      price: awayBest.price,
      oddsContext: {
        bookmaker: awayBest.row.book || null,
        h2h_home: isFiniteNumber(awayBest.row.home) ? awayBest.row.home : consensus.homePrice,
        h2h_away: awayBest.price,
        captured_at: game.capturedAtUtc || new Date().toISOString(),
        market_rows: rows,
      },
      consensusLine: null,
      consensusPrice: consensus.awayPrice,
      counterpartConsensusPrice: consensus.homePrice,
      consensusImplied: consensus.awayImplied,
      counterpartConsensusImplied: consensus.homeImplied,
      comparableLines: [],
      comparablePrices: rows.map((row) => row.away),
      sourceCount: rows.length,
    });
  }

  return candidates;
}

function buildCandidates(game) {
  if (
    !game ||
    !game.gameId ||
    !game.homeTeam ||
    !game.awayTeam ||
    !game.gameTimeUtc ||
    !game.market ||
    typeof game.market !== 'object'
  ) {
    return [];
  }

  const candidates = [
    ...buildSpreadCandidates(game),
    ...buildTotalCandidates(game),
    ...buildMoneylineCandidates(game),
  ];

  if (!isMlbSport(game.sport) || !game.oddsSnapshot) {
    // NHL model signal block
    if (isNhlSport(game.sport) && game.nhlSnapshot) {
      const nhlSignal = resolveNHLModelSignal(game);
      if (nhlSignal) {
        return candidates.map((candidate) => ({ ...candidate, nhlSignal }));
      }
    }
    // NBA model signal block: inject nbaSnapshot onto TOTAL candidates only
    if (String(game.sport || '').toUpperCase() === 'NBA' && game.nbaSnapshot) {
      const nbaSignal = resolveNBAModelSignal(game);
      if (nbaSignal) {
        return candidates.map((candidate) =>
          candidate.marketType === 'TOTAL'
            ? { ...candidate, nbaSnapshot: game.nbaSnapshot }
            : candidate
        );
      }
    }
    return candidates;
  }

  const mlbSignal = resolveMLBModelSignal(game);
  if (!mlbSignal) {
    return candidates;
  }

  return candidates.map((candidate) => ({
    ...candidate,
    mlbSignal,
  }));
}

function qualityLabel(score) {
  if (score >= 0.67) return 'strong';
  if (score >= 0.5) return 'solid';
  return 'below average';
}

function buildReasoningString({
  selectionLabel,
  price,
  edgePct,
  modelWinProb,
  lineValue,
  marketConsensus,
  marketType,
  projectionSource,
}) {
  const priceStr = price > 0 ? `+${price}` : String(price);
  const edgeStr = isFiniteNumber(edgePct)
    ? `edge +${(edgePct * 100).toFixed(1)}pp`
    : null;
  const winProbStr = isFiniteNumber(modelWinProb)
    ? `win prob ${(modelWinProb * 100).toFixed(1)}%`
    : null;
  const stats = [
    edgeStr,
    winProbStr,
    `line value ${qualityLabel(lineValue)}`,
    `market consensus ${qualityLabel(marketConsensus)}`,
  ]
    .filter(Boolean)
    .join(', ');

  if (marketType === 'MONEYLINE' && projectionSource) {
    const sourceLabel = projectionSource.startsWith('FULL_MODEL')
      ? 'Full model projection'
      : `Model projection (${projectionSource})`;
    return `${sourceLabel} backs ${selectionLabel} at ${priceStr}: ${stats}.`;
  }

  return `Model likes ${selectionLabel} at ${priceStr}: ${stats}.`;
}

function scoreCandidate(candidate) {
  if (!candidate || !isFiniteNumber(candidate.price)) {
    return null;
  }

  const impliedProb = americanToImplied(candidate.price);
  if (!isFiniteNumber(impliedProb)) return null;

  let lineDelta = 0;
  if (candidate.marketType === 'SPREAD') {
    lineDelta = isFiniteNumber(candidate.line) && isFiniteNumber(candidate.consensusLine)
      ? candidate.line - candidate.consensusLine
      : 0;
  } else if (candidate.marketType === 'TOTAL') {
    if (isFiniteNumber(candidate.line) && isFiniteNumber(candidate.consensusLine)) {
      lineDelta =
        candidate.selection === 'OVER'
          ? candidate.consensusLine - candidate.line
          : candidate.line - candidate.consensusLine;
    }
  }

  const priceDelta =
    isFiniteNumber(candidate.consensusPrice) && isFiniteNumber(candidate.price)
      ? candidate.price - candidate.consensusPrice
      : 0;

  // Parity with consensus is neutral at 0.5. Better lines/prices push toward 1.0.
  // Divide lineDelta by the consensus line magnitude so a 1-point delta on a
  // ±1.5 runline (~0.67/pt) is correctly valued more than the same delta on a
  // 7-point NBA spread (~0.14/pt). Floor at 1 avoids divide-by-zero.
  const lineComponent =
    candidate.marketType === 'MONEYLINE'
      ? 0.5
      : clamp(
          0.5 + lineDelta / Math.max(Math.abs(candidate.consensusLine), 1),
          0,
          1
        );
  const priceComponent = clamp(0.5 + priceDelta / 80, 0, 1);
  const lineValue =
    candidate.marketType === 'MONEYLINE'
      ? round(priceComponent, 6)
      : round((lineComponent * 0.75) + (priceComponent * 0.25), 6);

  const marketConsensus = buildMarketConsensusScore({
    lineValues: candidate.comparableLines,
    priceValues: candidate.comparablePrices,
    sourceCount: candidate.sourceCount,
    marketType: candidate.marketType,
  });

  // Use median-of-implied-probs consensus to avoid mixed-sign American-odds median
  // producing a near-zero implied probability (e.g. [-105,-105,-102,100,100,105] => -1).
  // Candidates from buildMoneylineCandidates et al. carry pre-computed consensusImplied;
  // hand-crafted or legacy candidates fall back to deriving implied from American odds.
  // fairProbA is always the selection's own win probability.
  const impliedConsensus = isFiniteNumber(candidate.consensusImplied)
    ? candidate.consensusImplied
    : americanToImplied(candidate.consensusPrice);
  const impliedCounterpart = isFiniteNumber(candidate.counterpartConsensusImplied)
    ? candidate.counterpartConsensusImplied
    : americanToImplied(candidate.counterpartConsensusPrice);
  const fairPair = removeVigFromImplied(impliedConsensus, impliedCounterpart);
  const modelFairProbability = fairPair.fairProbA;

  if (!isFiniteNumber(modelFairProbability)) return null;

  // MLB model override: replace consensus fair prob + edge with pitcher-quality model signal
  const mlbSignal = candidate.mlbSignal ?? null;
  const useMlbModelSignal =
    isMlbSport(candidate.sport) &&
    candidate.marketType === 'MONEYLINE' &&
    Number.isFinite(mlbSignal?.modelWinProb) &&
    Number.isFinite(mlbSignal?.edge);
  if (useMlbModelSignal) {
    const modelEdge = round(mlbSignal.edge, 6);
    const totalScore = round((lineValue * 0.625) + (marketConsensus * 0.375), 6);
    return {
      ...candidate,
      lineValue,
      marketConsensus,
      totalScore,
      modelWinProb: round(mlbSignal.modelWinProb, 6),
      impliedProb,
      edgePct: modelEdge,
      edgeSourceTag: 'MODEL',
      edgeSourceMeta: {
        projection_source: mlbSignal.projection_source ?? null,
        model_win_prob: round(mlbSignal.modelWinProb, 6),
        signal_type: 'MLB_PITCHER_MODEL',
      },
      confidenceLabel: confidenceLabel(totalScore),
      scoreBreakdown: {
        lineValue,
        marketConsensus,
        model_win_prob: round(mlbSignal.modelWinProb, 6),
        projection_source: mlbSignal.projection_source ?? null,
      },
      reasoning: buildReasoningString({
        selectionLabel: candidate.selectionLabel,
        price: candidate.price,
        edgePct: modelEdge,
        modelWinProb: round(mlbSignal.modelWinProb, 6),
        lineValue,
        marketConsensus,
        marketType: candidate.marketType,
        projectionSource: mlbSignal.projection_source ?? null,
      }),
    };
  }

  // NHL model override: replace consensus fair prob + edge with goalie-composite signal
  const nhlSignal = candidate.nhlSignal ?? null;
  const useNhlModelSignal =
    isNhlSport(candidate.sport) &&
    candidate.marketType === 'MONEYLINE' &&
    Number.isFinite(nhlSignal?.homeModelWinProb);
  if (useNhlModelSignal) {
    const modelWinProb =
      candidate.selection === 'HOME'
        ? nhlSignal.homeModelWinProb
        : round(1 - nhlSignal.homeModelWinProb, 6);
    const modelEdge = round(modelWinProb - impliedProb, 6);
    const totalScore = round((lineValue * 0.625) + (marketConsensus * 0.375), 6);
    return {
      ...candidate,
      lineValue,
      marketConsensus,
      totalScore,
      modelWinProb,
      impliedProb,
      edgePct: modelEdge,
      edgeSourceTag: 'MODEL',
      edgeSourceMeta: {
        projection_source: nhlSignal.projection_source ?? null,
        model_win_prob: modelWinProb,
        signal_type: 'NHL_GOALIE_COMPOSITE',
      },
      confidenceLabel: confidenceLabel(totalScore),
      scoreBreakdown: {
        lineValue,
        marketConsensus,
        model_win_prob: modelWinProb,
        projection_source: nhlSignal.projection_source ?? null,
      },
      reasoning: buildReasoningString({
        selectionLabel: candidate.selectionLabel,
        price: candidate.price,
        edgePct: modelEdge,
        modelWinProb,
        lineValue,
        marketConsensus,
        marketType: candidate.marketType,
        projectionSource: nhlSignal.projection_source ?? null,
      }),
    };
  }

  // NBA totals model override: replace consensus edge with total projection signal (WI-1030)
  const nbaSignal = candidate.nbaSnapshot ? resolveNBAModelSignal({ nbaSnapshot: candidate.nbaSnapshot }) : null;
  const useNbaModelSignal =
    String(candidate.sport || '').toUpperCase() === 'NBA' &&
    candidate.marketType === 'TOTAL' &&
    nbaSignal !== null;
  if (useNbaModelSignal) {
    const refLine = isFiniteNumber(candidate.consensusLine) ? candidate.consensusLine : candidate.line;
    const modelOverProb = clamp(0.5 + (nbaSignal.totalProjection - refLine) / 20, 0.05, 0.95);
    const modelSelectionProb = candidate.selection === 'OVER'
      ? round(modelOverProb, 6)
      : round(1 - modelOverProb, 6);
    const modelEdge = round(modelSelectionProb - impliedProb, 6);
    const totalScore = round((lineValue * 0.625) + (marketConsensus * 0.375), 6);
    return {
      ...candidate,
      lineValue,
      marketConsensus,
      totalScore,
      modelWinProb: modelSelectionProb,
      impliedProb,
      edgePct: modelEdge,
      edgeSourceTag: 'MODEL',
      edgeSourceMeta: {
        projection_source: nbaSignal.projection_source,
        model_win_prob: modelSelectionProb,
        signal_type: 'NBA_TOTALS_MODEL',
      },
      confidenceLabel: confidenceLabel(totalScore),
      scoreBreakdown: {
        lineValue,
        marketConsensus,
        model_win_prob: modelSelectionProb,
        projection_source: nbaSignal.projection_source,
      },
      reasoning: buildReasoningString({
        selectionLabel: candidate.selectionLabel,
        price: candidate.price,
        edgePct: modelEdge,
        modelWinProb: modelSelectionProb,
        lineValue,
        marketConsensus,
        marketType: candidate.marketType,
        projectionSource: nbaSignal.projection_source,
      }),
    };
  }

  const edgePct = round(modelFairProbability - impliedProb, 6);
  const totalScore = round((lineValue * 0.625) + (marketConsensus * 0.375), 6);

  return {
    ...candidate,
    lineValue,
    marketConsensus,
    totalScore,
    modelWinProb: modelFairProbability,
    impliedProb,
    edgePct,
    edgeSourceTag: 'CONSENSUS_FALLBACK',
    edgeSourceMeta: {
      projection_source: null,
      model_win_prob: modelFairProbability,
      signal_type: 'DEVIG_CONSENSUS',
    },
    confidenceLabel: confidenceLabel(totalScore),
    scoreBreakdown: {
      lineValue,
      marketConsensus,
    },
    reasoning: buildReasoningString({
      selectionLabel: candidate.selectionLabel,
      price: candidate.price,
      edgePct,
      modelWinProb: modelFairProbability,
      lineValue,
      marketConsensus,
      marketType: candidate.marketType,
      projectionSource: null,
    }),
  };
}

// Returns up to maxNominees sport winners ranked by totalScore -> edgePct -> stable key.
// One candidate per sport (prevents high-volume sports from flooding the list).
function selectTopPlays(scoredCandidates, { minConfidence = 'HIGH', minEdgePct = null, maxNominees = 5, requirePositiveEdge = true } = {}) {
  const threshold = confidenceThreshold(minConfidence);
  const hasEdgeFloor = isFiniteNumber(minEdgePct);
  const viable = (Array.isArray(scoredCandidates) ? scoredCandidates : [])
    .filter(Boolean)
    .filter((c) => isFiniteNumber(c.edgePct))
    .filter((c) => !requirePositiveEdge || c.edgePct > 0)
    .filter((c) => !hasEdgeFloor || c.edgePct >= minEdgePct)
    .filter((c) => isFiniteNumber(c.totalScore) && c.totalScore >= threshold);

  if (viable.length === 0) return [];

  // Pick the best candidate per sport first, then compare sport winners.
  // This prevents high-volume sports (e.g. 14+ MLB games/day) from dominating
  // purely through candidate count rather than signal quality.
  const bySport = {};
  for (const candidate of viable) {
    const key = candidate.sport || '__unknown__';
    const curr = bySport[key];
    const candStableKey = `${candidate.sport || ''}:${candidate.gameId || ''}:${candidate.marketType || ''}`;
    const currStableKey = curr ? `${curr.sport || ''}:${curr.gameId || ''}:${curr.marketType || ''}` : '';
    if (
      !curr ||
      candidate.totalScore > curr.totalScore ||
      (candidate.totalScore === curr.totalScore && (candidate.edgePct || 0) > (curr.edgePct || 0)) ||
      (candidate.totalScore === curr.totalScore && (candidate.edgePct || 0) === (curr.edgePct || 0) && candStableKey < currStableKey)
    ) {
      bySport[key] = candidate;
    }
  }

  return Object.values(bySport)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if ((b.edgePct || 0) !== (a.edgePct || 0)) return (b.edgePct || 0) - (a.edgePct || 0);
      const keyA = `${a.sport || ''}:${a.gameId || ''}:${a.marketType || ''}`;
      const keyB = `${b.sport || ''}:${b.gameId || ''}:${b.marketType || ''}`;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    })
    .slice(0, maxNominees);
}

function selectBestPlay(scoredCandidates, options = {}) {
  const { minConfidence = 'HIGH', minEdgePct = 0 } = options;
  return selectTopPlays(scoredCandidates, { minConfidence, minEdgePct, maxNominees: 1 })[0] || null;
}

function kellySize({
  edgePct,
  impliedProb,
  bankroll,
  kellyFraction = 0.25,
  maxWagerPct = 0.2,
}) {
  if (
    !isFiniteNumber(edgePct) ||
    edgePct <= 0 ||
    !isFiniteNumber(impliedProb) ||
    impliedProb <= 0 ||
    impliedProb >= 1 ||
    !isFiniteNumber(bankroll) ||
    bankroll <= 0
  ) {
    return 0;
  }

  const winProb = impliedProb + edgePct;
  if (!isFiniteNumber(winProb) || winProb <= 0 || winProb >= 1) return 0;

  const decimalOdds = 1 / impliedProb;
  const b = decimalOdds - 1;
  if (!isFiniteNumber(b) || b <= 0) return 0;

  const q = 1 - winProb;
  const rawKelly = ((b * winProb) - q) / b;
  if (!isFiniteNumber(rawKelly) || rawKelly <= 0) return 0;

  const stakeFraction = clamp(rawKelly * kellyFraction, 0, maxWagerPct);
  return round(bankroll * stakeFraction, 2) || 0;
}

module.exports = {
  americanToImplied,
  buildCandidates,
  confidenceMultiplier,
  confidenceThreshold,
  EDGE_SOURCE_CONTRACT,
  isNhlSport,
  kellySize,
  removeVig,
  resolveEdgeSourceContract,
  resolveNHLModelSignal,
  resolveNoiseFloor,
  scoreCandidate,
  selectBestPlay,
  selectTopPlays,
};
