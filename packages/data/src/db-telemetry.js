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

function normalizeDecisionBasis(value, fallback = 'UNKNOWN') {
  const token = toUpperToken(value);
  if (token === 'PROJECTION_ONLY' || token === 'ODDS_BACKED' || token === 'UNKNOWN') return token;
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
      decision_basis TEXT NOT NULL DEFAULT 'UNKNOWN',
      CONSTRAINT clv_ledger_basis_known
        CHECK (decision_basis IN ('ODDS_BACKED', 'UNKNOWN'))
    );
  `);
}

function recordClvEntry(entry = {}) {
  if (!isFlagEnabled('ENABLE_CLV_LEDGER')) return;
  const normalizedBasis = normalizeDecisionBasis(entry.decisionBasis, 'UNKNOWN');
  if (normalizedBasis === 'PROJECTION_ONLY') return;

  const cardId = entry.cardId ? String(entry.cardId).trim() : '';
  const gameId = entry.gameId ? String(entry.gameId).trim() : '';
  if (!cardId || !gameId) return;

  const db = getDb();
  ensureClvLedgerSchema(db);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO clv_ledger (
      id, card_id, game_id, sport, market_type, prop_type,
      selection, line, odds_at_pick, volatility_band, decision_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    normalizedBasis,
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

module.exports = {
  recordClvEntry,
  settleClvEntry,
};
