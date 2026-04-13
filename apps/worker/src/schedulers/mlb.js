'use strict';

/**
 * MLB Sub-Scheduler
 *
 * Handles MLB job registrations including:
 * - ESPN-direct game seeding only for true without-odds mode fallback
 * - MLB model at fixed (09:00, 12:00 ET) and T-minus windows
 *
 * Interface:
 *   computeMlbDueJobs(nowEt, { nowUtc, games, dryRun, quotaTier,
 *     maybeQueueTeamMetricsRefresh, claimTminusPullSlot, pullOddsHourly,
 *     ENABLE_WITHOUT_ODDS_MODE, ODDS_SPORTS_CONFIG })
 */

const {
  isFixedDue,
  keyFixed,
  keyTminus,
  dueTminusMinutes,
  keyEspnGamesDirect,
} = require('./windows');

const { runMLBModel } = require('../jobs/run_mlb_model');
const { pullEspnGamesDirect } = require('../jobs/pull_espn_games_direct');

/**
 * Compute due MLB jobs for this tick
 * @param {DateTime} nowEt - Current ET time
 * @param {object} ctx - Scheduler context
 * @returns {Array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeMlbDueJobs(nowEt, {
  nowUtc,
  games,
  dryRun,
  quotaTier,
  maybeQueueTeamMetricsRefresh,
  claimTminusPullSlot,
  pullOddsHourly,
  ENABLE_WITHOUT_ODDS_MODE,
  ODDS_SPORTS_CONFIG,
}) {
  const ENABLE_MLB_MODEL = isFeatureEnabled('mlb', 'model');
  const ODDS_FETCH_START_HOUR = Number(process.env.ODDS_FETCH_START_HOUR ?? 9);

  if (!ENABLE_MLB_MODEL) return [];

  // MLB runs odds-backed by default. ESPN-direct seeding is only used for the
  // true global without-odds fallback mode.
  const mlbWithoutOddsMode = ENABLE_WITHOUT_ODDS_MODE;

  const jobs = [];

  // ========== MLB ESPN-DIRECT SEEDING (2B) ==========
  // Only used in true without-odds mode so MLB model runs can still find games.
  if (ENABLE_WITHOUT_ODDS_MODE) {
    const isQuietHours = nowEt.hour < ODDS_FETCH_START_HOUR;
    if (!isQuietHours) {
      const jobKey = keyEspnGamesDirect(nowEt);
      jobs.push({
        jobName: 'pull_espn_games_direct',
        jobKey,
        execute: pullEspnGamesDirect,
        args: { jobKey, dryRun },
        reason: 'MLB ESPN-direct game seeding (without-odds fallback)',
      });
    }
  }

  // ========== MLB FIXED-TIME MODEL RUNS ==========
  // Three anchors keep model_freshness (MODEL_FRESHNESS_MAX_AGE_MINUTES, default 4h) satisfied:
  //   09:00 → covers until 13:00
  //   12:00 → covers until 16:00
  //   15:00 → covers until 19:00, after which T-minus runs carry the load
  const fixedTimes = ['09:00', '12:00', '15:00'];
  for (const t of fixedTimes) {
    if (!isFixedDue(nowEt, t)) continue;
    maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, 'mlb');
    const jobKey = keyFixed('mlb', nowEt, t);
    jobs.push({
      jobName: 'run_mlb_model',
      jobKey,
      requireFreshInputs: !mlbWithoutOddsMode,
      freshnessSourceJobs: mlbWithoutOddsMode
        ? ['pull_espn_games_direct']
        : ['pull_odds_hourly'],
      runMode: mlbWithoutOddsMode ? 'PROJECTION_ONLY' : 'ODDS_BACKED',
      withoutOddsMode: mlbWithoutOddsMode,
      execute: runMLBModel,
      args: { jobKey, dryRun, withoutOddsMode: mlbWithoutOddsMode },
      reason: `fixed ${t} ET${mlbWithoutOddsMode ? ' [WITHOUT_ODDS]' : ''}`,
    });
  }

  // ========== MLB T-MINUS MODEL RUNS ==========
  // MLB is not a projection-model sport (NBA/NHL only), so no pre-model odds pull via T-minus.
  const mlbGames = games.filter((g) => String(g.sport).toLowerCase() === 'mlb');
  const hourSlot = nowUtc.toISO().slice(0, 13); // YYYY-MM-DDTHH

  for (const g of mlbGames) {
    const { DateTime } = require('luxon');
    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      maybeQueueTeamMetricsRefresh(`T-${mins} for ${g.game_id}`, 'mlb');

      const jobKey = keyTminus('mlb', g.game_id, mins);
      jobs.push({
        jobName: 'run_mlb_model',
        jobKey,
        requireFreshInputs: !mlbWithoutOddsMode,
        freshnessSourceJobs: mlbWithoutOddsMode
          ? ['pull_espn_games_direct']
          : ['pull_odds_hourly'],
        runMode: mlbWithoutOddsMode ? 'PROJECTION_ONLY' : 'ODDS_BACKED',
        withoutOddsMode: mlbWithoutOddsMode,
        execute: runMLBModel,
        args: { jobKey, dryRun, withoutOddsMode: mlbWithoutOddsMode },
        reason: `T-${mins} for ${g.game_id}${mlbWithoutOddsMode ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  return jobs;
}

module.exports = { computeMlbDueJobs };
