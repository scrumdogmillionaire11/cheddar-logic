/**
 * Quota management and freshness gates.
 *
 * Extracted from schedulers/main.js (WI-0780) to keep main.js under 300 lines.
 * Provides token-budget tier tracking, model-input freshness gates, and the
 * daily quota summary log line.
 */

'use strict';

const { wasJobRecentlySuccessful, getQuotaLedger } = require('@cheddar-logic/data');

let _lastQuotaTier = null;

/**
 * Token quota tier — governs odds fetch frequency and feature gating.
 *
 * | Tier     | Condition              | T-minus pulls | Backstop pulls |
 * |----------|------------------------|---------------|----------------|
 * | FULL     | >50% remaining         | yes           | yes            |
 * | MEDIUM   | 25-50% remaining       | no            | no             |
 * | LOW      | 10-25% remaining       | no            | no             |
 * | CRITICAL | <10% remaining         | no            | no             |
 */
function getCurrentQuotaTier() {
  const d = new Date();
  const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  let ledger;
  try {
    ledger = getQuotaLedger('odds_api', period);
  } catch (_e) {
    return 'FULL';
  }

  const monthlyLimit = ledger.monthly_limit || Number(process.env.ODDS_MONTHLY_LIMIT) || 20000;
  const reservePct = Number(process.env.ODDS_BUDGET_RESERVE_PCT) || 15;
  const effectiveLimit = monthlyLimit * (1 - reservePct / 100);

  function emitTier(tier) {
    if (_lastQuotaTier !== null && _lastQuotaTier !== tier) {
      console.log(
        `[QUOTA] Tier changed: ${_lastQuotaTier} => ${tier} ` +
        `(tokens_remaining=${ledger.tokens_remaining}, ` +
        `burn_rate=${Math.round(ledger.tokens_spent_session)}tokens/session, ` +
        `monthly_limit=${monthlyLimit})`,
      );
    }
    _lastQuotaTier = tier;
    return tier;
  }

  const effectiveRemaining =
    ledger.tokens_remaining === 0 && ledger.tokens_spent_session === 0
      ? null
      : ledger.tokens_remaining;

  if (effectiveRemaining !== null) {
    const pctRemaining = (effectiveRemaining / monthlyLimit) * 100;
    const hoursElapsed = new Date().getDate() * 24 + new Date().getHours();
    if (hoursElapsed > 0 && ledger.tokens_spent_session > 0) {
      const projectedMonthly = (ledger.tokens_spent_session / hoursElapsed) * 24 * 30;
      if (projectedMonthly > effectiveLimit) {
        console.warn(
          `[QUOTA] Burn rate alarm: projected ${Math.round(projectedMonthly)} tokens/month > limit ${Math.round(effectiveLimit)} — forcing MEDIUM`,
        );
        return emitTier('MEDIUM');
      }
    }
    if (pctRemaining > 50) return emitTier('FULL');
    if (pctRemaining > 25) return emitTier('MEDIUM');
    if (pctRemaining > 10) return emitTier('LOW');
    return emitTier('CRITICAL');
  }

  return emitTier('FULL');
}

/**
 * Log daily quota summary at 09:00 ET window.
 */
function logQuotaDailySummary(quotaTier, nowEt) {
  try {
    const period = `${nowEt.year}-${String(nowEt.month).padStart(2, '0')}`;
    const ledger = getQuotaLedger('odds_api', period);
    const monthlyLimit = ledger.monthly_limit || Number(process.env.ODDS_MONTHLY_LIMIT) || 20000;
    const hoursElapsed = (nowEt.day - 1) * 24 + nowEt.hour;
    const spentSession = ledger.tokens_spent_session || 0;
    const projectedMonthly = hoursElapsed > 0
      ? Math.round((spentSession / hoursElapsed) * 24 * 30)
      : 0;
    const pctUsed = ledger.tokens_remaining !== null
      ? Math.round(((monthlyLimit - ledger.tokens_remaining) / monthlyLimit) * 100)
      : null;
    const tierNextChange =
      quotaTier === 'FULL' ? `>50% remaining (currently ${pctUsed !== null ? 100 - pctUsed : '?'}%)` :
      quotaTier === 'MEDIUM' ? 'drops to LOW below 25% remaining' :
      quotaTier === 'LOW' ? 'drops to CRITICAL below 10% remaining' :
      'CRITICAL — no odds fetches until balance recovers';
    console.log(
      `[QUOTA] Daily summary (09:00 ET) — ` +
      `period=${period}, tier=${quotaTier}, ` +
      `tokens_remaining=${ledger.tokens_remaining ?? 'unknown'}, ` +
      `spent_session=${spentSession}, projected_monthly=${projectedMonthly}, ` +
      `monthly_limit=${monthlyLimit} | tier_context: ${tierNextChange}`,
    );
  } catch (_summaryErr) {
    // DB not yet migrated — skip summary
  }
}

const REQUIRE_FRESH_ODDS_FOR_MODELS =
  process.env.REQUIRE_FRESH_ODDS_FOR_MODELS !== 'false';
const ENABLE_WITHOUT_ODDS_MODE =
  process.env.ENABLE_WITHOUT_ODDS_MODE === 'true';

/**
 * Gate: are model inputs (odds or ESPN-direct) fresh enough to run?
 */
function hasFreshInputsForModels(opts = {}) {
  const requireFresh = opts.requireFresh !== undefined ? opts.requireFresh : REQUIRE_FRESH_ODDS_FOR_MODELS;
  const withoutOddsMode = opts.withoutOddsMode !== undefined ? opts.withoutOddsMode : ENABLE_WITHOUT_ODDS_MODE;
  const maxAgeMinutes = opts.maxAgeMinutes || Number(process.env.MODEL_ODDS_MAX_AGE_MINUTES) || Number(process.env.ODDS_GAP_ALERT_MINUTES) || 210;

  if (!requireFresh) return true;
  if (withoutOddsMode) return wasJobRecentlySuccessful('pull_espn_games_direct', maxAgeMinutes);
  if (process.env.ENABLE_ODDS_PULL === 'false') return true;
  return wasJobRecentlySuccessful('pull_odds_hourly', maxAgeMinutes);
}

/** @deprecated Use hasFreshInputsForModels. */
function hasFreshOddsForModels() {
  return hasFreshInputsForModels();
}

const REQUIRE_FRESH_TEAM_METRICS =
  process.env.REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS !== 'false';
const TEAM_METRICS_MAX_AGE_MINUTES =
  Number(process.env.TEAM_METRICS_MAX_AGE_MINUTES) || 20 * 60;

function hasFreshTeamMetricsCache() {
  if (!REQUIRE_FRESH_TEAM_METRICS) return true;
  return wasJobRecentlySuccessful('refresh_team_metrics_daily', TEAM_METRICS_MAX_AGE_MINUTES);
}

const ODDS_GAP_ALERT_MINUTES = Number(process.env.ODDS_GAP_ALERT_MINUTES || 210);
const ODDS_GAP_ALERT_COOLDOWN_MS = Number(process.env.ODDS_GAP_ALERT_COOLDOWN_MS || 15 * 60 * 1000);
let _lastOddsGapAlertAt = 0;

/**
 * Health check: warn when pull_odds_hourly hasn't run recently.
 */
function checkOddsFreshnessHealth(nowUtc) {
  if (ENABLE_WITHOUT_ODDS_MODE) return;
  if (process.env.ENABLE_ODDS_PULL === 'false') return;
  if (wasJobRecentlySuccessful('pull_odds_hourly', ODDS_GAP_ALERT_MINUTES)) {
    _lastOddsGapAlertAt = 0;
    return;
  }
  const nowMs = nowUtc.toMillis();
  if (nowMs - _lastOddsGapAlertAt < ODDS_GAP_ALERT_COOLDOWN_MS) return;
  _lastOddsGapAlertAt = nowMs;
  console.warn(
    `[SCHEDULER][HEALTH] No successful pull_odds_hourly run in the last ${ODDS_GAP_ALERT_MINUTES} minutes. ` +
    'Odds pipeline may be stale.',
  );
}

module.exports = {
  getCurrentQuotaTier,
  logQuotaDailySummary,
  hasFreshInputsForModels,
  hasFreshOddsForModels,
  hasFreshTeamMetricsCache,
  checkOddsFreshnessHealth,
};
