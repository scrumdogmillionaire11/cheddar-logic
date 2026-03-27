'use strict';

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isFlagEnabled(flagName) {
  return isTruthy(process.env[flagName]);
}

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function normalizeDecisionBasis(value, fallback = 'ODDS_BACKED') {
  const token = toUpperToken(value);
  if (token === 'PROJECTION_ONLY' || token === 'ODDS_BACKED') return token;
  return fallback;
}

function getDb() {
  const { getDatabase } = require('./db');
  return getDatabase();
}

function ensureClvLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clv_ledger (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      sport TEXT,
      market_type TEXT,
      prop_type TEXT,
      selection TEXT,
      line REAL,
      odds_at_pick REAL,
      closing_odds REAL,
      clv_pct REAL,
      volatility_band TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      decision_basis TEXT NOT NULL DEFAULT 'ODDS_BACKED',
      CONSTRAINT clv_ledger_no_projection
        CHECK (decision_basis = 'ODDS_BACKED')
    );
  `);
}

function ensureProjectionPerfLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_perf_ledger (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      sport TEXT,
      prop_type TEXT,
      player_name TEXT,
      pick_side TEXT,
      projection REAL,
      prop_line REAL,
      actual_result REAL,
      won INTEGER,
      confidence TEXT,
      volatility_band TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT,
      decision_basis TEXT NOT NULL DEFAULT 'PROJECTION_ONLY',
      CONSTRAINT proj_perf_no_odds_backed
        CHECK (decision_basis = 'PROJECTION_ONLY')
    );
  `);
}

function recordClvEntry(entry = {}) {
  if (!isFlagEnabled('ENABLE_CLV_LEDGER')) return;
  if (normalizeDecisionBasis(entry.decisionBasis) === 'PROJECTION_ONLY') return;

  const cardId = entry.cardId ? String(entry.cardId).trim() : '';
  const gameId = entry.gameId ? String(entry.gameId).trim() : '';
  if (!cardId || !gameId) return;

  const db = getDb();
  ensureClvLedgerSchema(db);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO clv_ledger (
      id, card_id, game_id, sport, market_type, prop_type,
      selection, line, odds_at_pick, volatility_band, decision_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ODDS_BACKED')
  `);

  stmt.run(
    entry.id || `clv-${cardId}`,
    cardId,
    gameId,
    entry.sport || null,
    entry.marketType || null,
    entry.propType || null,
    entry.selection || null,
    entry.line ?? null,
    entry.oddsAtPick ?? null,
    entry.volatilityBand || null,
  );
}

function settleClvEntry(cardId, closingOdds, clvPct, closedAt) {
  if (!isFlagEnabled('ENABLE_CLV_LEDGER')) return;
  const normalizedCardId = cardId ? String(cardId).trim() : '';
  if (!normalizedCardId) return;
  const normalizedClosingOdds = Number(closingOdds);
  const normalizedClvPct = Number(clvPct);
  if (!Number.isFinite(normalizedClosingOdds) || !Number.isFinite(normalizedClvPct)) {
    return;
  }

  const db = getDb();
  ensureClvLedgerSchema(db);
  const stmt = db.prepare(`
    UPDATE clv_ledger
    SET closing_odds = ?, clv_pct = ?, closed_at = ?
    WHERE card_id = ? AND closed_at IS NULL
  `);

  stmt.run(
    normalizedClosingOdds,
    normalizedClvPct,
    closedAt || new Date().toISOString(),
    normalizedCardId,
  );
}

function recordProjectionEntry(entry = {}) {
  if (!isFlagEnabled('ENABLE_PROJECTION_PERF_LEDGER')) return;
  if (entry.decisionBasis === 'ODDS_BACKED') return;

  const db = getDb();
  ensureProjectionPerfLedgerSchema(db);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO projection_perf_ledger (
      id, card_id, game_id, sport, prop_type, player_name,
      pick_side, projection, prop_line, confidence, volatility_band, decision_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROJECTION_ONLY')
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

function settleProjectionEntry(cardId, actualResult, settledAt) {
  if (!isFlagEnabled('ENABLE_PROJECTION_PERF_LEDGER')) return;
  if (!cardId) return;

  const db = getDb();
  const row = db
    .prepare(
      `
        SELECT pick_side, prop_line
        FROM projection_perf_ledger
        WHERE card_id = ? AND settled_at IS NULL
        LIMIT 1
      `,
    )
    .get(cardId);
  if (!row) return;

  let won = null;
  if (Number.isFinite(actualResult) && Number.isFinite(row.prop_line)) {
    const side = String(row.pick_side || '').toUpperCase();
    if (side === 'OVER') won = actualResult > row.prop_line ? 1 : 0;
    if (side === 'UNDER') won = actualResult < row.prop_line ? 1 : 0;
  }

  db.prepare(
    `
      UPDATE projection_perf_ledger
      SET actual_result = ?, won = ?, settled_at = ?
      WHERE card_id = ? AND settled_at IS NULL
    `,
  ).run(actualResult ?? null, won, settledAt || new Date().toISOString(), cardId);
}

module.exports = {
  recordClvEntry,
  settleClvEntry,
  recordProjectionEntry,
  settleProjectionEntry,
};
