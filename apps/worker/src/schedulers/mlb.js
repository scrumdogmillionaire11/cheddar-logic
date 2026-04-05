'use strict';

/**
 * MLB Sub-Scheduler
 *
 * Handles MLB job registrations including:
 * - ESPN-direct game seeding (2B) — when MLB odds are disabled but model is enabled
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
  const ENABLE_MLB_MODEL = process.env.ENABLE_MLB_MODEL !== 'false';
  const ODDS_FETCH_START_HOUR = Number(process.env.ODDS_FETCH_START_HOUR ?? 9);

  if (!ENABLE_MLB_MODEL) return [];

  const jobs = [];

  // ========== MLB ESPN-DIRECT SEEDING (2B) ==========
  // When MLB odds are disabled in config (projection-only period) but the model is enabled,
  // use pull_espn_games_direct to seed MLB game records so runMLBModel can find them.
  // This is independent of the global ENABLE_WITHOUT_ODDS_MODE — NBA/NHL still use live odds.
  if (!ENABLE_WITHOUT_ODDS_MODE && !ODDS_SPORTS_CONFIG.MLB.active) {
    const isQuietHours = nowEt.hour < ODDS_FETCH_START_HOUR;
    if (!isQuietHours) {
      const jobKey = keyEspnGamesDirect(nowEt);
      jobs.push({
        jobName: 'pull_espn_games_direct',
        jobKey,
        execute: pullEspnGamesDirect,
        args: { jobKey, dryRun },
        reason: 'MLB ESPN-direct game seeding (MLB odds inactive, projection-only)',
      });
    }
  }

  // ========== MLB FIXED-TIME MODEL RUNS ==========
  const fixedTimes = ['09:00', '12:00'];
  for (const t of fixedTimes) {
    if (!isFixedDue(nowEt, t)) continue;
    maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, 'mlb');
    const jobKey = keyFixed('mlb', nowEt, t);
    jobs.push({
      jobName: 'run_mlb_model',
      jobKey,
      execute: runMLBModel,
      args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
      reason: `fixed ${t} ET${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
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
        execute: runMLBModel,
        args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
        reason: `T-${mins} for ${g.game_id}${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  return jobs;
}

module.exports = { computeMlbDueJobs };
