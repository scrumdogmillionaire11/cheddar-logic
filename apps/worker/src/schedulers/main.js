/**
 * Window-Based Scheduler — Tick loop with idempotency
 *
 * Architecture:
 * - Fixed-time windows: 09:00 ET, 12:00 ET (daily model refresh)
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
 * - FPL-SAGE Engine: FPL (deadline-based, NOT game-time) — TODO future refactor
 */

require('dotenv').config();

const { DateTime } = require('luxon');
const {
  initDb,
  getUpcomingGames,
  shouldRunJobKey,
  hasRunningJobRun,
  wasJobRecentlySuccessful,
} = require('@cheddar-logic/data');

// Import all jobs
const { pullOddsHourly } = require('../jobs/pull_odds_hourly');
const { refreshStaleOdds } = require('../jobs/refresh_stale_odds');
const { runNHLModel } = require('../jobs/run_nhl_model');
const { runNBAModel } = require('../jobs/run_nba_model');
const { runFPLModel } = require('../jobs/run_fpl_model');
const { runNFLModel } = require('../jobs/run_nfl_model');
const { runMLBModel } = require('../jobs/run_mlb_model');
const { runSoccerModel } = require('../jobs/run_soccer_model');
const { pullSoccerPlayerProps } = require('../jobs/pull_soccer_player_props');
const { pullSoccerXgStats } = require('../jobs/pull_soccer_xg_stats');
const { runNCAAMModel } = require('../jobs/run_ncaam_model');
const { runRefreshNcaamFtCsv } = require('../jobs/refresh_ncaam_ft_csv');
const { settleGameResults } = require('../jobs/settle_game_results');
const { settlePendingCards } = require('../jobs/settle_pending_cards');
const { backfillCardResults } = require('../jobs/backfill_card_results');
const { checkPipelineHealth } = require('../jobs/check_pipeline_health');
const {
  run: refreshTeamMetricsDaily,
} = require('../jobs/refresh_team_metrics_daily');
const { syncNhlSogPlayerIds } = require('../jobs/sync_nhl_sog_player_ids');
const { syncNhlPlayerAvailability } = require('../jobs/sync_nhl_player_availability');

// Timezone for fixed-time windows
const TZ = process.env.TZ || 'America/New_York';
const ODDS_GAP_ALERT_MINUTES = Number(process.env.ODDS_GAP_ALERT_MINUTES || 90);
const ODDS_GAP_ALERT_COOLDOWN_MS = Number(
  process.env.ODDS_GAP_ALERT_COOLDOWN_MS || 15 * 60 * 1000,
);
const REQUIRE_FRESH_ODDS_FOR_MODELS =
  process.env.REQUIRE_FRESH_ODDS_FOR_MODELS !== 'false';
const MODEL_ODDS_MAX_AGE_MINUTES = Number(
  process.env.MODEL_ODDS_MAX_AGE_MINUTES || ODDS_GAP_ALERT_MINUTES,
);
const REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS =
  process.env.REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS !== 'false';
const TEAM_METRICS_MAX_AGE_MINUTES = Number(
  process.env.TEAM_METRICS_MAX_AGE_MINUTES || 20 * 60,
);
const ENABLE_NCAAM_FT_REFRESH = process.env.ENABLE_NCAAM_FT_REFRESH !== 'false';
const ENABLE_NHL_SOG_PLAYER_SYNC =
  process.env.ENABLE_NHL_SOG_PLAYER_SYNC !== 'false';
const ENABLE_NHL_PLAYER_AVAILABILITY_SYNC =
  process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC !== 'false';
const NCAAM_FT_REFRESH_MAX_AGE_MINUTES = Number(
  process.env.NCAAM_FT_REFRESH_MAX_AGE_MINUTES || 360,
);
const SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL =
  process.env.SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL === 'true';
const SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL =
  process.env.SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL === 'true';
let lastOddsGapAlertAt = 0;

const SOCCER_LINEUP_T45_MINUTES = 45;

function isSoccerLineupT45Enabled() {
  return process.env.ENABLE_SOCCER_T45_LINEUP_CHECK !== 'false';
}

function getSoccerLineupT45Bounds() {
  const min = Number(process.env.SOCCER_LINEUP_T45_MIN || 40);
  const max = Number(process.env.SOCCER_LINEUP_T45_MAX || 45);
  return {
    min: Number.isFinite(min) ? min : 40,
    max: Number.isFinite(max) ? max : 45,
  };
}

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
  soccer: {
    jobName: 'run_soccer_model',
    execute: runSoccerModel,
    env: 'ENABLE_SOCCER_MODEL',
  },
  ncaam: {
    jobName: 'run_ncaam_model',
    execute: runNCAAMModel,
    env: 'ENABLE_NCAAM_MODEL',
  },

  // TEMPORARY: FPL here until deadline-based scheduler refactor
  fpl: {
    jobName: 'run_fpl_model',
    execute: runFPLModel,
    env: 'ENABLE_FPL_MODEL',
  },
};

/**
 * Get list of enabled sports from environment
 */
function enabledSports() {
  return Object.keys(SPORT_JOBS).filter(
    (s) => process.env[SPORT_JOBS[s].env] !== 'false',
  );
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
function keyOddsHourly(nowEt) {
  return `odds|hourly|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyFixed(sport, nowEt, hhmm) {
  return `${sport}|fixed|${nowEt.toISODate()}|${hhmm.replace(':', '')}`;
}

function keyTminus(sport, gameId, minutes) {
  return `${sport}|tminus|${gameId}|${minutes}`;
}

function keyNightlySweep(nowEt) {
  return `settle|nightly|${nowEt.toISODate()}`;
}

function keyNcaamFtRefresh(nowEt) {
  const freshnessWindow = Math.max(15, NCAAM_FT_REFRESH_MAX_AGE_MINUTES);
  const minutesSinceMidnight = nowEt.hour * 60 + nowEt.minute;
  const bucket = Math.floor(minutesSinceMidnight / freshnessWindow);
  return `refresh_ncaam_ft_csv|${nowEt.toISODate()}|b${bucket}`;
}

function keyNhlSogPlayerSync(nowEt) {
  return `sync_nhl_sog_player_ids|${nowEt.toISODate()}|0400`;
}

function keyNhlPlayerAvailabilitySync(nowEt) {
  return `sync_nhl_player_availability|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyHourlySettlementSweep(nowEt) {
  return `settle|hourly|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function isHourlySettlementDue(nowEt) {
  const boundaryMinutes = Number(
    process.env.SETTLEMENT_HOURLY_BOUNDARY_MINUTES || 5,
  );
  return nowEt.minute >= 0 && nowEt.minute < Math.max(boundaryMinutes, 1);
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
 * Health check: detect stale odds pipeline based on last successful pull job
 */
function checkOddsFreshnessHealth(nowUtc) {
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

function hasFreshOddsForModels() {
  if (!REQUIRE_FRESH_ODDS_FOR_MODELS) return true;
  if (process.env.ENABLE_ODDS_PULL === 'false') return true;
  return wasJobRecentlySuccessful(
    'pull_odds_hourly',
    MODEL_ODDS_MAX_AGE_MINUTES,
  );
}

function isProjectionModelSport(sport) {
  return ['nba', 'nhl', 'ncaam'].includes(String(sport || '').toLowerCase());
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

function isSoccerLineupT45Due(nowUtc, startUtc) {
  if (!isSoccerLineupT45Enabled()) return false;
  const delta = Math.floor(startUtc.diff(nowUtc, 'minutes').minutes);
  const { min, max } = getSoccerLineupT45Bounds();
  return delta >= min && delta <= max;
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
  let ncaamFtRefreshQueued = false;
  let teamMetricsRefreshQueued = false;

  function queueSoccerPropIngestBeforeModel(modelJobKey, reason) {
    const propJobKey = `soccer_props|${modelJobKey}`;
    jobs.push({
      jobName: 'pull_soccer_player_props',
      jobKey: propJobKey,
      execute: pullSoccerPlayerProps,
      args: { jobKey: propJobKey, dryRun },
      reason: `pre-model soccer Tier-1 prop ingest (${reason})`,
    });
  }

  function queueSoccerXgIngestBeforeModel(modelJobKey, reason) {
    const xgJobKey = `soccer_xg|${modelJobKey}`;
    jobs.push({
      jobName: 'pull_soccer_xg_stats',
      jobKey: xgJobKey,
      execute: pullSoccerXgStats,
      args: { jobKey: xgJobKey, dryRun },
      reason: `pre-model soccer xG cache refresh (${reason})`,
    });
  }

  function maybeQueueNcaamFtRefresh(triggerReason) {
    if (!ENABLE_NCAAM_FT_REFRESH) return;
    if (ncaamFtRefreshQueued) return;
    if (
      wasJobRecentlySuccessful(
        'refresh_ncaam_ft_csv',
        NCAAM_FT_REFRESH_MAX_AGE_MINUTES,
      )
    ) {
      return;
    }

    const refreshJobKey = keyNcaamFtRefresh(nowEt);
    jobs.push({
      jobName: 'refresh_ncaam_ft_csv',
      jobKey: refreshJobKey,
      execute: runRefreshNcaamFtCsv,
      args: { jobKey: refreshJobKey, dryRun },
      reason: `pre-NCAAM FT CSV refresh (${triggerReason})`,
    });
    ncaamFtRefreshQueued = true;
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

  // ========== ODDS (2) ==========
  // Keep existing hourly bucket for backward compatibility, but can also add time-aware logic
  if (process.env.ENABLE_ODDS_PULL !== 'false') {
    // Skip overnight hours (2am-5am ET) when no games start
    // Saves 3 fetches/day × 30 days × 8 tokens = 720 tokens/month
    const isOvernightHours = nowEt.hour >= 2 && nowEt.hour <= 5;

    if (!isOvernightHours) {
      const jobKey = keyOddsHourly(nowEt);
      jobs.push({
        jobName: 'pull_odds_hourly',
        jobKey,
        execute: pullOddsHourly,
        args: { jobKey, dryRun },
        reason: `hourly bucket ${nowEt.toISODate()} ${nowEt.hour}h (21/day, skip 2am-5am)`,
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
    if (
      process.env.ENABLE_ODDS_BACKSTOP !== 'false' &&
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

  // ========== NCAAM FT BOOTSTRAP (2.5) ==========
  // Early-morning (06:00 ET) pre-refresh ensures CSv is fresh before 09:00 model runs
  // Prevents race conditions if a scheduled refresh fails overnight
  if (ENABLE_NCAAM_FT_REFRESH && isFixedDue(nowEt, '06:00')) {
    maybeQueueNcaamFtRefresh('early-morning bootstrap (06:00 ET)');
  }

  // ========== NHL SOG PLAYER SYNC (2.75) ==========
  // Daily refresh of tracked NHL SOG player IDs before regular morning jobs.
  if (ENABLE_NHL_SOG_PLAYER_SYNC && isFixedDue(nowEt, '04:00')) {
    const jobKey = keyNhlSogPlayerSync(nowEt);
    jobs.push({
      jobName: 'sync_nhl_sog_player_ids',
      jobKey,
      execute: syncNhlSogPlayerIds,
      args: { jobKey, dryRun },
      reason: 'daily NHL SOG tracked-player sync (04:00 ET)',
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
  // Fixed-time model runs (per sport) - UNCHANGED
  const fixedTimes = ['09:00', '12:00'];
  for (const sport of sports) {
    const { jobName, execute } = SPORT_JOBS[sport];
    for (const t of fixedTimes) {
      if (!isFixedDue(nowEt, t)) continue;
      maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, sport);
      if (sport === 'ncaam') {
        maybeQueueNcaamFtRefresh(`fixed ${t} ET`);
      }

      const jobKey = keyFixed(sport, nowEt, t);
      if (sport === 'soccer') {
        queueSoccerXgIngestBeforeModel(jobKey, `fixed ${t} ET`);
        queueSoccerPropIngestBeforeModel(jobKey, `fixed ${t} ET`);
      }
      jobs.push({
        jobName,
        jobKey,
        execute,
        args: { jobKey, dryRun },
        reason: `fixed ${t} ET`,
      });
    }
  }

  // T-minus windows (per game) - UNCHANGED
  for (const g of games) {
    const sport = String(g.sport).toLowerCase();
    if (!SPORT_JOBS[sport]) continue;
    if (!sports.includes(sport)) continue;

    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      maybeQueueTeamMetricsRefresh(`T-${mins} for ${g.game_id}`, sport);
      if (sport === 'ncaam') {
        maybeQueueNcaamFtRefresh(`T-${mins} for ${g.game_id}`);
      }

      const jobKey = keyTminus(sport, g.game_id, mins);
      if (sport === 'soccer') {
        queueSoccerXgIngestBeforeModel(jobKey, `T-${mins} for ${g.game_id}`);
        queueSoccerPropIngestBeforeModel(jobKey, `T-${mins} for ${g.game_id}`);
      }
      jobs.push({
        jobName: SPORT_JOBS[sport].jobName,
        jobKey,
        execute: SPORT_JOBS[sport].execute,
        args: { jobKey, dryRun },
        reason: `T-${mins} for ${g.game_id}`,
      });
    }

    if (sport === 'soccer' && isSoccerLineupT45Due(nowUtc, startUtc)) {
      const jobKey = keyTminus(sport, g.game_id, SOCCER_LINEUP_T45_MINUTES);
      queueSoccerXgIngestBeforeModel(
        jobKey,
        `soccer lineup checkpoint T-${SOCCER_LINEUP_T45_MINUTES} for ${g.game_id}`,
      );
      queueSoccerPropIngestBeforeModel(
        jobKey,
        `soccer lineup checkpoint T-${SOCCER_LINEUP_T45_MINUTES} for ${g.game_id}`,
      );
      jobs.push({
        jobName: SPORT_JOBS[sport].jobName,
        jobKey,
        execute: SPORT_JOBS[sport].execute,
        args: { jobKey, dryRun },
        reason: `soccer lineup checkpoint T-${SOCCER_LINEUP_T45_MINUTES} for ${g.game_id}`,
      });
    }
  }

  // ========== SETTLEMENT (4) ==========
  if (process.env.ENABLE_SETTLEMENT !== 'false') {
    const sweepDate = nowEt.toISODate();

    // Enforce singleton settlement across all processes (race mitigation)
    const settlementGameRunning = hasRunningJobRun(
      'settle|global|game-results',
    );
    const settlementCardsRunning = hasRunningJobRun(
      'settle|global|pending-cards',
    );

    // 4A) Hourly settlement sweep (default enabled)
    if (
      process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP !== 'false' &&
      isHourlySettlementDue(nowEt)
    ) {
      const hourlyKey = keyHourlySettlementSweep(nowEt);

      if (!settlementGameRunning) {
        jobs.push({
          jobName: 'settle_game_results',
          jobKey: 'settle|global|game-results',
          execute: settleGameResults,
          args: { jobKey: 'settle|global|game-results', dryRun },
          reason: `hourly settlement sweep ${hourlyKey}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_game_results — already running in another process`,
        );
      }

      if (!settlementCardsRunning) {
        jobs.push({
          jobName: 'settle_pending_cards',
          jobKey: 'settle|global|pending-cards',
          execute: settlePendingCards,
          args: {
            jobKey: 'settle|global|pending-cards',
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
        jobs.push({
          jobName: 'settle_game_results',
          jobKey: 'settle|global|game-results',
          execute: settleGameResults,
          args: { jobKey: 'settle|global|game-results', dryRun },
          reason: `nightly settlement sweep ${sweepDate}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_game_results — already running in another process`,
        );
      }

      if (!settlementCardsRunning) {
        jobs.push({
          jobName: 'settle_pending_cards',
          jobKey: 'settle|global|pending-cards',
          execute: settlePendingCards,
          args: {
            jobKey: 'settle|global|pending-cards',
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

  // ========== HEALTH WATCHDOG (5) ==========
  if (process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG === 'true') {
    const watchdogJobs = getPipelineHealthJobs(nowUtc);
    jobs.push(...watchdogJobs);
  }

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
    if (isModelJob(job.jobName) && !hasFreshOddsForModels()) {
      if (!staleOddsSkipLogged) {
        console.warn(
          `[SCHEDULER][GATE] Skipping model jobs: no successful pull_odds_hourly in last ${MODEL_ODDS_MAX_AGE_MINUTES} minutes`,
        );
        staleOddsSkipLogged = true;
      }
      console.log(`  ⏭️  skip ${job.jobKey} (${job.jobName}) — stale odds`);
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
    `  ENABLE_SOCCER_T45_LINEUP_CHECK: ${isSoccerLineupT45Enabled() ? 'true' : 'false'} (window ${getSoccerLineupT45Bounds().min}-${getSoccerLineupT45Bounds().max}m)`,
  );
  console.log(
    `  ENABLE_NCAAM_FT_REFRESH: ${ENABLE_NCAAM_FT_REFRESH ? 'true' : 'false'}`,
  );
  console.log(
    `  ENABLE_NHL_SOG_PLAYER_SYNC: ${ENABLE_NHL_SOG_PLAYER_SYNC ? 'true' : 'false'}`,
  );
  console.log(
    `  ENABLE_NHL_PLAYER_AVAILABILITY_SYNC: ${ENABLE_NHL_PLAYER_AVAILABILITY_SYNC ? 'true' : 'false'}`,
  );
  console.log(
    `  NCAAM_FT_REFRESH_MAX_AGE_MINUTES: ${NCAAM_FT_REFRESH_MAX_AGE_MINUTES}`,
  );
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
  console.log('═'.repeat(60));
  console.log('');

  // Initialize database
  console.log('[SCHEDULER] Initializing database...');
  await initDb();
  console.log('[SCHEDULER] Database ready.\n');

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
  keyTminus,
  keyNightlySweep,
  keyNhlSogPlayerSync,
  keyNhlPlayerAvailabilitySync,
  keyHourlySettlementSweep,
  isHourlySettlementDue,
  isFixedDue,
  dueTminusMinutes,
  isSoccerLineupT45Due,
  SOCCER_LINEUP_T45_MINUTES,
  TMINUS_BANDS,
  // New helper functions
  getOddsIntervalMinutes,
  getScheduleRefreshDue,
  shouldRefreshOddsForGame,
  getPipelineHealthJobs,
};
