/**
 * Window-Based Scheduler — thin orchestrator; sport logic lives in sub-schedulers.
 *
 * Sub-schedulers (WI-0780):
 *   windows.js    — key builders, window predicates, isProjectionModelSport
 *   quota.js      — quota tier, freshness gates, odds health check
 *   nhl.js        — NHL model + availability + goalie + SOG + team stats
 *   nba.js        — NBA model + availability
 *   mlb.js        — MLB model + ESPN-direct seeding
 *   nfl.js        — NFL model
 *   settlement.js — settlement chain, splits, health report
 *   fpl.js        — FPL deadline scheduler
 *   player-props.js — player props scheduler
 */

'use strict';

require('dotenv').config();
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local'), override: false });
const fs = require('fs');
const path = require('path');

const { DateTime } = require('luxon');
const {
  getUpcomingGames, shouldRunJobKey, hasRunningJobRun, getQuotaLedger,
  claimTminusPullSlot,
  purgeStaleTminusPullLog, purgeStalePropOddsUsageLog, purgeExpiredPropEventMappings,
  recoverStaleJobRuns,
  wasJobKeyRecentlySuccessful,
} = require('@cheddar-logic/data');

const {
  isFixedDue, keyFixed, keyTminus, keyOddsHourly, keyEspnGamesDirect, keyNightlySweep,
  keyOddsNearTipBackstop,
  keyPullScheduleNba, keyPullScheduleNhl, keyDiscordCardsSnapshot,
  getOddsIntervalMinutes, getScheduleRefreshDue, shouldRefreshOddsForGame,
  dueTminusMinutes, TMINUS_BANDS,
  keyNhlPlayerAvailabilitySync, keyNhlGoalieStarters, keyNhlSogPlayerSync, keyNhlTeamStats,
  keyNbaPlayerAvailabilitySync,
  keySettlementHealthReport, keyHourlySettlementSweep, keyHourlySettlementJob,
  keyNightlySettlementJob, keyPublicSplits, keyVsinSplits,
  isHourlySettlementDue, isNightlySettlementOwningHourlyWindow,
  isNearTipOddsBackstopDue,
  isProjectionModelSport,
} = require('./windows');

const {
  getCurrentQuotaTier, logQuotaDailySummary,
  hasFreshInputsForModels,
  hasFreshTeamMetricsCache, checkOddsFreshnessHealth,
} = require('./quota');

const { pullOddsHourly } = require('../jobs/pull_odds_hourly');
const { pullEspnGamesDirect } = require('../jobs/pull_espn_games_direct');
const { refreshStaleOdds } = require('../jobs/refresh_stale_odds');
const { checkPipelineHealth, writePipelineHealth } = require('../jobs/check_pipeline_health');
const { runDrClaireHealthReport } = require('../jobs/dr_claire_health_report');
const { checkOddsHealth } = require('../jobs/check_odds_health');
const { run: refreshTeamMetricsDaily } = require('../jobs/refresh_team_metrics_daily');
const { pullScheduleNba } = require('../jobs/pull_schedule_nba');
const { pullScheduleNhl } = require('../jobs/pull_schedule_nhl');
const { pullNhlGameIds } = require('../jobs/pull_nhl_game_ids');
const { postDiscordCards } = require('../jobs/post_discord_cards');
const { runPotdEngine } = require('../jobs/potd/run_potd_engine');
const { mirrorPotdSettlement } = require('../jobs/potd/settlement-mirror');
const { runClvSnapshot } = require('../jobs/run_clv_snapshot');
const { runDailyPerformanceReport } = require('../jobs/run_daily_performance_report');
const { runCalibrationReport } = require('../jobs/run_calibration_report');
const { run: runFitCalibrationModels } = require('../jobs/fit_calibration_models');
const { run: runResidualValidation } = require('../jobs/run_residual_validation');
const { nightlyDbBackup } = require('../jobs/nightly_db_backup');

const { computeFplDueJobs } = require('./fpl');
const { computeNflDueJobs } = require('./nfl');
const { computePlayerPropsDueJobs } = require('./player-props');
const { computeNhlDueJobs } = require('./nhl');
const { computeNbaDueJobs } = require('./nba');
const { computeMlbDueJobs } = require('./mlb');
const { computeSettlementDueJobs } = require('./settlement');
const { SPORTS_CONFIG: ODDS_SPORTS_CONFIG } = require('@cheddar-logic/odds/src/config');

const TZ = process.env.TZ || 'America/New_York';
const REQUIRE_FRESH_ODDS_FOR_MODELS = process.env.REQUIRE_FRESH_ODDS_FOR_MODELS !== 'false';
const ENABLE_WITHOUT_ODDS_MODE = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true';
const MODEL_ODDS_MAX_AGE_MINUTES = Number(process.env.MODEL_ODDS_MAX_AGE_MINUTES) || Number(process.env.ODDS_GAP_ALERT_MINUTES) || 210;
const REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS = process.env.REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS !== 'false';
const TEAM_METRICS_MAX_AGE_MINUTES = Number(process.env.TEAM_METRICS_MAX_AGE_MINUTES) || 20 * 60;
const ODDS_FETCH_SLOT_MINUTES = Number(process.env.ODDS_FETCH_SLOT_MINUTES || 180);
const ODDS_FETCH_START_HOUR = Number(process.env.ODDS_FETCH_START_HOUR ?? 9);
const ENABLE_ODDS_BACKSTOP = process.env.ENABLE_ODDS_BACKSTOP === 'true';
const ENABLE_ODDS_NEAR_TIP_BACKSTOP = process.env.ENABLE_ODDS_NEAR_TIP_BACKSTOP !== 'false';
const ENABLE_PULL_SCHEDULE_NBA = process.env.ENABLE_PULL_SCHEDULE_NBA !== 'false';
const ENABLE_PULL_SCHEDULE_NHL = process.env.ENABLE_PULL_SCHEDULE_NHL !== 'false';
const ENABLE_POTD = process.env.ENABLE_POTD === 'true';
const SCHEDULER_HEARTBEAT_FILE =
  process.env.CHEDDAR_SCHEDULER_HEARTBEAT_FILE || '/opt/data/cheddar-worker-heartbeat.json';

const SPORT_JOBS = {
  nhl: { env: 'ENABLE_NHL_MODEL' },
  nba: { env: 'ENABLE_NBA_MODEL' },
  mlb: { env: 'ENABLE_MLB_MODEL' },
};

function enabledSports() {
  return Object.keys(SPORT_JOBS).filter((s) => {
    const envVal = process.env[SPORT_JOBS[s].env];
    return envVal !== 'false';
  });
}

function nowET() { return DateTime.now().setZone(TZ); }

function writeSchedulerHeartbeat(patch = {}) {
  try {
    const nowIso = new Date().toISOString();
    const current =
      fs.existsSync(SCHEDULER_HEARTBEAT_FILE)
        ? JSON.parse(fs.readFileSync(SCHEDULER_HEARTBEAT_FILE, 'utf8'))
        : {};
    const payload = {
      ...current,
      pid: process.pid,
      updated_at: nowIso,
      ...patch,
    };
    const dir = path.dirname(SCHEDULER_HEARTBEAT_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${SCHEDULER_HEARTBEAT_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.renameSync(tmp, SCHEDULER_HEARTBEAT_FILE);
  } catch (error) {
    console.warn(
      `[SCHEDULER] Heartbeat write failed (${SCHEDULER_HEARTBEAT_FILE}): ${error.message}`,
    );
  }
}

function computePotdScheduleMetadata(nowEt, games = []) {
  const eligibleSports = new Set(
    enabledSports().filter((sport) => ODDS_SPORTS_CONFIG[String(sport || '').toUpperCase()]),
  );
  const todayStart = nowEt.startOf('day');
  const todayEnd = todayStart.plus({ days: 1 });
  const windowStart = todayStart.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const windowEnd = todayStart.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });

  const todayGames = (Array.isArray(games) ? games : [])
    .filter((game) => eligibleSports.has(String(game?.sport || '').toLowerCase()))
    .map((game) => ({
      ...game,
      gameTimeEt: DateTime.fromISO(game.game_time_utc, { zone: 'utc' }).setZone(TZ),
    }))
    .filter((game) => game.gameTimeEt.isValid)
    .filter((game) => game.gameTimeEt >= todayStart && game.gameTimeEt < todayEnd)
    .sort((left, right) => left.gameTimeEt.toMillis() - right.gameTimeEt.toMillis());

  if (todayGames.length === 0) return null;

  const earliestGameEt = todayGames[0].gameTimeEt;
  const unclampedTarget = earliestGameEt.minus({ minutes: 90 });
  const targetPostTimeEt =
    unclampedTarget < windowStart
      ? windowStart
      : unclampedTarget > windowEnd
        ? windowEnd
        : unclampedTarget;
  const postDeadline = todayStart.set({ hour: 16, minute: 15, second: 0, millisecond: 0 });

  return {
    playDate: nowEt.toISODate(),
    earliestGameTimeEt: earliestGameEt.toISO(),
    targetPostTimeEt: targetPostTimeEt.toISO(),
    windowStartEt: windowStart.toISO(),
    windowEndEt: windowEnd.toISO(),
    postDeadlineEt: postDeadline.toISO(),
    windowCollapsed: targetPostTimeEt.toMillis() === windowEnd.toMillis(),
  };
}

function isModelJob(jobName) {
  return typeof jobName === 'string' && jobName.startsWith('run_') && jobName.endsWith('_model');
}

function getPipelineHealthJobs(nowUtc) {
  if (nowUtc.minute % 5 !== 0) return [];
  const jobKey = `health|watchdog|${nowUtc.toISO().slice(0, 16)}`;
  return [{ jobName: 'check_pipeline_health', jobKey, execute: checkPipelineHealth, args: { jobKey, dryRun: false }, reason: 'pipeline health watchdog (5-min cadence)' }];
}

function getDrClairePersistJobs(nowUtc) {
  if (nowUtc.minute % 5 !== 0) return [];
  const bucket = nowUtc.toISO().slice(0, 16);
  const jobKey = `health|dr-claire|${bucket}`;
  return [{
    jobName: 'dr_claire_health_report',
    jobKey,
    execute: runDrClaireHealthReport,
    args: {
      jobKey,
      dryRun: false,
      persist: true,
    },
    reason: 'dr claire model health snapshot (5-min cadence)',
  }];
}

function getOddsHealthJobs(nowUtc) {
  const minuteOfDay = nowUtc.hour * 60 + nowUtc.minute;
  if (minuteOfDay % 30 !== 0) return [];
  const slot = Math.floor(minuteOfDay / 30);
  const jobKey = `health|odds|${nowUtc.toISODate()}|s${String(slot).padStart(3, '0')}`;
  return [{ jobName: 'check_odds_health', jobKey, execute: checkOddsHealth, args: { jobKey, dryRun: false }, reason: 'odds freshness watchdog (30-min cadence)' }];
}

function computeDueJobs({ nowEt, nowUtc, games, dryRun }) {
  const jobs = [];
  let teamMetricsRefreshQueued = false;
  const quotaTier = getCurrentQuotaTier();
  if (quotaTier !== 'FULL') console.warn(`[QUOTA] Tier=${quotaTier} — T-minus and backstop odds pulls disabled this tick`);
  if (quotaTier === 'CRITICAL') console.error('[QUOTA] Tier=CRITICAL — all odds fetches halted for this tick');
  if (isFixedDue(nowEt, '09:00')) logQuotaDailySummary(quotaTier, nowEt);

  function maybeQueueTeamMetricsRefresh(reason, sport) {
    if (!isProjectionModelSport(sport)) return;
    if (!REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS || teamMetricsRefreshQueued || hasFreshTeamMetricsCache()) return;
    const jobKey = `refresh_team_metrics|${nowEt.toISODate()}`;
    jobs.push({ jobName: 'refresh_team_metrics_daily', jobKey, execute: refreshTeamMetricsDaily, args: { jobKey, dryRun }, reason: `pre-model team metrics refresh (${reason})` });
    teamMetricsRefreshQueued = true;
  }

  // ========== SCHEDULE PULLS (1) ==========
  const scheduleRefresh = getScheduleRefreshDue(nowEt);
  if (scheduleRefresh && ENABLE_PULL_SCHEDULE_NBA) {
    const jobKey = keyPullScheduleNba(nowEt);
    jobs.push({ jobName: 'pull_schedule_nba', jobKey, execute: pullScheduleNba, args: { jobKey, dryRun }, reason: `NBA schedule refresh (${scheduleRefresh.reason})` });
  }
  if (scheduleRefresh && ENABLE_PULL_SCHEDULE_NHL) {
    const jobKey = keyPullScheduleNhl(nowEt);
    jobs.push({ jobName: 'pull_schedule_nhl', jobKey, execute: pullScheduleNhl, args: { jobKey, dryRun }, reason: `NHL schedule refresh (${scheduleRefresh.reason})` });
  }

  // NHL gamecenter ID sync — runs once daily at 06:00 ET before settlement sweep
  if (isFixedDue(nowEt, '06:00')) {
    const jobKey = `pull|nhl-game-ids|${nowEt.toISODate()}`;
    jobs.push({ jobName: 'pull_nhl_game_ids', jobKey, execute: pullNhlGameIds, args: { jobKey, dryRun }, reason: `daily NHL gamecenter ID sync ${nowEt.toISODate()}` });
  }

  // ========== INGESTION / ODDS (2) ==========
  if (ENABLE_WITHOUT_ODDS_MODE && nowEt.hour >= ODDS_FETCH_START_HOUR) {
    const jobKey = keyEspnGamesDirect(nowEt);
    jobs.push({ jobName: 'pull_espn_games_direct', jobKey, execute: pullEspnGamesDirect, args: { jobKey, dryRun }, reason: `ESPN-direct ingestion (without-odds mode) slot=${ODDS_FETCH_SLOT_MINUTES}min` });
  }
  if (!ENABLE_WITHOUT_ODDS_MODE && process.env.ENABLE_ODDS_PULL !== 'false' && quotaTier !== 'CRITICAL' && nowEt.hour >= ODDS_FETCH_START_HOUR) {
    jobs.push({ jobName: 'pull_odds_hourly', jobKey: keyOddsHourly(nowEt), execute: pullOddsHourly, args: { jobKey: keyOddsHourly(nowEt), dryRun }, reason: `hourly bucket ${nowEt.toISODate()} ${nowEt.hour}h (slot=${ODDS_FETCH_SLOT_MINUTES}min)` });
    if (process.env.ENABLE_TIME_AWARE_ODDS === 'true') {
      for (const g of games.filter((g) => shouldRefreshOddsForGame(nowUtc, g))) {
        const sport = String(g.sport).toLowerCase();
        const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
        const jobKey = `odds|${sport}|${g.game_id}|${nowUtc.toISO().slice(0, 16)}`;
        jobs.push({ jobName: 'pull_odds_hourly', jobKey, execute: pullOddsHourly, args: { jobKey, game_id: g.game_id, dryRun }, reason: `time-aware odds (T-${Math.round(startUtc.diff(nowUtc, 'minutes').minutes)}m, interval ${getOddsIntervalMinutes(nowUtc, startUtc)}m)` });
      }
    }
    if (ENABLE_ODDS_BACKSTOP && quotaTier === 'FULL' && nowUtc.minute % 10 === 0) {
      const jobKey = `odds|global-backstop|${nowUtc.toISO().slice(0, 16)}`;
      jobs.push({ jobName: 'refresh_stale_odds', jobKey, execute: refreshStaleOdds, args: { jobKey, dryRun }, reason: 'global odds backstop (find + refresh stale snapshots within T-6h)' });
    }
    if (
      ENABLE_ODDS_NEAR_TIP_BACKSTOP &&
      quotaTier === 'FULL' &&
      isNearTipOddsBackstopDue(nowEt)
    ) {
      const jobKey = keyOddsNearTipBackstop(nowEt);
      jobs.push({
        jobName: 'refresh_stale_odds',
        jobKey,
        execute: refreshStaleOdds,
        args: { jobKey, dryRun },
        reason: `deterministic near-tip odds backstop (slot midpoint, every ${ODDS_FETCH_SLOT_MINUTES}m)`,
      });
    }
  }

  // ========== TEAM METRICS CACHE (2.5) ==========
  if (process.env.ENABLE_TEAM_METRICS_CACHE !== 'false' && isFixedDue(nowEt, '09:00')) {
    const jobKey = `refresh_team_metrics|${nowEt.toISODate()}`;
    jobs.push({ jobName: 'refresh_team_metrics_daily', jobKey, execute: refreshTeamMetricsDaily, args: { jobKey, dryRun }, reason: 'daily team metrics cache prewarm (09:00 ET)' });
  }

  // ========== DISCORD SNAPSHOT (3) ==========
  // Only push the latest due window to prevent catch-up storms sending duplicate snapshots.
  // If multiple windows are past-due (e.g. worker was down since 10:30 and restarts at 14:26),
  // only the most-recent window fires — the content would be identical for older windows anyway.
  if (process.env.ENABLE_DISCORD_CARD_WEBHOOKS === 'true' && String(process.env.DISCORD_CARD_WEBHOOK_URL || '').trim()) {
    const dueDiscordTimes = ['10:30', '12:30', '18:00'].filter((t) => isFixedDue(nowEt, t));
    if (dueDiscordTimes.length > 0) {
      const latestT = dueDiscordTimes[dueDiscordTimes.length - 1];
      const jobKey = keyDiscordCardsSnapshot(nowEt, latestT);
      jobs.push({ jobName: 'post_discord_cards', jobKey, execute: postDiscordCards, args: { jobKey, dryRun }, reason: `discord cards snapshot ${latestT} ET` });
    }
  }

  // ========== SPORT SUB-SCHEDULERS (WI-0780) ==========
  const subCtx = { nowUtc, games, dryRun, quotaTier, maybeQueueTeamMetricsRefresh, claimTminusPullSlot, pullOddsHourly, ENABLE_WITHOUT_ODDS_MODE, ODDS_SPORTS_CONFIG };
  jobs.push(...computeNhlDueJobs(nowEt, subCtx));
  jobs.push(...computeNbaDueJobs(nowEt, subCtx));
  jobs.push(...computeMlbDueJobs(nowEt, subCtx));
  // NFL betting domain is frozen (ENABLE_NFL_MODEL=false by default). computeNflDueJobs
  // returns [] with an explicit log when frozen — fail-closed guard per WI-1139.
  jobs.push(...computeNflDueJobs(nowEt, subCtx));
  const settlementJobs = computeSettlementDueJobs(nowEt, { nowUtc, dryRun, ENABLE_WITHOUT_ODDS_MODE });
  jobs.push(...settlementJobs);

  // ========== POTD (4.5) ==========
  if (ENABLE_POTD) {
    const meta = computePotdScheduleMetadata(nowEt, games);
    if (!meta) {
      console.warn('[POTD] No eligible games today — skipping');
    } else {
      const targetPostTimeEt = DateTime.fromISO(meta.targetPostTimeEt, { zone: TZ });
      const postDeadlineEt   = DateTime.fromISO(meta.postDeadlineEt,   { zone: TZ });

      if (meta.windowCollapsed) {
        console.warn(
          `[POTD] Window collapsed — all games tip after 5:30 PM ET. ` +
          `Effective window: [${targetPostTimeEt.toFormat('h:mm a')} – ${postDeadlineEt.toFormat('h:mm a')} ET]`,
        );
      }

      const publishJobKey = `potd|${nowEt.toISODate()}`;
      if (
        nowEt >= targetPostTimeEt &&
        nowEt <  postDeadlineEt &&
        shouldRunJobKey(publishJobKey)
      ) {
        jobs.push({
          jobName: 'run_potd_engine',
          jobKey:  publishJobKey,
          execute: runPotdEngine,
          args:    { jobKey: publishJobKey, dryRun, schedule: meta },
          reason:  `potd engine (${meta.targetPostTimeEt})`,
        });
      }

      const forceFallbackDeadline = postDeadlineEt.plus({ minutes: 15 });
      const fallbackJobKey   = `${publishJobKey}:fallback`;
      const alreadySucceeded = wasJobKeyRecentlySuccessful(publishJobKey, 300) ||
                                wasJobKeyRecentlySuccessful(fallbackJobKey, 300);

      if (
        nowEt >= postDeadlineEt &&
        nowEt <  forceFallbackDeadline &&
        !alreadySucceeded &&
        shouldRunJobKey(fallbackJobKey)
      ) {
        console.warn('[POTD] Primary window missed — firing fallback publish');
        jobs.push({
          jobName: 'run_potd_engine',
          jobKey:  fallbackJobKey,
          execute: runPotdEngine,
          args:    { jobKey: fallbackJobKey, dryRun, schedule: meta },
          reason:  `potd fallback engine (primary window missed, ${nowEt.toISO()})`,
        });
      }

      if (nowEt >= forceFallbackDeadline && !alreadySucceeded) {
        console.error(
          `[POTD] Hard deadline passed with no successful publish — ` +
          `manual review needed (date=${meta.playDate})`,
        );
      }
    }

    const settlementDue = settlementJobs.some((job) =>
      ['backfill_card_results', 'settle_game_results', 'settle_projections', 'settle_pending_cards']
        .includes(job.jobName),
    );
    if (settlementDue) {
      const mirrorJobKey = `potd-settlement|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
      jobs.push({
        jobName: 'mirror_potd_settlement',
        jobKey: mirrorJobKey,
        execute: mirrorPotdSettlement,
        args: { jobKey: mirrorJobKey, dryRun },
        reason: 'potd settlement mirror after canonical settlement jobs',
      });
      const shadowSettlementJobKey = `potd-shadow-settlement|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
      jobs.push({
        jobName: 'settle_potd_shadow_candidates',
        jobKey: shadowSettlementJobKey,
        execute: (args) => require('../jobs/potd/settle-shadow-candidates').settleShadowCandidates(args),
        args: { jobKey: shadowSettlementJobKey, dryRun },
        reason: 'potd near-miss shadow settlement after canonical settlement jobs',
      });
    }
  }

  // ========== NIGHTLY REPORTING: CLV SNAPSHOT + DAILY PERFORMANCE (4.9) ==========
  // nightly_db_backup: standalone daily backup independent of settlement jobs (02:00 ET).
  // Timer path (02:47 ET via cheddar-db-backup.timer) covers worker-down incidents.
  if (isFixedDue(nowEt, '02:00')) {
    const nightlyDbBackupKey = `nightly_db_backup|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'nightly_db_backup',
      jobKey: nightlyDbBackupKey,
      execute: () => nightlyDbBackup({ jobKey: nightlyDbBackupKey, dryRun }),
      args: {},
      reason: `nightly DB backup ${nowEt.toISODate()}`,
    });
  }
  // run_clv_snapshot: converts settled clv_ledger rows into clv_entries (03:00 ET)
  if (process.env.ENABLE_SETTLEMENT !== 'false' && isFixedDue(nowEt, '03:00')) {
    const clvSnapshotKey = `clv_snapshot|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'run_clv_snapshot',
      jobKey: clvSnapshotKey,
      execute: () => runClvSnapshot(),
      args: {},
      reason: `nightly CLV snapshot ${nowEt.toISODate()}`,
    });
  }
  // run_daily_performance_report: aggregates firing+winning metrics per market (03:30 ET)
  if (isFixedDue(nowEt, '03:30')) {
    const perfReportKey = `perf_report|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'run_daily_performance_report',
      jobKey: perfReportKey,
      execute: () => runDailyPerformanceReport(),
      args: {},
      reason: `nightly daily performance report ${nowEt.toISODate()}`,
    });
  }
  // run_residual_validation: Pearson r + quartile hit rate for residual signal (04:30 ET)
  if (process.env.ENABLE_SETTLEMENT !== 'false' && isFixedDue(nowEt, '04:30')) {
    const residualValKey = `run_residual_validation|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'run_residual_validation',
      jobKey: residualValKey,
      execute: () => runResidualValidation(),
      args: {},
      reason: `daily residual validation ${nowEt.toISODate()}`,
    });
  }
  // run_calibration_report: ECE per market + kill switch refresh (04:00 ET)
  if (process.env.ENABLE_SETTLEMENT !== 'false' && isFixedDue(nowEt, '04:00')) {
    const calibrationReportKey = `calibration_report|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'run_calibration_report',
      jobKey: calibrationReportKey,
      execute: () => runCalibrationReport(),
      args: {},
      reason: `nightly calibration report + kill switch refresh ${nowEt.toISODate()}`,
    });
  }
  // fit_calibration_models: fit per-market isotonic regression on historical fair_prob (06:00 ET)
  if (process.env.ENABLE_SETTLEMENT !== 'false' && isFixedDue(nowEt, '06:00')) {
    const fitCalibrationKey = `fit_calibration_models|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'fit_calibration_models',
      jobKey: fitCalibrationKey,
      execute: () => runFitCalibrationModels(),
      args: {},
      reason: `daily calibration model fit ${nowEt.toISODate()}`,
    });
  }

  // ========== WATCHDOGS / FPL / PLAYER-PROPS (5-8) ==========
  if (process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG !== 'false') {
    jobs.push(...getPipelineHealthJobs(nowUtc));
    jobs.push(...getDrClairePersistJobs(nowUtc));
  }
  if (process.env.ENABLE_ODDS_HEALTH_WATCHDOG !== 'false') jobs.push(...getOddsHealthJobs(nowUtc));
  // FPL is a standalone Python app (cheddar-fpl-sage/) — no main-worker DB integration.
  // Set ENABLE_FPL_MODEL=false to disable entirely (default in env.example). See ADR-0011.
  jobs.push(...computeFplDueJobs(nowEt, { dryRun }));
  jobs.push(...computePlayerPropsDueJobs(nowEt, { games, dryRun, quotaTier }));

  return jobs;
}

async function tick() {
  const dryRun = process.env.DRY_RUN === 'true';
  const nowEt = nowET();
  const nowUtc = DateTime.utc();
  checkOddsFreshnessHealth(nowUtc);
  const games = getUpcomingGames({ startUtcIso: nowUtc.minus({ hours: 1 }).toISO(), endUtcIso: nowUtc.plus({ hours: 36 }).toISO(), sports: enabledSports() });
  const seen = new Set();
  const uniqueDue = computeDueJobs({ nowEt, nowUtc, games, dryRun }).filter((j) => { if (seen.has(j.jobKey)) return false; seen.add(j.jobKey); return true; });
  console.log(`[SCHEDULER] Tick ${nowEt.toISO()} ET — due candidates: ${uniqueDue.length}`);
  for (const job of uniqueDue) {
    if (isModelJob(job.jobName)) {
      const requireFreshInputs = job.requireFreshInputs !== false;
      const jobWithoutOddsMode = job.withoutOddsMode !== undefined ? job.withoutOddsMode : ENABLE_WITHOUT_ODDS_MODE;
      const freshnessSources =
        Array.isArray(job.freshnessSourceJobs) && job.freshnessSourceJobs.length > 0
          ? job.freshnessSourceJobs
          : [jobWithoutOddsMode ? 'pull_espn_games_direct' : 'pull_odds_hourly'];
      if (requireFreshInputs && !hasFreshInputsForModels({ requireFresh: REQUIRE_FRESH_ODDS_FOR_MODELS, withoutOddsMode: jobWithoutOddsMode, maxAgeMinutes: MODEL_ODDS_MAX_AGE_MINUTES })) {
        const gateSource = freshnessSources.join(', ');
        console.warn(`[SCHEDULER][GATE] Skipping ${job.jobName} (${job.jobKey}): no successful ${gateSource} in last ${MODEL_ODDS_MAX_AGE_MINUTES} minutes`);
        console.log(`  skip ${job.jobKey} (${job.jobName}) — stale inputs`);
        continue;
      }
      if (!requireFreshInputs && job.runMode === 'PROJECTION_ONLY') {
        console.log(
          `  note ${job.jobKey} (${job.jobName}) — projection-only run ungated; seed freshness reported separately via ${freshnessSources.join(', ')}`,
        );
      }
    }
    if (!shouldRunJobKey(job.jobKey)) { console.log(`  skip ${job.jobKey} (${job.jobName})`); continue; }
    if (hasRunningJobRun(job.jobKey)) { console.log(`  running ${job.jobKey} (${job.jobName})`); continue; }
    if (dryRun) { console.log(`  DRY_RUN would run ${job.jobKey} (${job.jobName}) — ${job.reason}`); continue; }
    console.log(`  run ${job.jobKey} (${job.jobName}) — ${job.reason}`);
    try { await job.execute(job.args); } catch (err) {
      console.error(`  ${job.jobKey} failed:`, err.message);
      try { writePipelineHealth(job.jobName, 'job_execution', 'failed', err.message); } catch (_e) { /* DB may be unavailable */ }
    }
  }
}

async function start() {
  const tickMs = Number(process.env.TICK_MS || 60_000);
  console.log(`\n${'='.repeat(60)}\n  CHEDDAR-LOGIC WINDOW SCHEDULER (Tick Loop)\n${'='.repeat(60)}`);
  if (ENABLE_WITHOUT_ODDS_MODE) console.log('  *** WITHOUT ODDS MODE — ESPN-direct ingestion, PROJECTION_ONLY, no settlement ***');
  console.log(`  TZ=${TZ} | TICK_MS=${tickMs} | DRY_RUN=${process.env.DRY_RUN || 'false'} | enabled_sports=${enabledSports().join(',') || 'none'}`);
  console.log(`  ENABLE_ODDS_PULL=${process.env.ENABLE_ODDS_PULL !== 'false'} | ODDS_FETCH_SLOT_MINUTES=${ODDS_FETCH_SLOT_MINUTES} | ODDS_FETCH_START_HOUR=${ODDS_FETCH_START_HOUR}h ET`);
  console.log(`  REQUIRE_FRESH_ODDS=${REQUIRE_FRESH_ODDS_FOR_MODELS} | MODEL_ODDS_MAX_AGE=${MODEL_ODDS_MAX_AGE_MINUTES}min | REQUIRE_FRESH_TEAM_METRICS=${REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS}`);
  console.log(`  ENABLE_SETTLEMENT=${process.env.ENABLE_SETTLEMENT !== 'false'} | ENABLE_HOURLY_SETTLEMENT_SWEEP=${process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP !== 'false'}`);
  console.log(`  ENABLE_POTD=${ENABLE_POTD}`);
  console.log('='.repeat(60) + '\n');

  console.log('[SCHEDULER] Database ready.');
  writeSchedulerHeartbeat({
    state: 'starting',
    tick_ms: tickMs,
    timezone: TZ,
    enabled_sports: enabledSports(),
  });
  purgeStaleTminusPullLog();
  purgeStalePropOddsUsageLog();
  purgeExpiredPropEventMappings();
  const staleLocks = recoverStaleJobRuns();
  if (staleLocks > 0) console.log(`[SCHEDULER] Stale lock recovery: ${staleLocks} orphaned job_run(s) recovered.`);

  const MAX_TICK_MS = Number(process.env.MAX_TICK_MS || 900_000); // 15 minutes default
  let tickRunning = false;
  function runTick() {
    if (tickRunning) {
      console.log('[SCHEDULER] Skipping tick — previous tick still running');
      writeSchedulerHeartbeat({
        state: 'tick_skipped_lock_held',
        last_tick_skipped_at: new Date().toISOString(),
      });
      return;
    }
    tickRunning = true;
    const tickStartedAt = new Date().toISOString();
    writeSchedulerHeartbeat({
      state: 'running',
      last_tick_started_at: tickStartedAt,
    });
    const tickDeadline = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[SCHEDULER] Tick exceeded MAX_TICK_MS=${MAX_TICK_MS}ms — releasing lock`)), MAX_TICK_MS),
    );
    Promise.race([tick(), tickDeadline])
      .then(() => {
        writeSchedulerHeartbeat({
          state: 'idle',
          last_tick_completed_at: new Date().toISOString(),
          last_tick_ok: true,
          last_tick_error: null,
        });
      })
      .catch((err) => {
        console.error('[SCHEDULER] tick error', err);
        writeSchedulerHeartbeat({
          state: 'tick_error',
          last_tick_completed_at: new Date().toISOString(),
          last_tick_ok: false,
          last_tick_error: err?.message || String(err),
        });
      })
      .finally(() => { tickRunning = false; });
  }
  runTick();
  const interval = setInterval(runTick, tickMs);
  process.on('SIGTERM', () => {
    clearInterval(interval);
    writeSchedulerHeartbeat({ state: 'stopping', stop_signal: 'SIGTERM' });
    console.log('\n[SCHEDULER] SIGTERM, exiting...');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    clearInterval(interval);
    writeSchedulerHeartbeat({ state: 'stopping', stop_signal: 'SIGINT' });
    console.log('\n[SCHEDULER] SIGINT, exiting...');
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    writeSchedulerHeartbeat({
      state: 'crashed',
      crash_type: 'uncaughtException',
      crash_message: err?.message || String(err),
    });
    console.error('[SCHEDULER] uncaughtException — exiting:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    writeSchedulerHeartbeat({
      state: 'crashed',
      crash_type: 'unhandledRejection',
      crash_message:
        reason && typeof reason === 'object' && reason.message
          ? reason.message
          : String(reason),
    });
    console.error('[SCHEDULER] unhandledRejection — exiting:', reason);
    process.exit(1);
  });
}

if (require.main === module) start();

module.exports = {
  start, tick, computeDueJobs, enabledSports,
  keyOddsHourly, keyFixed, keyDiscordCardsSnapshot, keyTminus, keyNightlySweep,
  keyOddsNearTipBackstop,
  keyNhlPlayerAvailabilitySync, keyNhlGoalieStarters, keyNhlSogPlayerSync,
  keySettlementHealthReport, keyHourlySettlementSweep, keyHourlySettlementJob, keyNightlySettlementJob,
  isHourlySettlementDue, isFixedDue, isNearTipOddsBackstopDue, dueTminusMinutes, TMINUS_BANDS,
  getOddsIntervalMinutes, getScheduleRefreshDue, shouldRefreshOddsForGame,
  getPipelineHealthJobs, getDrClairePersistJobs, getOddsHealthJobs, keyPullScheduleNba, keyPullScheduleNhl,
  computePotdScheduleMetadata,
};
