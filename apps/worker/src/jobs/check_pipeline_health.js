/**
 * Pipeline Health Check Watchdog
 *
 * Runs every 5 minutes to verify all pipeline phases are healthy and emits
 * Discord alerts when multiple consecutive failures are detected.
 *
 * Checks: schedule freshness, odds freshness (with self-healing remediation),
 * cards freshness, settlement backlog, per-sport model freshness, MLB F5/game-line
 * market availability, NHL SOG sync freshness (feature-aware), calibration kill
 * switches, and watchdog heartbeat.
 *
 * Writes all results to pipeline_health for UI visibility.
 *
 * Env:
 * - ENABLE_PIPELINE_HEALTH_WATCHDOG (default: true — set to 'false' to disable)
 * - PIPELINE_HEALTH_INTERVAL_MINUTES (default: 5)
 * - LIVE_ODDS_HEALTH_MAX_AGE_MINUTES (default: slot + 15 minutes, minimum 15)
 *     Intentionally independent from execution-gate hardMaxMinutes (120 min).
 *     The watchdog monitors live odds pipeline health right now; execution gate
 *     decides whether a model write was acceptable at card-generation time.
 *     Keeping this tighter (default ~75 min) preserves early-warning fidelity.
 * - CARDS_FRESHNESS_MAX_AGE_MINUTES (default: 30; informational stale-card age only)
 */

const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  createJob,
  wasJobRecentlySuccessful,
  writePipelineHealthState,
  buildPipelineHealthCheckId,
} = require('@cheddar-logic/data');
const { getContractForSport } = require('./execution-gate-freshness-contract');
const { getCurrentQuotaTier } = require('../schedulers/quota');
const { keyTminus, TMINUS_BANDS } = require('../schedulers/windows');
const { SPORTS_CONFIG: ODDS_SPORTS_CONFIG } = require('@cheddar-logic/odds/src/config');
const { isFeatureEnabled } = require('@cheddar-logic/data/src/feature-flags');
const settlementHealth = require('./report_settlement_health');
const {
  collectVisibilityIntegrityDiagnostics,
} = settlementHealth;

if (typeof settlementHealth.maybeLoadLocalDotenv === 'function') {
  settlementHealth.maybeLoadLocalDotenv();
}

function getSendDiscordMessages() {
  return require('./post_discord_cards').sendDiscordMessages;
}

function getRefreshStaleOdds() {
  return require('./refresh_stale_odds').refreshStaleOdds;
}

function getBuildMlbMarketAvailability() {
  return require('./run_mlb_model').buildMlbMarketAvailability;
}

const WATCHDOG_CRITICAL_BREACH = 'WATCHDOG_CRITICAL_BREACH';
const WATCHDOG_INFO = 'WATCHDOG_INFO';

function parseEnvNumber(name, fallback, { min = null, max = null } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== null && parsed < min) return fallback;
  if (max !== null && parsed > max) return fallback;
  return parsed;
}


// Align freshness threshold with the fetch slot size so alerts don't fire
// continuously during the normal gap between pulls. When ODDS_FETCH_SLOT_MINUTES
// is 180 (April 2026 budget mode) a hardcoded 15-min threshold fires on every
// check. Default: slot + 15 min buffer, minimum 15 min.
const ODDS_FETCH_SLOT_MINUTES = parseEnvNumber('ODDS_FETCH_SLOT_MINUTES', 60, { min: 1 });
// Intentionally NOT derived from execution-gate hardMaxMinutes (120 min).
// This is a live watchdog threshold for current odds pipeline health, not a
// per-card execution gate. Default: slot + 15 min buffer (≈75 min at 60-min cadence).
// card_payload.freshness_tier records what was true at card-generation time and
// must not be read here — it is historical metadata, not a live health signal.
const LEGACY_ODDS_FRESHNESS_MAX_AGE_MINUTES = parseEnvNumber(
  'ODDS_FRESHNESS_MAX_AGE_MINUTES',
  Math.max(15, ODDS_FETCH_SLOT_MINUTES + 15),
  { min: 1 },
);
const LIVE_ODDS_HEALTH_MAX_AGE_MINUTES = parseEnvNumber(
  'LIVE_ODDS_HEALTH_MAX_AGE_MINUTES',
  LEGACY_ODDS_FRESHNESS_MAX_AGE_MINUTES,
  { min: 1 },
);
const ODDS_FRESHNESS_ALERT_WINDOW_HOURS = parseEnvNumber(
  'ODDS_FRESHNESS_ALERT_WINDOW_HOURS',
  Math.max(2, Math.ceil(ODDS_FETCH_SLOT_MINUTES / 60)),
  { min: 1 },
);
const SEED_FRESHNESS_MAX_AGE_MINUTES = parseEnvNumber(
  'SEED_FRESHNESS_MAX_AGE_MINUTES',
  Math.max(15, ODDS_FETCH_SLOT_MINUTES + 15),
  { min: 1 },
);
const CARDS_FRESHNESS_MAX_AGE_MINUTES = parseEnvNumber(
  'CARDS_FRESHNESS_MAX_AGE_MINUTES',
  30,
  { min: 1 },
);
// Per-sport model freshness threshold (WI-0950).
// Imported from execution-gate-freshness-contract; health check uses 4x the moneyline hardMax
// per operational policy (health check is stricter to catch issues earlier).
// Default: 120m hardMax * 4 = 480m, but env var can override.
function getModelFreshnessMaxAgeMinutes() {
  const envOverride = parseEnvNumber('MODEL_FRESHNESS_MAX_AGE_MINUTES', 0, { min: 0 });
  if (envOverride > 0) return envOverride;
  // Use contract hardMax * 4 for health check window (typically 120m * 4 = 480m)
  const contract = getContractForSport('mlb');
  return contract.hardMaxMinutes * 4;
}
// Alert timing windows for checks that depend on T-minus execution, not schedule ingestion.
const MODEL_FRESHNESS_ALERT_WINDOW_HOURS = parseEnvNumber(
  'MODEL_FRESHNESS_ALERT_WINDOW_HOURS',
  2,
  { min: 1 },
);
const MLB_F5_ALERT_WINDOW_HOURS = parseEnvNumber(
  'MLB_F5_ALERT_WINDOW_HOURS',
  2,
  { min: 1 },
);
const PIPELINE_HEALTH_INTERVAL_MINUTES = parseEnvNumber(
  'PIPELINE_HEALTH_INTERVAL_MINUTES',
  5,
  { min: 1 },
);
const PIPELINE_HEALTH_ALERT_CONSECUTIVE = parseEnvNumber(
  'PIPELINE_HEALTH_ALERT_CONSECUTIVE',
  3,
  { min: 1 },
);
const PIPELINE_HEALTH_COOLDOWN_MINUTES = parseEnvNumber(
  'PIPELINE_HEALTH_COOLDOWN_MINUTES',
  30,
  { min: 1 },
);
const CARD_OUTPUT_INTEGRITY_LOOKBACK_HOURS = parseEnvNumber(
  'CARD_OUTPUT_INTEGRITY_LOOKBACK_HOURS',
  6,
  { min: 1 },
);
const CARD_OUTPUT_INTEGRITY_MIN_SAMPLE = parseEnvNumber(
  'CARD_OUTPUT_INTEGRITY_MIN_SAMPLE',
  20,
  { min: 1 },
);
const CARD_OUTPUT_PASS_RATE_MAX = parseEnvNumber(
  'CARD_OUTPUT_PASS_RATE_MAX',
  0.92,
  { min: 0, max: 1 },
);
const CARD_OUTPUT_MISSING_ODDS_RATE_MAX = parseEnvNumber(
  'CARD_OUTPUT_MISSING_ODDS_RATE_MAX',
  0.35,
  { min: 0, max: 1 },
);
const CARD_OUTPUT_DEGRADED_RATE_MAX = parseEnvNumber(
  'CARD_OUTPUT_DEGRADED_RATE_MAX',
  0.45,
  { min: 0, max: 1 },
);
const VISIBILITY_INTEGRITY_LOOKBACK_HOURS = parseEnvNumber(
  'VISIBILITY_INTEGRITY_LOOKBACK_HOURS',
  24,
  { min: 1 },
);
const VISIBILITY_INTEGRITY_SAMPLE_LIMIT = parseEnvNumber(
  'VISIBILITY_INTEGRITY_SAMPLE_LIMIT',
  5,
  { min: 1 },
);
const DEFAULT_MODEL_JOB_EXPECTED_INTERVAL_MINUTES = parseEnvNumber(
  'MODEL_JOB_EXPECTED_INTERVAL_MINUTES',
  120,
  { min: 1 },
);
const SCHEDULED_GAME_CARD_COVERAGE_LOOKAHEAD_HOURS = 6;
const SCHEDULED_GAME_CARD_COVERAGE_START_BUFFER_MINUTES = 15;
const SCHEDULED_GAME_CARD_COVERAGE_FAIL_THRESHOLD = 0.50;
const SCHEDULED_GAME_CARD_COVERAGE_WARN_THRESHOLD = 0.80;

function buildCheckId(domain, name, scope) {
  return `${domain}:${name}:${scope}`;
}

const CHECK_REGISTRY = Object.freeze({
  watchdog_heartbeat: {
    phase: 'watchdog', checkName: 'heartbeat', checkId: buildCheckId('watchdog', 'heartbeat', 'global'),
  },
  schedule_freshness: {
    phase: 'schedule', checkName: 'freshness', checkId: buildCheckId('schedule', 'freshness', 'global'),
  },
  odds_freshness: {
    phase: 'odds', checkName: 'freshness', checkId: buildCheckId('odds', 'freshness', 'active_sports'),
  },
  cards_freshness: {
    phase: 'cards', checkName: 'freshness', checkId: buildCheckId('cards', 'freshness', 'tminus_2h'),
  },
  card_output_integrity: {
    phase: 'cards', checkName: 'output_integrity', checkId: buildCheckId('cards', 'output_integrity', 'all_sports'),
  },
  visibility_integrity: {
    phase: 'cards', checkName: 'visibility_integrity', checkId: buildCheckId('cards', 'visibility_integrity', 'display_log_enrollment'),
  },
  mlb_f5_market_availability: {
    phase: 'mlb', checkName: 'f5_market_availability', checkId: buildCheckId('mlb', 'market_availability', 'f5'),
  },
  mlb_game_line_coverage: {
    phase: 'mlb', checkName: 'game_line_coverage', checkId: buildCheckId('mlb', 'coverage', 'game_line'),
  },
  mlb_scheduled_game_card_coverage: {
    phase: 'mlb', checkName: 'scheduled_game_card_coverage', checkId: buildCheckId('mlb', 'coverage', 'scheduled_game_card'),
  },
  mlb_seed_freshness: {
    phase: 'mlb', checkName: 'seed_freshness', checkId: buildCheckId('mlb', 'freshness', 'seed'),
  },
  settlement_backlog: {
    phase: 'settlement', checkName: 'backlog', checkId: buildCheckId('settlement', 'backlog', 'global'),
  },
  nhl_model_freshness: {
    phase: 'nhl', checkName: 'model_freshness', checkId: buildCheckId('model', 'freshness', 'nhl'),
  },
  nhl_market_call_diagnostics: {
    phase: 'nhl', checkName: 'market_call_blockers', checkId: buildCheckId('nhl', 'diagnostics', 'market_call'),
  },
  nhl_moneyline_coverage: {
    phase: 'nhl', checkName: 'moneyline_coverage', checkId: buildCheckId('nhl', 'coverage', 'moneyline'),
  },
  nhl_scheduled_game_card_coverage: {
    phase: 'nhl', checkName: 'scheduled_game_card_coverage', checkId: buildCheckId('nhl', 'coverage', 'scheduled_game_card'),
  },
  nhl_false_listing_candidates: {
    phase: 'nhl', checkName: 'false_listing_candidates', checkId: buildCheckId('nhl', 'integrity', 'false_listing_candidates'),
  },
  nhl_sog_sync_freshness: {
    phase: 'nhl', checkName: 'sog_sync_freshness', checkId: buildCheckId('job', 'freshness', 'sync_nhl_sog_player_ids'),
  },
  nhl_sog_pull_freshness: {
    phase: 'nhl', checkName: 'sog_pull_freshness', checkId: buildCheckId('job', 'freshness', 'pull_nhl_player_shots'),
  },
  nhl_shots_model_freshness: {
    phase: 'nhl', checkName: 'shots_model_freshness', checkId: buildCheckId('model', 'freshness', 'nhl_shots'),
  },
  nhl_blk_rates_nst_freshness: {
    phase: 'nhl', checkName: 'blk_rates_nst_freshness', checkId: buildCheckId('nhl', 'freshness', 'blk_csv_nst_decommissioned'),
  },
  nhl_blk_rates_moneypuck_freshness: {
    phase: 'nhl', checkName: 'blk_rates_moneypuck_freshness', checkId: buildCheckId('nhl', 'freshness', 'blk_csv_moneypuck_decommissioned'),
  },
  nhl_blk_source_integrity: {
    phase: 'nhl', checkName: 'blk_source_integrity', checkId: buildCheckId('nhl', 'integrity', 'blk_csv_sources_decommissioned'),
  },
  nba_model_freshness: {
    phase: 'nba', checkName: 'model_freshness', checkId: buildCheckId('model', 'freshness', 'nba'),
  },
  nba_market_call_diagnostics: {
    phase: 'nba', checkName: 'market_call_blockers', checkId: buildCheckId('nba', 'diagnostics', 'market_call'),
  },
  nba_moneyline_coverage: {
    phase: 'nba', checkName: 'moneyline_coverage', checkId: buildCheckId('nba', 'coverage', 'moneyline'),
  },
  nba_scheduled_game_card_coverage: {
    phase: 'nba', checkName: 'scheduled_game_card_coverage', checkId: buildCheckId('nba', 'coverage', 'scheduled_game_card'),
  },
  mlb_model_freshness: {
    phase: 'mlb', checkName: 'model_freshness', checkId: buildCheckId('model', 'freshness', 'mlb'),
  },
  calibration_kill_switches: {
    phase: 'calibration', checkName: 'kill_switch', checkId: buildCheckId('calibration', 'kill_switch', 'all_markets'),
  },
});
const CARD_HEALTH_MODEL_JOB_BY_SPORT = Object.freeze({
  nba: { jobName: 'run_nba_model', env: 'ENABLE_NBA_MODEL' },
  nhl: { jobName: 'run_nhl_model', env: 'ENABLE_NHL_MODEL' },
  mlb: { jobName: 'run_mlb_model', env: 'ENABLE_MLB_MODEL' },
  nfl: { jobName: 'run_nfl_model', env: 'ENABLE_NFL_MODEL' },
});

const CHECK_ID_BY_PHASE_AND_NAME = Object.values(CHECK_REGISTRY).reduce((acc, entry) => {
  acc[`${entry.phase}:${entry.checkName}`] = entry.checkId;
  return acc;
}, {});

function resolveCheckId(phase, checkName) {
  if (typeof buildPipelineHealthCheckId !== 'function') {
    return `${phase}:${checkName}`;
  }
  return CHECK_ID_BY_PHASE_AND_NAME[`${phase}:${checkName}`]
    || buildPipelineHealthCheckId(phase, checkName);
}

/**
 * Write health check result to pipeline_health table
 */
function writePipelineHealth(phase, check, status, reason) {
  if (typeof writePipelineHealthState !== 'function') {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO pipeline_health (phase, check_name, status, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(phase, check, status, reason, DateTime.utc().toISO());
    return;
  }

  writePipelineHealthState({
    phase,
    checkName: check,
    status,
    reason,
    checkId: resolveCheckId(phase, check),
    createdAt: DateTime.utc().toISO(),
  });
}

function summarizeErrorMessage(message, maxLength = 180) {
  const normalized = String(message || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'no error message recorded';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getLatestFailedJobRun(jobName, lookbackMinutes) {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT started_at, error_message
       FROM job_runs
       WHERE job_name = ?
         AND status = 'failed'
         AND started_at >= datetime('now', ?)
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(jobName, `-${Math.max(lookbackMinutes, 1)} minutes`);
}

async function deliverPipelineHealthAlert(alertChecks, sourceCheckName) {
  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    const reason = 'DISCORD_ALERT_WEBHOOK_URL not set — skipping Discord alert';
    console.warn(`[check_pipeline_health] ${reason}`);
    writePipelineHealth('watchdog', 'alert_delivery', 'warning', reason);
    return { delivered: false, skipped: true, reason };
  }

  try {
    const message = buildHealthAlertMessage(alertChecks);
    const sendDiscordMessages = getSendDiscordMessages();
    await sendDiscordMessages({ webhookUrl, messages: [message] });
    writePipelineHealth(
      'watchdog',
      'alert_delivery',
      'ok',
      `Alert delivered for ${sourceCheckName}: ${alertChecks.length} failing check(s)`,
    );
    return { delivered: true, skipped: false };
  } catch (error) {
    const reason = `Alert delivery failed for ${sourceCheckName}: ${summarizeErrorMessage(error?.message)}`;
    writePipelineHealth('watchdog', 'alert_delivery', 'failed', reason);
    console.error(`[check_pipeline_health] ${reason}`);
    return { delivered: false, skipped: false, reason };
  }
}

/**
 * Check 1: Schedule freshness
 * Verify we have upcoming games for today + next 2 days
 */
function checkScheduleFreshness() {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ days: 2 });

  const count = db
    .prepare(
      `
    SELECT COUNT(*) as cnt
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
  `,
    )
    .get(nowUtc.toISO(), endUtc.toISO()).cnt;

  if (count > 0) {
    const reason = `${count} upcoming games found`;
    writePipelineHealth('schedule', 'freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const reason = 'No upcoming games in next 48h (schedule may be stale)';
  writePipelineHealth('schedule', 'freshness', 'failed', reason);
  return { ok: false, reason };
}

function buildOddsFreshnessMatchupKey(game) {
  const sport = String(game.sport || '').toLowerCase();
  const away = String(game.away_team || '').trim().toUpperCase();
  const home = String(game.home_team || '').trim().toUpperCase();
  const gameDate = String(game.game_time_utc || '').slice(0, 10);
  return `${sport}|${away}|${home}|${gameDate}`;
}

function dedupeOddsFreshnessGames(gamesWithFreshness) {
  const byMatchup = new Map();

  for (const game of gamesWithFreshness) {
    const key = buildOddsFreshnessMatchupKey(game);
    const bucket = byMatchup.get(key);
    if (bucket) {
      bucket.push(game);
    } else {
      byMatchup.set(key, [game]);
    }
  }

  const deduped = [];
  for (const duplicates of byMatchup.values()) {
    duplicates.sort((a, b) => {
      const aFresh = !a.isStale;
      const bFresh = !b.isStale;
      if (aFresh !== bFresh) return aFresh ? -1 : 1;

      const aHasSnapshot = Boolean(a.latestCapturedAt);
      const bHasSnapshot = Boolean(b.latestCapturedAt);
      if (aHasSnapshot !== bHasSnapshot) return aHasSnapshot ? -1 : 1;

      const aCapturedAt = a.latestCapturedAt || '';
      const bCapturedAt = b.latestCapturedAt || '';
      if (aCapturedAt !== bCapturedAt) return bCapturedAt.localeCompare(aCapturedAt);

      return String(a.game_time_utc || '').localeCompare(String(b.game_time_utc || ''));
    });

    const winner = duplicates[0];
    deduped.push({
      ...winner,
      duplicateGameIds: duplicates.map((entry) => entry.game_id),
      duplicateCount: duplicates.length,
    });
  }

  return deduped;
}

/**
 * Check 2: Odds freshness
 * For games within T-6h, verify latest odds snapshot is < 15 min old.
 * When near-term stale games are detected, attempts bounded remediation via
 * refreshStaleOdds before writing a final 'failed' status.
 */
async function checkOddsFreshness() {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc;
  const endUtc = nowUtc.plus({ hours: 6 });

  // Only check sports whose odds are actively fetched.
  const activeSports = Object.entries(ODDS_SPORTS_CONFIG)
    .filter(([, cfg]) => cfg.active)
    .map(([sport]) => sport.toLowerCase());

  if (activeSports.length === 0) {
    return { ok: true, reason: 'No sports with active odds configured' };
  }

  const sportPlaceholders = activeSports.map(() => '?').join(', ');

  // Find games within T-6h for active-odds sports only
  const upcomingGames = db
    .prepare(
      `SELECT game_id, sport, home_team, away_team, game_time_utc
       FROM games
       WHERE game_time_utc >= ? AND game_time_utc <= ?
         AND LOWER(sport) IN (${sportPlaceholders})`,
    )
    .all(startUtc.toISO(), endUtc.toISO(), ...activeSports);

  if (upcomingGames.length === 0) {
    return { ok: true, reason: 'No games within T-6h for active-odds sports' };
  }

  // Check latest odds snapshot age for these games
  const gamesWithFreshness = [];
  for (const game of upcomingGames) {
    const latestOdds = db
      .prepare(
        `
      SELECT captured_at
      FROM odds_snapshots
      WHERE game_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `,
      )
      .get(game.game_id);

    const capturedAt = latestOdds?.captured_at
      ? DateTime.fromISO(latestOdds.captured_at, { zone: 'utc' })
      : null;
    const ageMinutes = capturedAt
      ? nowUtc.diff(capturedAt, 'minutes').minutes
      : null;
    const isStale = !capturedAt || ageMinutes > LIVE_ODDS_HEALTH_MAX_AGE_MINUTES;

    gamesWithFreshness.push({
      ...game,
      latestCapturedAt: latestOdds?.captured_at || null,
      ageMinutes,
      isStale,
    });
  }

  const dedupedGames = dedupeOddsFreshnessGames(gamesWithFreshness);
  const staleGames = dedupedGames.filter((game) => game.isStale);
  const duplicateRowsIgnored = upcomingGames.length - dedupedGames.length;

  if (staleGames.length === 0) {
    const duplicateSuffix =
      duplicateRowsIgnored > 0
        ? ` (${duplicateRowsIgnored} duplicate game_id rows ignored)`
        : '';
    const reason = `All ${dedupedGames.length} games within T-6h have fresh odds${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        detected: 0,
        blocked: 0,
        refreshed: 0,
      },
    };
  }

  // Only escalate to failed/alert when stale games are inside the configured alert window.
  // Games outside this window are warning-only because they still have runway before tip.
  const alertWindowEnd = nowUtc.plus({ hours: ODDS_FRESHNESS_ALERT_WINDOW_HOURS });
  const staleNearTerm = staleGames.filter(
    (g) => DateTime.fromISO(g.game_time_utc, { zone: 'utc' }) <= alertWindowEnd,
  );

  const quotaTier = getCurrentQuotaTier();
  const quotaConstrained = ['MEDIUM', 'LOW', 'CRITICAL'].includes(quotaTier);
  const duplicateSuffix =
    duplicateRowsIgnored > 0
      ? ` (${duplicateRowsIgnored} duplicate game_id rows ignored)`
      : '';

  if (quotaConstrained) {
    const reason = `${staleGames.length}/${dedupedGames.length} games within T-6h have stale odds (>${LIVE_ODDS_HEALTH_MAX_AGE_MINUTES}m old; alert window T-${ODDS_FRESHNESS_ALERT_WINDOW_HOURS}h) — odds fetch paused (quota tier: ${quotaTier})${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'warning', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        detected: staleGames.length,
        blocked: staleNearTerm.length,
        refreshed: 0,
      },
    };
  }

  if (staleNearTerm.length === 0) {
    const reason = `${staleGames.length}/${dedupedGames.length} games within T-6h have stale odds (>${LIVE_ODDS_HEALTH_MAX_AGE_MINUTES}m old) but none within alert window T-${ODDS_FRESHNESS_ALERT_WINDOW_HOURS}h${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'warning', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        detected: staleGames.length,
        blocked: 0,
        refreshed: 0,
      },
    };
  }

  // Attempt bounded remediation before writing final fail status.
  let remediationDiag = { detected: staleGames.length, refreshed: 0, blocked: staleNearTerm.length };
  try {
    const refreshStaleOdds = getRefreshStaleOdds();
    const remResult = await refreshStaleOdds({ jobKey: null });
    if (remResult?.staleDiagnostics) {
      remediationDiag = remResult.staleDiagnostics;
    }
  } catch (_err) {
    // Remediation threw — proceed with original stale classification.
  }

  // Re-check near-term stale games after remediation.
  const nowUtcAfter = DateTime.utc();
  const stillStaleNearTerm = staleNearTerm.filter((game) => {
    const dbNow = getDatabase();
    const latest = dbNow
      .prepare('SELECT captured_at FROM odds_snapshots WHERE game_id = ? ORDER BY captured_at DESC LIMIT 1')
      .get(game.game_id);
    const capturedAt = latest?.captured_at ? DateTime.fromISO(latest.captured_at, { zone: 'utc' }) : null;
    const ageMinutes = capturedAt ? nowUtcAfter.diff(capturedAt, 'minutes').minutes : null;
    return !capturedAt || ageMinutes > LIVE_ODDS_HEALTH_MAX_AGE_MINUTES;
  });

  const remSuffix = `remediation: detected=${remediationDiag.detected} refreshed=${remediationDiag.refreshed} blocked=${remediationDiag.blocked}`;

  if (stillStaleNearTerm.length === 0) {
    const reason = `Stale near-term odds cleared by remediation (${remSuffix})${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'ok', reason);
    return { ok: true, reason, diagnostics: remediationDiag };
  }

  const reason = `${stillStaleNearTerm.length}/${dedupedGames.length} games within alert window T-${ODDS_FRESHNESS_ALERT_WINDOW_HOURS}h still stale after remediation (${remSuffix})${duplicateSuffix}`;
  writePipelineHealth('odds', 'freshness', 'failed', reason);
  return { ok: false, reason, diagnostics: remediationDiag };
}

/**
 * Check 3: Cards freshness
 * For games within T-2h, verify the most recent completed model window ran
 * successfully. Missing/stale card_payloads are informational only because some
 * model runners legitimately emit no actionable card.
 */
function checkCardsFreshness() {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc;
  const endUtc = nowUtc.plus({ hours: 2 });

  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, game_time_utc, sport
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
  `,
    )
    .all(startUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    return { ok: true, reason: 'No games within T-2h' };
  }

  const modelRunMisses = [];
  let dueWindowCount = 0;
  let awaitingFirstWindowCount = 0;
  let unsupportedSportCount = 0;
  let informationalCardLagCount = 0;

  for (const game of upcomingGames) {
    const sport = String(game.sport || '').toLowerCase();
    const descriptor = CARD_HEALTH_MODEL_JOB_BY_SPORT[sport] || null;
    const latestCard = db
      .prepare(
        `
      SELECT created_at
      FROM card_payloads
      WHERE game_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(game.game_id);

    const latestCardAgeMinutes = latestCard
      ? nowUtc.diff(DateTime.fromISO(latestCard.created_at, { zone: 'utc' }), 'minutes').minutes
      : null;
    const hasCardLag = latestCardAgeMinutes === null || latestCardAgeMinutes > CARDS_FRESHNESS_MAX_AGE_MINUTES;

    if (!descriptor || process.env[descriptor.env] === 'false') {
      unsupportedSportCount += 1;
      if (hasCardLag) informationalCardLagCount += 1;
      continue;
    }

    const minsUntilStart = Math.floor(
      DateTime.fromISO(game.game_time_utc, { zone: 'utc' }).diff(nowUtc, 'minutes').minutes,
    );
    const completedBands = TMINUS_BANDS.filter((band) => minsUntilStart < band.min);
    const latestCompletedBand = completedBands[completedBands.length - 1] || null;

    if (!latestCompletedBand) {
      awaitingFirstWindowCount += 1;
      if (hasCardLag) informationalCardLagCount += 1;
      continue;
    }

    dueWindowCount += 1;
    const jobKey = keyTminus(sport, game.game_id, latestCompletedBand.minutes);
    const recentModelRun = db
      .prepare(
        `
      SELECT started_at
      FROM job_runs
      WHERE job_name = ?
        AND job_key = ?
        AND status = 'success'
      ORDER BY started_at DESC
      LIMIT 1
    `,
      )
      .get(descriptor.jobName, jobKey);

    if (!recentModelRun) {
      modelRunMisses.push({
        gameId: game.game_id,
        sport,
        expectedWindowMinutes: latestCompletedBand.minutes,
      });
      continue;
    }

    if (hasCardLag) informationalCardLagCount += 1;
  }

  if (modelRunMisses.length === 0) {
    const reasonParts = [];
    if (dueWindowCount === 0) {
      reasonParts.push(`No games within T-2h have a completed model window yet`);
    } else {
      reasonParts.push(`All ${dueWindowCount} completed model windows within T-2h have recent model runs`);
    }
    if (awaitingFirstWindowCount > 0) {
      reasonParts.push(`${awaitingFirstWindowCount} games awaiting first model window`);
    }
    if (unsupportedSportCount > 0) {
      reasonParts.push(`${unsupportedSportCount} games skipped (unsupported or disabled sport model)`);
    }
    if (informationalCardLagCount > 0) {
      reasonParts.push(`${informationalCardLagCount}/${upcomingGames.length} missing/stale cards are informational`);
    }
    const reason = reasonParts.join('; ');
    writePipelineHealth('cards', 'freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const reasonParts = [
    `${modelRunMisses.length}/${dueWindowCount} games within T-2h missing expected model runs`,
  ];
  if (informationalCardLagCount > 0) {
    reasonParts.push(`${informationalCardLagCount}/${upcomingGames.length} missing/stale cards are informational`);
  }
  const reason = reasonParts.join('; ');
  writePipelineHealth('cards', 'freshness', 'warning', reason);
  return { ok: false, reason };
}

function checkCardOutputIntegrity() {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total_cards,
         SUM(CASE
               WHEN UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.official_status'), json_extract(payload_data, '$.status'))) = 'PASS'
                 THEN 1 ELSE 0 END) AS pass_cards,
         SUM(CASE
               WHEN UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%NO_MARKET%'
                 OR UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%MISSING_ODDS%'
                 OR UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%ODDS_MISSING%'
                 THEN 1 ELSE 0 END) AS missing_odds_cards,
         SUM(CASE
               WHEN UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%STALE%'
                 OR UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%PROJECTION_ONLY%'
                 OR UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%MISSING_INPUT%'
                 OR UPPER(COALESCE(json_extract(payload_data, '$.decision_v2.primary_reason_code'), json_extract(payload_data, '$.pass_reason_code'), '')) LIKE '%CONTRACT%'
                 THEN 1 ELSE 0 END) AS degraded_cards,
         SUM(CASE
               WHEN COALESCE(
                 json_type(payload_data, '$.decision_v2'),
                 json_type(payload_data, '$.play.decision_v2')
               ) IS NULL
                 THEN 1 ELSE 0 END) AS missing_decision_v2_count,
         SUM(CASE
               WHEN UPPER(COALESCE(
                 json_extract(payload_data, '$.decision_v2.official_status'),
                 json_extract(payload_data, '$.play.decision_v2.official_status'),
                 ''
               )) = 'INVALID'
                 THEN 1 ELSE 0 END) AS invalid_decision_count
       FROM card_payloads
       WHERE created_at > datetime('now', ?)`,
    )
    .get(`-${CARD_OUTPUT_INTEGRITY_LOOKBACK_HOURS} hours`);

  const invalidBySportRows = db
    .prepare(
      `SELECT
         UPPER(COALESCE(json_extract(payload_data, '$.sport'), 'UNKNOWN')) AS sport,
         COUNT(*) AS count
       FROM card_payloads
       WHERE created_at > datetime('now', ?)
         AND UPPER(COALESCE(
           json_extract(payload_data, '$.decision_v2.official_status'),
           json_extract(payload_data, '$.play.decision_v2.official_status'),
           ''
         )) = 'INVALID'
       GROUP BY UPPER(COALESCE(json_extract(payload_data, '$.sport'), 'UNKNOWN'))
       ORDER BY count DESC`,
    )
    .all(`-${CARD_OUTPUT_INTEGRITY_LOOKBACK_HOURS} hours`);

  const recentInvalidExamples = db
    .prepare(
      `SELECT
         game_id,
         card_type,
         created_at
       FROM card_payloads
       WHERE created_at > datetime('now', ?)
         AND (
           COALESCE(
             json_type(payload_data, '$.decision_v2'),
             json_type(payload_data, '$.play.decision_v2')
           ) IS NULL
           OR UPPER(COALESCE(
             json_extract(payload_data, '$.decision_v2.official_status'),
             json_extract(payload_data, '$.play.decision_v2.official_status'),
             ''
           )) = 'INVALID'
         )
       ORDER BY datetime(created_at) DESC
       LIMIT 5`,
    )
    .all(`-${CARD_OUTPUT_INTEGRITY_LOOKBACK_HOURS} hours`)
    .map((row) => ({
      game_id: row.game_id || null,
      card_type: row.card_type || null,
      created_at: row.created_at || null,
    }));

  const totalCards = Number(row?.total_cards || 0);
  if (totalCards < CARD_OUTPUT_INTEGRITY_MIN_SAMPLE) {
    const reason = `Insufficient sample for card output integrity (${totalCards}/${CARD_OUTPUT_INTEGRITY_MIN_SAMPLE} cards in last ${CARD_OUTPUT_INTEGRITY_LOOKBACK_HOURS}h)`;
    writePipelineHealth('cards', 'output_integrity', 'ok', reason);
    return { ok: true, reason, diagnostics: { totalCards } };
  }

  const passRate = Number(row?.pass_cards || 0) / totalCards;
  const missingOddsRate = Number(row?.missing_odds_cards || 0) / totalCards;
  const degradedRate = Number(row?.degraded_cards || 0) / totalCards;
  const missingDecisionV2Count = Number(row?.missing_decision_v2_count || 0);
  const invalidDecisionCount = Number(row?.invalid_decision_count || 0);
  const invalidBySport = Array.isArray(invalidBySportRows)
    ? invalidBySportRows.reduce((acc, item) => {
        const sport = String(item?.sport || 'UNKNOWN');
        acc[sport] = Number(item?.count || 0);
        return acc;
      }, {})
    : {};

  const failingSignals = [];
  // Pre-baseline hard fail policy: any invalid/missing canonical decision is a failure.
  // This should be revisited after baseline measurement to tune alert thresholds.
  if (missingDecisionV2Count > 0) {
    failingSignals.push(`missing_decision_v2_count=${missingDecisionV2Count}`);
  }
  if (invalidDecisionCount > 0) {
    failingSignals.push(`invalid_decision_count=${invalidDecisionCount}`);
  }
  if (passRate > CARD_OUTPUT_PASS_RATE_MAX) {
    failingSignals.push(`PASS spike ${passRate.toFixed(3)}>${CARD_OUTPUT_PASS_RATE_MAX.toFixed(3)}`);
  }
  if (missingOddsRate > CARD_OUTPUT_MISSING_ODDS_RATE_MAX) {
    failingSignals.push(`missing_odds spike ${missingOddsRate.toFixed(3)}>${CARD_OUTPUT_MISSING_ODDS_RATE_MAX.toFixed(3)}`);
  }
  if (degradedRate > CARD_OUTPUT_DEGRADED_RATE_MAX) {
    failingSignals.push(`degraded spike ${degradedRate.toFixed(3)}>${CARD_OUTPUT_DEGRADED_RATE_MAX.toFixed(3)}`);
  }

  const metrics = `sample=${totalCards} pass_rate=${passRate.toFixed(3)} missing_odds_rate=${missingOddsRate.toFixed(3)} degraded_rate=${degradedRate.toFixed(3)} missing_decision_v2_count=${missingDecisionV2Count} invalid_decision_count=${invalidDecisionCount}`;
  if (failingSignals.length === 0) {
    const reason = `Card output integrity healthy (${metrics})`;
    writePipelineHealth('cards', 'output_integrity', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        totalCards,
        passRate,
        missingOddsRate,
        degradedRate,
        missingDecisionV2Count,
        invalidDecisionCount,
        invalidBySport,
        recentInvalidExamples,
      },
    };
  }

  const reason = `CARD_OUTPUT_INTEGRITY_DEGRADED — ${failingSignals.join('; ')} (${metrics})`;
  writePipelineHealth('cards', 'output_integrity', 'failed', reason);
  return {
    ok: false,
    reason,
    diagnostics: {
      totalCards,
      passRate,
      missingOddsRate,
      degradedRate,
      missingDecisionV2Count,
      invalidDecisionCount,
      invalidBySport,
      recentInvalidExamples,
    },
  };
}

function getLatestOddsSnapshot(db, gameId) {
  return db
    .prepare(
      `
    SELECT *
    FROM odds_snapshots
    WHERE game_id = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `,
    )
    .get(gameId);
}

function checkScheduledGameCardCoverage(
  sport,
  {
    lookaheadHours = SCHEDULED_GAME_CARD_COVERAGE_LOOKAHEAD_HOURS,
    startBufferMinutes = SCHEDULED_GAME_CARD_COVERAGE_START_BUFFER_MINUTES,
  } = {},
) {
  const db = getDatabase();
  const normalizedSport = String(sport || '').toUpperCase();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc.plus({ minutes: startBufferMinutes });
  const endUtc = nowUtc.plus({ hours: lookaheadHours });

  const scheduledRows = db
    .prepare(
      `SELECT
         g.game_id,
         g.game_time_utc,
         COUNT(cp.id) AS card_count
       FROM games g
       LEFT JOIN card_payloads cp
         ON cp.game_id = g.game_id
       WHERE UPPER(g.sport) = ?
         AND LOWER(COALESCE(g.status, '')) IN ('scheduled', 'pre')
         AND datetime(g.game_time_utc) >= datetime(?)
         AND datetime(g.game_time_utc) <= datetime(?)
       GROUP BY g.game_id, g.game_time_utc
       ORDER BY datetime(g.game_time_utc) ASC, g.game_id ASC`,
    )
    .all(normalizedSport, startUtc.toISO(), endUtc.toISO());

  if (scheduledRows.length === 0) {
    const reason =
      `${normalizedSport} scheduled game card coverage: no scheduled games between ` +
      `T+${startBufferMinutes}m and T+${lookaheadHours}h`;
    writePipelineHealth(normalizedSport.toLowerCase(), 'scheduled_game_card_coverage', 'ok', reason);
    return {
      ok: true,
      status: 'ok',
      check_name: 'scheduled_game_card_coverage',
      sport: normalizedSport,
      reason,
      diagnostics: {
        total_games: 0,
        covered_games: 0,
        missing_game_ids: [],
        coverage_pct: 1,
        lookahead_hours: lookaheadHours,
        start_buffer_minutes: startBufferMinutes,
      },
    };
  }

  const missingGameIds = scheduledRows
    .filter((row) => Number(row.card_count || 0) === 0)
    .map((row) => row.game_id);
  const totalGames = scheduledRows.length;
  const coveredGames = totalGames - missingGameIds.length;
  const coveragePct = coveredGames / totalGames;

  let status = 'ok';
  if (coveragePct < SCHEDULED_GAME_CARD_COVERAGE_FAIL_THRESHOLD) {
    status = 'failed';
  } else if (coveragePct < SCHEDULED_GAME_CARD_COVERAGE_WARN_THRESHOLD) {
    status = 'warning';
  }

  const coveragePctText = `${Math.round(coveragePct * 100)}%`;
  const missingSuffix = missingGameIds.length > 0
    ? ` Missing: [${missingGameIds.join(', ')}]`
    : '';
  const reason =
    `${normalizedSport} scheduled game card coverage: Coverage ` +
    `${coveredGames}/${totalGames} (${coveragePctText}).${missingSuffix}`;
  writePipelineHealth(normalizedSport.toLowerCase(), 'scheduled_game_card_coverage', status, reason);
  return {
    ok: status === 'ok',
    status,
    check_name: 'scheduled_game_card_coverage',
    sport: normalizedSport,
    reason,
    diagnostics: {
      total_games: totalGames,
      covered_games: coveredGames,
      missing_game_ids: missingGameIds,
      coverage_pct: coveragePct,
      lookahead_hours: lookaheadHours,
      start_buffer_minutes: startBufferMinutes,
    },
  };
}

const MLB_REJECT_REASON_FAMILIES = Object.freeze([
  'DATA_STALENESS',
  'NO_EDGE',
  'INPUT_FAILURE',
  'EXECUTION_POLICY',
  'UNCATEGORIZED',
]);

const MLB_REJECT_MARKETS = Object.freeze([
  'f5_total',
  'full_game_total',
  'full_game_ml',
]);
const MLB_GAME_LINE_MARKETS = Object.freeze([
  { key: 'full_game_total', cardType: 'mlb-full-game' },
  { key: 'full_game_ml', cardType: 'mlb-full-game-ml' },
]);
const MLB_GAME_LINE_REASON_BUCKETS = Object.freeze([
  'no_card_row',
  'current_blocked',
  'current_projection_only',
  'current_non_publishable',
  'stale_snapshot',
  'stale_or_unverifiable_snapshot',
]);
const MLB_GAME_LINE_SAMPLE_LIMIT = 5;
const MLB_GAME_LINE_FALLBACK_MAX_AGE_MINUTES = parseEnvNumber(
  'API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES',
  90,
  { min: 1 },
);
const MLB_GAME_LINE_ODDS_TOLERANCE_MINUTES = parseEnvNumber(
  'API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES',
  10,
  { min: 0 },
);

function mapMlbCardTypeToRejectMarket(cardType) {
  if (cardType === 'mlb-f5') return 'f5_total';
  if (cardType === 'mlb-full-game') return 'full_game_total';
  if (cardType === 'mlb-full-game-ml') return 'full_game_ml';
  return null;
}

function classifyMlbRejectReasonFamily(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (!code) return 'UNCATEGORIZED';
  if (code.includes('STALE') || code.includes('SNAPSHOT_AGE') || code.includes('SNAPSHOT_MISSING')) {
    return 'DATA_STALENESS';
  }
  if (code.includes('NO_EDGE') || code.includes('EDGE_INSUFFICIENT') || code.includes('PASS_NO_EDGE')) {
    return 'NO_EDGE';
  }
  if (
    code.includes('INPUT') ||
    code.includes('MISSING') ||
    code.includes('UNAVAILABLE') ||
    code.includes('NO_MARKET') ||
    code.includes('CONTRACT')
  ) {
    return 'INPUT_FAILURE';
  }
  if (
    code.includes('PROJECTION_ONLY') ||
    code.includes('ROLL') ||
    code.includes('DISABLED') ||
    code.includes('QUARANTINE') ||
    code.includes('POLICY')
  ) {
    return 'EXECUTION_POLICY';
  }
  return 'UNCATEGORIZED';
}

function summarizeMlbRejectReasonFamilies(db, lookbackHours = 24) {
  const reasonFamilyCounts = MLB_REJECT_MARKETS.reduce((acc, market) => {
    acc[market] = MLB_REJECT_REASON_FAMILIES.reduce((families, family) => {
      families[family] = 0;
      return families;
    }, {});
    return acc;
  }, {});

  const rows = db
    .prepare(
      `SELECT
         card_type,
         json_extract(payload_data, '$.decision_v2.primary_reason_code') AS decision_reason,
         json_extract(payload_data, '$.pass_reason_code') AS pass_reason,
         json_extract(payload_data, '$.reason_codes') AS reason_codes_json,
         COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'MLB'
         AND card_type IN ('mlb-f5', 'mlb-full-game', 'mlb-full-game-ml')
         AND created_at > datetime('now', ?)
       GROUP BY 1, 2, 3, 4`,
    )
    .all(`-${lookbackHours} hours`);

  for (const row of rows) {
    const market = mapMlbCardTypeToRejectMarket(row.card_type);
    if (!market) continue;

    const codes = [];
    if (typeof row.decision_reason === 'string' && row.decision_reason.length > 0) {
      codes.push(row.decision_reason);
    }
    if (typeof row.pass_reason === 'string' && row.pass_reason.length > 0) {
      codes.push(row.pass_reason);
    }

    if (typeof row.reason_codes_json === 'string' && row.reason_codes_json.length > 0) {
      try {
        const parsed = JSON.parse(row.reason_codes_json);
        if (Array.isArray(parsed)) {
          for (const code of parsed) {
            if (typeof code === 'string' && code.length > 0) {
              codes.push(code);
            }
          }
        }
      } catch (_error) {
        // Keep deterministic fallback to UNCATEGORIZED when reason_codes is malformed.
      }
    }

    const family = codes.length > 0
      ? classifyMlbRejectReasonFamily(codes[0])
      : 'UNCATEGORIZED';
    reasonFamilyCounts[market][family] += Number(row.cnt || 0);
  }

  const uncategorizedCount = MLB_REJECT_MARKETS.reduce(
    (sum, market) => sum + Number(reasonFamilyCounts[market].UNCATEGORIZED || 0),
    0,
  );

  return {
    lookback_hours: lookbackHours,
    reason_family_counts: reasonFamilyCounts,
    uncategorized_count: uncategorizedCount,
  };
}

// ---------------------------------------------------------------------------
// TD-04: NHL market-call reject reason-family diagnostics
// ---------------------------------------------------------------------------

const NHL_REJECT_REASON_FAMILIES = Object.freeze([
  'DATA_STALENESS',
  'NO_EDGE',
  'INTEGRITY_VETO',
  'SUPPORT_FAIL',
  'CONTRACT_MISMATCH',
  'UNCATEGORIZED',
]);

const NHL_MARKET_CALL_CARD_TYPES = Object.freeze([
  'nhl-totals-call',
  'nhl-spread-call',
  'nhl-moneyline-call',
]);

function classifyNhlRejectReasonFamily(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (!code) return 'UNCATEGORIZED';
  if (code.includes('STALE') || code.includes('SNAPSHOT_AGE') || code.includes('SNAPSHOT_MISSING')) {
    return 'DATA_STALENESS';
  }
  if (
    code.includes('NO_EDGE') ||
    code.includes('EDGE_INSUFFICIENT') ||
    code.includes('PASS_NO_EDGE') ||
    code.includes('PASS_EXECUTION_GATE') ||
    code.includes('EDGE_VERIFICATION')
  ) {
    return 'NO_EDGE';
  }
  if (
    code.includes('GOALIE') ||
    code.includes('INJURY') ||
    code.includes('UNCERTAINTY') ||
    code.includes('INTEGRITY') ||
    code.includes('VETO') ||
    code.includes('VERIFICATION_REQUIRED') ||
    code.includes('CAUTION')
  ) {
    return 'INTEGRITY_VETO';
  }
  if (
    code.includes('SUPPORT') ||
    code.includes('INSUFFICIENT_DATA') ||
    code.includes('TOTAL_INSUFFICIENT')
  ) {
    return 'SUPPORT_FAIL';
  }
  if (
    code.includes('CONTRACT') ||
    code.includes('MARKET_UNAVAILABLE') ||
    code.includes('PROJECTION_ONLY') ||
    code.includes('NO_ODDS_MODE') ||
    code.includes('MISSING')
  ) {
    return 'CONTRACT_MISMATCH';
  }
  return 'UNCATEGORIZED';
}

function summarizeNhlRejectReasonFamilies(db, lookbackHours = 24) {
  const reasonFamilyCounts = NHL_MARKET_CALL_CARD_TYPES.reduce((acc, cardType) => {
    acc[cardType] = NHL_REJECT_REASON_FAMILIES.reduce((families, family) => {
      families[family] = 0;
      return families;
    }, {});
    return acc;
  }, {});

  const rows = db
    .prepare(
      `SELECT
         card_type,
         json_extract(payload_data, '$.decision_v2.primary_reason_code') AS decision_reason,
         json_extract(payload_data, '$.pass_reason_code') AS pass_reason,
         json_extract(payload_data, '$.reason_codes') AS reason_codes_json,
         COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'NHL'
         AND card_type IN ('nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call')
         AND created_at > datetime('now', ?)
       GROUP BY 1, 2, 3, 4`,
    )
    .all(`-${lookbackHours} hours`);

  for (const row of rows) {
    const cardType = row.card_type;
    if (!reasonFamilyCounts[cardType]) continue;

    const codes = [];
    if (typeof row.decision_reason === 'string' && row.decision_reason.length > 0) {
      codes.push(row.decision_reason);
    }
    if (typeof row.pass_reason === 'string' && row.pass_reason.length > 0) {
      codes.push(row.pass_reason);
    }
    if (typeof row.reason_codes_json === 'string' && row.reason_codes_json.length > 0) {
      try {
        const parsed = JSON.parse(row.reason_codes_json);
        if (Array.isArray(parsed)) {
          for (const code of parsed) {
            if (typeof code === 'string' && code.length > 0) {
              codes.push(code);
            }
          }
        }
      } catch (_error) {
        // deterministic fallback to UNCATEGORIZED when reason_codes is malformed
      }
    }

    const family = codes.length > 0
      ? classifyNhlRejectReasonFamily(codes[0])
      : 'UNCATEGORIZED';
    reasonFamilyCounts[cardType][family] += Number(row.cnt || 0);
  }

  const uncategorizedCount = NHL_MARKET_CALL_CARD_TYPES.reduce(
    (sum, ct) => sum + Number(reasonFamilyCounts[ct].UNCATEGORIZED || 0),
    0,
  );

  return {
    lookback_hours: lookbackHours,
    reason_family_counts: reasonFamilyCounts,
    uncategorized_count: uncategorizedCount,
  };
}

function checkNhlMarketCallDiagnostics() {
  const db = getDatabase();
  const diag = summarizeNhlRejectReasonFamilies(db);
  const ok = diag.uncategorized_count === 0;
  const parts = NHL_MARKET_CALL_CARD_TYPES.map((ct) => {
    const counts = diag.reason_family_counts[ct];
    return `${ct}:[${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(',')}]`;
  });
  const reason = ok
    ? `NHL market call diagnostics: all blockers categorized (${parts.join(' ')})`
    : `NHL market call diagnostics: ${diag.uncategorized_count} uncategorized blocker(s) (${parts.join(' ')})`;
  writePipelineHealth('nhl', 'market_call_blockers', ok ? 'ok' : 'warning', reason);
  return { ok, reason, diagnostics: diag };
}

function checkNhlMoneylineCoverage({ lookaheadHours = 6, lookbackHours = 12 } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });

  const readSingleCount = (statement, ...args) => {
    if (statement && typeof statement.get === 'function') {
      const row = statement.get(...args);
      return Number(row?.cnt || 0);
    }
    if (statement && typeof statement.all === 'function') {
      const rows = statement.all(...args);
      return Number(rows?.[0]?.cnt || 0);
    }
    return 0;
  };

  const h2hGamesStmt = db.prepare(
    `SELECT COUNT(DISTINCT g.game_id) AS cnt
     FROM games g
     JOIN odds_snapshots o ON o.game_id = g.game_id
     WHERE g.sport = 'NHL'
       AND g.game_time_utc >= ?
       AND g.game_time_utc <= ?
       AND o.captured_at > datetime('now', ?)
       AND (o.h2h_home IS NOT NULL OR o.h2h_away IS NOT NULL)`,
  );
  const h2hGamesCount = readSingleCount(
    h2hGamesStmt,
    nowUtc.toISO(),
    endUtc.toISO(),
    `-${lookbackHours} hours`,
  );

  const mlCardsStmt = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM card_payloads
     WHERE sport = 'NHL'
       AND card_type = 'nhl-moneyline-call'
       AND created_at > datetime('now', ?)`,
  );
  const moneylineCardsCount = readSingleCount(mlCardsStmt, `-${lookbackHours} hours`);

  if (h2hGamesCount === 0) {
    const reason = `NHL moneyline coverage: no games with h2h odds in next ${lookaheadHours}h`;
    writePipelineHealth('nhl', 'moneyline_coverage', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        nhl_games_with_h2h_odds: 0,
        nhl_moneyline_cards_count: moneylineCardsCount,
        alert_code: null,
      },
    };
  }

  if (moneylineCardsCount === 0) {
    const reason = `NHL_ML_SURFACING_GAP: ${h2hGamesCount} game(s) with h2h odds in next ${lookaheadHours}h but 0 nhl-moneyline-call cards in last ${lookbackHours}h`;
    writePipelineHealth('nhl', 'moneyline_coverage', 'failed', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        nhl_games_with_h2h_odds: h2hGamesCount,
        nhl_moneyline_cards_count: 0,
        alert_code: 'NHL_ML_SURFACING_GAP',
      },
    };
  }

  const reason = `NHL moneyline coverage: ${h2hGamesCount} game(s) with h2h odds and ${moneylineCardsCount} nhl-moneyline-call card(s) in last ${lookbackHours}h`;
  writePipelineHealth('nhl', 'moneyline_coverage', 'ok', reason);
  return {
    ok: true,
    reason,
    diagnostics: {
      nhl_games_with_h2h_odds: h2hGamesCount,
      nhl_moneyline_cards_count: moneylineCardsCount,
      alert_code: null,
    },
  };
}

function isEtMidnightGameTime(value) {
  if (!value) return false;
  const normalized = String(value).includes('T')
    ? String(value)
    : String(value).replace(' ', 'T');
  const utcValue = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const dt = DateTime.fromISO(utcValue, { zone: 'utc' });
  if (!dt.isValid) return false;
  const et = dt.setZone('America/New_York');
  return et.hour === 0 && et.minute === 0;
}

function checkNhlFalseListingCandidates({ lookaheadHours = 36 } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });

  const candidateRows = db
    .prepare(
      `SELECT
         g.game_id,
         g.home_team,
         g.away_team,
         g.game_time_utc,
         COUNT(cp.id) AS card_count,
         SUM(CASE WHEN LOWER(cp.card_type) LIKE 'nhl-player-%' THEN 1 ELSE 0 END) AS prop_card_count,
         SUM(CASE WHEN LOWER(cp.card_type) NOT LIKE 'nhl-player-%' THEN 1 ELSE 0 END) AS non_prop_card_count
       FROM games g
       LEFT JOIN card_payloads cp
         ON cp.game_id = g.game_id
       WHERE UPPER(g.sport) = 'NHL'
         AND LOWER(COALESCE(g.status, '')) = 'scheduled'
         AND datetime(g.game_time_utc) > datetime(?)
         AND datetime(g.game_time_utc) <= datetime(?)
         AND NOT EXISTS (
           SELECT 1
           FROM odds_snapshots o
           WHERE o.game_id = g.game_id
             AND (
               o.h2h_home IS NOT NULL OR
               o.h2h_away IS NOT NULL OR
               o.total IS NOT NULL OR
               o.spread_home IS NOT NULL OR
               o.spread_away IS NOT NULL
             )
         )
       GROUP BY g.game_id, g.home_team, g.away_team, g.game_time_utc
       HAVING COUNT(cp.id) > 0`,
    )
    .all(nowUtc.toISO(), endUtc.toISO());

  const suspiciousRows = candidateRows.filter(
    (row) =>
      Number(row.non_prop_card_count || 0) === 0 &&
      isEtMidnightGameTime(row.game_time_utc),
  );

  if (suspiciousRows.length === 0) {
    const reason =
      `NHL false-listing candidates: no future scheduled NHL rows in next ${lookaheadHours}h ` +
      'with midnight ET start time, prop-only cards, and no displayable odds';
    writePipelineHealth('nhl', 'false_listing_candidates', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: { candidate_count: 0, samples: [] },
    };
  }

  const samples = suspiciousRows
    .slice(0, 3)
    .map(
      (row) =>
        `${row.game_id} ${row.away_team} @ ${row.home_team} ${row.game_time_utc}`,
    );
  const reason =
    `NHL_FALSE_LISTING_CANDIDATE: ${suspiciousRows.length} future scheduled NHL row(s) ` +
    `have midnight ET start time, prop-only cards, and no displayable odds; samples=${samples.join(' | ')}`;
  writePipelineHealth('nhl', 'false_listing_candidates', 'failed', reason);
  return {
    ok: false,
    reason,
    diagnostics: {
      candidate_count: suspiciousRows.length,
      samples,
    },
  };
}

// ---------------------------------------------------------------------------
// TD-04: NBA market-call reject reason-family diagnostics
// ---------------------------------------------------------------------------

const NBA_REJECT_REASON_FAMILIES = Object.freeze([
  'DATA_STALENESS',
  'NO_EDGE',
  'INTEGRITY_VETO',
  'SUPPORT_FAIL',
  'POLICY_QUARANTINE',
  'CONTRACT_MISMATCH',
  'UNCATEGORIZED',
]);

const NBA_MARKET_CALL_CARD_TYPES = Object.freeze([
  'nba-totals-call',
  'nba-spread-call',
]);

function classifyNbaRejectReasonFamily(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (!code) return 'UNCATEGORIZED';
  if (code.includes('NBA_TOTAL_QUARANTINE_DEMOTE')) {
    return 'POLICY_QUARANTINE';
  }
  if (code.includes('STALE') || code.includes('SNAPSHOT_AGE') || code.includes('SNAPSHOT_MISSING')) {
    return 'DATA_STALENESS';
  }
  if (
    code.includes('NO_EDGE') ||
    code.includes('EDGE_INSUFFICIENT') ||
    code.includes('PASS_NO_EDGE') ||
    code.includes('PASS_EXECUTION_GATE') ||
    code.includes('EDGE_VERIFICATION')
  ) {
    return 'NO_EDGE';
  }
  if (
    code.includes('INJURY') ||
    code.includes('UNCERTAINTY') ||
    code.includes('INTEGRITY') ||
    code.includes('VETO') ||
    code.includes('VERIFICATION_REQUIRED') ||
    code.includes('CAUTION')
  ) {
    return 'INTEGRITY_VETO';
  }
  if (
    code.includes('SUPPORT') ||
    code.includes('INSUFFICIENT_DATA') ||
    code.includes('TOTAL_INSUFFICIENT')
  ) {
    return 'SUPPORT_FAIL';
  }
  if (
    code.includes('CONTRACT') ||
    code.includes('MARKET_UNAVAILABLE') ||
    code.includes('PROJECTION_ONLY') ||
    code.includes('NO_ODDS_MODE') ||
    code.includes('MISSING')
  ) {
    return 'CONTRACT_MISMATCH';
  }
  return 'UNCATEGORIZED';
}

function summarizeNbaRejectReasonFamilies(db, lookbackHours = 24) {
  const reasonFamilyCounts = NBA_MARKET_CALL_CARD_TYPES.reduce((acc, cardType) => {
    acc[cardType] = NBA_REJECT_REASON_FAMILIES.reduce((families, family) => {
      families[family] = 0;
      return families;
    }, {});
    return acc;
  }, {});

  const rows = db
    .prepare(
      `SELECT
         card_type,
         json_extract(payload_data, '$.decision_v2.primary_reason_code') AS decision_reason,
         json_extract(payload_data, '$.pass_reason_code') AS pass_reason,
         json_extract(payload_data, '$.reason_codes') AS reason_codes_json,
         COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'NBA'
         AND card_type IN ('nba-totals-call', 'nba-spread-call')
         AND created_at > datetime('now', ?)
       GROUP BY 1, 2, 3, 4`,
    )
    .all(`-${lookbackHours} hours`);

  for (const row of rows) {
    const cardType = row.card_type;
    if (!reasonFamilyCounts[cardType]) continue;

    const codes = [];
    if (typeof row.decision_reason === 'string' && row.decision_reason.length > 0) {
      codes.push(row.decision_reason);
    }
    if (typeof row.pass_reason === 'string' && row.pass_reason.length > 0) {
      codes.push(row.pass_reason);
    }
    if (typeof row.reason_codes_json === 'string' && row.reason_codes_json.length > 0) {
      try {
        const parsed = JSON.parse(row.reason_codes_json);
        if (Array.isArray(parsed)) {
          for (const code of parsed) {
            if (typeof code === 'string' && code.length > 0) {
              codes.push(code);
            }
          }
        }
      } catch (_error) {
        // deterministic fallback to UNCATEGORIZED when reason_codes is malformed
      }
    }

    const family = codes.length > 0
      ? classifyNbaRejectReasonFamily(codes[0])
      : 'UNCATEGORIZED';
    reasonFamilyCounts[cardType][family] += Number(row.cnt || 0);
  }

  const uncategorizedCount = NBA_MARKET_CALL_CARD_TYPES.reduce(
    (sum, ct) => sum + Number(reasonFamilyCounts[ct].UNCATEGORIZED || 0),
    0,
  );

  return {
    lookback_hours: lookbackHours,
    reason_family_counts: reasonFamilyCounts,
    uncategorized_count: uncategorizedCount,
  };
}

function checkNbaMarketCallDiagnostics() {
  const db = getDatabase();
  const diag = summarizeNbaRejectReasonFamilies(db);
  const ok = diag.uncategorized_count === 0;
  const parts = NBA_MARKET_CALL_CARD_TYPES.map((ct) => {
    const counts = diag.reason_family_counts[ct];
    return `${ct}:[${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(',')}]`;
  });
  const reason = ok
    ? `NBA market call diagnostics: all blockers categorized (${parts.join(' ')})`
    : `NBA market call diagnostics: ${diag.uncategorized_count} uncategorized blocker(s) (${parts.join(' ')})`;
  writePipelineHealth('nba', 'market_call_blockers', ok ? 'ok' : 'warning', reason);
  return { ok, reason, diagnostics: diag };
}

function checkNbaMoneylineCoverage({ lookaheadHours = 6, lookbackHours = 12 } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });

  const upcomingGames = db
    .prepare(
      `SELECT game_id, sport, game_time_utc
       FROM games
       WHERE sport = 'NBA'
         AND game_time_utc >= ?
         AND game_time_utc <= ?
       ORDER BY game_time_utc ASC`,
    )
    .all(nowUtc.toISO(), endUtc.toISO());

  if (!Array.isArray(upcomingGames) || upcomingGames.length === 0) {
    const reason = `NBA moneyline coverage: no NBA games in next ${lookaheadHours}h`;
    writePipelineHealth('nba', 'moneyline_coverage', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        nba_games_with_spread_or_total: 0,
        nba_games_missing_ml: 0,
        nba_moneyline_cards_count: 0,
        alert_code: null,
      },
    };
  }

  let gamesWithSpreadOrTotal = 0;
  let gamesMissingMl = 0;
  const sampleMissingGameIds = [];

  for (const game of upcomingGames) {
    const snapshot = getLatestOddsSnapshot(db, game.game_id);
    if (!snapshot) continue;

    const hasSpreadOrTotal =
      snapshot.spread_home != null ||
      snapshot.spread_away != null ||
      snapshot.total != null;
    const hasMoneyline = snapshot.h2h_home != null || snapshot.h2h_away != null;

    if (!hasSpreadOrTotal) continue;
    gamesWithSpreadOrTotal += 1;
    if (!hasMoneyline) {
      gamesMissingMl += 1;
      if (sampleMissingGameIds.length < 5) {
        sampleMissingGameIds.push(game.game_id);
      }
    }
  }

  const mlCardsRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'NBA'
         AND card_type = 'nba-moneyline-call'
         AND created_at > datetime('now', ?)`,
    )
    .get(`-${lookbackHours} hours`);
  const moneylineCardsCount = Number(mlCardsRow?.cnt || 0);

  if (gamesWithSpreadOrTotal === 0) {
    const reason =
      `NBA moneyline coverage: no games with spread/total odds in next ${lookaheadHours}h`;
    writePipelineHealth('nba', 'moneyline_coverage', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        nba_games_with_spread_or_total: 0,
        nba_games_missing_ml: 0,
        nba_moneyline_cards_count: moneylineCardsCount,
        alert_code: null,
      },
    };
  }

  if (gamesMissingMl > 0) {
    const reason =
      `NBA_ML_MISSING_WITH_OTHER_MARKETS: ${gamesMissingMl}/${gamesWithSpreadOrTotal} game(s) have spread/total odds but missing moneyline in next ${lookaheadHours}h` +
      (sampleMissingGameIds.length > 0
        ? ` (sample=${sampleMissingGameIds.join(',')})`
        : '');
    writePipelineHealth('nba', 'moneyline_coverage', 'warning', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        nba_games_with_spread_or_total: gamesWithSpreadOrTotal,
        nba_games_missing_ml: gamesMissingMl,
        nba_moneyline_cards_count: moneylineCardsCount,
        sample_game_ids: sampleMissingGameIds,
        alert_code: 'NBA_ML_MISSING_WITH_OTHER_MARKETS',
      },
    };
  }

  const reason =
    `NBA moneyline coverage: ${gamesWithSpreadOrTotal} game(s) have spread/total+moneyline odds in next ${lookaheadHours}h`;
  writePipelineHealth('nba', 'moneyline_coverage', 'ok', reason);
  return {
    ok: true,
    reason,
    diagnostics: {
      nba_games_with_spread_or_total: gamesWithSpreadOrTotal,
      nba_games_missing_ml: 0,
      nba_moneyline_cards_count: moneylineCardsCount,
      alert_code: null,
    },
  };
}

function checkMlbScheduledGameCardCoverage(options = {}) {
  return checkScheduledGameCardCoverage('MLB', options);
}

function checkNhlScheduledGameCardCoverage(options = {}) {
  return checkScheduledGameCardCoverage('NHL', options);
}

function checkNbaScheduledGameCardCoverage(options = {}) {
  return checkScheduledGameCardCoverage('NBA', options);
}

/**
 * Check 4: MLB F5 market availability
 * For upcoming MLB games in the near T-minus window, report F5 total
 * availability separately
 * from full-game totals so watchdog output matches MLB market intent.
 *
 * Games within T-15min of gametime are excluded: F5 markets close before
 * gametime so their absence at that point is expected, not a pipeline failure.
 */
function checkMlbF5MarketAvailability({ expectF5Ml = false } = {}) {
  // In true without-odds mode, F5 market data will never be present in
  // odds_snapshots and the check would fail spuriously.
  if (!ODDS_SPORTS_CONFIG.MLB.active) {
    const skipReason = 'MLB odds inactive — F5 market check skipped';
    writePipelineHealth('mlb', 'f5_market_availability', 'ok', skipReason);
    return {
      ok: true,
      reason: skipReason,
      games_checked: 0,
      missing_f5_total_count: 0,
      missing_full_game_total_count: 0,
      expected_f5_ml_count: 0,
      missing_f5_ml_count: 0,
    };
  }

  const configuredMlbMarkets = Array.isArray(ODDS_SPORTS_CONFIG?.MLB?.markets)
    ? ODDS_SPORTS_CONFIG.MLB.markets.map((market) =>
        String(market || '').toLowerCase(),
      )
    : [];
  const enforceF5Totals = configuredMlbMarkets.some((market) =>
    [
      'totals_1st_5_innings',
      'totals_f5',
      'first_5_totals',
      'f5_totals',
    ].includes(market),
  );

  const db = getDatabase();
  const nowUtc = DateTime.utc();
  // Exclude games within 15 minutes of start — F5 markets are already closed
  const checkFromUtc = nowUtc.plus({ minutes: 15 });
  const endUtc = nowUtc.plus({ hours: MLB_F5_ALERT_WINDOW_HOURS });
  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, game_time_utc, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'mlb'
      AND game_time_utc >= ?
      AND game_time_utc <= ?
  `,
    )
    .all(checkFromUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    return {
      ok: true,
      reason: `No MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h`,
      games_checked: 0,
      missing_f5_total_count: 0,
      missing_full_game_total_count: 0,
      expected_f5_ml_count: 0,
      missing_f5_ml_count: 0,
    };
  }

  const missingF5Total = [];
  const missingFullGameTotal = [];
  const missingF5Ml = [];
  let expectedF5MlCount = 0;
  const rejectReasonDiagnostics = summarizeMlbRejectReasonFamilies(db);

  for (const game of upcomingGames) {
    const latestOdds = getLatestOddsSnapshot(db, game.game_id);
    const buildMlbMarketAvailability = getBuildMlbMarketAvailability();
    const availability = buildMlbMarketAvailability(
      latestOdds
        ? {
            ...latestOdds,
            game_id: game.game_id,
            game_time_utc: game.game_time_utc,
            home_team: game.home_team,
            away_team: game.away_team,
          }
        : {
            game_id: game.game_id,
            game_time_utc: game.game_time_utc,
            home_team: game.home_team,
            away_team: game.away_team,
          },
      { expectF5Ml },
    );

    if (enforceF5Totals && !availability.f5_line_ok) {
      missingF5Total.push(game.game_id);
    }
    if (!availability.full_game_total_ok) {
      missingFullGameTotal.push(game.game_id);
    }
    if (availability.expect_f5_ml) {
      expectedF5MlCount += 1;
      if (!availability.f5_ml_ok) {
        missingF5Ml.push(game.game_id);
      }
    }
  }

  const reasonParts = [];
  if (enforceF5Totals) {
    const f5Reason =
      missingF5Total.length === 0
        ? `F5 totals available for all ${upcomingGames.length} MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h`
        : `${missingF5Total.length}/${upcomingGames.length} MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h missing F5 totals`;
    reasonParts.push(f5Reason);
  } else {
    reasonParts.push('F5 totals not enforced (disabled in odds featured-market config)');
  }

  if (missingFullGameTotal.length > 0) {
    reasonParts.push(
      `${missingFullGameTotal.length}/${upcomingGames.length} MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h missing full-game totals`,
    );
  }
  if (expectedF5MlCount > 0) {
    reasonParts.push(
      `${missingF5Ml.length}/${expectedF5MlCount} missing F5 ML`,
    );
  }
  reasonParts.push(
    `reason families uncategorized=${rejectReasonDiagnostics.uncategorized_count}`,
  );

  const reason = reasonParts.join('; ');

  const hardFailF5 = enforceF5Totals && missingF5Total.length > 0;
  const hardFailFullGame =
    missingFullGameTotal.length > 0 &&
    missingFullGameTotal.length === upcomingGames.length;
  const warnFullGame =
    missingFullGameTotal.length > 0 && !hardFailFullGame;

  if (hardFailF5 || hardFailFullGame) {
    writePipelineHealth('mlb', 'f5_market_availability', 'failed', reason);
  } else if (warnFullGame) {
    writePipelineHealth('mlb', 'f5_market_availability', 'warning', reason);
  } else if (upcomingGames.length > 0) {
    writePipelineHealth('mlb', 'f5_market_availability', 'ok', reason);
  }

  return {
    ok: !(hardFailF5 || hardFailFullGame),
    reason,
    games_checked: upcomingGames.length,
    missing_f5_total_count: missingF5Total.length,
    missing_f5_total_games: missingF5Total,
    missing_full_game_total_count: missingFullGameTotal.length,
    missing_full_game_total_games: missingFullGameTotal,
    expected_f5_ml_count: expectedF5MlCount,
    missing_f5_ml_count: missingF5Ml.length,
    missing_f5_ml_games: missingF5Ml,
    reject_reason_diagnostics: rejectReasonDiagnostics,
  };
}

function parseMlbCardPayload(payloadData) {
  if (typeof payloadData !== 'string' || payloadData.length === 0) return null;
  try {
    return JSON.parse(payloadData);
  } catch (_error) {
    return null;
  }
}

function getMlbOfficialStatus(payload) {
  const d2 = payload && typeof payload.decision_v2 === 'object' ? payload.decision_v2 : null;
  const canonical = d2 && typeof d2.canonical_envelope_v2 === 'object'
    ? d2.canonical_envelope_v2
    : null;
  const fromCanonical = typeof canonical?.official_status === 'string'
    ? canonical.official_status.toUpperCase()
    : null;
  if (fromCanonical === 'PLAY' || fromCanonical === 'LEAN' || fromCanonical === 'PASS') {
    return fromCanonical;
  }
  const fromD2 = typeof d2?.official_status === 'string' ? d2.official_status.toUpperCase() : null;
  if (fromD2 === 'PLAY' || fromD2 === 'LEAN' || fromD2 === 'PASS') return fromD2;
  return null;
}

function hasMlbSelection(payload) {
  const d2 = payload && typeof payload.decision_v2 === 'object' ? payload.decision_v2 : null;
  const canonical = d2 && typeof d2.canonical_envelope_v2 === 'object'
    ? d2.canonical_envelope_v2
    : null;
  const side = String(
    canonical?.selection_side ||
      d2?.selection_side ||
      payload?.selection?.side ||
      payload?.prediction ||
      '',
  ).toUpperCase();
  return side !== '' && side !== 'NONE' && side !== 'NEUTRAL';
}

function hasMarketLineContext(payload, marketKey) {
  const oddsContext = payload && typeof payload.odds_context === 'object' ? payload.odds_context : null;
  const wager =
    payload &&
    typeof payload.market_context === 'object' &&
    payload.market_context &&
    typeof payload.market_context.wager === 'object'
      ? payload.market_context.wager
      : null;

  if (marketKey === 'full_game_total') {
    const line = Number(
      payload?.line ?? payload?.total_line ?? wager?.called_line ?? oddsContext?.total,
    );
    const price = Number(payload?.price ?? payload?.juice ?? wager?.called_price);
    return Number.isFinite(line) && Number.isFinite(price);
  }

  const mlHome = Number(payload?.ml_home ?? payload?.h2h_home ?? oddsContext?.h2h_home);
  const mlAway = Number(payload?.ml_away ?? payload?.h2h_away ?? oddsContext?.h2h_away);
  return Number.isFinite(mlHome) && Number.isFinite(mlAway);
}

function evaluateMlbGameLinePublishability({ row, payload, marketKey, latestOddsCapturedAt, nowUtc }) {
  const basis = String(payload?.basis || '').toUpperCase();
  const executionStatus = String(payload?.execution_status || '').toUpperCase();
  const officialStatus = getMlbOfficialStatus(payload);

  if (executionStatus === 'BLOCKED') {
    return { publishable: false, bucket: 'current_blocked' };
  }
  if (executionStatus === 'PROJECTION_ONLY') {
    return { publishable: false, bucket: 'current_projection_only' };
  }
  if (executionStatus !== 'EXECUTABLE') {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (basis !== 'ODDS_BACKED') {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (officialStatus !== 'PLAY' && officialStatus !== 'LEAN') {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (payload?.execution_gate?.drop_reason) {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (!hasMlbSelection(payload)) {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (!hasMarketLineContext(payload, marketKey)) {
    return { publishable: false, bucket: 'current_non_publishable' };
  }

  const snapshotAtRaw = payload?.snapshot_at || payload?.captured_at || payload?.created_at || row.created_at;
  const snapshotAt = snapshotAtRaw ? DateTime.fromISO(String(snapshotAtRaw), { zone: 'utc' }) : null;
  if (!snapshotAt || !snapshotAt.isValid || !latestOddsCapturedAt) {
    return { publishable: false, bucket: 'stale_or_unverifiable_snapshot' };
  }

  const snapshotAgeMinutes = nowUtc.diff(snapshotAt, 'minutes').minutes;
  if (!Number.isFinite(snapshotAgeMinutes) || snapshotAgeMinutes < 0) {
    return { publishable: false, bucket: 'stale_or_unverifiable_snapshot' };
  }
  if (snapshotAgeMinutes > MLB_GAME_LINE_FALLBACK_MAX_AGE_MINUTES) {
    return { publishable: false, bucket: 'stale_snapshot' };
  }

  const latestOddsAt = DateTime.fromISO(String(latestOddsCapturedAt), { zone: 'utc' });
  if (!latestOddsAt.isValid) {
    return { publishable: false, bucket: 'stale_or_unverifiable_snapshot' };
  }

  const oddsDeltaMinutes = latestOddsAt.diff(snapshotAt, 'minutes').minutes;
  if (oddsDeltaMinutes > MLB_GAME_LINE_ODDS_TOLERANCE_MINUTES) {
    return { publishable: false, bucket: 'stale_snapshot' };
  }

  return { publishable: true, bucket: null };
}

function checkMlbGameLineCoverage({ lookaheadHours = MLB_F5_ALERT_WINDOW_HOURS } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });
  const checkFromUtc = nowUtc.plus({ minutes: 15 });

  const upcomingGames = db
    .prepare(
      `SELECT game_id, game_time_utc, home_team, away_team
       FROM games
       WHERE LOWER(sport) = 'mlb'
         AND game_time_utc >= ?
         AND game_time_utc <= ?`,
    )
    .all(checkFromUtc.toISO(), endUtc.toISO());

  const diagnostics = {
    full_game_total: {
      games_with_odds: 0,
      current_publishable_count: 0,
      fallback_publishable_count: 0,
      missing_count: 0,
    },
    full_game_ml: {
      games_with_odds: 0,
      current_publishable_count: 0,
      fallback_publishable_count: 0,
      missing_count: 0,
    },
  };

  const reasonBuckets = MLB_GAME_LINE_REASON_BUCKETS.reduce((acc, bucket) => {
    acc[bucket] = { count: 0, sample_game_ids: [] };
    return acc;
  }, {});

  const registerReason = (bucket, gameId) => {
    const target = reasonBuckets[bucket];
    if (!target) return;
    target.count += 1;
    if (
      target.sample_game_ids.length < MLB_GAME_LINE_SAMPLE_LIMIT &&
      !target.sample_game_ids.includes(gameId)
    ) {
      target.sample_game_ids.push(gameId);
    }
  };

  const latestRunId = db
    .prepare(
      `SELECT run_id
       FROM card_payloads
       WHERE sport = 'MLB'
         AND run_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get()?.run_id;

  for (const game of upcomingGames) {
    const latestOdds = getLatestOddsSnapshot(db, game.game_id);
    const latestOddsCapturedAt = latestOdds?.captured_at || null;
    const hasTotalOdds = Number.isFinite(Number(latestOdds?.total));
    const hasMlOdds =
      Number.isFinite(Number(latestOdds?.h2h_home)) &&
      Number.isFinite(Number(latestOdds?.h2h_away));

    for (const market of MLB_GAME_LINE_MARKETS) {
      const marketOddsAvailable =
        market.key === 'full_game_total' ? hasTotalOdds : hasMlOdds;
      if (!marketOddsAvailable) continue;

      diagnostics[market.key].games_with_odds += 1;

      const rows = db
        .prepare(
          `SELECT id, game_id, card_type, payload_data, created_at, run_id
           FROM card_payloads
           WHERE game_id = ?
             AND card_type = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 25`,
        )
        .all(game.game_id, market.cardType);

      if (rows.length === 0) {
        diagnostics[market.key].missing_count += 1;
        registerReason('no_card_row', game.game_id);
        continue;
      }

      const currentRow = latestRunId
        ? rows.find((row) => row.run_id && row.run_id === latestRunId) || null
        : rows[0] || null;

      if (currentRow) {
        const payload = parseMlbCardPayload(currentRow.payload_data);
        if (!payload) {
          diagnostics[market.key].missing_count += 1;
          registerReason('current_non_publishable', game.game_id);
          continue;
        }
        const currentEval = evaluateMlbGameLinePublishability({
          row: currentRow,
          payload,
          marketKey: market.key,
          latestOddsCapturedAt,
          nowUtc,
        });
        if (currentEval.publishable) {
          diagnostics[market.key].current_publishable_count += 1;
          continue;
        }

        if (currentEval.bucket) {
          registerReason(currentEval.bucket, game.game_id);
        }

        const fallbackCandidate = rows.find((row) => {
          if (latestRunId && row.run_id && row.run_id === latestRunId) return false;
          const fallbackPayload = parseMlbCardPayload(row.payload_data);
          if (!fallbackPayload) return false;
          return evaluateMlbGameLinePublishability({
            row,
            payload: fallbackPayload,
            marketKey: market.key,
            latestOddsCapturedAt,
            nowUtc,
          }).publishable;
        });

        if (fallbackCandidate) {
          diagnostics[market.key].fallback_publishable_count += 1;
        } else {
          diagnostics[market.key].missing_count += 1;
        }
      }
    }
  }

  const rejectReasonDiagnostics = summarizeMlbRejectReasonFamilies(db);
  const missingTotal =
    diagnostics.full_game_total.missing_count + diagnostics.full_game_ml.missing_count;
  const status = missingTotal > 0 ? 'warning' : 'ok';
  const reason =
    missingTotal > 0
      ? `MLB game-line coverage missing=${missingTotal}; uncategorized reject families=${rejectReasonDiagnostics.uncategorized_count}`
      : `MLB game-line coverage complete; uncategorized reject families=${rejectReasonDiagnostics.uncategorized_count}`;

  writePipelineHealth('mlb', 'game_line_coverage', status, reason);
  return {
    ok: missingTotal === 0,
    reason,
    markets: diagnostics,
    reason_buckets: reasonBuckets,
    reject_reason_diagnostics: rejectReasonDiagnostics,
  };
}

/**
 * Check 5: Settlement backlog
 * Find games with status='final' but no game_results entry
 */
function checkSettlementBacklog() {
  const db = getDatabase();

  const backlog = db
    .prepare(
      `
    SELECT COUNT(*) as cnt
    FROM games g
    WHERE LOWER(g.status) IN ('final', 'ft', 'completed')
      AND NOT EXISTS (
        SELECT 1 FROM game_results gr
        WHERE gr.game_id = g.game_id
          AND gr.status = 'final'
      )
  `,
    )
    .get().cnt;

  if (backlog === 0) {
    const reason = 'No settlement backlog';
    writePipelineHealth('settlement', 'backlog', 'ok', reason);
    return { ok: true, reason };
  }

  const reason = `${backlog} final games pending settlement`;
  writePipelineHealth('settlement', 'backlog', 'warning', reason);
  return { ok: false, reason };
}

function checkMlbSeedFreshness(maxAgeMinutes = SEED_FRESHNESS_MAX_AGE_MINUTES) {
  const mlbWithoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true';

  if (!mlbWithoutOddsMode) {
    const reason = 'MLB live-odds mode active - seed freshness check skipped';
    writePipelineHealth('mlb', 'seed_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const horizonUtc = nowUtc.plus({ hours: 6 });
  const upcomingCount = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM games
       WHERE LOWER(sport) = 'mlb'
         AND game_time_utc >= ?
         AND game_time_utc <= ?`,
    )
    .get(nowUtc.toISO(), horizonUtc.toISO()).cnt;

  if (upcomingCount === 0) {
    const reason = 'No MLB games within T-6h - seed freshness check skipped';
    writePipelineHealth('mlb', 'seed_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const thresholdDesc =
    maxAgeMinutes >= 60
      ? `${Math.round(maxAgeMinutes / 60)}h`
      : `${maxAgeMinutes}m`;
  const recentlyRan = wasJobRecentlySuccessful(
    'pull_espn_games_direct',
    maxAgeMinutes,
  );

  if (recentlyRan) {
    const reason = `pull_espn_games_direct ran successfully within last ${thresholdDesc} (${upcomingCount} upcoming MLB games)`;
    writePipelineHealth('mlb', 'seed_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const reason = `pull_espn_games_direct has NOT run successfully in last ${thresholdDesc} — ${upcomingCount} upcoming MLB games at risk`;
  writePipelineHealth('mlb', 'seed_freshness', 'failed', reason);
  return { ok: false, reason };
}

/**
 * Check: Per-sport model freshness
 * Verifies the named job ran successfully within the threshold, but only
 * reports when there are upcoming games for that sport (avoids false negatives
 * on off-days and off-season).
 */
function checkSportModelFreshness(sport, jobName, checkName, maxAgeMinutes, threshold = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const horizonUtc = nowUtc.plus({ hours: MODEL_FRESHNESS_ALERT_WINDOW_HOURS });

  const upcomingCount = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM games
       WHERE LOWER(sport) = LOWER(?)
         AND game_time_utc >= ?
         AND game_time_utc <= ?`,
    )
    .get(sport, nowUtc.toISO(), horizonUtc.toISO()).cnt;

  if (upcomingCount === 0) {
    return {
      ok: true,
      reason: `No ${sport.toUpperCase()} games within T-${MODEL_FRESHNESS_ALERT_WINDOW_HOURS}h - model check skipped`,
    };
  }

  const thresholdDesc =
    maxAgeMinutes >= 60
      ? `${Math.round(maxAgeMinutes / 60)}h`
      : `${maxAgeMinutes}m`;

  const expectedIntervalMinutes = Number(
    threshold.expectedIntervalMinutes || DEFAULT_MODEL_JOB_EXPECTED_INTERVAL_MINUTES,
  );
  const graceWindowMinutes = Number(
    threshold.graceWindowMinutes || Math.max(maxAgeMinutes - expectedIntervalMinutes, 0),
  );
  const thresholdContext = `threshold=expected:${expectedIntervalMinutes}m grace:${graceWindowMinutes}m window:${maxAgeMinutes}m`;

  const recentlyRan = wasJobRecentlySuccessful(jobName, maxAgeMinutes);

  if (recentlyRan) {
    const reason = `${jobName} ran successfully within last ${thresholdDesc} (${upcomingCount} upcoming games; ${thresholdContext})`;
    writePipelineHealth(sport.toLowerCase(), checkName, 'ok', reason);
    return { ok: true, reason };
  }

  const latestFailure = getLatestFailedJobRun(jobName, maxAgeMinutes);
  const failureSuffix = latestFailure
    ? `; latest failed run at ${latestFailure.started_at}: ${summarizeErrorMessage(latestFailure.error_message)}`
    : '';
  const reason = `${jobName} has NOT run successfully in last ${thresholdDesc} — ${upcomingCount} upcoming ${sport.toUpperCase()} games at risk (${thresholdContext})${failureSuffix}`;
  writePipelineHealth(sport.toLowerCase(), checkName, 'failed', reason);
  return { ok: false, reason };
}

/**
 * Check: Calibration kill switch state
 * Queries calibration_reports for any active kill switches.
 * Returns gracefully if the table does not exist (dev environment).
 */
function checkCalibrationKillSwitches() {
  try {
    const db = getDatabase();
    // Latest row per market (deterministic for tied timestamps).
    const rows = db
      .prepare(
        `SELECT market, kill_switch_active, ece, n_samples, computed_at
         FROM calibration_reports cr
         WHERE cr.id = (
           SELECT cr2.id
           FROM calibration_reports cr2
           WHERE cr2.market = cr.market
           ORDER BY cr2.computed_at DESC, cr2.id DESC
           LIMIT 1
         )
         ORDER BY market`,
      )
      .all();

    const calibrationRows = rows.map((row) => ({
      market: row.market,
      kill_switch_active: Number(row.kill_switch_active || 0),
      ece: row.ece,
      n_samples: row.n_samples,
      computed_at: row.computed_at,
    }));

    const activeSwitches = calibrationRows.filter((r) => r.kill_switch_active === 1);

    if (activeSwitches.length > 0) {
      const detail = activeSwitches
        .map((r) => `${r.market}(ECE=${r.ece},n=${r.n_samples})`)
        .join(', ');
      const reason = `CALIB_KILL_SWITCH_ACTIVE — ${activeSwitches.length} market(s) suppressed: ${detail}`;
      writePipelineHealth('calibration', 'kill_switch', 'warning', reason);
      return {
        ok: false,
        reason,
        calibrationKillSwitches: activeSwitches,
        calibrationRows,
      };
    }

    const detail = calibrationRows
      .map((r) => `${r.market}(ECE=${r.ece},n=${r.n_samples},kill=${r.kill_switch_active})`)
      .join(', ');
    const reason = calibrationRows.length === 0
      ? 'No calibration_reports rows found'
      : `${calibrationRows.length} market(s) calibration OK — no active kill switches: ${detail}`;
    if (calibrationRows.length > 0) {
      writePipelineHealth('calibration', 'kill_switch', 'ok', reason);
    }
    return { ok: true, reason, calibrationKillSwitches: [], calibrationRows };
  } catch (err) {
    const message = String(err?.message || '').toLowerCase();
    if (message.includes('no such table') && message.includes('calibration_reports')) {
      // Table may not exist in dev — skip gracefully
      return {
        ok: true,
        reason: 'calibration_reports table absent — skipped',
        calibrationKillSwitches: [],
        calibrationRows: [],
      };
    }

    const reason = `calibration_reports check failed: ${summarizeErrorMessage(err?.message)}`;
    writePipelineHealth('calibration', 'kill_switch', 'failed', reason);
    return {
      ok: false,
      reason,
      calibrationKillSwitches: [],
      calibrationRows: [],
    };
  }
}

function buildVisibilityIntegrityAlertMarker({ count, sampleIds, lookbackHours }) {
  const renderedIds = sampleIds.length > 0 ? sampleIds.join(',') : 'none';
  return `VISIBILITY_INTEGRITY_ALERT count=${count} lookback_hours=${lookbackHours} sample_ids=${renderedIds}`;
}

function checkVisibilityIntegrity({
  lookbackHours = VISIBILITY_INTEGRITY_LOOKBACK_HOURS,
  sampleLimit = VISIBILITY_INTEGRITY_SAMPLE_LIMIT,
} = {}) {
  const db = getDatabase();
  const now = new Date();
  const dateRange = {
    start: new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString(),
    end: now.toISOString(),
  };
  const diagnostics = collectVisibilityIntegrityDiagnostics(db, {
    dateRange,
    sampleLimit,
  });
  const missingEnrollment = diagnostics?.displayLogNotEnrolled || {
    bucket: 'DISPLAY_LOG_NOT_ENROLLED',
    reason:
      'Missing card_display_log enrollment keeps the row out of surfaced results; diagnostics do not attempt repair writes.',
    count: Number(diagnostics?.counts?.DISPLAY_LOG_NOT_ENROLLED || 0),
    samples: diagnostics?.samples?.DISPLAY_LOG_NOT_ENROLLED || [],
  };
  const missingEnrollmentCount = Number(missingEnrollment.count || 0);
  const sampleIds = (missingEnrollment.samples || []).map(
    (sample) => sample.cardId,
  );

  if (missingEnrollmentCount > 0) {
    const marker = buildVisibilityIntegrityAlertMarker({
      count: missingEnrollmentCount,
      sampleIds,
      lookbackHours,
    });
    const reason =
      `${missingEnrollmentCount} display-eligible row(s) created in the last ` +
      `${lookbackHours}h are missing card_display_log enrollment; sampleIds=` +
      `${sampleIds.length > 0 ? sampleIds.join(', ') : 'none'}`;
    console.warn(`[check_pipeline_health] ${marker}`);
    writePipelineHealth('cards', 'visibility_integrity', 'failed', reason);
    return {
      ok: false,
      reason,
      missingEnrollment,
      missingEnrollmentCount,
      sampleIds,
      diagnostics,
      alertMarker: marker,
    };
  }

  const reason =
    `Visibility integrity OK — no display-eligible rows created in the last ` +
    `${lookbackHours}h are missing card_display_log enrollment`;
  writePipelineHealth('cards', 'visibility_integrity', 'ok', reason);
  return {
    ok: true,
    reason,
    missingEnrollment,
    missingEnrollmentCount: 0,
    sampleIds: [],
    diagnostics,
    alertMarker: null,
  };
}

/**
 * Returns true only when the current row causes the check to cross the failed
 * streak threshold. Continued failed runs remain persisted in pipeline_health
 * but do not re-alert until the streak resets and crosses the threshold again.
 */
function shouldSendAlert(phase, checkName, _consecutiveRequired, cooldownMinutes) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const consecutiveRequired = Math.max(Number(_consecutiveRequired) || 1, 1);
  const requiredStreakMinutes = Math.max(consecutiveRequired - 1, 0) * PIPELINE_HEALTH_INTERVAL_MINUTES;

  try {
    const activeRow = db
      .prepare(
        `SELECT status, first_seen_at, last_seen_at
         FROM pipeline_health
         WHERE phase = ?
           AND check_name = ?
           AND resolved_at IS NULL
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(phase, checkName);

    if (activeRow) {
      if (activeRow.status !== 'failed') return false;

      const firstSeenAt = DateTime.fromISO(activeRow.first_seen_at || '', { zone: 'utc' });
      const lastSeenAt = DateTime.fromISO(activeRow.last_seen_at || '', { zone: 'utc' });
      if (!firstSeenAt.isValid || !lastSeenAt.isValid) return false;

      const streakAgeMinutes = nowUtc.diff(firstSeenAt, 'minutes').minutes;
      const sinceLastSeenMinutes = nowUtc.diff(lastSeenAt, 'minutes').minutes;
      const crossingWindowMinutes = PIPELINE_HEALTH_INTERVAL_MINUTES * 1.5;

      if (!Number.isFinite(streakAgeMinutes) || !Number.isFinite(sinceLastSeenMinutes)) return false;
      if (streakAgeMinutes < requiredStreakMinutes) return false;
      if (streakAgeMinutes > cooldownMinutes) return false;
      if (sinceLastSeenMinutes > PIPELINE_HEALTH_INTERVAL_MINUTES * 2) return false;

      return streakAgeMinutes <= (requiredStreakMinutes + crossingWindowMinutes);
    }
  } catch (_error) {
    // Pre-migration fallback handled below.
  }

  const rows = db
    .prepare(
      `SELECT status, created_at
       FROM pipeline_health
       WHERE phase = ? AND check_name = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(phase, checkName, consecutiveRequired + 1);

  if (rows.length < consecutiveRequired) return false;
  const currentStreak = rows.slice(0, consecutiveRequired);
  if (currentStreak.some((r) => r.status !== 'failed')) return false;

  const priorRow = rows[consecutiveRequired];
  if (priorRow?.status === 'failed') return false;

  const oldestRow = currentStreak[consecutiveRequired - 1];
  const oldestAt = DateTime.fromISO(oldestRow.created_at, { zone: 'utc' });
  const ageMinutes = nowUtc.diff(oldestAt, 'minutes').minutes;
  return ageMinutes <= cooldownMinutes;
}

/**
 * Formats a Discord alert message for a list of failed pipeline checks.
 */
function buildHealthAlertMessage(failedChecks) {
  const lines = ['🚨 **Pipeline Health Alert**', '', 'The following checks are failing:'];
  for (const { phase, checkName, reason } of failedChecks) {
    lines.push(`• \`${phase} / ${checkName}\` — ${reason}`);
  }
  return lines.join('\n');
}

function writeOverallDegradedState(results) {
  const failingChecks = Object.entries(results)
    .filter(([, result]) => result && result.ok === false)
    .map(([checkName]) => CHECK_REGISTRY[checkName]?.checkId || checkName);

  if (failingChecks.length === 0) {
    writePipelineHealth('watchdog', 'degraded_state', 'ok', 'Pipeline healthy: all checks passed');
    return;
  }

  const summary = failingChecks.slice(0, 6).join(', ');
  const suffix = failingChecks.length > 6 ? ` (+${failingChecks.length - 6} more)` : '';
  writePipelineHealth(
    'watchdog',
    'degraded_state',
    'failed',
    `Pipeline degraded: ${failingChecks.length} failing check(s): ${summary}${suffix}`,
  );
}

/**
 * Self-check: alert when check_pipeline_health hasn't run successfully in > 2h.
 * Writes a pipeline_health row with phase='watchdog', check_name='heartbeat'.
 */
async function checkWatchdogHeartbeat() {
  const db = getDatabase();
  const prev = db
    .prepare(
      `SELECT started_at FROM job_runs
       WHERE job_name = 'check_pipeline_health' AND status = 'success'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get();

  if (!prev) {
    return {
      ok: true,
      reason: 'No prior successful watchdog run; baseline unavailable',
      healthClass: WATCHDOG_INFO,
    };
  }

  const gapMs = Date.now() - new Date(prev.started_at).getTime();
  const gapH = (gapMs / 3600000).toFixed(1);
  const isGap = gapMs > 2 * 60 * 60 * 1000;
  const reason = isGap
    ? `Last watchdog run was ${gapH}h ago`
    : `Heartbeat OK (${gapH}h since last run)`;

  writePipelineHealth(
    'watchdog',
    'heartbeat',
    isGap ? 'warning' : 'ok',
    reason,
  );

  if (isGap && process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG !== 'false') {
    const delivery = await deliverPipelineHealthAlert(
      [{
        phase: 'watchdog',
        checkName: 'heartbeat',
        reason: `check_pipeline_health gap: ${gapH}h (threshold: 2h)`,
      }],
      'heartbeat',
    );
    if (delivery.delivered) {
      console.warn(`[check_pipeline_health] Watchdog heartbeat alert sent — ${gapH}h gap`);
    }
  }

  return {
    ok: !isGap,
    reason,
    healthClass: isGap ? WATCHDOG_CRITICAL_BREACH : null,
  };
}

function collectJobHealthIssues(results, { defaultHealthClass, nonFatalHealthClasses = [] }) {
  const nonFatalSet = new Set(nonFatalHealthClasses);
  const healthIssues = [];

  for (const [checkName, result] of Object.entries(results || {})) {
    if (!result || result.ok !== false) continue;
    const healthClass = result.healthClass || defaultHealthClass;
    healthIssues.push({
      checkName,
      healthClass,
      fatal: !nonFatalSet.has(healthClass),
      reason: result.reason || `${checkName} failed`,
    });
  }

  return healthIssues;
}

/**
 * Main health check runner
 */
async function checkPipelineHealth({
  jobKey,
  dryRun,
  skipHeartbeat = false,
  checksOverride = null,
}) {

  if (dryRun) {
    console.log(`[check_pipeline_health] DRY_RUN: ${jobKey}`);
    return;
  }

  const runId = uuidV4();
  insertJobRun('check_pipeline_health', runId, jobKey);

  try {
    console.log(`[check_pipeline_health] Running health checks...`);

    const defaultChecks = {
      schedule_freshness: checkScheduleFreshness,
      odds_freshness: checkOddsFreshness,
      cards_freshness: checkCardsFreshness,
      card_output_integrity: checkCardOutputIntegrity,
      visibility_integrity: () => checkVisibilityIntegrity(),
      mlb_f5_market_availability: checkMlbF5MarketAvailability,
      mlb_game_line_coverage: checkMlbGameLineCoverage,
      mlb_scheduled_game_card_coverage: checkMlbScheduledGameCardCoverage,
      mlb_seed_freshness: () => checkMlbSeedFreshness(),
      settlement_backlog: checkSettlementBacklog,
      // Per-sport model freshness (only fires when upcoming games exist for that sport)
      // Uses 4x moneyline hardMax from contract per operational policy (stricter health check)
      nhl_model_freshness: () =>
        checkSportModelFreshness('nhl', 'run_nhl_model', 'model_freshness', getModelFreshnessMaxAgeMinutes(), {
          expectedIntervalMinutes: 120,
          graceWindowMinutes: Math.max(getModelFreshnessMaxAgeMinutes() - 120, 0),
        }),
      nhl_market_call_diagnostics: checkNhlMarketCallDiagnostics,
      nhl_moneyline_coverage: checkNhlMoneylineCoverage,
      nhl_scheduled_game_card_coverage: checkNhlScheduledGameCardCoverage,
      nhl_false_listing_candidates: checkNhlFalseListingCandidates,
      nhl_sog_sync_freshness: checkNhlSogSyncFreshness,
      nhl_sog_pull_freshness: checkNhlSogPullFreshness,
      nhl_shots_model_freshness: () =>
        checkSportModelFreshness('nhl', 'run-nhl-player-shots-model', 'shots_model_freshness', getModelFreshnessMaxAgeMinutes(), {
          expectedIntervalMinutes: 120,
          graceWindowMinutes: Math.max(getModelFreshnessMaxAgeMinutes() - 120, 0),
        }),
      nhl_blk_rates_nst_freshness: checkNhlBlkRatesFreshness,
      nhl_blk_rates_moneypuck_freshness: checkNhlMoneyPuckBlkRatesFreshness,
      nhl_blk_source_integrity: checkNhlBlkSourceIntegrity,
      nba_model_freshness: () =>
        checkSportModelFreshness('nba', 'run_nba_model', 'model_freshness', getModelFreshnessMaxAgeMinutes(), {
          expectedIntervalMinutes: 120,
          graceWindowMinutes: Math.max(getModelFreshnessMaxAgeMinutes() - 120, 0),
        }),
      nba_market_call_diagnostics: checkNbaMarketCallDiagnostics,
      nba_moneyline_coverage: checkNbaMoneylineCoverage,
      nba_scheduled_game_card_coverage: checkNbaScheduledGameCardCoverage,
      mlb_model_freshness: () =>
        checkSportModelFreshness('mlb', 'run_mlb_model', 'model_freshness', getModelFreshnessMaxAgeMinutes(), {
          expectedIntervalMinutes: 120,
          graceWindowMinutes: Math.max(getModelFreshnessMaxAgeMinutes() - 120, 0),
        }),
      calibration_kill_switches: checkCalibrationKillSwitches,
    };
    const checks = checksOverride || defaultChecks;

    const results = {};
    let allOk = true;

    if (!skipHeartbeat) {
      const heartbeatResult = await checkWatchdogHeartbeat();
      results.watchdog_heartbeat = heartbeatResult;

      if (heartbeatResult.ok) {
        console.log(`  ✓ watchdog_heartbeat: ${heartbeatResult.reason}`);
      } else {
        console.warn(`  ⚠️  watchdog_heartbeat: ${heartbeatResult.reason}`);
        allOk = false;
      }
    }

    for (const [checkName, checkFn] of Object.entries(checks)) {
      const result = await checkFn();
      results[checkName] = result;

      if (result.ok) {
        console.log(`  ✓ ${checkName}: ${result.reason}`);
      } else {
        console.warn(`  ⚠️  ${checkName}: ${result.reason}`);
        allOk = false;
      }
    }

    // Persist a run-level degraded/healthy state so the latest system posture is
    // visible even after worker restarts.
    writeOverallDegradedState(results);

    // --- Discord watchdog alert ---
    if (process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG !== 'false' && !allOk) {
      const alertCandidates = [];
      for (const [key, result] of Object.entries(results)) {
        if (result.ok) continue;
        if ((result.healthClass || WATCHDOG_CRITICAL_BREACH) === WATCHDOG_INFO) continue;
        const mapping = CHECK_REGISTRY[key];
        if (!mapping) continue;
        if (shouldSendAlert(mapping.phase, mapping.checkName, PIPELINE_HEALTH_ALERT_CONSECUTIVE, PIPELINE_HEALTH_COOLDOWN_MINUTES)) {
          alertCandidates.push({
            phase: mapping.phase,
            checkName: mapping.checkName,
            reason: `[${mapping.checkId}] ${result.reason}`,
          });
        }
      }

      if (alertCandidates.length > 0) {
        const delivery = await deliverPipelineHealthAlert(alertCandidates, 'failed_checks');
        if (delivery.delivered) {
          console.log(`[check_pipeline_health] Sent Discord alert for ${alertCandidates.length} failed check(s)`);
        }
      }
    }
    // --- end Discord watchdog alert ---

    const healthIssues = collectJobHealthIssues(results, {
      defaultHealthClass: WATCHDOG_CRITICAL_BREACH,
      nonFatalHealthClasses: [WATCHDOG_INFO],
    });
    const criticalHealthIssues = healthIssues.filter((issue) => issue.fatal);
    const summary = criticalHealthIssues.length > 0
      ? `Critical pipeline health failures: ${criticalHealthIssues.map((issue) => `[${issue.healthClass}] ${issue.checkName}: ${issue.reason}`).join('; ')}`
      : allOk
        ? 'All pipeline health checks passed'
        : 'Pipeline health warnings detected (non-fatal)';

    if (criticalHealthIssues.length > 0) {
      markJobRunFailure(runId, summary);
    } else {
      markJobRunSuccess(runId);
    }
    console.log(`[check_pipeline_health] ${summary}`);

    const calibrationKillSwitches = (results.calibration_kill_switches?.calibrationKillSwitches) || [];
    const calibrationRows = (results.calibration_kill_switches?.calibrationRows) || [];
    if (calibrationRows.length > 0) {
      console.log(
        `[check_pipeline_health] Calibration rows: ${calibrationRows.map((r) => `${r.market}(ECE=${r.ece},n=${r.n_samples},kill=${r.kill_switch_active})`).join(', ')}`,
      );
    }
    if (calibrationKillSwitches.length > 0) {
      console.warn(`[check_pipeline_health] CALIB_KILL_SWITCH_ACTIVE: ${calibrationKillSwitches.map((r) => r.market).join(', ')}`);
    }
    return {
      ok: criticalHealthIssues.length === 0,
      allOk,
      summary,
      exitCode: criticalHealthIssues.length > 0 ? 1 : 0,
      jobStatus: criticalHealthIssues.length > 0 ? 'failed' : 'success',
      healthIssues,
      criticalHealthIssues,
      calibrationKillSwitches,
      calibrationRows,
      visibilityIntegrity: results.visibility_integrity || null,
    };
  } catch (error) {
    console.error(`[check_pipeline_health] Error:`, error);
    markJobRunFailure(runId, error.message);
    throw error;
  }
}

if (require.main === module) {
  createJob('check_pipeline_health', ({ dryRun }) =>
    checkPipelineHealth({
      jobKey: `check_pipeline_health-${new Date().toISOString().slice(0, 16)}`,
      dryRun,
    })
  );
}

function checkNhlSogSyncFreshness() {
  if (!isFeatureEnabled('nhl', 'sog-sync')) {
    const reason = 'sync_nhl_sog_player_ids feature disabled';
    writePipelineHealth('nhl', 'sog_sync_freshness', 'ok', reason);
    return { ok: true, reason };
  }
  return checkSportModelFreshness('nhl', 'sync_nhl_sog_player_ids', 'sog_sync_freshness', 1440, {
    expectedIntervalMinutes: 1440,
    graceWindowMinutes: 0,
  });
}

function checkNhlSogPullFreshness() {
  return checkSportModelFreshness('nhl', 'pull_nhl_player_shots', 'sog_pull_freshness', 1440, {
    expectedIntervalMinutes: 1440,
    graceWindowMinutes: 0,
  });
}

function checkNhlBlkSourceIntegrity() {
  const reason =
    'BLK CSV source-integrity checks decommissioned: external NST/MoneyPuck CSV reliance removed';
  writePipelineHealth('nhl', 'blk_source_integrity', 'ok', reason);
  return { ok: true, reason };
}

function checkNhlBlkRatesFreshness() {
  const reason =
    'BLK NST freshness check decommissioned: no external CSV pulls are expected';
  writePipelineHealth('nhl', 'blk_rates_nst_freshness', 'ok', reason);
  return { ok: true, reason };
}

function checkNhlMoneyPuckBlkRatesFreshness() {
  const reason =
    'BLK MoneyPuck freshness check decommissioned: no external CSV pulls are expected';
  writePipelineHealth('nhl', 'blk_rates_moneypuck_freshness', 'ok', reason);
  return { ok: true, reason };
}

module.exports = {
  writePipelineHealth,
  writeOverallDegradedState,
  checkPipelineHealth,
  checkNhlSogSyncFreshness,
  checkNhlSogPullFreshness,
  checkNhlBlkSourceIntegrity,
  checkNhlBlkRatesFreshness,
  checkNhlMoneyPuckBlkRatesFreshness,
  checkCardsFreshness,
  checkCardOutputIntegrity,
  checkMlbF5MarketAvailability,
  checkMlbGameLineCoverage,
  summarizeMlbRejectReasonFamilies,
  checkMlbSeedFreshness,
  checkOddsFreshness,
  checkCalibrationKillSwitches,
  buildVisibilityIntegrityAlertMarker,
  checkVisibilityIntegrity,
  checkWatchdogHeartbeat,
  shouldSendAlert,
  buildHealthAlertMessage,
  summarizeNhlRejectReasonFamilies,
  checkNhlMarketCallDiagnostics,
  checkNhlMoneylineCoverage,
  checkScheduledGameCardCoverage,
  checkMlbScheduledGameCardCoverage,
  checkNhlScheduledGameCardCoverage,
  checkNbaScheduledGameCardCoverage,
  checkNhlFalseListingCandidates,
  summarizeNbaRejectReasonFamilies,
  checkNbaMarketCallDiagnostics,
  checkNbaMoneylineCoverage,
  NBA_MARKET_CALL_CARD_TYPES,
  NBA_REJECT_REASON_FAMILIES,
};
