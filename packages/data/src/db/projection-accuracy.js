'use strict';

/**
 * projection-accuracy.js — WI-0864
 *
 * Data access layer for projection-only accuracy.
 *
 * All functions accept `db` as first argument (better-sqlite3 / DatabaseProxy instance).
 */

const TRACKED_PROJECTION_ACCURACY_CARD_TYPES = Object.freeze({
  'nba-totals-call': Object.freeze({
    marketFamily: 'NBA_TOTAL',
    actualKeys: ['total_score'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: [
      'projection_accuracy.projection_raw',
      'projection.total',
      'odds_context.projection_comparison',
      'odds_context.projection_comparison.fair_line_from_projection',
    ],
    propType: 'game_total',
    identity: 'game',
  }),
  'nba-total-projection': Object.freeze({
    marketFamily: 'NBA_TOTAL',
    actualKeys: ['total_score'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: [
      'projection_accuracy.projection_raw',
      'projection.total',
    ],
    propType: 'game_total',
    identity: 'game',
  }),
  'mlb-f5': Object.freeze({
    marketFamily: 'MLB_F5_TOTAL',
    actualKeys: ['runs_f5'],
    defaultPeriod: 'F5',
    projectionKeys: [
      'projection_accuracy.projection_raw',
      'projection.projected_total',
      'projected_total',
      'decision.model_projection',
      'drivers.0.projected',
    ],
    propType: 'f5_total',
    identity: 'game',
  }),
  'mlb-f5-ml': Object.freeze({
    marketFamily: 'MLB_F5_ML',
    actualKeys: ['f5_ml_actual'],
    defaultPeriod: 'F5',
    projectionKeys: [
      'projection_accuracy.win_probability',
      'win_probability',
      'p_fair',
      'fair_prob',
      'model_prob',
      'projection.projected_win_prob_home',
      'drivers.0.projected_win_prob_home',
      'drivers.0.win_prob_home',
    ],
    propType: 'f5_moneyline',
    identity: 'game',
  }),
  'nhl-player-shots': Object.freeze({
    marketFamily: 'NHL_PLAYER_SHOTS',
    actualKeys: ['shots'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: [
      'projection_accuracy.projection_raw',
      'decision.projection',
      'decision.model_projection',
      'projectedTotal',
      'mu',
      'drivers.sog_mu',
    ],
    propType: 'shots_on_goal',
    identity: 'player',
  }),
  'nhl-player-shots-1p': Object.freeze({
    marketFamily: 'NHL_PLAYER_SHOTS_1P',
    actualKeys: ['shots_1p'],
    defaultPeriod: '1P',
    projectionKeys: ['decision.projection', 'decision.model_projection', 'projectedTotal', 'mu', 'drivers.sog_mu'],
    propType: 'shots_on_goal',
  }),
  'nhl-player-blk': Object.freeze({
    marketFamily: 'NHL_PLAYER_BLOCKS',
    actualKeys: ['blocks'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: [
      'projection_accuracy.projection_raw',
      'decision.projection',
      'projectedTotal',
      'mu',
      'drivers.blk_mu',
    ],
    propType: 'blocked_shots',
    identity: 'player',
  }),
  'mlb-pitcher-k': Object.freeze({
    marketFamily: 'MLB_PITCHER_K',
    actualKeys: ['pitcher_ks'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: [
      'projection_accuracy.projection_raw',
      'projection.k_mean',
      'projection.projected',
      'pitcher_k_result.projection.k_mean',
      'pitcher_k_result.k_mean',
      'drivers.0.projected',
      'drivers.0.projection',
    ],
    propType: 'strikeouts',
    identity: 'player',
  }),
});

const COMMON_LINES_BY_MARKET_FAMILY = Object.freeze({
  NBA_TOTAL: Object.freeze([219.5, 229.5, 239.5]),
  MLB_F5_TOTAL: Object.freeze([3.5, 4.5, 5.5]),
  MLB_PITCHER_K: Object.freeze([4.5, 5.5, 6.5, 7.5]),
  NHL_PLAYER_SHOTS: Object.freeze([1.5, 2.5, 3.5, 4.5]),
  NHL_PLAYER_SHOTS_1P: Object.freeze([0.5, 1.5, 2.5]),
  NHL_PLAYER_BLOCKS: Object.freeze([0.5, 1.5, 2.5, 3.5]),
});

const MARKET_CONFIDENCE_DEFAULTS = Object.freeze({
  NBA_TOTAL: Object.freeze({ marketEdgeScale: 1.25, marketVarianceCap: 6.0 }),
  MLB_F5_TOTAL: Object.freeze({ marketEdgeScale: 0.75, marketVarianceCap: 3.0 }),
  MLB_F5_ML: Object.freeze({ marketEdgeScale: 0.08, marketVarianceCap: 0.25 }),
  MLB_PITCHER_K: Object.freeze({ marketEdgeScale: 1.0, marketVarianceCap: 3.5 }),
  NHL_PLAYER_SHOTS: Object.freeze({ marketEdgeScale: 0.75, marketVarianceCap: 2.5 }),
  NHL_PLAYER_SHOTS_1P: Object.freeze({ marketEdgeScale: 0.5, marketVarianceCap: 1.5 }),
  NHL_PLAYER_BLOCKS: Object.freeze({ marketEdgeScale: 0.5, marketVarianceCap: 2.0 }),
});

const WEAK_DIRECTION_EDGE_THRESHOLD = 0.15;
const SYNTHETIC_RULE_NEAREST_HALF = 'nearest_half';
const SYNTHETIC_RULE_MONEYLINE_BASELINE = 'moneyline_baseline';
const MONEYLINE_BASELINE = 0.5;
const MIN_MARKET_TRUST_SAMPLE = 25;
const PROJECTION_ACCURACY_MARKET_FAMILIES = Object.freeze([
  'NBA_TOTAL',
  'MLB_F5_TOTAL',
  'MLB_F5_ML',
  'MLB_PITCHER_K',
  'NHL_PLAYER_SHOTS',
  'NHL_PLAYER_BLOCKS',
]);

function normalizeCardType(value) {
  return String(value || '').trim().toLowerCase();
}

function isProjectionAccuracyCardType(cardType) {
  return Boolean(TRACKED_PROJECTION_ACCURACY_CARD_TYPES[normalizeCardType(cardType)]);
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToNearestHalf(value) {
  const parsed = toFiniteNumberOrNull(value);
  if (parsed === null) return null;
  return Math.round(parsed - 0.5) + 0.5;
}

function roundMetric(value, digits = 6) {
  const parsed = toFiniteNumberOrNull(value);
  if (parsed === null) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function normalizeDirection(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'OVER' || token === 'UNDER') return token;
  if (token === 'O') return 'OVER';
  if (token === 'U') return 'UNDER';
  return null;
}

function directionFromProjectionLine(projectionValue, line) {
  const projection = toFiniteNumberOrNull(projectionValue);
  const parsedLine = toFiniteNumberOrNull(line);
  if (projection === null || parsedLine === null) return 'NO_EDGE';
  if (Math.abs(projection - parsedLine) < WEAK_DIRECTION_EDGE_THRESHOLD) return 'NO_EDGE';
  if (projection > parsedLine) return 'OVER';
  if (projection < parsedLine) return 'UNDER';
  return 'NO_EDGE';
}

function getPathValue(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = String(path).split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function pickFirstFinite(payload, keys) {
  for (const key of keys) {
    const parsed = toFiniteNumberOrNull(getPathValue(payload, key));
    if (parsed !== null) return parsed;
  }
  return null;
}

function pickFirstString(payload, keys) {
  for (const key of keys) {
    const value = getPathValue(payload, key);
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function normalizeDriverContributions(value) {
  if (!Array.isArray(value)) return null;

  const normalized = value
    .map((entry) => ({
      driver: entry?.driver ? String(entry.driver).trim() : null,
      weight: toFiniteNumberOrNull(entry?.weight),
      signal: toFiniteNumberOrNull(entry?.signal ?? entry?.score),
    }))
    .filter((entry) => entry.driver && entry.weight !== null && entry.signal !== null)
    .map((entry) => ({
      driver: entry.driver,
      weight: roundMetric(entry.weight, 6),
      signal: roundMetric(entry.signal, 6),
    }));

  return normalized.length > 0 ? normalized : null;
}

function normalizeConfidenceScore(value) {
  const parsed = toFiniteNumberOrNull(value);
  if (parsed === null) return null;
  if (parsed > 1 && parsed <= 100) return parsed / 100;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeProbability(value) {
  const parsed = toFiniteNumberOrNull(value);
  if (parsed === null) return null;
  const probability = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  if (probability < 0 || probability > 1) return null;
  return probability;
}

function normalizeMoneylineSide(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'HOME' || token === 'H') return 'HOME';
  if (token === 'AWAY' || token === 'A') return 'AWAY';
  return null;
}

function resolveMoneylineSelectedSide(payload = {}) {
  return normalizeMoneylineSide(
    payload?.selection?.side ??
      payload?.play?.selection?.side ??
      payload?.market_context?.selection_side ??
      payload?.canonical_envelope_v2?.selection_side ??
      payload?.decision_v2?.selection_side ??
      payload?.prediction,
  );
}

function resolveMoneylineWinProbability(payload = {}, selectedSide = null) {
  const selectedProbability = pickFirstFinite(payload, [
    'projection_accuracy.win_probability',
    'win_probability',
    'p_fair',
    'fair_prob',
    'model_prob',
  ]);
  const normalizedSelected = normalizeProbability(selectedProbability);
  if (normalizedSelected !== null) return normalizedSelected;

  const homeProbability = normalizeProbability(pickFirstFinite(payload, [
    'projection.projected_win_prob_home',
    'drivers.0.projected_win_prob_home',
    'drivers.0.win_prob_home',
  ]));
  if (homeProbability === null) return null;
  const side = normalizeMoneylineSide(selectedSide);
  if (side === 'HOME') return homeProbability;
  if (side === 'AWAY') return roundMetric(1 - homeProbability, 6);
  return null;
}

function isMoneylineMarketFamily(marketFamily) {
  return marketFamily === 'MLB_F5_ML';
}

function moneylineExpectedOutcomeLabel(selectedSide) {
  const side = normalizeMoneylineSide(selectedSide);
  return side ? `${side}_WIN` : null;
}

function moneylineEdgePp(winProbability) {
  const probability = normalizeProbability(winProbability);
  return probability === null ? null : roundMetric((probability - MONEYLINE_BASELINE) * 100, 6);
}

function confidenceBand(score) {
  const parsed = toFiniteNumberOrNull(score);
  if (parsed === null) return 'UNKNOWN';
  const pct = parsed <= 1 ? parsed * 100 : parsed;
  if (pct >= 63) return 'STRONG';
  if (pct >= 58) return 'TRUST';
  if (pct >= 52) return 'WATCH';
  return 'LOW';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function variance(values) {
  const finite = values.map(toFiniteNumberOrNull).filter((value) => value !== null);
  if (finite.length < 2) return null;
  const avg = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return finite.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / finite.length;
}

function poissonCdf(k, lambda) {
  const parsedLambda = toFiniteNumberOrNull(lambda);
  if (parsedLambda === null || parsedLambda < 0) return null;
  const boundary = Math.floor(k);
  if (boundary < 0) return 0;
  let term = Math.exp(-parsedLambda);
  let sum = term;
  for (let i = 1; i <= boundary; i += 1) {
    term *= parsedLambda / i;
    sum += term;
  }
  return clamp(sum, 0, 1);
}

function expectedOverProbability(projectionRaw, line) {
  const lambda = toFiniteNumberOrNull(projectionRaw);
  const parsedLine = toFiniteNumberOrNull(line);
  if (lambda === null || parsedLine === null) return null;
  const floorLine = Math.floor(parsedLine);
  const cdf = poissonCdf(floorLine, lambda);
  return cdf === null ? null : roundMetric(1 - cdf, 6);
}

function expectedDirectionProbability(projectionRaw, line, direction) {
  const overProb = expectedOverProbability(projectionRaw, line);
  if (overProb === null) return null;
  const side = normalizeDirection(direction);
  if (side === 'OVER') return overProb;
  if (side === 'UNDER') return roundMetric(1 - overProb, 6);
  return null;
}

function calibrationBucketForProjection(projectionRaw) {
  const value = toFiniteNumberOrNull(projectionRaw);
  if (value === null) return 'UNKNOWN';
  const min = Math.floor(value);
  return `${min}.0-${min}.9`;
}

function getMarketDefaults(marketFamily) {
  return MARKET_CONFIDENCE_DEFAULTS[marketFamily] || {
    marketEdgeScale: 1,
    marketVarianceCap: 3,
  };
}

function deriveProjectionConfidence({
  edgeDistance = null,
  historicalBucketHitRate = 0.5,
  varianceOfMarket = null,
  marketFamily = null,
} = {}) {
  const defaults = getMarketDefaults(marketFamily);
  const edge = Math.max(0, toFiniteNumberOrNull(edgeDistance) ?? 0);
  const bucketHitRate = toFiniteNumberOrNull(historicalBucketHitRate) ?? 0.5;
  const marketVariance =
    toFiniteNumberOrNull(varianceOfMarket) ??
    (defaults.marketVarianceCap * 0.5);

  const edgeScore = clamp(edge / defaults.marketEdgeScale, 0, 1);
  const bucketScore = clamp((bucketHitRate - 0.50) / 0.15, -1, 1);
  const variancePenalty = clamp(marketVariance / defaults.marketVarianceCap, 0, 1);

  return Math.round(100 * clamp(
    0.50 +
      (0.30 * edgeScore) +
      (0.20 * bucketScore) -
      (0.20 * variancePenalty),
    0,
    1,
  ));
}

function collectFlags(payload) {
  const flags = [];
  const candidates = [
    payload?.market_trust_flags,
    payload?.reason_codes,
    payload?.missing_inputs,
    payload?.decision?.v2?.flags,
    payload?.decision_v2?.flags,
    payload?.prop_decision?.flags,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) flags.push(...candidate);
  }

  if (Array.isArray(payload?.tags) && payload.tags.includes('no_odds_mode')) {
    flags.push('PROJECTION_ONLY_MARKET');
  }
  if (String(payload?.decision?.market_line_source || '').toLowerCase() === 'synthetic_fallback') {
    flags.push('SYNTHETIC_LINE');
  }
  if (String(payload?.line_source || '').toLowerCase() === 'synthetic_fallback') {
    flags.push('SYNTHETIC_LINE');
  }

  return [...new Set(flags.map((flag) => String(flag).trim()).filter(Boolean))].sort();
}

function resolveProjectionMarketTrust(payload = {}) {
  const basis = String(payload?.basis || '').trim().toUpperCase();
  const lineSource = String(
    payload?.line_source ??
      payload?.decision?.market_line_source ??
      payload?.decision_basis_meta?.market_line_source ??
      '',
  ).trim().toLowerCase();
  const flags = collectFlags(payload);
  const tags = Array.isArray(payload?.tags) ? payload.tags.map((tag) => String(tag)) : [];

  if (basis === 'ODDS_BACKED' || payload?.odds_backed === true) {
    return { marketTrust: 'ODDS_BACKED', flags, lineSource: lineSource || 'odds_api', basis: basis || 'ODDS_BACKED' };
  }
  if (lineSource === 'synthetic_fallback') {
    return { marketTrust: 'SYNTHETIC_FALLBACK', flags, lineSource, basis: basis || null };
  }
  if (basis === 'PROJECTION_ONLY' || tags.includes('no_odds_mode') || payload?.execution_status === 'PROJECTION_ONLY') {
    return { marketTrust: 'PROJECTION_ONLY', flags, lineSource: lineSource || null, basis: basis || 'PROJECTION_ONLY' };
  }
  return { marketTrust: 'UNVERIFIED', flags, lineSource: lineSource || null, basis: basis || null };
}


/**
 * Insert a single proxy eval row.
 * Uses INSERT OR REPLACE to be idempotent on (card_id, proxy_line).
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {object} row - row matching projection_proxy_evals schema (all non-default fields required)
 */
function insertProjectionProxyEval(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO projection_proxy_evals (
      card_id, game_id, game_date, sport, card_family,
      proj_value, actual_value,
      proxy_line, edge_vs_line, recommended_side, tier, confidence_bucket,
      agreement_group, graded_result, hit_flag, tier_score, consensus_bonus
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    row.card_id,
    row.game_id,
    row.game_date,
    row.sport,
    row.card_family,
    row.proj_value,
    row.actual_value,
    row.proxy_line,
    row.edge_vs_line,
    row.recommended_side,
    row.tier,
    row.confidence_bucket,
    row.agreement_group ?? '',
    row.graded_result,
    row.hit_flag,
    row.tier_score ?? 0,
    row.consensus_bonus ?? 0,
  );
}

/**
 * Insert an array of proxy eval rows in a single transaction.
 * Idempotent on (card_id, proxy_line) via INSERT OR REPLACE.
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {Array<object>} rows - array of row objects
 * @returns {number} count of rows written
 */
function batchInsertProjectionProxyEvals(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insertProjectionProxyEval(db, row);
    }
    db.exec('COMMIT');
    return rows.length;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

/**
 * Read proxy eval rows with optional filters.
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {object} [opts]
 * @param {string} [opts.cardFamily]       - filter by card_family
 * @param {string} [opts.gameDateGte]      - filter game_date >= value (YYYY-MM-DD)
 * @param {string} [opts.gameDateLte]      - filter game_date <= value (YYYY-MM-DD)
 * @param {string} [opts.agreementGroup]   - filter by agreement_group
 * @param {string} [opts.tier]             - filter by tier
 * @param {number} [opts.limit=500]        - max rows to return
 * @returns {Array<object>}
 */
function getProjectionProxyEvals(db, {
  cardFamily,
  gameDateGte,
  gameDateLte,
  agreementGroup,
  tier,
  limit = 500,
} = {}) {
  const clauses = [];
  const params = [];

  if (cardFamily) {
    clauses.push('card_family = ?');
    params.push(cardFamily);
  }
  if (gameDateGte) {
    clauses.push('game_date >= ?');
    params.push(gameDateGte);
  }
  if (gameDateLte) {
    clauses.push('game_date <= ?');
    params.push(gameDateLte);
  }
  if (agreementGroup) {
    clauses.push('agreement_group = ?');
    params.push(agreementGroup);
  }
  if (tier) {
    clauses.push('tier = ?');
    params.push(tier);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  return db
    .prepare(`SELECT * FROM projection_proxy_evals ${where} ORDER BY game_date DESC, id DESC LIMIT ?`)
    .all(...params);
}

/**
 * Return aggregated accuracy summary for a card family.
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {object} [opts]
 * @param {string} [opts.cardFamily]   - required for meaningful results
 * @param {string} [opts.gameDateGte]  - YYYY-MM-DD lower bound
 * @param {string} [opts.gameDateLte]  - YYYY-MM-DD upper bound
 * @returns {object} summary matching ProjectionFamilySummary shape
 */
function getProjectionAccuracySummary(db, {
  cardFamily,
  gameDateGte,
  gameDateLte,
} = {}) {
  const clauses = [];
  const params = [];

  if (cardFamily) {
    clauses.push('card_family = ?');
    params.push(cardFamily);
  }
  if (gameDateGte) {
    clauses.push('game_date >= ?');
    params.push(gameDateGte);
  }
  if (gameDateLte) {
    clauses.push('game_date <= ?');
    params.push(gameDateLte);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // ── Overall summary ────────────────────────────────────────────────────────
  const overall = db.prepare(`
    SELECT
      MIN(game_date)                                           AS date_gte,
      MAX(game_date)                                           AS date_lte,
      COUNT(DISTINCT game_id)                                  AS total_games,
      COUNT(CASE WHEN graded_result != 'NO_BET' THEN 1 END)   AS total_proxy_decisions,
      SUM(hit_flag)                                            AS wins,
      COUNT(CASE WHEN graded_result = 'LOSS' THEN 1 END)      AS losses,
      COUNT(CASE WHEN graded_result = 'NO_BET' THEN 1 END)    AS no_bets,
      COUNT(CASE WHEN agreement_group IN ('CONSENSUS_OVER','CONSENSUS_UNDER') THEN 1 END) AS consensus_games,
      SUM(CASE WHEN agreement_group IN ('CONSENSUS_OVER','CONSENSUS_UNDER') THEN hit_flag ELSE 0 END) AS consensus_wins,
      COUNT(CASE WHEN agreement_group = 'SPLIT' THEN 1 END)   AS split_zone_games,
      AVG(CASE WHEN graded_result != 'NO_BET' THEN tier_score END) AS avg_tier_score,
      SUM(tier_score)                                          AS total_score
    FROM projection_proxy_evals
    ${where}
  `).get(...params);

  const wins = overall?.wins ?? 0;
  const losses = overall?.losses ?? 0;
  const totalDecisions = overall?.total_proxy_decisions ?? 0;
  const consensusWins = overall?.consensus_wins ?? 0;
  const consensusGames = overall?.consensus_games ?? 0;
  const consensusLosses = consensusGames - consensusWins;

  // ── By tier ────────────────────────────────────────────────────────────────
  const tierRows = db.prepare(`
    SELECT
      tier,
      COUNT(CASE WHEN graded_result != 'NO_BET' THEN 1 END) AS decisions,
      SUM(hit_flag)                                          AS wins,
      COUNT(CASE WHEN graded_result = 'LOSS' THEN 1 END)    AS losses
    FROM projection_proxy_evals
    ${where}
    GROUP BY tier
  `).all(...params);

  const byTier = { LEAN: null, PLAY: null, STRONG: null };
  for (const t of tierRows) {
    if (t.tier === 'LEAN' || t.tier === 'PLAY' || t.tier === 'STRONG') {
      const tierWins = t.wins ?? 0;
      const tierLosses = t.losses ?? 0;
      byTier[t.tier] = {
        decisions: t.decisions ?? 0,
        wins: tierWins,
        losses: tierLosses,
        hit_rate: (tierWins + tierLosses) > 0 ? tierWins / (tierWins + tierLosses) : null,
      };
    }
  }
  // Fill nulls for tiers with no rows
  for (const tier of ['LEAN', 'PLAY', 'STRONG']) {
    if (!byTier[tier]) {
      byTier[tier] = { decisions: 0, wins: 0, losses: 0, hit_rate: null };
    }
  }

  // ── By proxy_line ──────────────────────────────────────────────────────────
  const lineRows = db.prepare(`
    SELECT
      proxy_line,
      COUNT(CASE WHEN graded_result != 'NO_BET' THEN 1 END) AS decisions,
      SUM(hit_flag)                                          AS wins,
      COUNT(CASE WHEN graded_result = 'LOSS' THEN 1 END)    AS losses
    FROM projection_proxy_evals
    ${where}
    GROUP BY proxy_line
  `).all(...params);

  const byProxyLine = {};
  for (const l of lineRows) {
    const lineWins = l.wins ?? 0;
    const lineLosses = l.losses ?? 0;
    byProxyLine[String(l.proxy_line)] = {
      decisions: l.decisions ?? 0,
      wins: lineWins,
      losses: lineLosses,
      hit_rate: (lineWins + lineLosses) > 0 ? lineWins / (lineWins + lineLosses) : null,
    };
  }

  return {
    card_family: cardFamily ?? null,
    game_date_range: {
      gte: overall?.date_gte ?? null,
      lte: overall?.date_lte ?? null,
    },
    total_games: overall?.total_games ?? 0,
    total_proxy_decisions: totalDecisions,
    wins,
    losses,
    no_bets: overall?.no_bets ?? 0,
    proxy_hit_rate: (wins + losses) > 0 ? wins / (wins + losses) : null,
    consensus_games: consensusGames,
    consensus_wins: consensusWins,
    consensus_hit_rate: (consensusWins + consensusLosses) > 0
      ? consensusWins / (consensusWins + consensusLosses)
      : null,
    split_zone_games: overall?.split_zone_games ?? 0,
    avg_tier_score: overall?.avg_tier_score ?? null,
    total_score: overall?.total_score ?? 0,
    by_tier: byTier,
    by_proxy_line: byProxyLine,
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveSelectedLine(payload = {}) {
  return pickFirstFinite(payload, [
    'line',
    'decision.market_line',
    'play.selection.line',
    'selection.line',
    'pitcher_k_line_contract.line',
  ]);
}

function resolveSelectedDirection(payload = {}, projectionValue = null, line = null) {
  return normalizeDirection(
    payload?.decision?.direction ??
      payload?.prop_decision?.lean_side ??
      payload?.play?.selection?.side ??
      payload?.selection?.side ??
      payload?.selection,
  ) ?? directionFromProjectionLine(projectionValue, line);
}

function resolveActualValue(cardType, actualResult) {
  const config = TRACKED_PROJECTION_ACCURACY_CARD_TYPES[normalizeCardType(cardType)];
  if (!config) return null;
  const parsed = parseJsonObject(actualResult);
  for (const key of config.actualKeys) {
    const value = toFiniteNumberOrNull(parsed[key]);
    if (value !== null) return value;
  }
  return null;
}

function gradeLine({ actualValue, line, direction }) {
  const actual = toFiniteNumberOrNull(actualValue);
  const evalLine = toFiniteNumberOrNull(line);
  const side = normalizeDirection(direction);
  if (actual === null || evalLine === null) {
    return { gradedResult: 'PENDING', hitFlag: null };
  }
  if (!side || direction === 'NO_EDGE') {
    return { gradedResult: 'NO_BET', hitFlag: 0 };
  }
  if (actual === evalLine) {
    return { gradedResult: 'PUSH', hitFlag: null };
  }
  const won = side === 'OVER' ? actual > evalLine : actual < evalLine;
  return { gradedResult: won ? 'WIN' : 'LOSS', hitFlag: won ? 1 : 0 };
}

function arrayFromJson(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonArrayStringOrNull(value) {
  if (Array.isArray(value)) return value.length > 0 ? JSON.stringify(value) : null;
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

function buildLineEvalSettlementContext(parent, payload = {}, actualValue, gradedAt) {
  const rawData = payload?.raw_data && typeof payload.raw_data === 'object'
    ? payload.raw_data
    : {};
  const rawTotal = toFiniteNumberOrNull(parent?.projection_raw) ?? toFiniteNumberOrNull(parent?.projection_value);
  const calibratedTotal = pickFirstFinite(payload, [
    'projection_accuracy.calibrated_total',
    'projection_accuracy.projection_calibrated',
    'projection.calibrated_total',
  ]);

  return {
    gameId: parent?.game_id ?? null,
    settledAt: gradedAt ?? null,
    snapshotTime: pickFirstString(payload, [
      'raw_data.captured_at',
      'snapshot_timestamp.captured_at',
      'odds_context.captured_at',
      '_pricing_state.captured_at',
      'captured_at',
    ]) ?? parent?.captured_at ?? null,
    marketTotal: pickFirstFinite(payload, [
      'raw_data.market_total',
      'odds_context.total',
      'line',
    ]),
    rawTotal,
    calibratedTotal,
    actualTotal: actualValue,
    totalErrorRaw:
      rawTotal !== null && actualValue !== null
        ? roundMetric(rawTotal - actualValue, 6)
        : null,
    totalErrorCalibrated:
      calibratedTotal !== null && actualValue !== null
        ? roundMetric(calibratedTotal - actualValue, 6)
        : null,
    paceTier: pickFirstString(payload, ['raw_data.pace_tier']),
    volEnv: pickFirstString(payload, ['raw_data.vol_env']),
    totalBand: pickFirstString(payload, ['raw_data.total_band']),
    injuryCloud: pickFirstString(payload, ['raw_data.injury_cloud']),
    driverContributionsJson: jsonArrayStringOrNull(rawData.driver_contributions),
    regimeTagsJson:
      jsonArrayStringOrNull(rawData.regime_tags) ??
      jsonArrayStringOrNull(rawData.regime_tags_json),
    confidenceTier: pickFirstString(payload, ['tier']),
  };
}

function mergeFailureFlags(existing, additions = []) {
  return [...new Set([
    ...arrayFromJson(existing),
    ...additions.map(String),
  ].map((flag) => String(flag).trim()).filter(Boolean))].sort();
}

function getHistoricalBucketHitRate(db, marketFamily, calibrationBucket) {
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN graded_result = 'WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN graded_result = 'LOSS' THEN 1 ELSE 0 END) AS losses
      FROM projection_accuracy_evals
      WHERE market_family = ?
        AND calibration_bucket = ?
        AND grade_status = 'GRADED'
        AND COALESCE(weak_direction_flag, 0) = 0
    `).get(marketFamily, calibrationBucket);
    const wins = Number(row?.wins || 0);
    const losses = Number(row?.losses || 0);
    return wins + losses >= 10 ? wins / (wins + losses) : 0.5;
  } catch {
    return 0.5;
  }
}

function getMarketActualVariance(db, marketFamily) {
  try {
    const rows = db.prepare(`
      SELECT actual_value
      FROM projection_accuracy_evals
      WHERE market_family = ?
        AND grade_status = 'GRADED'
        AND actual_value IS NOT NULL
      ORDER BY id DESC
      LIMIT 200
    `).all(marketFamily);
    const calculated = variance(rows.map((row) => row.actual_value));
    if (calculated !== null) return calculated;
  } catch {
    // fall through to default below
  }
  return getMarketDefaults(marketFamily).marketVarianceCap * 0.5;
}

function computeMarketTrustStatus({ wins = 0, losses = 0, calibrationGap = 0, weakShare = 0, monotonicLift = true } = {}) {
  const sampleSize = wins + losses;
  if (sampleSize < MIN_MARKET_TRUST_SAMPLE) return 'INSUFFICIENT_DATA';
  const winRate = sampleSize > 0 ? wins / sampleSize : null;
  if (winRate === null) return 'INSUFFICIENT_DATA';
  if (winRate < 0.50 || !monotonicLift || weakShare > 0.40) return 'NOISE';
  if (winRate >= 0.57 && calibrationGap <= 0.05 && monotonicLift) return 'SHARP';
  if (winRate >= 0.53 && calibrationGap <= 0.08) return 'TRUSTED';
  return 'WATCH';
}

function hasMonotonicConfidenceLift(rows = []) {
  const bandOrder = ['LOW', 'WATCH', 'TRUST', 'STRONG'];
  let previousRate = null;
  let observedBands = 0;

  for (const band of bandOrder) {
    const row = rows.find((candidate) => candidate.band === band);
    const wins = Number(row?.wins || 0);
    const losses = Number(row?.losses || 0);
    if (wins + losses === 0) continue;

    const rate = wins / (wins + losses);
    observedBands += 1;
    if (previousRate !== null && rate < previousRate) return false;
    previousRate = rate;
  }

  return true;
}

function computeMarketTrustStatusForFamily(db, marketFamily) {
  try {
    const overall = db.prepare(`
      SELECT
        SUM(CASE WHEN l.graded_result = 'WIN' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN l.graded_result = 'LOSS' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS losses,
        COUNT(l.id) AS total_line_evals,
        SUM(CASE WHEN l.weak_direction_flag = 1 THEN 1 ELSE 0 END) AS weak_direction_count,
        AVG(
          CASE
            WHEN e.actual_value IS NOT NULL
             AND e.synthetic_line IS NOT NULL
             AND e.expected_over_prob IS NOT NULL
            THEN ABS(e.expected_over_prob - CASE WHEN e.actual_value > e.synthetic_line THEN 1.0 ELSE 0.0 END)
          END
        ) AS calibration_gap
      FROM projection_accuracy_line_evals l
      JOIN projection_accuracy_evals e ON e.card_id = l.card_id
      WHERE e.market_family = ?
        AND l.line_role = 'SYNTHETIC'
        AND l.grade_status = 'GRADED'
    `).get(marketFamily);

    const byBand = db.prepare(`
      SELECT
        l.confidence_band AS band,
        SUM(CASE WHEN l.graded_result = 'WIN' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN l.graded_result = 'LOSS' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS losses
      FROM projection_accuracy_line_evals l
      JOIN projection_accuracy_evals e ON e.card_id = l.card_id
      WHERE e.market_family = ?
        AND l.line_role = 'SYNTHETIC'
        AND l.grade_status = 'GRADED'
      GROUP BY l.confidence_band
    `).all(marketFamily);

    const totalLineEvals = Number(overall?.total_line_evals || 0);
    const weakShare = totalLineEvals > 0
      ? Number(overall?.weak_direction_count || 0) / totalLineEvals
      : 0;
    return computeMarketTrustStatus({
      wins: Number(overall?.wins || 0),
      losses: Number(overall?.losses || 0),
      calibrationGap: Number(overall?.calibration_gap || 0),
      weakShare,
      monotonicLift: hasMonotonicConfidenceLift(byBand),
    });
  } catch {
    return 'INSUFFICIENT_DATA';
  }
}

function computeProjectionAccuracyMarketHealth(db, {
  marketFamily,
  lineRole = 'SYNTHETIC',
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!db || !marketFamily) return null;

  const overall = db.prepare(`
    SELECT
      SUM(CASE WHEN l.graded_result = 'WIN' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN l.graded_result = 'LOSS' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN l.graded_result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN l.graded_result = 'NO_BET' THEN 1 ELSE 0 END) AS no_bets,
      COUNT(l.id) AS total_line_evals,
      SUM(CASE WHEN l.weak_direction_flag = 1 THEN 1 ELSE 0 END) AS weak_direction_count,
      AVG(e.absolute_error) AS mae,
      AVG(e.signed_error) AS bias,
      AVG(e.projection_confidence) AS avg_confidence,
      AVG(
        CASE
          WHEN e.actual_value IS NOT NULL
           AND e.synthetic_line IS NOT NULL
           AND e.expected_over_prob IS NOT NULL
          THEN ABS(e.expected_over_prob - CASE WHEN e.actual_value > e.synthetic_line THEN 1.0 ELSE 0.0 END)
        END
      ) AS calibration_gap
    FROM projection_accuracy_line_evals l
    JOIN projection_accuracy_evals e ON e.card_id = l.card_id
    WHERE e.market_family = ?
      AND l.line_role = ?
      AND l.grade_status = 'GRADED'
  `).get(marketFamily, lineRole);

  const confidenceRows = db.prepare(`
    SELECT
      l.confidence_band AS band,
      SUM(CASE WHEN l.graded_result = 'WIN' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN l.graded_result = 'LOSS' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS losses,
      AVG(e.absolute_error) AS mae,
      AVG(e.signed_error) AS bias
    FROM projection_accuracy_line_evals l
    JOIN projection_accuracy_evals e ON e.card_id = l.card_id
    WHERE e.market_family = ?
      AND l.line_role = ?
      AND l.grade_status = 'GRADED'
    GROUP BY l.confidence_band
  `).all(marketFamily, lineRole);

  const wins = Number(overall?.wins || 0);
  const losses = Number(overall?.losses || 0);
  const sampleSize = wins + losses;
  const totalLineEvals = Number(overall?.total_line_evals || 0);
  const weakDirectionShare = totalLineEvals > 0
    ? Number(overall?.weak_direction_count || 0) / totalLineEvals
    : 0;
  const calibrationGap = Number(overall?.calibration_gap || 0);
  const confidenceLift = {};
  for (const row of confidenceRows) {
    const bandWins = Number(row.wins || 0);
    const bandLosses = Number(row.losses || 0);
    confidenceLift[row.band || 'UNKNOWN'] = {
      wins: bandWins,
      losses: bandLosses,
      sample_size: bandWins + bandLosses,
      win_rate: bandWins + bandLosses > 0 ? bandWins / (bandWins + bandLosses) : null,
      mae: row.mae ?? null,
      bias: row.bias ?? null,
    };
  }

  const confidenceBandsImprove = hasMonotonicConfidenceLift(confidenceRows);
  const marketTrustStatus = computeMarketTrustStatus({
    wins,
    losses,
    calibrationGap,
    weakShare: weakDirectionShare,
    monotonicLift: confidenceBandsImprove,
  });

  return {
    market_family: marketFamily,
    line_role: lineRole,
    generated_at: generatedAt,
    sample_size: sampleSize,
    wins,
    losses,
    pushes: Number(overall?.pushes || 0),
    no_bets: Number(overall?.no_bets || 0),
    win_rate: sampleSize > 0 ? wins / sampleSize : null,
    mae: overall?.mae ?? null,
    bias: overall?.bias ?? null,
    calibration_gap: overall?.calibration_gap ?? null,
    avg_confidence: overall?.avg_confidence ?? null,
    weak_direction_share: weakDirectionShare,
    confidence_lift: confidenceLift,
    confidence_bands_improve: confidenceBandsImprove,
    market_trust_status: marketTrustStatus,
  };
}

function materializeProjectionAccuracyMarketHealth(db, {
  marketFamilies = PROJECTION_ACCURACY_MARKET_FAMILIES,
  lineRole = 'SYNTHETIC',
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!db) return [];
  const rows = [];

  const write = () => {
    for (const marketFamily of marketFamilies) {
      const row = computeProjectionAccuracyMarketHealth(db, {
        marketFamily,
        lineRole,
        generatedAt,
      });
      if (!row) continue;
      rows.push(row);

      db.prepare(`
        INSERT INTO projection_accuracy_market_health (
          market_family, line_role, generated_at, sample_size,
          wins, losses, pushes, no_bets, win_rate, mae, bias,
          calibration_gap, avg_confidence, weak_direction_share,
          confidence_lift_json, market_trust_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(market_family) DO UPDATE SET
          line_role = excluded.line_role,
          generated_at = excluded.generated_at,
          sample_size = excluded.sample_size,
          wins = excluded.wins,
          losses = excluded.losses,
          pushes = excluded.pushes,
          no_bets = excluded.no_bets,
          win_rate = excluded.win_rate,
          mae = excluded.mae,
          bias = excluded.bias,
          calibration_gap = excluded.calibration_gap,
          avg_confidence = excluded.avg_confidence,
          weak_direction_share = excluded.weak_direction_share,
          confidence_lift_json = excluded.confidence_lift_json,
          market_trust_status = excluded.market_trust_status,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        row.market_family,
        row.line_role,
        row.generated_at,
        row.sample_size,
        row.wins,
        row.losses,
        row.pushes,
        row.no_bets,
        row.win_rate,
        row.mae,
        row.bias,
        row.calibration_gap,
        row.avg_confidence,
        row.weak_direction_share,
        JSON.stringify(row.confidence_lift),
        row.market_trust_status,
      );

      db.prepare(`
        UPDATE projection_accuracy_evals
        SET market_trust_status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE market_family = ?
      `).run(row.market_trust_status, row.market_family);
    }
  };

  if (typeof db.transaction === 'function') {
    db.transaction(write)();
  } else {
    db.exec('BEGIN');
    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  return rows;
}

function buildProjectionAccuracyLineRows(capture) {
  if (!capture) return [];
  if (isMoneylineMarketFamily(capture.marketFamily)) {
    const evalLine = toFiniteNumberOrNull(capture.syntheticLine ?? MONEYLINE_BASELINE);
    const probability = normalizeProbability(capture.winProbability ?? capture.projectionValue);
    if (evalLine === null || probability === null) return [];
    const edge = roundMetric(probability - evalLine, 6);
    const confidenceScore = deriveProjectionConfidence({
      edgeDistance: Math.abs(edge ?? 0),
      historicalBucketHitRate: capture.historicalBucketHitRate ?? 0.5,
      varianceOfMarket: capture.varianceOfMarket ?? null,
      marketFamily: capture.marketFamily,
    });
    return [{
      card_id: capture.cardId,
      line_role: 'SYNTHETIC',
      line: evalLine,
      eval_line: evalLine,
      projection_value: probability,
      direction: capture.selectedDirection ?? 'SELECTED_SIDE',
      weak_direction_flag: 0,
      edge_vs_line: edge,
      edge_pp: moneylineEdgePp(probability),
      confidence_score: confidenceScore,
      confidence_band: confidenceBand(confidenceScore),
      market_trust: capture.marketTrust,
      expected_over_prob: probability,
      expected_direction_prob: probability,
      tracking_role: capture.trackingRole ?? 'SELECTED_SIDE',
      expected_outcome_label: capture.expectedOutcomeLabel ?? null,
    }];
  }

  const rows = [];
  const addLine = (lineRole, line) => {
    const evalLine = toFiniteNumberOrNull(line);
    if (evalLine === null) return;
    const direction = directionFromProjectionLine(capture.projectionValue, evalLine);
    const edge = roundMetric(capture.projectionValue - evalLine, 6);
    const weakDirectionFlag = Math.abs(edge ?? 0) < WEAK_DIRECTION_EDGE_THRESHOLD ? 1 : 0;
    const expectedOverProb = expectedOverProbability(capture.projectionValue, evalLine);
    const expectedDirProb = expectedDirectionProbability(capture.projectionValue, evalLine, direction);
    const confidenceScore = deriveProjectionConfidence({
      edgeDistance: Math.abs(edge ?? 0),
      historicalBucketHitRate: capture.historicalBucketHitRate ?? 0.5,
      varianceOfMarket: capture.varianceOfMarket ?? null,
      marketFamily: capture.marketFamily,
    });
    rows.push({
      card_id: capture.cardId,
      line_role: lineRole,
      line: evalLine,
      eval_line: evalLine,
      projection_value: capture.projectionValue,
      direction,
      weak_direction_flag: weakDirectionFlag,
      edge_vs_line: edge,
      confidence_score: confidenceScore,
      confidence_band: confidenceBand(confidenceScore),
      market_trust: capture.marketTrust,
      expected_over_prob: expectedOverProb,
      expected_direction_prob: expectedDirProb,
    });
  };

  addLine('SYNTHETIC', capture.nearestHalfLine);
  if (
    capture.selectedLine !== null &&
    capture.nearestHalfLine !== null &&
    Math.abs(capture.selectedLine - capture.nearestHalfLine) > 1e-9
  ) {
    addLine('SELECTED_MARKET', capture.selectedLine);
  }
  for (const line of COMMON_LINES_BY_MARKET_FAMILY[capture.marketFamily] || []) {
    addLine(`COMMON_${line}`, line);
  }

  const byLine = new Map();
  for (const row of rows) {
    if (!byLine.has(row.eval_line)) byLine.set(row.eval_line, row);
  }
  return Array.from(byLine.values());
}

function deriveProjectionAccuracyCapture(card = {}) {
  const cardType = normalizeCardType(card.cardType ?? card.card_type);
  const config = TRACKED_PROJECTION_ACCURACY_CARD_TYPES[cardType];
  if (!config) return null;

  const payloadData =
    card.payloadData && typeof card.payloadData === 'object'
      ? card.payloadData
      : parseJsonObject(card.payload_data);
  const projectionValue = pickFirstFinite(payloadData, config.projectionKeys);
  if (projectionValue === null) return null;
  const rawData = payloadData?.raw_data && typeof payloadData.raw_data === 'object'
    ? payloadData.raw_data
    : {};

  const selectedLine = resolveSelectedLine(payloadData);
  const nearestHalfLine = roundToNearestHalf(projectionValue);
  if (nearestHalfLine === null) return null;

  const { marketTrust, flags, lineSource, basis } = resolveProjectionMarketTrust(payloadData);
  const syntheticDirection = directionFromProjectionLine(projectionValue, nearestHalfLine);
  const selectedDirection = resolveSelectedDirection(payloadData, projectionValue, nearestHalfLine);
  const primaryEdge = roundMetric(projectionValue - nearestHalfLine, 6);
  const weakDirectionFlag =
    syntheticDirection === 'NO_EDGE' ||
    Math.abs(primaryEdge ?? 0) < WEAK_DIRECTION_EDGE_THRESHOLD
      ? 1
      : 0;
  const failureFlags = weakDirectionFlag ? ['DIRECTION_TOO_WEAK'] : [];
  const confidenceScore = deriveProjectionConfidence({
    edgeDistance: Math.abs(primaryEdge ?? 0),
    historicalBucketHitRate: 0.5,
    varianceOfMarket: null,
    marketFamily: config.marketFamily,
  });
  const period = pickFirstString(payloadData, [
    'period',
    'play.period',
    'market.period',
  ]) ?? config.defaultPeriod;
  const playerId = pickFirstString(payloadData, ['player_id', 'play.player_id', 'play.selection.player_id']);
  const playerName = pickFirstString(payloadData, ['player_name', 'play.player_name', 'play.selection.player_name']);
  const playerOrGameId = config.identity === 'player'
    ? (playerId || playerName || null)
    : (card.gameId ?? card.game_id ?? payloadData.game_id ?? null);
  const expectedOverProb = expectedOverProbability(projectionValue, nearestHalfLine);
  const expectedDirProb = expectedDirectionProbability(projectionValue, nearestHalfLine, syntheticDirection);
  const marketTotal = pickFirstFinite(payloadData, ['raw_data.market_total', 'odds_context.total', 'line']);
  const driverContributions = normalizeDriverContributions(rawData.driver_contributions);

  return {
    cardId: card.id ?? card.card_id,
    gameId: card.gameId ?? card.game_id ?? payloadData.game_id ?? null,
    sport: card.sport ?? payloadData.sport ?? null,
    cardType,
    marketFamily: config.marketFamily,
    marketType: config.marketFamily,
    playerId,
    playerName,
    playerOrGameId,
    teamAbbr: pickFirstString(payloadData, ['team_abbr', 'team_abbrev', 'play.selection.team']),
    period,
    projectionValue: roundMetric(projectionValue, 6),
    projectionRaw: roundMetric(projectionValue, 6),
    selectedLine,
    nearestHalfLine,
    syntheticLine: nearestHalfLine,
    syntheticRule: SYNTHETIC_RULE_NEAREST_HALF,
    syntheticDirection,
    selectedDirection,
    directionStrength: weakDirectionFlag ? 'WEAK' : 'STRONG',
    weakDirectionFlag,
    confidenceScore,
    projectionConfidence: confidenceScore,
    confidenceBand: confidenceBand(confidenceScore),
    marketTrust,
    marketTrustStatus: 'INSUFFICIENT_DATA',
    marketTrustFlags: flags,
    failureFlags,
    lineSource,
    basis,
    expectedOverProb,
    expectedDirectionProb: expectedDirProb,
    calibrationBucket: calibrationBucketForProjection(projectionValue),
    marketTotal,
    paceTier: pickFirstString(payloadData, ['raw_data.pace_tier']),
    volEnv: pickFirstString(payloadData, ['raw_data.vol_env']),
    totalBand: pickFirstString(payloadData, ['raw_data.total_band']),
    injuryCloud: pickFirstString(payloadData, ['raw_data.injury_cloud']),
    driverContributions,
    capturedAt: card.createdAt ?? card.created_at ?? payloadData.generated_at ?? new Date().toISOString(),
    generatedAt: payloadData.generated_at ?? null,
    payloadData,
    metadata: {
      prop_type: config.propType,
      selected_line_source: selectedLine === null ? 'nearest_half' : 'payload',
    },
  };
}

function captureProjectionAccuracyEval(db, capture) {
  if (!db || !capture?.cardId || !capture?.gameId || !capture?.cardType) return false;

  const lineRows = buildProjectionAccuracyLineRows(capture);
  if (lineRows.length === 0) return false;

  const write = () => {
    db.prepare(`
      INSERT OR IGNORE INTO projection_accuracy_evals (
        card_id, game_id, sport, card_type, market_family, market_type,
        player_id, player_name, player_or_game_id, team_abbr, period,
        projection_raw, projection_value, synthetic_line, synthetic_rule,
        synthetic_direction, direction_strength, selected_line,
        nearest_half_line, selected_direction, weak_direction_flag,
        projection_confidence, confidence_score, confidence_band,
        market_trust, market_trust_status, market_trust_flags, failure_flags,
        line_source, basis, expected_over_prob, expected_direction_prob,
        calibration_bucket, market_total, pace_tier, vol_env, total_band,
        injury_cloud, driver_contributions, captured_at, generated_at, metadata, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )
    `).run(
      capture.cardId,
      capture.gameId,
      capture.sport ? String(capture.sport).toLowerCase() : null,
      capture.cardType,
      capture.marketFamily,
      capture.marketType,
      capture.playerId,
      capture.playerName,
      capture.playerOrGameId,
      capture.teamAbbr,
      capture.period,
      capture.projectionRaw,
      capture.projectionValue,
      capture.syntheticLine,
      capture.syntheticRule,
      capture.syntheticDirection,
      capture.directionStrength,
      capture.selectedLine,
      capture.nearestHalfLine,
      capture.selectedDirection,
      capture.weakDirectionFlag,
      capture.projectionConfidence,
      capture.confidenceScore,
      capture.confidenceBand,
      capture.marketTrust,
      capture.marketTrustStatus,
      JSON.stringify(capture.marketTrustFlags ?? []),
      JSON.stringify(capture.failureFlags ?? []),
      capture.lineSource,
      capture.basis,
      capture.expectedOverProb,
      capture.expectedDirectionProb,
      capture.calibrationBucket,
      capture.marketTotal,
      capture.paceTier,
      capture.volEnv,
      capture.totalBand,
      capture.injuryCloud,
      capture.driverContributions ? JSON.stringify(capture.driverContributions) : null,
      capture.capturedAt,
      capture.generatedAt,
      JSON.stringify(capture.metadata ?? {}),
    );

    const parent = db
      .prepare('SELECT id FROM projection_accuracy_evals WHERE card_id = ?')
      .get(capture.cardId);

    for (const row of lineRows) {
      db.prepare(`
        INSERT OR IGNORE INTO projection_accuracy_line_evals (
          eval_id, card_id, line_role, line, eval_line, projection_value,
          direction, weak_direction_flag, edge_vs_line,
          confidence_score, confidence_band, market_trust,
          expected_over_prob, expected_direction_prob, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        parent?.id ?? null,
        row.card_id,
        row.line_role,
        row.line,
        row.eval_line,
        row.projection_value,
        row.direction,
        row.weak_direction_flag,
        row.edge_vs_line,
        row.confidence_score,
        row.confidence_band,
        row.market_trust,
        row.expected_over_prob,
        row.expected_direction_prob,
      );
    }
  };

  if (typeof db.transaction === 'function') {
    db.transaction(write)();
  } else {
    db.exec('BEGIN');
    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  return true;
}

function captureProjectionAccuracyForCard(db, card) {
  const capture = deriveProjectionAccuracyCapture(card);
  if (!capture) return false;
  return captureProjectionAccuracyEval(db, capture);
}

function gradeProjectionAccuracyEval(db, { cardId, actualResult, gradedAt = new Date().toISOString() } = {}) {
  if (!db || !cardId) return false;
  const parent = db
    .prepare('SELECT * FROM projection_accuracy_evals WHERE card_id = ?')
    .get(cardId);
  if (!parent) return false;

  const actualValue = resolveActualValue(parent.card_type, actualResult);
  if (actualValue === null) {
    const flags = [...new Set([...arrayFromJson(parent.failure_flags), 'MISSING_ACTUAL'])];
    db.prepare(`
      UPDATE projection_accuracy_evals
      SET failure_flags = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE card_id = ?
    `).run(JSON.stringify(flags), cardId);
    return false;
  }

  const syntheticLine = parent.synthetic_line ?? parent.nearest_half_line;
  const syntheticDirection = parent.synthetic_direction ?? parent.selected_direction;
  const projectionRaw = parent.projection_raw ?? parent.projection_value;
  const failureFlags = new Set(arrayFromJson(parent.failure_flags));
  if (Number.isFinite(Number(parent.nearest_half_line)) && roundToNearestHalf(projectionRaw) !== syntheticLine) {
    failureFlags.add('SYNTHETIC_LINE_OVERWRITTEN');
  }
  let payload = {};
  try {
    const payloadRow = db.prepare('SELECT payload_data FROM card_payloads WHERE id = ? LIMIT 1').get(cardId);
    if (payloadRow?.payload_data) {
      payload = parseJsonObject(payloadRow.payload_data);
      const config = TRACKED_PROJECTION_ACCURACY_CARD_TYPES[normalizeCardType(parent.card_type)];
      const currentProjection = config ? pickFirstFinite(payload, config.projectionKeys) : null;
      if (
        currentProjection !== null &&
        Math.abs(currentProjection - projectionRaw) > 1e-9
      ) {
        failureFlags.add('PROJECTION_MODIFIED_BEFORE_GRADING');
      }
    }
  } catch {
    // Mutation audit is best-effort; grading should still complete.
  }

  const parentGrade = gradeLine({
    actualValue,
    line: syntheticLine,
    direction: parent.weak_direction_flag ? 'NO_EDGE' : syntheticDirection,
  });
  const absoluteError = roundMetric(Math.abs(actualValue - parent.projection_value), 6);
  const signedError = roundMetric(parent.projection_value - actualValue, 6);
  const historicalBucketHitRate = getHistoricalBucketHitRate(
    db,
    parent.market_family,
    parent.calibration_bucket ?? calibrationBucketForProjection(parent.projection_value),
  );
  const varianceOfMarket = getMarketActualVariance(db, parent.market_family);
  const edgeDistance = Math.abs((parent.projection_value ?? 0) - (syntheticLine ?? 0));
  const confidence = deriveProjectionConfidence({
    edgeDistance,
    historicalBucketHitRate,
    varianceOfMarket,
    marketFamily: parent.market_family,
  });
  const expectedOverProb = expectedOverProbability(parent.projection_value, syntheticLine);
  const expectedDirProb = expectedDirectionProbability(parent.projection_value, syntheticLine, syntheticDirection);
  const lineEvalSettlementContext = buildLineEvalSettlementContext(parent, payload, actualValue, gradedAt);

  const write = () => {
    db.prepare(`
      UPDATE projection_accuracy_evals
      SET actual = ?,
          actual_value = ?,
          grade_status = 'GRADED',
          graded_result = ?,
          graded_at = ?,
          abs_error = ?,
          signed_error = ?,
          absolute_error = ?,
          projection_confidence = ?,
          confidence_score = ?,
          confidence_band = ?,
          expected_over_prob = ?,
          expected_direction_prob = ?,
          failure_flags = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE card_id = ?
    `).run(
      actualValue,
      actualValue,
      parentGrade.gradedResult,
      gradedAt,
      absoluteError,
      signedError,
      absoluteError,
      confidence,
      confidence,
      confidenceBand(confidence),
      expectedOverProb,
      expectedDirProb,
      JSON.stringify(Array.from(failureFlags).sort()),
      cardId,
    );

    const lineRows = db
      .prepare('SELECT id, eval_line, direction, edge_vs_line, weak_direction_flag FROM projection_accuracy_line_evals WHERE card_id = ?')
      .all(cardId);
    for (const row of lineRows) {
      const lineExpectedOver = expectedOverProbability(parent.projection_value, row.eval_line);
      const lineExpectedDir = expectedDirectionProbability(parent.projection_value, row.eval_line, row.direction);
      const lineConfidence = deriveProjectionConfidence({
        edgeDistance: Math.abs(row.edge_vs_line ?? 0),
        historicalBucketHitRate,
        varianceOfMarket,
        marketFamily: parent.market_family,
      });
      const lineGrade = gradeLine({
        actualValue,
        line: row.eval_line,
        direction: row.weak_direction_flag ? 'NO_EDGE' : row.direction,
      });
      db.prepare(`
        UPDATE projection_accuracy_line_evals
        SET actual_value = ?,
            game_id = ?,
            settled_at = ?,
            snapshot_time = ?,
            market_total = ?,
            raw_total = ?,
            calibrated_total = ?,
            actual_total = ?,
            total_error_raw = ?,
            total_error_calibrated = ?,
            pace_tier = ?,
            vol_env = ?,
            total_band = ?,
            injury_cloud = ?,
            driver_contributions_json = ?,
            regime_tags_json = ?,
            confidence_tier = ?,
            grade_status = 'GRADED',
            graded_result = ?,
            hit_flag = ?,
            confidence_score = ?,
            confidence_band = ?,
            expected_over_prob = ?,
            expected_direction_prob = ?,
            graded_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        actualValue,
        lineEvalSettlementContext.gameId,
        lineEvalSettlementContext.settledAt,
        lineEvalSettlementContext.snapshotTime,
        lineEvalSettlementContext.marketTotal,
        lineEvalSettlementContext.rawTotal,
        lineEvalSettlementContext.calibratedTotal,
        lineEvalSettlementContext.actualTotal,
        lineEvalSettlementContext.totalErrorRaw,
        lineEvalSettlementContext.totalErrorCalibrated,
        lineEvalSettlementContext.paceTier,
        lineEvalSettlementContext.volEnv,
        lineEvalSettlementContext.totalBand,
        lineEvalSettlementContext.injuryCloud,
        lineEvalSettlementContext.driverContributionsJson,
        lineEvalSettlementContext.regimeTagsJson,
        lineEvalSettlementContext.confidenceTier,
        lineGrade.gradedResult,
        lineGrade.hitFlag,
        lineConfidence,
        confidenceBand(lineConfidence),
        lineExpectedOver,
        lineExpectedDir,
        gradedAt,
        row.id,
      );
    }

    const marketTrustStatus = computeMarketTrustStatusForFamily(db, parent.market_family);
    db.prepare(`
      UPDATE projection_accuracy_evals
      SET market_trust_status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE market_family = ?
    `).run(marketTrustStatus, parent.market_family);
  };

  if (typeof db.transaction === 'function') {
    db.transaction(write)();
  } else {
    db.exec('BEGIN');
    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  return true;
}

function actualResultFromEvalRow(row) {
  const config = TRACKED_PROJECTION_ACCURACY_CARD_TYPES[normalizeCardType(row?.card_type)];
  const actualValue = toFiniteNumberOrNull(row?.actual_value ?? row?.actual);
  if (!config || actualValue === null) return null;
  return { [config.actualKeys[0]]: actualValue };
}

function backfillProjectionAccuracyEvals(db, {
  limit = 1000,
  now = new Date().toISOString(),
} = {}) {
  if (!db) return { processed: 0, updated: 0, lineRowsInserted: 0, graded: 0, unableToReconstruct: 0 };
  const maxRows = Math.max(1, Math.min(Number(limit) || 1000, 10000));
  const rows = db.prepare(`
    SELECT *
    FROM projection_accuracy_evals
    WHERE projection_raw IS NULL
       OR synthetic_line IS NULL
       OR synthetic_direction IS NULL
       OR direction_strength IS NULL
       OR projection_confidence IS NULL
       OR failure_flags IS NULL
       OR expected_over_prob IS NULL
       OR expected_direction_prob IS NULL
       OR calibration_bucket IS NULL
       OR market_type IS NULL
       OR player_or_game_id IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(maxRows);

  let updated = 0;
  let lineRowsInserted = 0;
  let graded = 0;
  let unableToReconstruct = 0;

  const write = () => {
    for (const row of rows) {
      const projectionRaw = toFiniteNumberOrNull(row.projection_raw) ?? toFiniteNumberOrNull(row.projection_value);
      const syntheticLine =
        toFiniteNumberOrNull(row.synthetic_line) ??
        toFiniteNumberOrNull(row.nearest_half_line) ??
        roundToNearestHalf(projectionRaw);
      const failureAdditions = [];
      if (projectionRaw === null || syntheticLine === null) {
        failureAdditions.push('BACKFILL_UNABLE_TO_RECONSTRUCT');
        unableToReconstruct += 1;
      }

      const syntheticDirection = projectionRaw === null || syntheticLine === null
        ? 'NO_EDGE'
        : directionFromProjectionLine(projectionRaw, syntheticLine);
      const edgeDistance = projectionRaw === null || syntheticLine === null
        ? 0
        : Math.abs(projectionRaw - syntheticLine);
      const weakDirectionFlag = syntheticDirection === 'NO_EDGE' || edgeDistance < WEAK_DIRECTION_EDGE_THRESHOLD ? 1 : 0;
      if (weakDirectionFlag) failureAdditions.push('DIRECTION_TOO_WEAK');
      const actualValue = toFiniteNumberOrNull(row.actual_value ?? row.actual);
      const confidence = deriveProjectionConfidence({
        edgeDistance,
        historicalBucketHitRate: 0.5,
        varianceOfMarket: null,
        marketFamily: row.market_family,
      });
      const expectedOverProb = expectedOverProbability(projectionRaw, syntheticLine);
      const expectedDirProb = expectedDirectionProbability(projectionRaw, syntheticLine, syntheticDirection);
      const absError = actualValue === null || projectionRaw === null
        ? null
        : roundMetric(Math.abs(projectionRaw - actualValue), 6);
      const signedError = actualValue === null || projectionRaw === null
        ? null
        : roundMetric(projectionRaw - actualValue, 6);
      const playerOrGameId = row.player_or_game_id || row.player_id || row.player_name || row.game_id || null;

      db.prepare(`
        UPDATE projection_accuracy_evals
        SET market_type = COALESCE(market_type, ?),
            player_or_game_id = COALESCE(player_or_game_id, ?),
            projection_raw = COALESCE(projection_raw, ?),
            synthetic_line = COALESCE(synthetic_line, ?),
            synthetic_rule = COALESCE(synthetic_rule, ?),
            synthetic_direction = COALESCE(synthetic_direction, ?),
            direction_strength = COALESCE(direction_strength, ?),
            weak_direction_flag = ?,
            projection_confidence = COALESCE(projection_confidence, ?),
            confidence_score = COALESCE(confidence_score, ?),
            confidence_band = CASE
              WHEN confidence_band IS NULL OR confidence_band = 'UNKNOWN' THEN ?
              ELSE confidence_band
            END,
            failure_flags = ?,
            actual = COALESCE(actual, ?),
            abs_error = COALESCE(abs_error, ?),
            signed_error = COALESCE(signed_error, ?),
            absolute_error = COALESCE(absolute_error, ?),
            expected_over_prob = COALESCE(expected_over_prob, ?),
            expected_direction_prob = COALESCE(expected_direction_prob, ?),
            calibration_bucket = COALESCE(calibration_bucket, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        row.market_family,
        playerOrGameId,
        projectionRaw,
        syntheticLine,
        SYNTHETIC_RULE_NEAREST_HALF,
        syntheticDirection,
        weakDirectionFlag ? 'WEAK' : 'STRONG',
        weakDirectionFlag,
        confidence,
        confidence,
        confidenceBand(confidence),
        JSON.stringify(mergeFailureFlags(row.failure_flags, failureAdditions)),
        actualValue,
        absError,
        signedError,
        absError,
        expectedOverProb,
        expectedDirProb,
        calibrationBucketForProjection(projectionRaw),
        row.id,
      );
      updated += 1;

      if (projectionRaw !== null && syntheticLine !== null) {
        const capture = {
          cardId: row.card_id,
          projectionValue: projectionRaw,
          nearestHalfLine: syntheticLine,
          selectedLine: toFiniteNumberOrNull(row.selected_line),
          marketFamily: row.market_family,
          marketTrust: row.market_trust || 'UNVERIFIED',
          historicalBucketHitRate: 0.5,
          varianceOfMarket: null,
        };
        const parent = { id: row.id };
        for (const lineRow of buildProjectionAccuracyLineRows(capture)) {
          const info = db.prepare(`
            INSERT OR IGNORE INTO projection_accuracy_line_evals (
              eval_id, card_id, line_role, line, eval_line, projection_value,
              direction, weak_direction_flag, edge_vs_line,
              confidence_score, confidence_band, market_trust,
              expected_over_prob, expected_direction_prob, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
            parent.id,
            lineRow.card_id,
            lineRow.line_role,
            lineRow.line,
            lineRow.eval_line,
            lineRow.projection_value,
            lineRow.direction,
            lineRow.weak_direction_flag,
            lineRow.edge_vs_line,
            lineRow.confidence_score,
            lineRow.confidence_band,
            lineRow.market_trust,
            lineRow.expected_over_prob,
            lineRow.expected_direction_prob,
          );
          lineRowsInserted += Number(info?.changes || 0);
        }
      }
    }
  };

  if (typeof db.transaction === 'function') {
    db.transaction(write)();
  } else {
    db.exec('BEGIN');
    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  for (const row of rows) {
    const actualResult = actualResultFromEvalRow(row);
    if (actualResult && gradeProjectionAccuracyEval(db, { cardId: row.card_id, actualResult, gradedAt: now })) {
      graded += 1;
    }
  }

  return {
    processed: rows.length,
    updated,
    lineRowsInserted,
    graded,
    unableToReconstruct,
  };
}

function buildWhereClause(opts = {}, tableAlias = 'e') {
  const clauses = [];
  const params = [];
  const add = (sql, value) => {
    clauses.push(sql);
    params.push(value);
  };

  if (opts.cardId) add(`${tableAlias}.card_id = ?`, opts.cardId);
  if (opts.gameId) add(`${tableAlias}.game_id = ?`, opts.gameId);
  if (opts.sport) add(`LOWER(${tableAlias}.sport) = LOWER(?)`, opts.sport);
  if (opts.cardType) add(`${tableAlias}.card_type = ?`, normalizeCardType(opts.cardType));
  if (opts.marketFamily) add(`${tableAlias}.market_family = ?`, opts.marketFamily);
  if (opts.marketTrust) add(`${tableAlias}.market_trust = ?`, opts.marketTrust);
  if (opts.confidenceBand) add(`${tableAlias}.confidence_band = ?`, opts.confidenceBand);
  if (opts.gradeStatus) add(`${tableAlias}.grade_status = ?`, opts.gradeStatus);
  if (opts.capturedAtGte) add(`${tableAlias}.captured_at >= ?`, opts.capturedAtGte);
  if (opts.capturedAtLte) add(`${tableAlias}.captured_at <= ?`, opts.capturedAtLte);

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function getProjectionAccuracyEvals(db, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 500, 5000));
  const { where, params } = buildWhereClause(opts, 'e');
  return db
    .prepare(`
      SELECT e.*,
        ABS(
          COALESCE(e.projection_raw, e.projection_value) -
          COALESCE(e.synthetic_line, e.nearest_half_line)
        ) AS edge_distance
      FROM projection_accuracy_evals e
      ${where}
      ORDER BY datetime(e.captured_at) DESC, e.id DESC
      LIMIT ?
    `)
    .all(...params, limit);
}

function getProjectionAccuracyLineEvals(db, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 1000, 10000));
  const { where, params } = buildWhereClause(opts, 'e');
  const clauses = where ? [where.replace(/^WHERE /, '')] : [];
  const lineParams = [...params];
  if (opts.lineRole) {
    clauses.push('l.line_role = ?');
    lineParams.push(opts.lineRole);
  }
  const finalWhere = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`
      SELECT
        l.*,
        e.game_id,
        e.sport,
        e.card_type,
        e.market_family,
        e.player_id,
        e.player_name,
        e.period,
        e.captured_at
      FROM projection_accuracy_line_evals l
      JOIN projection_accuracy_evals e ON e.card_id = l.card_id
      ${finalWhere}
      ORDER BY datetime(e.captured_at) DESC, l.id DESC
      LIMIT ?
    `)
    .all(...lineParams, limit);
}

function getProjectionAccuracyMarketHealth(db, opts = {}) {
  const clauses = [];
  const params = [];
  if (opts.marketFamily) {
    clauses.push('market_family = ?');
    params.push(opts.marketFamily);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  try {
    const rows = db.prepare(`
      SELECT *
      FROM projection_accuracy_market_health
      ${where}
      ORDER BY market_family ASC
    `).all(...params);
    return rows.map((row) => ({
      ...row,
      confidence_lift: parseJsonObject(row.confidence_lift_json) || {},
    }));
  } catch {
    return [];
  }
}

function rowsByKey(rows, keyName) {
  const output = {};
  for (const row of rows) {
    const wins = Number(row.wins || 0);
    const losses = Number(row.losses || 0);
    output[row[keyName] ?? 'UNKNOWN'] = {
      line_evals: Number(row.line_evals || 0),
      wins,
      losses,
      pushes: Number(row.pushes || 0),
      no_bets: Number(row.no_bets || 0),
      hit_rate: wins + losses > 0 ? wins / (wins + losses) : null,
      avg_absolute_error: row.avg_absolute_error ?? null,
    };
  }
  return output;
}

function getProjectionAccuracyEvalSummary(db, opts = {}) {
  const { where, params } = buildWhereClause(opts, 'e');
  const clauses = where ? [where.replace(/^WHERE /, '')] : [];
  const lineParams = [...params];
  const lineRole = opts.lineRole || 'SYNTHETIC';
  if (lineRole !== 'ALL') {
    clauses.push('l.line_role = ?');
    lineParams.push(lineRole);
  }
  const finalWhere = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const overall = db.prepare(`
    SELECT
      COUNT(DISTINCT e.card_id) AS total_cards,
      COUNT(l.id) AS total_line_evals,
      SUM(CASE WHEN l.grade_status = 'GRADED' THEN 1 ELSE 0 END) AS graded_line_evals,
      SUM(CASE WHEN l.graded_result = 'WIN' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN l.graded_result = 'LOSS' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN l.graded_result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN l.graded_result = 'NO_BET' THEN 1 ELSE 0 END) AS no_bets,
      SUM(CASE WHEN l.weak_direction_flag = 1 THEN 1 ELSE 0 END) AS weak_direction_count,
      AVG(e.absolute_error) AS avg_absolute_error,
      AVG(e.signed_error) AS avg_signed_error,
      AVG(e.projection_confidence) AS avg_projection_confidence,
      AVG(
        CASE
          WHEN e.actual_value IS NOT NULL
           AND e.synthetic_line IS NOT NULL
           AND e.expected_over_prob IS NOT NULL
          THEN ABS(e.expected_over_prob - CASE WHEN e.actual_value > e.synthetic_line THEN 1.0 ELSE 0.0 END)
        END
      ) AS calibration_gap
    FROM projection_accuracy_line_evals l
    JOIN projection_accuracy_evals e ON e.card_id = l.card_id
    ${finalWhere}
  `).get(...lineParams);

  const groupSql = (column) => `
    SELECT
      ${column} AS bucket,
      COUNT(l.id) AS line_evals,
      SUM(CASE WHEN l.graded_result = 'WIN' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN l.graded_result = 'LOSS' AND COALESCE(l.weak_direction_flag, 0) = 0 THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN l.graded_result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN l.graded_result = 'NO_BET' THEN 1 ELSE 0 END) AS no_bets,
      AVG(e.absolute_error) AS avg_absolute_error
    FROM projection_accuracy_line_evals l
    JOIN projection_accuracy_evals e ON e.card_id = l.card_id
    ${finalWhere}
    GROUP BY ${column}
    ORDER BY line_evals DESC
  `;

  const byCardTypeRows = db.prepare(groupSql('e.card_type')).all(...lineParams);
  const byMarketTrustRows = db.prepare(groupSql('e.market_trust')).all(...lineParams);
  const byConfidenceBandRows = db.prepare(groupSql('l.confidence_band')).all(...lineParams);

  const wins = Number(overall?.wins || 0);
  const losses = Number(overall?.losses || 0);
  const totalLineEvals = Number(overall?.total_line_evals || 0);
  const weakDirectionCount = Number(overall?.weak_direction_count || 0);
  const weakShare = totalLineEvals > 0 ? weakDirectionCount / totalLineEvals : 0;
  const calibrationGap = Number(overall?.calibration_gap || 0);
  const marketTrustStatus = computeMarketTrustStatus({
    wins,
    losses,
    calibrationGap,
    weakShare,
    monotonicLift: hasMonotonicConfidenceLift(byConfidenceBandRows.map((row) => ({
      band: row.bucket,
      wins: row.wins,
      losses: row.losses,
    }))),
  });

  return {
    line_role: lineRole,
    total_cards: Number(overall?.total_cards || 0),
    total_line_evals: totalLineEvals,
    graded_line_evals: Number(overall?.graded_line_evals || 0),
    wins,
    losses,
    pushes: Number(overall?.pushes || 0),
    no_bets: Number(overall?.no_bets || 0),
    hit_rate: wins + losses > 0 ? wins / (wins + losses) : null,
    weak_direction_count: weakDirectionCount,
    weak_direction_share: weakShare,
    avg_absolute_error: overall?.avg_absolute_error ?? null,
    avg_signed_error: overall?.avg_signed_error ?? null,
    avg_projection_confidence: overall?.avg_projection_confidence ?? null,
    calibration_gap: calibrationGap,
    market_trust_status: marketTrustStatus,
    by_card_type: rowsByKey(byCardTypeRows, 'bucket'),
    by_market_trust: rowsByKey(byMarketTrustRows, 'bucket'),
    by_confidence_band: rowsByKey(byConfidenceBandRows, 'bucket'),
  };
}

module.exports = {
  TRACKED_PROJECTION_ACCURACY_CARD_TYPES,
  COMMON_LINES_BY_MARKET_FAMILY,
  MARKET_CONFIDENCE_DEFAULTS,
  PROJECTION_ACCURACY_MARKET_FAMILIES,
  WEAK_DIRECTION_EDGE_THRESHOLD,
  isProjectionAccuracyCardType,
  roundToNearestHalf,
  expectedOverProbability,
  expectedDirectionProbability,
  calibrationBucketForProjection,
  computeMarketTrustStatus,
  computeProjectionAccuracyMarketHealth,
  materializeProjectionAccuracyMarketHealth,
  backfillProjectionAccuracyEvals,
  deriveProjectionAccuracyCapture,
  deriveProjectionConfidence,
  resolveProjectionMarketTrust,
  captureProjectionAccuracyEval,
  captureProjectionAccuracyForCard,
  gradeProjectionAccuracyEval,
  getProjectionAccuracyEvals,
  getProjectionAccuracyLineEvals,
  getProjectionAccuracyMarketHealth,
  getProjectionAccuracyEvalSummary,
  insertProjectionProxyEval,
  batchInsertProjectionProxyEvals,
  getProjectionProxyEvals,
  getProjectionAccuracySummary,
};
