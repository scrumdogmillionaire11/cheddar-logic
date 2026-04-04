/**
 * Window-Based Scheduler — Tick loop with idempotency
 *
 * Architecture:
 * - Fixed-time windows: 09:00 ET, 12:00 ET, 18:00 ET
 * - T-minus windows: T-120, T-90, T-60, T-30 (pre-game updates)
 * - Hourly odds bucket: captures odds every hour
 *
 * Idempotency:
 * - Each job receives a deterministic job_key
 * - shouldRunJobKey() checks if already successful or running
 * - Tick loop reschedules on next pass
 *
 * Can be started locally:
 *   node src/schedulers/main.js
 *   DRY_RUN=true node src/schedulers/main.js
 *   TZ=America/New_York TICK_MS=10000 node src/schedulers/main.js
 *
 * Domain Split:
 * - Betting Engine: NHL/NBA/MLB/NFL (game-time windows)
 * - FPL-SAGE Engine: FPL (deadline-based) — see schedulers/fpl.js
 */

require('dotenv').config();
// Also load .env.local (Next.js convention for local overrides, not loaded by dotenv by default)
// __dirname = apps/worker/src/schedulers/ → ../../ = apps/worker/
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local'), override: false });

const { DateTime } = require('luxon');
const {
  getUpcomingGames,
  shouldRunJobKey,
  hasRunningJobRun,
  hasRunningJobName,
  wasJobRecentlySuccessful,
  getQuotaLedger,
  claimTminusPullSlot,
  purgeStaleTminusPullLog,
  purgeStalePropOddsUsageLog,
  purgeExpiredPropEventMappings,
  recoverStaleJobRuns,
} = require('@cheddar-logic/data');

// Import all jobs
const { pullOddsHourly } = require('../jobs/pull_odds_hourly');
const { pullEspnGamesDirect } = require('../jobs/pull_espn_games_direct');
const { refreshStaleOdds } = require('../jobs/refresh_stale_odds');
const { runNHLModel } = require('../jobs/run_nhl_model');
const { runNBAModel } = require('../jobs/run_nba_model');
const { runNFLModel } = require('../jobs/run_nfl_model');
const { runMLBModel } = require('../jobs/run_mlb_model');
const { settleMlbF5 } = require('../jobs/settle_mlb_f5');
const { settleProjections } = require('../jobs/settle_projections');
const { syncGameStatuses } = require('../jobs/sync_game_statuses');
const { settleGameResults } = require('../jobs/settle_game_results');
const { settlePendingCards } = require('../jobs/settle_pending_cards');
const { backfillCardResults } = require('../jobs/backfill_card_results');
const { checkPipelineHealth } = require('../jobs/check_pipeline_health');
const { checkOddsHealth } = require('../jobs/check_odds_health');
const {
  generateSettlementHealthReport: runSettlementHealthReport,
} = require('../jobs/report_settlement_health');
const {
  run: refreshTeamMetricsDaily,
} = require('../jobs/refresh_team_metrics_daily');
const { syncNhlPlayerAvailability } = require('../jobs/sync_nhl_player_availability');
const { syncNhlSogPlayerIds } = require('../jobs/sync_nhl_sog_player_ids');
const { pullNhlTeamStats } = require('../jobs/pull_nhl_team_stats');
const { postDiscordCards } = require('../jobs/post_discord_cards');
const { runPullPublicSplits } = require('../jobs/pull_public_splits');
const { computeFplDueJobs } = require('./fpl');
const { computePlayerPropsDueJobs } = require('./player-props');

// Timezone for fixed-time windows
const TZ = process.env.TZ || 'America/New_York';
const ODDS_GAP_ALERT_MINUTES = Number(process.env.ODDS_GAP_ALERT_MINUTES || 210);
const ODDS_GAP_ALERT_COOLDOWN_MS = Number(
  process.env.ODDS_GAP_ALERT_COOLDOWN_MS || 15 * 60 * 1000,
);
const REQUIRE_FRESH_ODDS_FOR_MODELS =
  process.env.REQUIRE_FRESH_ODDS_FOR_MODELS !== 'false';
// Without Odds Mode: use ESPN-direct ingestion; skip market odds + settlement.
// Set ENABLE_WITHOUT_ODDS_MODE=true. All model outputs are PROJECTION_ONLY.
const ENABLE_WITHOUT_ODDS_MODE = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true';
const MODEL_ODDS_MAX_AGE_MINUTES = Number(
  process.env.MODEL_ODDS_MAX_AGE_MINUTES || ODDS_GAP_ALERT_MINUTES,
);
const REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS =
  process.env.REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS !== 'false';
const TEAM_METRICS_MAX_AGE_MINUTES = Number(
  process.env.TEAM_METRICS_MAX_AGE_MINUTES || 20 * 60,
);
const ENABLE_NHL_PLAYER_AVAILABILITY_SYNC =
  process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC !== 'false';
const ENABLE_NHL_SOG_PLAYER_SYNC =
  process.env.ENABLE_NHL_SOG_PLAYER_SYNC === 'true';
const ODDS_FETCH_SLOT_MINUTES = Number(process.env.ODDS_FETCH_SLOT_MINUTES || 180);
// Conservative default: start the 3-hour baseline at 09:00 ET so it aligns with the first model window.
const ODDS_FETCH_START_HOUR = Number(process.env.ODDS_FETCH_START_HOUR ?? 9);
const ENABLE_ODDS_BACKSTOP = process.env.ENABLE_ODDS_BACKSTOP === 'true';
const SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL =
  process.env.SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL === 'true';
const SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL =
  process.env.SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL === 'true';
let lastOddsGapAlertAt = 0;

/**
 * Sport-to-job mapping
 * FPL is included here temporarily but should be refactored to deadline scheduling
 */
const SPORT_JOBS = {
  nhl: {
    jobName: 'run_nhl_model',
    execute: runNHLModel,
    env: 'ENABLE_NHL_MODEL',
  },
  nba: {
    jobName: 'run_nba_model',
    execute: runNBAModel,
    env: 'ENABLE_NBA_MODEL',
  },
  mlb: {
    jobName: 'run_mlb_model',
    execute: runMLBModel,
    env: 'ENABLE_MLB_MODEL',
  },
  nfl: {
    jobName: 'run_nfl_model',
    execute: runNFLModel,
    env: 'ENABLE_NFL_MODEL',
  },
};

/**
 * Get list of enabled sports from environment
 */
function enabledSports() {
  return Object.keys(SPORT_JOBS).filter((s) => {
    const job = SPORT_JOBS[s];
    const envVal = process.env[job.env];
    if (envVal === 'false') return false;
    if (envVal === 'true') return true;
    return job.defaultOn !== false; // explicit opt-in required when defaultOn=false
  });
}

/**
 * Get current time in Eastern Time (for fixed windows)
 */
function nowET() {
  return DateTime.now().setZone(TZ);
}

/**
 * Job key builders (deterministic identifiers for idempotency)
 */
function keyEspnGamesDirect(nowEt) {
  const minuteOfDay = nowEt.hour * 60 + nowEt.minute;
  const slot = Math.floor(minuteOfDay / ODDS_FETCH_SLOT_MINUTES);
  return `espn_direct|${nowEt.toISODate()}|s${String(slot).padStart(3, '0')}`;
}

function keyOddsHourly(nowEt) {
  // Slot size is configurable via ODDS_FETCH_SLOT_MINUTES (default 180).
  // Conservative default keeps the main baseline at 09:00/12:00/15:00/18:00/21:00 ET.
  const minuteOfDay = nowEt.hour * 60 + nowEt.minute;
  const slot = Math.floor(minuteOfDay / ODDS_FETCH_SLOT_MINUTES);
  return `odds|hourly|${nowEt.toISODate()}|s${String(slot).padStart(3, '0')}`;
}

function keyFixed(sport, nowEt, hhmm) {
  return `${sport}|fixed|${nowEt.toISODate()}|${hhmm.replace(':', '')}`;
}

function keyDiscordCardsSnapshot(nowEt, hhmm) {
  return `discord_cards|fixed|${nowEt.toISODate()}|${hhmm.replace(':', '')}`;
}

function keyTminus(sport, gameId, minutes) {
  return `${sport}|tminus|${gameId}|${minutes}`;
}

function keyNightlySweep(nowEt) {
  return `settle|nightly|${nowEt.toISODate()}`;
}


function keyNhlPlayerAvailabilitySync(nowEt) {
  return `sync_nhl_player_availability|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyNhlSogPlayerSync(nowEt) {
  const hhmm = `${String(nowEt.hour).padStart(2, '0')}${String(nowEt.minute).padStart(2, '0')}`;
  return `sync_nhl_sog_player_ids|${nowEt.toISODate()}|${hhmm}`;
}

function keyNhlTeamStats(nowEt) {
  return `pull_nhl_team_stats|${nowEt.toISODate()}`;
}

function keySettlementHealthReport(nowEt) {
  return `report_settlement_health|${nowEt.toISODate()}`;
}

function keyHourlySettlementSweep(nowEt) {
  return `settle|hourly|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyPublicSplits(nowEt) {
  return `pull_public_splits|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyHourlySettlementJob(nowEt, suffix) {
  return `${keyHourlySettlementSweep(nowEt)}|${suffix}`;
}

function keyNightlySettlementJob(nowEt, suffix) {
  return `${keyNightlySweep(nowEt)}|${suffix}`;
}

function isHourlySettlementDue(nowEt) {
  const boundaryMinutes = Number(
    process.env.SETTLEMENT_HOURLY_BOUNDARY_MINUTES || 5,
  );
  return nowEt.minute >= 0 && nowEt.minute < Math.max(boundaryMinutes, 1);
}

function isNightlySettlementOwningHourlyWindow(nowEt) {
  return nowEt.hour === 2 && isHourlySettlementDue(nowEt);
}

/**
 * Calculate next odds pull interval based on game start time
 * @param {DateTime} nowUtc - Current UTC time
 * @param {DateTime} startUtc - Game start UTC time
 * @returns {number|null} - Minutes until next pull (null if game already started/ended)
 */
function getOddsIntervalMinutes(nowUtc, startUtc) {
  const minsUntilStart = Math.round(startUtc.diff(nowUtc, 'minutes').minutes);

  if (minsUntilStart < -30) return null; // Don't fetch for games >30m past start
  if (minsUntilStart <= 0) return 1; // Live mode: 1-2 min cadence
  if (minsUntilStart <= 30) return 1;
  if (minsUntilStart <= 120) return 2;
  if (minsUntilStart <= 360) return 5;
  if (minsUntilStart <= 1440) return 15;
  if (minsUntilStart <= 3600) return 30;
  return null; // Too far out, skip
}

/**
 * Check if schedule refresh is due based on time window
 * @param {DateTime} nowEt - Current ET time
 * @returns {object|null} - {type, reason} or null
 */
function getScheduleRefreshDue(nowEt) {
  const hour = nowEt.hour;
  const min = nowEt.minute;

  // 04:00 ET — full refresh (covers overnight changes)
  if (hour === 4 && min < 10) {
    return { type: 'full', reason: '04:00 ET daily full refresh' };
  }

  // 11:00 ET — same-day sanity check
  if (hour === 11 && min < 10) {
    return { type: 'sameday', reason: '11:00 ET same-day sanity refresh' };
  }

  // Every 2–4h for next 48h (every 180 min)
  const minsSinceMidnight = nowEt.diff(nowEt.startOf('day'), 'minutes').minutes;
  if (minsSinceMidnight % 180 < 10) {
    return { type: 'targeted', reason: '2–4h rolling window for next 48h' };
  }

  return null;
}

/**
 * Determine if a game needs odds refresh based on time-to-start
 * @param {DateTime} nowUtc - Current time
 * @param {object} game - Game object with game_time_utc
 * @returns {boolean} - Should refresh odds for this game
 */
function shouldRefreshOddsForGame(nowUtc, game) {
  const startUtc = DateTime.fromISO(game.game_time_utc, { zone: 'utc' });
  const interval = getOddsIntervalMinutes(nowUtc, startUtc);
  if (!interval) return false;

  // For now, check if within refresh window
  const minsUntilStart = Math.round(startUtc.diff(nowUtc, 'minutes').minutes);
  return minsUntilStart > -30; // Pull if game hasn't ended yet
}

/**
 * Watchdog: check pipeline health every 5 minutes
 * @param {DateTime} nowUtc - Current time
 * @returns {array} - Health check jobs
 */
function getPipelineHealthJobs(nowUtc) {
  const jobs = [];

  // 5-minute cadence (minute % 5 === 0)
  if (nowUtc.minute % 5 !== 0) return jobs;

  jobs.push({
    jobName: 'check_pipeline_health',
    jobKey: `health|watchdog|${nowUtc.toISO().slice(0, 16)}`, // Per 1-min window
    execute: checkPipelineHealth,
    args: {
      jobKey: `health|watchdog|${nowUtc.toISO().slice(0, 16)}`,
      dryRun: false,
    },
    reason: `pipeline health watchdog (5-min cadence)`,
  });

  return jobs;
}

/**
 * Watchdog: check odds freshness every 30 minutes
 * @param {DateTime} nowUtc - Current UTC time
 * @returns {array} - Health check jobs
 */
function getOddsHealthJobs(nowUtc) {
  const jobs = [];

  // 30-min cadence: slot = floor((hour*60 + minute) / 30)
  const minuteOfDay = nowUtc.hour * 60 + nowUtc.minute;
  if (minuteOfDay % 30 !== 0) return jobs;

  const slot = Math.floor(minuteOfDay / 30);
  const jobKey = `health|odds|${nowUtc.toISODate()}|s${String(slot).padStart(3, '0')}`;

  jobs.push({
    jobName: 'check_odds_health',
    jobKey,
    execute: checkOddsHealth,
    args: { jobKey, dryRun: false },
    reason: 'odds freshness watchdog (30-min cadence)',
  });

  return jobs;
}

/**
 * Health check: detect stale odds pipeline based on last successful pull job
 */
function checkOddsFreshnessHealth(nowUtc) {
  if (ENABLE_WITHOUT_ODDS_MODE) return; // ESPN-direct mode — odds freshness irrelevant
  if (process.env.ENABLE_ODDS_PULL === 'false') return;

  const recentlySuccessful = wasJobRecentlySuccessful(
    'pull_odds_hourly',
    ODDS_GAP_ALERT_MINUTES,
  );
  if (recentlySuccessful) {
    lastOddsGapAlertAt = 0;
    return;
  }

  const nowMs = nowUtc.toMillis();
  if (nowMs - lastOddsGapAlertAt < ODDS_GAP_ALERT_COOLDOWN_MS) {
    return;
  }

  lastOddsGapAlertAt = nowMs;
  console.warn(
    `[SCHEDULER][HEALTH] No successful pull_odds_hourly run in the last ${ODDS_GAP_ALERT_MINUTES} minutes. ` +
      'Odds pipeline may be stale.',
  );
}

function isModelJob(jobName) {
  return (
    typeof jobName === 'string' &&
    jobName.startsWith('run_') &&
    jobName.endsWith('_model')
  );
}

/**
 * Gate: are model inputs fresh enough to run?
 * In Without Odds Mode: checks pull_espn_games_direct recency.
 * In normal mode: checks pull_odds_hourly recency.
 */
function hasFreshInputsForModels() {
  if (!REQUIRE_FRESH_ODDS_FOR_MODELS) return true;
  if (ENABLE_WITHOUT_ODDS_MODE) {
    return wasJobRecentlySuccessful(
      'pull_espn_games_direct',
      MODEL_ODDS_MAX_AGE_MINUTES,
    );
  }
  if (process.env.ENABLE_ODDS_PULL === 'false') return true;
  return wasJobRecentlySuccessful(
    'pull_odds_hourly',
    MODEL_ODDS_MAX_AGE_MINUTES,
  );
}

/** @deprecated Use hasFreshInputsForModels. Kept for call-site compatibility. */
function hasFreshOddsForModels() {
  return hasFreshInputsForModels();
}

function isProjectionModelSport(sport) {
  return ['nba', 'nhl'].includes(String(sport || '').toLowerCase());
}

let _lastQuotaTier = null;

/**
 * Token quota tier — governs odds fetch frequency and feature gating.
 *
 * | Tier     | Condition              | T-minus pulls | Backstop pulls |
 * |----------|------------------------|---------------|----------------|
 * | FULL     | >50% remaining         | ✅            | ✅             |
 * | MEDIUM   | 25–50% remaining       | ❌            | ❌             |
 * | LOW      | 10–25% remaining       | ❌            | ❌             |
 * | CRITICAL | <10% remaining         | ❌            | ❌             |
 *
 * Also forces MEDIUM if the burn rate projects overage by end of month.
 *
 * @returns {'FULL'|'MEDIUM'|'LOW'|'CRITICAL'}
 */
function getCurrentQuotaTier() {
  const period = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  let ledger;
  try {
    ledger = getQuotaLedger('odds_api', period);
  } catch (_e) {
    return 'FULL'; // DB not yet migrated — default to unrestricted
  }

  const monthlyLimit = ledger.monthly_limit || Number(process.env.ODDS_MONTHLY_LIMIT) || 20000;
  const reservePct = Number(process.env.ODDS_BUDGET_RESERVE_PCT) || 15;
  const effectiveLimit = monthlyLimit * (1 - reservePct / 100);

  function emitTier(tier) {
    if (_lastQuotaTier !== null && _lastQuotaTier !== tier) {
      console.log(
        `[QUOTA] Tier changed: ${_lastQuotaTier} → ${tier} ` +
          `(tokens_remaining=${ledger.tokens_remaining}, ` +
          `burn_rate=${Math.round(ledger.tokens_spent_session)}tokens/session, ` +
          `monthly_limit=${monthlyLimit})`,
      );
    }
    _lastQuotaTier = tier;
    return tier;
  }

  // Migration 043 set DEFAULT 0 on tokens_remaining (NOT NULL), so a row with
  // tokens_remaining=0 AND tokens_spent_session=0 means "no fetches have run yet"
  // — treat it the same as a missing row (null) to avoid spurious CRITICAL on first startup.
  const effectiveRemaining =
    ledger.tokens_remaining === 0 && ledger.tokens_spent_session === 0
      ? null
      : ledger.tokens_remaining;

  // If we have a known remaining balance, use it
  if (effectiveRemaining !== null) {
    const pctRemaining = (effectiveRemaining / monthlyLimit) * 100;

    // Burn rate projection: if projected month-end spend > effectiveLimit → force MEDIUM
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

  // No ledger data yet — default to FULL
  return emitTier('FULL');
}

function hasFreshTeamMetricsCache() {
  if (!REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS) return true;
  return wasJobRecentlySuccessful(
    'refresh_team_metrics_daily',
    TEAM_METRICS_MAX_AGE_MINUTES,
  );
}

/**
 * Check if fixed time window is due
 * Only returns true if:
 * 1) Current time is past the target time AND
 * 2) It's the same calendar day (prevents multi-day catchup)
 * 3) FIXED_CATCHUP is enabled (or we're past the window by more than tick interval)
 */
function isFixedDue(nowEt, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const target = nowEt.set({ hour: h, minute: m, second: 0, millisecond: 0 });

  // Must be same day to prevent yesterday's windows from firing
  const sameDay = nowEt.toISODate() === target.toISODate();
  if (!sameDay) return false;

  // Must be past the target time
  if (nowEt < target) return false;

  // If FIXED_CATCHUP is disabled, only fire if we're within one tick interval
  const catchupEnabled = process.env.FIXED_CATCHUP !== 'false';
  if (!catchupEnabled) {
    const tickMs = Number(process.env.TICK_MS || 60_000);
    const msSinceTarget = nowEt.diff(target, 'milliseconds').milliseconds;
    // Only due if we just crossed the window (within 2x tick interval buffer)
    return msSinceTarget <= tickMs * 2;
  }

  return true;
}

/**
 * T-minus window bands with tolerance
 * If game starts at 19:00, T-120 window = 17:00 ± 5 min
 */
const TMINUS_BANDS = [
  { minutes: 120, min: 115, max: 120 },
  { minutes: 90, min: 85, max: 90 },
  { minutes: 60, min: 55, max: 60 },
  { minutes: 30, min: 25, max: 30 },
];

/**
 * Detect which T-minus windows are due for a game
 * @param {DateTime} nowUtc - Current UTC time
 * @param {DateTime} startUtc - Game start UTC time
 * @returns {number[]} - List of due window minutes (e.g., [120, 60])
 */
function dueTminusMinutes(nowUtc, startUtc) {
  const delta = Math.floor(startUtc.diff(nowUtc, 'minutes').minutes);
  return TMINUS_BANDS.filter((b) => delta >= b.min && delta <= b.max).map(
    (b) => b.minutes,
  );
}

/**
 * Compute due jobs (pure function, no side effects)
 * OPTIMIZED VERSION: Time-aware odds pulls, gated model runs, status-triggered settlement
 *
 * @param {object} params
 * @param {DateTime} params.nowEt - Current ET time
 * @param {DateTime} params.nowUtc - Current UTC time
 * @param {array} params.games - Games from DB
 * @param {boolean} params.dryRun - Dry run mode
 * @returns {array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeDueJobs({ nowEt, nowUtc, games, dryRun }) {
  const jobs = [];
  const sports = enabledSports();
  let teamMetricsRefreshQueued = false;

  // Token quota tier — gates T-minus and backstop odds pulls to protect monthly budget.
  // FULL: all features enabled. MEDIUM/LOW/CRITICAL: T-minus + backstop shut off.
  // Hourly baseline remains until CRITICAL (hard stop).
  const quotaTier = getCurrentQuotaTier();
  if (quotaTier !== 'FULL') {
    console.warn(`[QUOTA] Tier=${quotaTier} — T-minus and backstop odds pulls disabled this tick`);
  }
  if (quotaTier === 'CRITICAL') {
    console.error('[QUOTA] Tier=CRITICAL — all odds fetches halted for this tick');
  }

  // Daily quota summary at 09:00 ET — log current balance, burn rate, and tier context.
  if (isFixedDue(nowEt, '09:00')) {
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
        `monthly_limit=${monthlyLimit} | ` +
        `tier_context: ${tierNextChange}`,
      );
    } catch (_summaryErr) {
      // DB not yet migrated — skip summary
    }
  }

  function maybeQueueTeamMetricsRefresh(triggerReason, sport) {
    if (!isProjectionModelSport(sport)) return;
    if (!REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS) return;
    if (teamMetricsRefreshQueued) return;
    if (hasFreshTeamMetricsCache()) return;

    const cacheDate = nowEt.toISODate();
    const jobKey = `refresh_team_metrics|${cacheDate}`;
    jobs.push({
      jobName: 'refresh_team_metrics_daily',
      jobKey,
      execute: refreshTeamMetricsDaily,
      args: { jobKey, dryRun },
      reason: `pre-model team metrics refresh (${triggerReason})`,
    });
    teamMetricsRefreshQueued = true;
  }

  // ========== SCHEDULES (1) ==========
  // Use new time-aware schedule refresh logic (optional, can keep old hourly for now)
  // Old behavior maintained for backward compatibility

  // ========== INGESTION (2) ==========
  // Without Odds Mode: use ESPN-direct ingestion instead of The Odds API.
  if (ENABLE_WITHOUT_ODDS_MODE) {
    const isQuietHours = nowEt.hour < ODDS_FETCH_START_HOUR;
    if (!isQuietHours) {
      const jobKey = keyEspnGamesDirect(nowEt);
      jobs.push({
        jobName: 'pull_espn_games_direct',
        jobKey,
        execute: pullEspnGamesDirect,
        args: { jobKey, dryRun },
        reason: `ESPN-direct ingestion (without-odds mode) slot=${ODDS_FETCH_SLOT_MINUTES}min`,
      });
    }
  }

  // ========== ODDS (2) ==========
  // Keep existing hourly bucket for backward compatibility, but can also add time-aware logic
  if (!ENABLE_WITHOUT_ODDS_MODE && process.env.ENABLE_ODDS_PULL !== 'false' && quotaTier !== 'CRITICAL') {
    // Skip quiet hours (midnight to ODDS_FETCH_START_HOUR ET).
    // Conservative default: skip midnight–09:00 ET and run a 3-hour baseline.
    const isQuietHours = nowEt.hour < ODDS_FETCH_START_HOUR;

    if (!isQuietHours) {
      const jobKey = keyOddsHourly(nowEt);
      jobs.push({
        jobName: 'pull_odds_hourly',
        jobKey,
        execute: pullOddsHourly,
        args: { jobKey, dryRun },
        reason: `hourly bucket ${nowEt.toISODate()} ${nowEt.hour}h (slot=${ODDS_FETCH_SLOT_MINUTES}min, start=${ODDS_FETCH_START_HOUR}h ET)`,
      });
    }

    // Optional: Add time-aware per-game odds pulls
    if (process.env.ENABLE_TIME_AWARE_ODDS === 'true') {
      const oddsGames = games.filter((g) =>
        shouldRefreshOddsForGame(nowUtc, g),
      );

      for (const g of oddsGames) {
        const sport = String(g.sport).toLowerCase();
        const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
        const interval = getOddsIntervalMinutes(nowUtc, startUtc);

        const jobKey = `odds|${sport}|${g.game_id}|${nowUtc.toISO().slice(0, 16)}`;
        jobs.push({
          jobName: 'pull_odds_hourly',
          jobKey,
          execute: pullOddsHourly,
          args: { jobKey, game_id: g.game_id, dryRun },
          reason: `time-aware odds (T-${Math.round(startUtc.diff(nowUtc, 'minutes').minutes)}m, interval ${interval}m)`,
        });
      }
    }

    // Global backstop: every 10 minutes, refresh stale odds for T-6h games
    // Disabled at MEDIUM or below (tier check preserves hourly baseline only)
    if (
      ENABLE_ODDS_BACKSTOP &&
      quotaTier === 'FULL' &&
      nowUtc.minute % 10 === 0
    ) {
      const jobKey = `odds|global-backstop|${nowUtc.toISO().slice(0, 16)}`;
      jobs.push({
        jobName: 'refresh_stale_odds',
        jobKey,
        execute: refreshStaleOdds,
        args: { jobKey, dryRun },
        reason: `global odds backstop (find + refresh stale snapshots within T-6h)`,
      });
    }
  }

  // ========== TEAM METRICS CACHE (2.5) ==========
  // Daily prewarm at 09:00 ET (before first model run)
  if (
    process.env.ENABLE_TEAM_METRICS_CACHE !== 'false' &&
    isFixedDue(nowEt, '09:00')
  ) {
    const cacheDate = nowEt.toISODate();
    const jobKey = `refresh_team_metrics|${cacheDate}`;
    jobs.push({
      jobName: 'refresh_team_metrics_daily',
      jobKey,
      execute: refreshTeamMetricsDaily,
      args: { jobKey, dryRun },
      reason: `daily team metrics cache prewarm (09:00 ET)`,
    });
  }

  // ========== NHL SOG PLAYER ID SYNC (2.55) ==========
  // Daily 04:00 ET sync refreshes the tracked SOG player roster before prop ingest windows.
  if (ENABLE_NHL_SOG_PLAYER_SYNC && isFixedDue(nowEt, '04:00')) {
    const jobKey = keyNhlSogPlayerSync(nowEt);
    jobs.push({
      jobName: 'sync_nhl_sog_player_ids',
      jobKey,
      execute: syncNhlSogPlayerIds,
      args: { jobKey, dryRun },
      reason: 'daily NHL SOG player ID sync (04:00 ET)',
    });
  }

  // ========== NHL TEAM STATS (2.6) ==========
  // Daily early-morning refresh keeps team_stats current before the NHL model window.
  if (isFixedDue(nowEt, '06:00')) {
    const jobKey = keyNhlTeamStats(nowEt);
    jobs.push({
      jobName: 'pull_nhl_team_stats',
      jobKey,
      execute: pullNhlTeamStats,
      args: { jobKey, dryRun },
      reason: 'daily NHL team stats refresh (06:00 ET)',
    });
  }

  // ========== SETTLEMENT HEALTH REPORT (2.65) ==========
  // Daily read-only diagnostic so settlement failures surface in the scheduler flow.
  if (isFixedDue(nowEt, '08:00')) {
    const jobKey = keySettlementHealthReport(nowEt);
    jobs.push({
      jobName: 'report_settlement_health',
      jobKey,
      execute: runSettlementHealthReport,
      args: { jobKey, dryRun },
      reason: 'daily settlement health diagnostic (08:00 ET)',
    });
  }

  // ========== PUBLIC SPLITS (2.7) ==========
  // 60-minute cadence during active hours (09:00–23:00 ET).
  // Fetches Action Network public bet/handle pct and writes to odds_snapshots.
  // Unmatched HIGH-consensus games are flagged as pinnacle_proxy for WI-0667.
  if (nowEt.hour >= 9 && nowEt.hour < 23) {
    const jobKey = keyPublicSplits(nowEt);
    jobs.push({
      jobName: 'pull_public_splits',
      jobKey,
      execute: runPullPublicSplits,
      args: { jobKey, dryRun },
      reason: `hourly public splits (${nowEt.toISODate()} ${nowEt.hour}h)`,
    });
  }

  // ========== NHL PLAYER AVAILABILITY SYNC (2.8) ==========
  // Hourly injury/availability poll to keep player_availability fresh between
  // pull_nhl_player_shots runs (which may run infrequently).
  if (ENABLE_NHL_PLAYER_AVAILABILITY_SYNC) {
    const jobKey = keyNhlPlayerAvailabilitySync(nowEt);
    jobs.push({
      jobName: 'sync_nhl_player_availability',
      jobKey,
      execute: syncNhlPlayerAvailability,
      args: { jobKey, dryRun },
      reason: `hourly NHL player availability sync (${nowEt.toISODate()} ${nowEt.hour}h)`,
    });
  }

  // ========== MODELS (3) ==========
  if (
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS === 'true' &&
    String(process.env.DISCORD_CARD_WEBHOOK_URL || '').trim()
  ) {
    const discordSnapshotTimes = ['09:00', '12:00', '18:00'];
    for (const t of discordSnapshotTimes) {
      if (!isFixedDue(nowEt, t)) continue;
      const jobKey = keyDiscordCardsSnapshot(nowEt, t);
      jobs.push({
        jobName: 'post_discord_cards',
        jobKey,
        execute: postDiscordCards,
        args: { jobKey, dryRun },
        reason: `discord cards snapshot ${t} ET`,
      });
    }
  }

  // ========== MODELS (3) ==========
  // Fixed-time model runs (per sport) - UNCHANGED
  const fixedTimes = ['09:00', '12:00'];
  for (const sport of sports) {
    const { jobName, execute } = SPORT_JOBS[sport];
    for (const t of fixedTimes) {
      if (!isFixedDue(nowEt, t)) continue;
      maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, sport);
      const jobKey = keyFixed(sport, nowEt, t);
      jobs.push({
        jobName,
        jobKey,
        execute,
        args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
        reason: `fixed ${t} ET${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  // T-minus windows (per game)
  // Pre-model odds pulls are deduped per sport per T-minus window (not per game).
  // On a 25-game NBA night, without dedup: 25 × 4 T-minus windows = 100 pulls (700+ tokens).
  // With dedup: 1 pull per sport per window (nba|T-30) = max ~4 pulls/sport/day (~56 tokens).
  //
  // *** March 2026 incident ***
  // Once-per-game T-minus pulls burned both API keys in a single evening.
  // 25 NBA games × 4 T-minus windows × 7 tokens = 700 tokens in one evening — no circuit
  // breaker, no dev env wall. This dedup guard is the first line of defense.
  //
  // DB-backed dedup: claimTminusPullSlot uses INSERT OR IGNORE so a scheduler crash-restart
  // mid-tick cannot double-pull for the same sport+window. The in-memory Set provided no
  // protection across restarts. window_key: '<sport>|T-<mins>|<YYYY-MM-DDTHH>'
  const hourSlot = nowUtc.toISO().slice(0, 13); // YYYY-MM-DDTHH

  for (const g of games) {
    const sport = String(g.sport).toLowerCase();
    if (!SPORT_JOBS[sport]) continue;
    if (!sports.includes(sport)) continue;

    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      maybeQueueTeamMetricsRefresh(`T-${mins} for ${g.game_id}`, sport);

      const jobKey = keyTminus(sport, g.game_id, mins);
      // For projection-model sports, force a fresh odds pull immediately before the model
      // so T-minus runs always see the current line (not up-to-29-min-stale hourly snapshot).
      // Deduped per sport per T-minus window — one pull serves all games in the same window.
      // Skipped in Without Odds Mode (no Odds API calls).
      if (!ENABLE_WITHOUT_ODDS_MODE && isProjectionModelSport(sport) && process.env.ENABLE_ODDS_PULL !== 'false' && quotaTier === 'FULL') {
        const oddsWindowKey = `${sport}|T-${mins}|${hourSlot}`;
        if (claimTminusPullSlot(sport, oddsWindowKey)) {
          const oddsPreKey = `odds|pre-model|${sport}|T-${mins}`;
          jobs.push({
            jobName: 'pull_odds_hourly',
            jobKey: oddsPreKey,
            execute: pullOddsHourly,
            args: { jobKey: oddsPreKey, dryRun },
            reason: `pre-model odds refresh (T-${mins}, ${sport})`,
          });
        }
      }
      jobs.push({
        jobName: SPORT_JOBS[sport].jobName,
        jobKey,
        execute: SPORT_JOBS[sport].execute,
        args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
        reason: `T-${mins} for ${g.game_id}${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  // ========== SETTLEMENT (4) ==========
  // Settlement is disabled in Without Odds Mode — cards have no locked prices to settle against.
  if (!ENABLE_WITHOUT_ODDS_MODE && process.env.ENABLE_SETTLEMENT !== 'false') {
    const sweepDate = nowEt.toISODate();
    const nightlySettlementOwnsHourlyWindow =
      isNightlySettlementOwningHourlyWindow(nowEt);

    // Enforce singleton settlement across all processes (race mitigation)
    const settlementGameRunning = hasRunningJobName('settle_game_results');
    const settlementCardsRunning = hasRunningJobName('settle_pending_cards');

    // 4A) Hourly settlement sweep (default enabled)
    if (
      process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP !== 'false' &&
      isHourlySettlementDue(nowEt)
    ) {
      const hourlyKey = keyHourlySettlementSweep(nowEt);

      // Sync game statuses first so road-trip sequence logic (e.g. Welcome Home)
      // has accurate 'final' status before models and settlement run.
      jobs.push({
        jobName: 'sync_game_statuses',
        jobKey: `sync|game-statuses|${hourlyKey}`,
        execute: syncGameStatuses,
        args: { jobKey: `sync|game-statuses|${hourlyKey}`, dryRun },
        reason: `hourly game status sync ${hourlyKey}`,
      });

      if (nightlySettlementOwnsHourlyWindow) {
        console.log(
          '[Scheduler] Skipping hourly settlement enqueue — nightly settlement owns the 02:00 ET window',
        );
      } else if (!settlementGameRunning) {
        const gameResultsJobKey = keyHourlySettlementJob(nowEt, 'game-results');
        jobs.push({
          jobName: 'settle_game_results',
          jobKey: gameResultsJobKey,
          execute: settleGameResults,
          args: { jobKey: gameResultsJobKey, dryRun },
          reason: `hourly settlement sweep ${hourlyKey}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_game_results — already running in another process`,
        );
      }

      if (nightlySettlementOwnsHourlyWindow) {
        // Nightly sweep owns settlement for this minute; keep hourly status sync only.
      } else if (!settlementCardsRunning) {
        const pendingCardsJobKey = keyHourlySettlementJob(nowEt, 'pending-cards');
        jobs.push({
          jobName: 'settle_pending_cards',
          jobKey: pendingCardsJobKey,
          execute: settlePendingCards,
          args: {
            jobKey: pendingCardsJobKey,
            dryRun,
            allowDisplayBackfill: SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL,
          },
          reason: `hourly card settlement ${hourlyKey}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_pending_cards — already running in another process`,
        );
      }
    }

    // 4B) Nightly backfill + settlement sweep (02:00 ET)
    if (isFixedDue(nowEt, '02:00')) {
      jobs.push({
        jobName: 'backfill_card_results',
        jobKey: `settle|backfill-card-results|${sweepDate}`,
        execute: backfillCardResults,
        args: { jobKey: `settle|backfill-card-results|${sweepDate}`, dryRun },
        reason: `nightly card_results backfill ${sweepDate}`,
      });

      if (!settlementGameRunning) {
        const gameResultsJobKey = keyNightlySettlementJob(nowEt, 'game-results');
        jobs.push({
          jobName: 'settle_game_results',
          jobKey: gameResultsJobKey,
          execute: settleGameResults,
          args: { jobKey: gameResultsJobKey, dryRun },
          reason: `nightly settlement sweep ${sweepDate}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_game_results — already running in another process`,
        );
      }

      if (!settlementCardsRunning) {
        const pendingCardsJobKey = keyNightlySettlementJob(nowEt, 'pending-cards');
        jobs.push({
          jobName: 'settle_pending_cards',
          jobKey: pendingCardsJobKey,
          execute: settlePendingCards,
          args: {
            jobKey: pendingCardsJobKey,
            dryRun,
            allowDisplayBackfill: SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL,
          },
          reason: `nightly card settlement ${sweepDate}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_pending_cards — already running in another process`,
        );
      }
    }
  }

  // ========== MLB F5 SETTLEMENT (4C) ==========
  if (process.env.ENABLE_MLB_MODEL !== 'false') {
    const f5SettleKey = `settle_mlb_f5|${nowEt.toISODate()}|${nowEt.hour}`;
    jobs.push({
      jobName: 'settle_mlb_f5',
      jobKey: f5SettleKey,
      execute: settleMlbF5,
      args: { jobKey: f5SettleKey, dryRun },
      reason: 'MLB F5 card settlement (post-game)',
    });
  }

  // ========== PROJECTION ACTUAL RESULT INGESTION (4D) ==========
  // Runs in the same window as MLB F5 settlement — post-game, hourly.
  // Writes actual_result for nhl-pace-1p (goals_1p) and mlb-f5 (runs_f5) cards.
  {
    const projSettleKey = `settle_projections|${nowEt.toISODate()}|${nowEt.hour}`;
    jobs.push({
      jobName: 'settle_projections',
      jobKey: projSettleKey,
      execute: settleProjections,
      args: { jobKey: projSettleKey, dryRun },
      reason: 'Projection actual result ingestion (nhl-pace-1p, mlb-f5)',
    });
  }

  // ========== HEALTH WATCHDOG (5) ==========
  if (process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG === 'true') {
    const watchdogJobs = getPipelineHealthJobs(nowUtc);
    jobs.push(...watchdogJobs);
  }

  // ========== ODDS HEALTH WATCHDOG (6) ==========
  if (process.env.ENABLE_ODDS_HEALTH_WATCHDOG !== 'false') {
    const oddsHealthJobs = getOddsHealthJobs(nowUtc);
    jobs.push(...oddsHealthJobs);
  }

  // ========== FPL DEADLINE SCHEDULER (7) ==========
  // Runs in parallel with game-time sports; keyed to GW deadline windows (not kick-offs).
  // Delegation to schedulers/fpl.js keeps deadline logic isolated from game-time logic.
  const fplJobs = computeFplDueJobs(nowEt, { dryRun });
  jobs.push(...fplJobs);

  // ========== PLAYER PROPS SCHEDULER (8) ==========
  // NHL SOG/BLK + MLB pitcher-K prop ingest/model — dedicated cadence (09:00, 18:00, T-60).
  // See schedulers/player-props.js for window logic and key format.
  const playerPropsJobs = computePlayerPropsDueJobs(nowEt, {
    games,
    dryRun,
    quotaTier,
  });
  jobs.push(...playerPropsJobs);

  return jobs;
}

/**
 * Execute tick: check due jobs and run them if not already successful/running
 */
async function tick() {
  const dryRun = process.env.DRY_RUN === 'true';
  const nowEt = nowET();
  const nowUtc = DateTime.utc();

  checkOddsFreshnessHealth(nowUtc);

  // Get games in the next 36 hours (covers tomorrow + late games)
  const startUtcIso = nowUtc.minus({ hours: 1 }).toISO(); // small back buffer
  const endUtcIso = nowUtc.plus({ hours: 36 }).toISO();

  const sports = enabledSports();
  const games = getUpcomingGames({ startUtcIso, endUtcIso, sports });

  const due = computeDueJobs({ nowEt, nowUtc, games, dryRun });

  // De-dup inside the tick so we don't schedule the same jobKey twice
  const seen = new Set();
  const uniqueDue = due.filter((j) => {
    if (seen.has(j.jobKey)) return false;
    seen.add(j.jobKey);
    return true;
  });

  console.log(
    `[SCHEDULER] Tick ${nowEt.toISO()} ET — due candidates: ${uniqueDue.length}`,
  );
  let staleOddsSkipLogged = false;

  for (const job of uniqueDue) {
    if (isModelJob(job.jobName) && !hasFreshInputsForModels()) {
      if (!staleOddsSkipLogged) {
        const gateJobName = ENABLE_WITHOUT_ODDS_MODE ? 'pull_espn_games_direct' : 'pull_odds_hourly';
        console.warn(
          `[SCHEDULER][GATE] Skipping model jobs: no successful ${gateJobName} in last ${MODEL_ODDS_MAX_AGE_MINUTES} minutes`,
        );
        staleOddsSkipLogged = true;
      }
      console.log(`  ⏭️  skip ${job.jobKey} (${job.jobName}) — stale inputs`);
      continue;
    }

    // Idempotency gate
    if (!shouldRunJobKey(job.jobKey)) {
      console.log(`  ⏭️  skip ${job.jobKey} (${job.jobName})`);
      continue;
    }

    // Extra overlap gate
    if (hasRunningJobRun(job.jobKey)) {
      console.log(`  ⏳ running ${job.jobKey} (${job.jobName})`);
      continue;
    }

    if (dryRun) {
      console.log(
        `  🧪 DRY_RUN would run ${job.jobKey} (${job.jobName}) — ${job.reason}`,
      );
      continue;
    }

    console.log(`  ▶️  run ${job.jobKey} (${job.jobName}) — ${job.reason}`);
    try {
      await job.execute(job.args);
    } catch (err) {
      console.error(`  ❌ ${job.jobKey} failed:`, err.message);
    }
  }
}

/**
 * Start the scheduler with tick loop
 */
async function start() {
  const tickMs = Number(process.env.TICK_MS || 60_000);

  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  CHEDDAR-LOGIC WINDOW SCHEDULER (Tick Loop)');
  if (ENABLE_WITHOUT_ODDS_MODE) {
    console.log('  *** WITHOUT ODDS MODE — ESPN-direct ingestion, PROJECTION_ONLY cards, no settlement ***');
  }
  console.log('═'.repeat(60));
  console.log(`  TZ: ${TZ}`);
  console.log(`  TICK_MS: ${tickMs}`);
  console.log(`  DRY_RUN: ${process.env.DRY_RUN || 'false'}`);
  console.log(
    `  FIXED_CATCHUP: ${process.env.FIXED_CATCHUP !== 'false' ? 'true' : 'false'}`,
  );
  console.log(
    `  ENABLE_ODDS_PULL: ${process.env.ENABLE_ODDS_PULL !== 'false' ? 'true' : 'false'}`,
  );
  console.log(
    `  REQUIRE_FRESH_ODDS_FOR_MODELS: ${REQUIRE_FRESH_ODDS_FOR_MODELS ? 'true' : 'false'}`,
  );
  console.log(`  MODEL_ODDS_MAX_AGE_MINUTES: ${MODEL_ODDS_MAX_AGE_MINUTES}`);
  console.log(
    `  REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS: ${REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS ? 'true' : 'false'}`,
  );
  console.log(`  TEAM_METRICS_MAX_AGE_MINUTES: ${TEAM_METRICS_MAX_AGE_MINUTES}`);
  console.log(
    `  ENABLE_NHL_PLAYER_AVAILABILITY_SYNC: ${ENABLE_NHL_PLAYER_AVAILABILITY_SYNC ? 'true' : 'false'}`,
  );
  console.log(
    `  ENABLE_PLAYER_PROPS_SCHEDULER: ${process.env.ENABLE_PLAYER_PROPS_SCHEDULER || 'true (default)'}`,
  );
  console.log(
    `  ENABLE_NHL_BLK_INGEST: ${process.env.ENABLE_NHL_BLK_INGEST || 'true (default)'}`,
  );
  console.log(`  ODDS_FETCH_SLOT_MINUTES: ${ODDS_FETCH_SLOT_MINUTES}`);
  console.log(`  ODDS_FETCH_START_HOUR: ${ODDS_FETCH_START_HOUR}h ET`);
  console.log(
    `  ENABLE_SETTLEMENT: ${process.env.ENABLE_SETTLEMENT !== 'false' ? 'true' : 'false'}`,
  );
  console.log(
    `  ENABLE_HOURLY_SETTLEMENT_SWEEP: ${process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP !== 'false' ? 'true' : 'false'}`,
    `  SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL: ${SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL ? 'true' : 'false'}`,
    `  SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL: ${SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL ? 'true' : 'false'}`,
  );
  console.log(
    `  SETTLEMENT_HOURLY_BOUNDARY_MINUTES: ${process.env.SETTLEMENT_HOURLY_BOUNDARY_MINUTES || '5'}`,
  );
  console.log(`  Enabled sports: ${enabledSports().join(', ') || 'none'}`);
  console.log(
    `  ENABLE_WITHOUT_ODDS_MODE: ${ENABLE_WITHOUT_ODDS_MODE ? 'true — ESPN-direct, PROJECTION_ONLY, no settlement' : 'false'}`,
  );
  console.log('═'.repeat(60));
  console.log('');

  // Initialize database
  console.log('[SCHEDULER] Initializing database...');
  console.log('[SCHEDULER] Database ready.\n');
  purgeStaleTminusPullLog();
  console.log('[SCHEDULER] T-minus pull log: stale rows purged (>48h).');
  purgeStalePropOddsUsageLog();
  purgeExpiredPropEventMappings();
  console.log('[SCHEDULER] Prop odds control tables: usage log and expired mappings pruned.');

  const staleLockCount = recoverStaleJobRuns();
  if (staleLockCount > 0) {
    console.log(`[SCHEDULER] Stale lock recovery: ${staleLockCount} orphaned job_run(s) transitioned from 'running' to 'failed'.`);
  } else {
    console.log('[SCHEDULER] Stale lock recovery: no orphaned locks found.');
  }

  let tickRunning = false;

  function runTick() {
    if (tickRunning) {
      console.log('[SCHEDULER] Skipping tick — previous tick still running');
      return;
    }
    tickRunning = true;
    tick()
      .catch((err) => console.error('[SCHEDULER] tick error', err))
      .finally(() => {
        tickRunning = false;
      });
  }

  // Initial tick
  runTick();

  // Loop
  const interval = setInterval(runTick, tickMs);

  process.on('SIGTERM', () => {
    clearInterval(interval);
    console.log('\n[SCHEDULER] Received SIGTERM, exiting...');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\n[SCHEDULER] Received SIGINT, exiting...');
    process.exit(0);
  });
}

// CLI execution
if (require.main === module) {
  start();
}

module.exports = {
  start,
  tick,
  computeDueJobs,
  enabledSports,
  keyOddsHourly,
  keyFixed,
  keyDiscordCardsSnapshot,
  keyTminus,
  keyNightlySweep,
  keyNhlPlayerAvailabilitySync,
  keyNhlSogPlayerSync,
  keySettlementHealthReport,
  keyHourlySettlementSweep,
  keyHourlySettlementJob,
  keyNightlySettlementJob,
  isHourlySettlementDue,
  isFixedDue,
  dueTminusMinutes,
  TMINUS_BANDS,
  // New helper functions
  getOddsIntervalMinutes,
  getScheduleRefreshDue,
  shouldRefreshOddsForGame,
  getPipelineHealthJobs,
  getOddsHealthJobs,
};
