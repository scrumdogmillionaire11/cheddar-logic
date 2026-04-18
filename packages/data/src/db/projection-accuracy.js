'use strict';

/**
 * projection-accuracy.js — WI-0864
 *
 * Data access layer for projection_proxy_evals table.
 * Stores per-game × per-proxy-line graded rows for MLB F5 and NHL 1P projections.
 *
 * All functions accept `db` as first argument (better-sqlite3 / DatabaseProxy instance).
 */

const TRACKED_PROJECTION_ACCURACY_CARD_TYPES = Object.freeze({
  'nhl-player-shots': Object.freeze({
    marketFamily: 'NHL_PLAYER_SHOTS_FULL_GAME',
    actualKeys: ['shots'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: ['decision.projection', 'decision.model_projection', 'projectedTotal', 'mu', 'drivers.sog_mu'],
    propType: 'shots_on_goal',
  }),
  'nhl-player-shots-1p': Object.freeze({
    marketFamily: 'NHL_PLAYER_SHOTS_1P',
    actualKeys: ['shots_1p'],
    defaultPeriod: '1P',
    projectionKeys: ['decision.projection', 'decision.model_projection', 'projectedTotal', 'mu', 'drivers.sog_mu'],
    propType: 'shots_on_goal',
  }),
  'nhl-player-blk': Object.freeze({
    marketFamily: 'NHL_PLAYER_BLOCKS_FULL_GAME',
    actualKeys: ['blocks'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: ['decision.projection', 'projectedTotal', 'mu', 'drivers.blk_mu'],
    propType: 'blocked_shots',
  }),
  'mlb-pitcher-k': Object.freeze({
    marketFamily: 'MLB_PITCHER_STRIKEOUTS',
    actualKeys: ['pitcher_ks'],
    defaultPeriod: 'FULL_GAME',
    projectionKeys: [
      'projection.k_mean',
      'projection.projected',
      'pitcher_k_result.projection.k_mean',
      'pitcher_k_result.k_mean',
      'drivers.0.projected',
      'drivers.0.projection',
    ],
    propType: 'strikeouts',
  }),
});

const WEAK_DIRECTION_EDGE_THRESHOLD = 0.25;

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
  return Math.round(parsed * 2) / 2;
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
  if (projection === null || parsedLine === null) return 'PASS';
  if (projection > parsedLine) return 'OVER';
  if (projection < parsedLine) return 'UNDER';
  return 'PASS';
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

function normalizeConfidenceScore(value) {
  const parsed = toFiniteNumberOrNull(value);
  if (parsed === null) return null;
  if (parsed > 1 && parsed <= 100) return parsed / 100;
  return Math.max(0, Math.min(1, parsed));
}

function confidenceBand(score) {
  const parsed = toFiniteNumberOrNull(score);
  if (parsed === null) return 'UNKNOWN';
  if (parsed >= 0.7) return 'HIGH';
  if (parsed >= 0.55) return 'MEDIUM';
  if (parsed >= 0.4) return 'LOW';
  return 'FRAGILE';
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

function deriveProjectionConfidence({ payload = {}, projectionValue, line, marketTrust }) {
  const explicit = normalizeConfidenceScore(payload?.confidence ?? payload?.decision?.confidence);
  const edge = Math.abs((toFiniteNumberOrNull(projectionValue) ?? 0) - (toFiniteNumberOrNull(line) ?? 0));
  const edgeComponent =
    edge >= 1.5 ? 0.9 :
      edge >= 1.0 ? 0.78 :
        edge >= 0.5 ? 0.65 :
          edge >= WEAK_DIRECTION_EDGE_THRESHOLD ? 0.52 :
            0.42;
  const base = explicit === null ? edgeComponent : ((explicit * 0.7) + (edgeComponent * 0.3));
  const trustMultiplier =
    marketTrust === 'ODDS_BACKED' ? 1 :
      marketTrust === 'PROJECTION_ONLY' ? 0.88 :
        marketTrust === 'SYNTHETIC_FALLBACK' ? 0.82 :
          0.75;
  const capped = edge < WEAK_DIRECTION_EDGE_THRESHOLD
    ? Math.min(base * trustMultiplier, 0.49)
    : base * trustMultiplier;
  return roundMetric(Math.max(0, Math.min(1, capped)), 3);
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
  if (!side) {
    return { gradedResult: 'NO_BET', hitFlag: 0 };
  }
  if (actual === evalLine) {
    return { gradedResult: 'PUSH', hitFlag: null };
  }
  const won = side === 'OVER' ? actual > evalLine : actual < evalLine;
  return { gradedResult: won ? 'WIN' : 'LOSS', hitFlag: won ? 1 : 0 };
}

function buildProjectionAccuracyLineRows(capture) {
  if (!capture) return [];
  const rows = [];
  const addLine = (lineRole, line) => {
    const evalLine = toFiniteNumberOrNull(line);
    if (evalLine === null) return;
    const direction = directionFromProjectionLine(capture.projectionValue, evalLine);
    const edge = roundMetric(capture.projectionValue - evalLine, 6);
    const weakDirectionFlag = Math.abs(edge ?? 0) < WEAK_DIRECTION_EDGE_THRESHOLD ? 1 : 0;
    const confidenceScore = deriveProjectionConfidence({
      payload: capture.payloadData,
      projectionValue: capture.projectionValue,
      line: evalLine,
      marketTrust: capture.marketTrust,
    });
    rows.push({
      card_id: capture.cardId,
      line_role: lineRole,
      eval_line: evalLine,
      projection_value: capture.projectionValue,
      direction,
      weak_direction_flag: weakDirectionFlag,
      edge_vs_line: edge,
      confidence_score: confidenceScore,
      confidence_band: confidenceBand(confidenceScore),
      market_trust: capture.marketTrust,
    });
  };

  addLine('NEAREST_HALF', capture.nearestHalfLine);
  if (
    capture.selectedLine !== null &&
    capture.nearestHalfLine !== null &&
    Math.abs(capture.selectedLine - capture.nearestHalfLine) > 1e-9
  ) {
    addLine('SELECTED_MARKET', capture.selectedLine);
  }

  return rows;
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

  const selectedLine = resolveSelectedLine(payloadData);
  const nearestHalfLine = roundToNearestHalf(projectionValue);
  if (nearestHalfLine === null) return null;

  const primaryLine = selectedLine ?? nearestHalfLine;
  const { marketTrust, flags, lineSource, basis } = resolveProjectionMarketTrust(payloadData);
  const selectedDirection = resolveSelectedDirection(payloadData, projectionValue, primaryLine);
  const primaryEdge = roundMetric(projectionValue - primaryLine, 6);
  const weakDirectionFlag = Math.abs(primaryEdge ?? 0) < WEAK_DIRECTION_EDGE_THRESHOLD ? 1 : 0;
  const confidenceScore = deriveProjectionConfidence({
    payload: payloadData,
    projectionValue,
    line: primaryLine,
    marketTrust,
  });
  const period = pickFirstString(payloadData, [
    'period',
    'play.period',
    'market.period',
  ]) ?? config.defaultPeriod;

  return {
    cardId: card.id ?? card.card_id,
    gameId: card.gameId ?? card.game_id ?? payloadData.game_id ?? null,
    sport: card.sport ?? payloadData.sport ?? null,
    cardType,
    marketFamily: config.marketFamily,
    playerId: pickFirstString(payloadData, ['player_id', 'play.player_id', 'play.selection.player_id']),
    playerName: pickFirstString(payloadData, ['player_name', 'play.player_name', 'play.selection.player_name']),
    teamAbbr: pickFirstString(payloadData, ['team_abbr', 'team_abbrev', 'play.selection.team']),
    period,
    projectionValue: roundMetric(projectionValue, 6),
    selectedLine,
    nearestHalfLine,
    selectedDirection,
    weakDirectionFlag,
    confidenceScore,
    confidenceBand: confidenceBand(confidenceScore),
    marketTrust,
    marketTrustFlags: flags,
    lineSource,
    basis,
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
      INSERT INTO projection_accuracy_evals (
        card_id, game_id, sport, card_type, market_family,
        player_id, player_name, team_abbr, period,
        projection_value, selected_line, nearest_half_line, selected_direction,
        weak_direction_flag, confidence_score, confidence_band,
        market_trust, market_trust_flags, line_source, basis,
        captured_at, generated_at, metadata, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT(card_id) DO UPDATE SET
        game_id = excluded.game_id,
        sport = excluded.sport,
        card_type = excluded.card_type,
        market_family = excluded.market_family,
        player_id = excluded.player_id,
        player_name = excluded.player_name,
        team_abbr = excluded.team_abbr,
        period = excluded.period,
        projection_value = excluded.projection_value,
        selected_line = excluded.selected_line,
        nearest_half_line = excluded.nearest_half_line,
        selected_direction = excluded.selected_direction,
        weak_direction_flag = excluded.weak_direction_flag,
        confidence_score = excluded.confidence_score,
        confidence_band = excluded.confidence_band,
        market_trust = excluded.market_trust,
        market_trust_flags = excluded.market_trust_flags,
        line_source = excluded.line_source,
        basis = excluded.basis,
        captured_at = excluded.captured_at,
        generated_at = excluded.generated_at,
        metadata = excluded.metadata,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      capture.cardId,
      capture.gameId,
      capture.sport ? String(capture.sport).toLowerCase() : null,
      capture.cardType,
      capture.marketFamily,
      capture.playerId,
      capture.playerName,
      capture.teamAbbr,
      capture.period,
      capture.projectionValue,
      capture.selectedLine,
      capture.nearestHalfLine,
      capture.selectedDirection,
      capture.weakDirectionFlag,
      capture.confidenceScore,
      capture.confidenceBand,
      capture.marketTrust,
      JSON.stringify(capture.marketTrustFlags ?? []),
      capture.lineSource,
      capture.basis,
      capture.capturedAt,
      capture.generatedAt,
      JSON.stringify(capture.metadata ?? {}),
    );

    const parent = db
      .prepare('SELECT id FROM projection_accuracy_evals WHERE card_id = ?')
      .get(capture.cardId);

    for (const row of lineRows) {
      db.prepare(`
        INSERT INTO projection_accuracy_line_evals (
          eval_id, card_id, line_role, eval_line, projection_value,
          direction, weak_direction_flag, edge_vs_line,
          confidence_score, confidence_band, market_trust, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(card_id, line_role) DO UPDATE SET
          eval_id = excluded.eval_id,
          eval_line = excluded.eval_line,
          projection_value = excluded.projection_value,
          direction = excluded.direction,
          weak_direction_flag = excluded.weak_direction_flag,
          edge_vs_line = excluded.edge_vs_line,
          confidence_score = excluded.confidence_score,
          confidence_band = excluded.confidence_band,
          market_trust = excluded.market_trust,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        parent?.id ?? null,
        row.card_id,
        row.line_role,
        row.eval_line,
        row.projection_value,
        row.direction,
        row.weak_direction_flag,
        row.edge_vs_line,
        row.confidence_score,
        row.confidence_band,
        row.market_trust,
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
  if (actualValue === null) return false;

  const primaryLine = parent.selected_line !== null && parent.selected_line !== undefined
    ? parent.selected_line
    : parent.nearest_half_line;
  const parentGrade = gradeLine({
    actualValue,
    line: primaryLine,
    direction: parent.selected_direction,
  });
  const absoluteError = roundMetric(Math.abs(actualValue - parent.projection_value), 6);

  const write = () => {
    db.prepare(`
      UPDATE projection_accuracy_evals
      SET actual_value = ?,
          grade_status = 'GRADED',
          graded_result = ?,
          graded_at = ?,
          absolute_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE card_id = ?
    `).run(actualValue, parentGrade.gradedResult, gradedAt, absoluteError, cardId);

    const lineRows = db
      .prepare('SELECT id, eval_line, direction FROM projection_accuracy_line_evals WHERE card_id = ?')
      .all(cardId);
    for (const row of lineRows) {
      const lineGrade = gradeLine({
        actualValue,
        line: row.eval_line,
        direction: row.direction,
      });
      db.prepare(`
        UPDATE projection_accuracy_line_evals
        SET actual_value = ?,
            grade_status = 'GRADED',
            graded_result = ?,
            hit_flag = ?,
            graded_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(actualValue, lineGrade.gradedResult, lineGrade.hitFlag, gradedAt, row.id);
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
      SELECT *
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
  const lineRole = opts.lineRole || 'NEAREST_HALF';
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
      SUM(CASE WHEN l.graded_result = 'WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN l.graded_result = 'LOSS' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN l.graded_result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN l.graded_result = 'NO_BET' THEN 1 ELSE 0 END) AS no_bets,
      SUM(CASE WHEN l.weak_direction_flag = 1 THEN 1 ELSE 0 END) AS weak_direction_count,
      AVG(e.absolute_error) AS avg_absolute_error
    FROM projection_accuracy_line_evals l
    JOIN projection_accuracy_evals e ON e.card_id = l.card_id
    ${finalWhere}
  `).get(...lineParams);

  const groupSql = (column) => `
    SELECT
      ${column} AS bucket,
      COUNT(l.id) AS line_evals,
      SUM(CASE WHEN l.graded_result = 'WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN l.graded_result = 'LOSS' THEN 1 ELSE 0 END) AS losses,
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

  return {
    line_role: lineRole,
    total_cards: Number(overall?.total_cards || 0),
    total_line_evals: Number(overall?.total_line_evals || 0),
    graded_line_evals: Number(overall?.graded_line_evals || 0),
    wins,
    losses,
    pushes: Number(overall?.pushes || 0),
    no_bets: Number(overall?.no_bets || 0),
    hit_rate: wins + losses > 0 ? wins / (wins + losses) : null,
    weak_direction_count: Number(overall?.weak_direction_count || 0),
    avg_absolute_error: overall?.avg_absolute_error ?? null,
    by_card_type: rowsByKey(byCardTypeRows, 'bucket'),
    by_market_trust: rowsByKey(byMarketTrustRows, 'bucket'),
    by_confidence_band: rowsByKey(byConfidenceBandRows, 'bucket'),
  };
}

module.exports = {
  TRACKED_PROJECTION_ACCURACY_CARD_TYPES,
  WEAK_DIRECTION_EDGE_THRESHOLD,
  isProjectionAccuracyCardType,
  roundToNearestHalf,
  deriveProjectionAccuracyCapture,
  deriveProjectionConfidence,
  resolveProjectionMarketTrust,
  captureProjectionAccuracyEval,
  captureProjectionAccuracyForCard,
  gradeProjectionAccuracyEval,
  getProjectionAccuracyEvals,
  getProjectionAccuracyLineEvals,
  getProjectionAccuracyEvalSummary,
  insertProjectionProxyEval,
  batchInsertProjectionProxyEvals,
  getProjectionProxyEvals,
  getProjectionAccuracySummary,
};
