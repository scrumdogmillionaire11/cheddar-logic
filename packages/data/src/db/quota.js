const { getDatabase } = require('./connection');

// ─────────────────────────────────────────────────────────────────────────────
// Token Quota Ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get or create the quota ledger row for a provider+period.
 * Returns the current row (or a default if not yet written).
 */
function getQuotaLedger(provider, period) {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM token_quota_ledger WHERE provider = ? AND period = ? LIMIT 1`,
    )
    .get(provider, period);
  if (row) return row;
  // Return safe defaults — row will be created on first upsert
  return {
    provider,
    period,
    tokens_remaining: null,
    tokens_spent_session: 0,
    monthly_limit: Number(process.env.ODDS_MONTHLY_LIMIT) || 20000,
    circuit_open_until: null,
    circuit_reason: null,
  };
}

/**
 * Upsert quota ledger for a provider+period.
 * Pass only the fields you want to update; others retain their existing values.
 */
function upsertQuotaLedger({
  provider,
  period,
  tokens_remaining,
  tokens_spent_session,
  monthly_limit,
  circuit_open_until,
  circuit_reason,
  updated_by,
}) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO token_quota_ledger
       (provider, period, tokens_remaining, tokens_spent_session, monthly_limit,
        circuit_open_until, circuit_reason, last_updated, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(provider, period) DO UPDATE SET
       tokens_remaining     = COALESCE(excluded.tokens_remaining, tokens_remaining),
       tokens_spent_session = COALESCE(excluded.tokens_spent_session, tokens_spent_session),
       monthly_limit        = COALESCE(excluded.monthly_limit, monthly_limit),
       circuit_open_until   = excluded.circuit_open_until,
       circuit_reason       = excluded.circuit_reason,
       last_updated         = datetime('now'),
       updated_by           = excluded.updated_by`,
  ).run(
    provider,
    period,
    tokens_remaining ?? null,
    tokens_spent_session ?? null,
    monthly_limit ?? null,
    circuit_open_until ?? null,
    circuit_reason ?? null,
    updated_by ?? null,
  );
}

/**
 * Check if the DB-persisted circuit breaker is open for a provider.
 * Returns { open: boolean, until: string|null, reason: string|null }.
 */
function isQuotaCircuitOpen(provider, period) {
  const row = getQuotaLedger(provider, period);
  if (!row.circuit_open_until) return { open: false, until: null, reason: null };
  const until = new Date(row.circuit_open_until).getTime();
  if (Date.now() < until) {
    return { open: true, until: row.circuit_open_until, reason: row.circuit_reason };
  }
  return { open: false, until: null, reason: null };
}

module.exports = {
  getQuotaLedger,
  upsertQuotaLedger,
  isQuotaCircuitOpen,
};
