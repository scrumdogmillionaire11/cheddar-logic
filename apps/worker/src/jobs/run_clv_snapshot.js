'use strict';

/**
 * Run CLV Snapshot Job
 *
 * Reads settled clv_ledger rows (where closing_odds is set by
 * settle_pending_cards) and writes per-entry CLV delta rows to clv_entries.
 *
 * clv_ledger is the canonical pick-side owner.  This job is the exclusive
 * writer of clv_entries — closing-side + delta.
 *
 * CLV = closing_implied_prob − implied_prob_at_placement
 * Positive = the closing market priced the side HIGHER than we paid.
 *
 * Run after settle_pending_cards, e.g. nightly 03:00 ET.
 *
 * WI-0826
 */

require('dotenv').config();

const {
  closeDatabase,
  getDatabase,
} = require('@cheddar-logic/data');

/**
 * Convert American odds integer to no-vig implied probability.
 * Returns null for invalid / 0 input.
 *
 * @param {number|null} odds - American moneyline integer (e.g. -110, +150)
 * @returns {number|null}
 */
function americanOddsToImpliedProb(odds) {
  if (odds === null || odds === undefined || !Number.isFinite(Number(odds))) {
    return null;
  }
  const o = Number(odds);
  if (o === 0) return null;
  const raw = o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
  return Number(raw.toFixed(6));
}

/**
 * CLV = closing_implied_prob − implied_prob_at_placement
 * Positive CLV = closed at a higher probability for our side = we got value.
 *
 * @param {number|null} impliedProbAtPlacement
 * @param {number|null} closingImpliedProb
 * @returns {number|null}
 */
function computeCLV(impliedProbAtPlacement, closingImpliedProb) {
  if (impliedProbAtPlacement === null || impliedProbAtPlacement === undefined) {
    return null;
  }
  if (closingImpliedProb === null || closingImpliedProb === undefined) {
    return null;
  }
  const a = Number(impliedProbAtPlacement);
  const b = Number(closingImpliedProb);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Number((b - a).toFixed(4));
}

/**
 * Resolve outcome integer from card_results row.
 *
 * @param {string|null} result
 * @returns {number|null}
 */
function toOutcome(result) {
  const token = String(result || '').trim().toLowerCase();
  if (token === 'win') return 1;
  if (token === 'loss') return 0;
  return null;
}

/**
 * Normalise a market_type string into the calibration key format.
 * E.g. sport=NHL, betType=TOTAL → NHL_TOTAL.
 *
 * @param {string|null} sport
 * @param {string|null} marketType
 * @returns {string|null}
 */
function buildMarketKey(sport, marketType) {
  if (!sport || !marketType) return null;
  const s = String(sport).trim().toUpperCase();
  const mt = String(marketType).trim().toUpperCase();
  return `${s}_${mt}`;
}

/**
 * Find clv_ledger rows that have closing odds but no matching clv_entries row
 * yet.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<object>}
 */
function findUnsnapshotted(db) {
  const tablesStmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('clv_ledger','clv_entries')",
  );
  const tables = tablesStmt.all().map((r) => r.name);
  if (!tables.includes('clv_ledger') || !tables.includes('clv_entries')) {
    return [];
  }

  return db.prepare(`
    SELECT
      cl.card_id,
      cl.game_id,
      cl.sport,
      cl.market_type,
      cl.selection        AS side,
      cl.odds_at_pick,
      cl.closing_odds,
      cl.clv_pct,
      cl.closed_at
    FROM clv_ledger cl
    WHERE cl.closing_odds IS NOT NULL
      AND cl.closed_at   IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM clv_entries ce
        WHERE ce.game_id = cl.game_id
          AND ce.market  = UPPER(cl.sport || '_' || COALESCE(cl.market_type, ''))
          AND ce.side    = UPPER(COALESCE(cl.selection, ''))
      )
    ORDER BY cl.closed_at DESC
    LIMIT 500
  `).all();
}

/**
 * Look up calibration_predictions for a game/market/side to get fair_prob
 * and implied_prob that were recorded at card creation time.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} p
 * @returns {{fairProb: number|null, impliedProb: number|null}}
 */
function lookupCalibrationPrediction(db, { gameId, market, side }) {
  const hasCp = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_predictions'",
  ).get();
  if (!hasCp) return { fairProb: null, impliedProb: null };

  const row = db.prepare(`
    SELECT fair_prob, implied_prob
    FROM calibration_predictions
    WHERE game_id = ?
      AND market  = ?
      AND side    = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(gameId, market, side);

  return {
    fairProb: row?.fair_prob ?? null,
    impliedProb: row?.implied_prob ?? null,
  };
}

/**
 * Look up win/loss outcome for a specific game+market+side from card_results.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} p
 * @returns {number|null}
 */
function lookupOutcome(db, { gameId, sport, marketType }) {
  const hasCr = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_results'",
  ).get();
  if (!hasCr) return null;

  const row = db.prepare(`
    SELECT result
    FROM card_results
    WHERE game_id = ?
      AND sport   = ?
      AND (market_type = ? OR recommended_bet_type = ?)
      AND status = 'settled'
      AND result IN ('win','loss')
    ORDER BY settled_at DESC
    LIMIT 1
  `).get(gameId, sport, marketType, marketType);

  return toOutcome(row?.result ?? null);
}

/**
 * Main entry point.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @param {string} [options.computedAt]
 * @returns {{ written: number, skipped: number }}
 */
function runClvSnapshot(options = {}) {
  const db = options.db || getDatabase();
  const createdAt = options.computedAt || new Date().toISOString();

  const rows = findUnsnapshotted(db);
  if (rows.length === 0) {
    return { written: 0, skipped: 0 };
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO clv_entries (
      game_id,
      market,
      side,
      edge_at_placement,
      fair_prob_at_placement,
      implied_prob_at_placement,
      closing_price,
      closing_implied_prob,
      clv,
      clv_positive,
      outcome,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let written = 0;
  let skipped = 0;

  const writeAll = db.transaction((items) => {
    for (const row of items) {
      const market = buildMarketKey(row.sport, row.market_type);
      const side = String(row.side || '').trim().toUpperCase();

      if (!market || !side) {
        skipped += 1;
        continue;
      }

      const impliedProbAtPlacement = americanOddsToImpliedProb(row.odds_at_pick);
      const closingImpliedProb = americanOddsToImpliedProb(row.closing_odds);
      const clv = computeCLV(impliedProbAtPlacement, closingImpliedProb);

      const { fairProb, impliedProb } = lookupCalibrationPrediction(db, {
        gameId: row.game_id,
        market,
        side,
      });

      const impliedProbFinal = impliedProb ?? impliedProbAtPlacement;

      // Determine edge at placement: fair_prob - implied_prob (if available)
      let edgeAtPlacement = null;
      if (fairProb !== null && impliedProbFinal !== null) {
        edgeAtPlacement = Number((fairProb - impliedProbFinal).toFixed(4));
      }

      const outcome = lookupOutcome(db, {
        gameId: row.game_id,
        sport: row.sport,
        marketType: String(row.market_type || '').toLowerCase(),
      });

      insert.run(
        row.game_id,
        market,
        side,
        edgeAtPlacement,
        fairProb,
        impliedProbFinal,
        row.closing_odds,
        closingImpliedProb,
        clv,
        clv !== null ? (clv > 0 ? 1 : 0) : null,
        outcome,
        createdAt,
      );
      written += 1;
    }
  });

  writeAll(rows);

  return { written, skipped };
}

module.exports = {
  americanOddsToImpliedProb,
  computeCLV,
  runClvSnapshot,
};

if (require.main === module) {
  try {
    const result = runClvSnapshot();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[CLV_SNAPSHOT] run_clv_snapshot failed:', error);
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
