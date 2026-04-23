'use strict';

/**
 * NFL Sub-Scheduler
 *
 * Handles NFL model job registration at fixed and T-minus windows.
 * Imported by schedulers/main.js — receives context params to avoid circular deps.
 *
 * Interface:
 *   computeNflDueJobs(nowEt, { nowUtc, games, dryRun, quotaTier,
 *     maybeQueueTeamMetricsRefresh, claimTminusPullSlot, pullOddsHourly,
 *     ENABLE_WITHOUT_ODDS_MODE })
 *
 * Windows:
 *   Fixed: 09:00 ET, 12:00 ET
 *   T-minus: T-120, T-90, T-60, T-30 (per NFL game)
 */

const { isFixedDue, keyFixed, keyTminus, dueTminusMinutes } = require('./windows');
const { runNFLModel } = require('../jobs/run_nfl_model');

/**
 * Compute due NFL jobs for this tick
 * @param {DateTime} nowEt - Current ET time
 * @param {object} ctx - Scheduler context
 * @returns {Array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeNflDueJobs(nowEt, {
  nowUtc,
  games,
  dryRun,
  quotaTier,
  maybeQueueTeamMetricsRefresh,
  claimTminusPullSlot,
  pullOddsHourly,
  ENABLE_WITHOUT_ODDS_MODE,
}) {
  if (process.env.ENABLE_NFL_MODEL === 'false') {
    console.log('[NFL][FROZEN] NFL betting domain is frozen — ENABLE_NFL_MODEL=false. No jobs enqueued.');
    return [];
  }

  const jobs = [];

  // ========== NFL FIXED-TIME MODEL RUNS ==========
  const fixedTimes = ['09:00', '12:00'];
  for (const t of fixedTimes) {
    if (!isFixedDue(nowEt, t)) continue;
    maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, 'nfl');
    const jobKey = keyFixed('nfl', nowEt, t);
    jobs.push({
      jobName: 'run_nfl_model',
      jobKey,
      execute: runNFLModel,
      args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
      reason: `fixed ${t} ET${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
    });
  }

  // ========== NFL T-MINUS MODEL RUNS ==========
  // NFL is not a projection-model sport (NBA/NHL only), so no pre-model odds pull.
  // Still runs the T-minus model window for fresh spread/total lines before kickoff.
  const hourSlot = nowUtc.toISO().slice(0, 13); // YYYY-MM-DDTHH
  const nflGames = games.filter((g) => String(g.sport).toLowerCase() === 'nfl');

  for (const g of nflGames) {
    const { DateTime } = require('luxon');
    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      maybeQueueTeamMetricsRefresh(`T-${mins} for ${g.game_id}`, 'nfl');

      const jobKey = keyTminus('nfl', g.game_id, mins);
      jobs.push({
        jobName: 'run_nfl_model',
        jobKey,
        execute: runNFLModel,
        args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
        reason: `T-${mins} for ${g.game_id}${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  return jobs;
}

module.exports = { computeNflDueJobs };
