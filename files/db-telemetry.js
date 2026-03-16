/**
 * db-telemetry.js
 *
 * Additive telemetry functions for db.js.
 *
 * Two new tables (created on demand, never blocking):
 *   clv_ledger           — CLV tracking for odds-backed plays
 *   projection_perf_ledger — Win-rate tracking for projection-only plays
 *
 * Rules enforced in code:
 *   - Synthetic-line props are EXCLUDED from both ledgers by assertion
 *   - No joins or dependencies on card_results, card_display_log, settlement flow
 *   - Rows are append-first; settlement fields may be updated in-place post-game
 *   - getDatabase() used for all access — same singleton, same lock
 *
 * Integration into db.js:
 *   1. Add require('./db-telemetry') at the bottom of db.js
 *   2. Add the 4 exported functions to module.exports in db.js
 *   OR: import directly from this file in the jobs that need it.
 */

'use strict';

const { FLAGS } = require('./flags');

// ─────────────────────────────────────────────────────────────────────────────
// Schema bootstraps — called lazily on first write
// ─────────────────────────────────────────────────────────────────────────────

function ensureClvLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clv_ledger (
      id                TEXT PRIMARY KEY,
      card_id           TEXT NOT NULL,
      game_id           TEXT NOT NULL,
      sport             TEXT NOT NULL,
      market_type       TEXT NOT NULL,
      prop_type         TEXT,
      selection         TEXT,
      line              REAL,
      odds_at_pick      REAL,
      closing_odds      REAL,
      clv_pct           REAL,
      volatility_band   TEXT,
      recorded_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at         TEXT,
      decision_basis    TEXT NOT NULL DEFAULT 'ODDS_BACKED',
      CONSTRAINT clv_ledger_no_projection
        CHECK (decision_basis = 'ODDS_BACKED')
    );
    CREATE INDEX IF NOT EXISTS idx_clv_ledger_game_id
      ON clv_ledger(game_id);
    CREATE INDEX IF NOT EXISTS idx_clv_ledger_sport_market
      ON clv_ledger(sport, market_type, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clv_ledger_card_id
      ON clv_ledger(card_id);
  `);
}

function ensureProjectionPerfLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_perf_ledger (
      id                TEXT PRIMARY KEY,
      card_id           TEXT NOT NULL,
      game_id           TEXT NOT NULL,
      sport             TEXT NOT NULL,
      prop_type         TEXT NOT NULL,
      player_name       TEXT,
      pick_side         TEXT NOT NULL,
      projection        REAL NOT NULL,
      prop_line         REAL,
      actual_result     REAL,
      won               INTEGER,
      confidence        TEXT,
      volatility_band   TEXT,
      recorded_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at        TEXT,
      decision_basis    TEXT NOT NULL DEFAULT 'PROJECTION_ONLY',
      CONSTRAINT proj_perf_no_odds_backed
        CHECK (decision_basis = 'PROJECTION_ONLY')
    );
    CREATE INDEX IF NOT EXISTS idx_proj_perf_ledger_sport_prop
      ON projection_perf_ledger(sport, prop_type, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proj_perf_ledger_card_id
      ON projection_perf_ledger(card_id);
    CREATE INDEX IF NOT EXISTS idx_proj_perf_ledger_unsettled
      ON projection_perf_ledger(settled_at)
      WHERE settled_at IS NULL;
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLV Ledger — odds-backed plays only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an odds-backed play when it is displayed (pre-game).
 * Call this when a card with decision_basis=ODDS_BACKED is served to the user.
 *
 * @param {object} entry
 * @param {string} entry.id              - Unique ledger entry ID
 * @param {string} entry.cardId          - card_payloads.id
 * @param {string} entry.gameId          - Game ID
 * @param {string} entry.sport           - Sport code
 * @param {string} entry.marketType      - MONEYLINE | SPREAD | TOTAL etc.
 * @param {string} [entry.propType]      - Prop type if applicable
 * @param {string} entry.selection       - HOME | AWAY | OVER | UNDER
 * @param {number} [entry.line]          - Market line at pick time
 * @param {number} entry.oddsAtPick      - American odds at pick time
 * @param {string} [entry.volatilityBand] - LOW | MEDIUM | HIGH
 */
function recordClvEntry(entry) {
  if (!FLAGS.ENABLE_CLV_LEDGER) return;

  // Enforce: never record projection-only plays in CLV ledger
  if (entry.decisionBasis === 'PROJECTION_ONLY') {
    console.warn(`[clv_ledger] Rejected PROJECTION_ONLY entry for card ${entry.cardId}`);
    return;
  }

  // Late import to avoid circular dependency with db.js
  const { getDatabase } = require('../packages/data/src/db');
  const db = getDatabase();
  ensureClvLedgerSchema(db);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO clv_ledger (
      id, card_id, game_id, sport, market_type, prop_type,
      selection, line, odds_at_pick, volatility_band,
      recorded_at, decision_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'ODDS_BACKED')
  `);

  stmt.run(
    entry.id,
    entry.cardId,
    entry.gameId,
    entry.sport || null,
    entry.marketType || null,
    entry.propType || null,
    entry.selection || null,
    entry.line ?? null,
    entry.oddsAtPick ?? null,
    entry.volatilityBand || null,
  );
}

/**
 * Update a CLV entry with closing line value after the market closes.
 * Typically called by a post-game settlement job.
 *
 * @param {string} cardId        - The card_payloads.id to update
 * @param {number} closingOdds   - American odds at market close
 * @param {number} clvPct        - CLV percentage (odds_at_pick vs closing_odds)
 * @param {string} closedAt      - ISO timestamp
 */
function settleClvEntry(cardId, closingOdds, clvPct, closedAt) {
  if (!FLAGS.ENABLE_CLV_LEDGER) return;

  const { getDatabase } = require('../packages/data/src/db');
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE clv_ledger
    SET closing_odds = ?,
        clv_pct     = ?,
        closed_at   = ?
    WHERE card_id = ?
      AND closed_at IS NULL
  `);

  stmt.run(
    closingOdds ?? null,
    clvPct ?? null,
    closedAt || new Date().toISOString(),
    cardId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection Performance Ledger — projection-only plays only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a projection-only play when it is generated (pre-game).
 * Call this when a card with decision_basis=PROJECTION_ONLY is created.
 *
 * @param {object} entry
 * @param {string} entry.id              - Unique ledger entry ID
 * @param {string} entry.cardId          - card_payloads.id
 * @param {string} entry.gameId          - Game ID
 * @param {string} entry.sport           - Sport code
 * @param {string} entry.propType        - shots_on_goal | pitcher_strikeouts | etc.
 * @param {string} [entry.playerName]    - Player name
 * @param {string} entry.pickSide        - OVER | UNDER
 * @param {number} entry.projection      - Model projection value
 * @param {number} [entry.propLine]      - Synthetic line used (projection_floor)
 * @param {string} [entry.confidence]    - HIGH | MEDIUM | LOW
 * @param {string} [entry.volatilityBand] - LOW | MEDIUM | HIGH
 */
function recordProjectionEntry(entry) {
  if (!FLAGS.ENABLE_PROJECTION_PERF_LEDGER) return;

  // Enforce: never record odds-backed plays in projection ledger
  if (entry.decisionBasis === 'ODDS_BACKED') {
    console.warn(`[proj_perf_ledger] Rejected ODDS_BACKED entry for card ${entry.cardId}`);
    return;
  }

  const { getDatabase } = require('../packages/data/src/db');
  const db = getDatabase();
  ensureProjectionPerfLedgerSchema(db);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO projection_perf_ledger (
      id, card_id, game_id, sport, prop_type, player_name,
      pick_side, projection, prop_line, confidence, volatility_band,
      recorded_at, decision_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'PROJECTION_ONLY')
  `);

  stmt.run(
    entry.id,
    entry.cardId,
    entry.gameId,
    entry.sport || null,
    entry.propType || null,
    entry.playerName || null,
    entry.pickSide || null,
    entry.projection ?? null,
    entry.propLine ?? null,
    entry.confidence || null,
    entry.volatilityBand || null,
  );
}

/**
 * Settle a projection entry with the actual game result.
 * Called by the post-game result ingestion job.
 * Win rate is computed at query time — this just stores the raw result.
 *
 * @param {string} cardId        - The card_payloads.id to settle
 * @param {number} actualResult  - The actual stat value (e.g., 4 shots)
 * @param {string} settledAt     - ISO timestamp
 */
function settleProjectionEntry(cardId, actualResult, settledAt) {
  if (!FLAGS.ENABLE_PROJECTION_PERF_LEDGER) return;

  const { getDatabase } = require('../packages/data/src/db');
  const db = getDatabase();

  // Look up pick_side and prop_line to determine win/loss
  const existingRow = db.prepare(`
    SELECT pick_side, prop_line, projection
    FROM projection_perf_ledger
    WHERE card_id = ? AND settled_at IS NULL
    LIMIT 1
  `).get(cardId);

  if (!existingRow) return; // Not tracked or already settled

  const line = existingRow.prop_line ?? existingRow.projection;
  let won = null;
  if (line !== null && actualResult !== null && actualResult !== undefined) {
    won = existingRow.pick_side === 'OVER'
      ? (actualResult > line ? 1 : 0)
      : (actualResult < line ? 1 : 0);
  }

  db.prepare(`
    UPDATE projection_perf_ledger
    SET actual_result = ?,
        won           = ?,
        settled_at    = ?
    WHERE card_id = ?
      AND settled_at IS NULL
  `).run(
    actualResult ?? null,
    won,
    settledAt || new Date().toISOString(),
    cardId,
  );
}

/**
 * Get win rate summary for projection-only plays.
 * Used by the Model Health Dashboard.
 *
 * @param {object} filters
 * @param {string} [filters.sport]      - Filter by sport
 * @param {string} [filters.propType]   - Filter by prop type
 * @param {number} [filters.lastNDays]  - Rolling window (default 30)
 * @returns {object[]} Win rate rows per sport/prop_type
 */
function getProjectionWinRates({ sport, propType, lastNDays = 30 } = {}) {
  const { getDatabase } = require('../packages/data/src/db');
  const db = getDatabase();

  const clauses = [
    `settled_at IS NOT NULL`,
    `decision_basis = 'PROJECTION_ONLY'`,
    `datetime(settled_at) >= datetime('now', '-${Math.min(lastNDays, 365)} days')`,
  ];
  const params = [];

  if (sport) {
    clauses.push(`UPPER(sport) = UPPER(?)`);
    params.push(sport);
  }
  if (propType) {
    clauses.push(`prop_type = ?`);
    params.push(propType);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;

  const stmt = db.prepare(`
    SELECT
      sport,
      prop_type,
      COUNT(*) AS total_plays,
      SUM(won) AS wins,
      ROUND(CAST(SUM(won) AS REAL) / COUNT(*), 3) AS win_rate,
      -- Rolling 20 window
      (
        SELECT ROUND(CAST(SUM(w2.won) AS REAL) / COUNT(*), 3)
        FROM (
          SELECT won FROM projection_perf_ledger p2
          WHERE p2.sport = p.sport
            AND p2.prop_type = p.prop_type
            AND p2.settled_at IS NOT NULL
          ORDER BY p2.settled_at DESC
          LIMIT 20
        ) w2
      ) AS rolling_20_win_rate,
      MAX(settled_at) AS last_settled_at
    FROM projection_perf_ledger p
    ${where}
    GROUP BY sport, prop_type
    ORDER BY win_rate DESC, total_plays DESC
  `);

  return stmt.all(...params);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION INSTRUCTIONS for db.js
//
// Option A (recommended): Add at the bottom of db.js, before module.exports:
//
//   const {
//     recordClvEntry,
//     settleClvEntry,
//     recordProjectionEntry,
//     settleProjectionEntry,
//     getProjectionWinRates,
//   } = require('./db-telemetry');
//
// Then add to the module.exports object:
//   recordClvEntry,
//   settleClvEntry,
//   recordProjectionEntry,
//   settleProjectionEntry,
//   getProjectionWinRates,
//
// Option B: Import directly in the job files that need telemetry:
//   const { recordProjectionEntry } = require('./db-telemetry');
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  recordClvEntry,
  settleClvEntry,
  recordProjectionEntry,
  settleProjectionEntry,
  getProjectionWinRates,
};
