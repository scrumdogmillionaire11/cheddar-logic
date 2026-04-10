'use strict';

/**
 * projection-accuracy.js — WI-0864
 *
 * Data access layer for projection_proxy_evals table.
 * Stores per-game × per-proxy-line graded rows for MLB F5 and NHL 1P projections.
 *
 * All functions accept `db` as first argument (better-sqlite3 / DatabaseProxy instance).
 */

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

module.exports = {
  insertProjectionProxyEval,
  batchInsertProjectionProxyEvals,
  getProjectionProxyEvals,
  getProjectionAccuracySummary,
};
