'use strict';

/**
 * NBA Sub-Scheduler
 *
 * Handles NBA job registrations including:
 * - Player availability sync (2.8b) — hourly
 * - NBA model at fixed (09:00, 12:00 ET) and T-minus windows
 *
 * Interface:
 *   computeNbaDueJobs(nowEt, { nowUtc, games, dryRun, quotaTier,
 *     maybeQueueTeamMetricsRefresh, claimTminusPullSlot, pullOddsHourly,
 *     ENABLE_WITHOUT_ODDS_MODE })
 */

const {
  isFixedDue,
  keyFixed,
  keyTminus,
  dueTminusMinutes,
  keyNbaPlayerAvailabilitySync,
} = require('./windows');

const { runNBAModel } = require('../jobs/run_nba_model');
const { syncNbaPlayerAvailability } = require('../jobs/sync_nba_player_availability');
const { isFeatureEnabled } = require('@cheddar-logic/data/src/feature-flags');

/**
 * Compute due NBA jobs for this tick
 * @param {DateTime} nowEt - Current ET time
 * @param {object} ctx - Scheduler context
 * @returns {Array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeNbaDueJobs(nowEt, {
  nowUtc,
  games,
  dryRun,
  quotaTier,
  maybeQueueTeamMetricsRefresh,
  claimTminusPullSlot,
  pullOddsHourly,
  ENABLE_WITHOUT_ODDS_MODE,
}) {
  const ENABLE_NBA_MODEL = isFeatureEnabled('nba', 'model');
  const ENABLE_NBA_PLAYER_AVAILABILITY_SYNC = isFeatureEnabled('nba', 'player-availability-sync');

  if (!ENABLE_NBA_MODEL && !ENABLE_NBA_PLAYER_AVAILABILITY_SYNC) return [];

  const jobs = [];

  // ========== NBA PLAYER AVAILABILITY SYNC (2.8b) ==========
  // Hourly injury/availability poll to keep NBA player_availability fresh so
  // run_nba_model.js can apply the key-player gate.
  if (ENABLE_NBA_PLAYER_AVAILABILITY_SYNC) {
    const jobKey = keyNbaPlayerAvailabilitySync(nowEt);
    jobs.push({
      jobName: 'sync_nba_player_availability',
      jobKey,
      execute: syncNbaPlayerAvailability,
      args: { jobKey, dryRun },
      reason: `hourly NBA player availability sync (${nowEt.toISODate()} ${nowEt.hour}h)`,
    });
  }

  if (!ENABLE_NBA_MODEL) return jobs;

  // ========== NBA FIXED-TIME MODEL RUNS ==========
  const fixedTimes = ['09:00', '12:00'];
  for (const t of fixedTimes) {
    if (!isFixedDue(nowEt, t)) continue;
    maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, 'nba');
    const jobKey = keyFixed('nba', nowEt, t);
    jobs.push({
      jobName: 'run_nba_model',
      jobKey,
      execute: runNBAModel,
      args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
      reason: `fixed ${t} ET${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
    });
  }

  // ========== NBA T-MINUS MODEL RUNS ==========
  const hourSlot = nowUtc.toISO().slice(0, 13); // YYYY-MM-DDTHH
  const nbaGames = games.filter((g) => String(g.sport).toLowerCase() === 'nba');

  for (const g of nbaGames) {
    const { DateTime } = require('luxon');
    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      maybeQueueTeamMetricsRefresh(`T-${mins} for ${g.game_id}`, 'nba');

      const jobKey = keyTminus('nba', g.game_id, mins);
      // NBA is a projection-model sport: force fresh odds pull before T-minus model.
      // Deduped per sport per T-minus window via claimTminusPullSlot.
      if (
        !ENABLE_WITHOUT_ODDS_MODE &&
        process.env.ENABLE_ODDS_PULL !== 'false' &&
        quotaTier === 'FULL'
      ) {
        const oddsWindowKey = `nba|T-${mins}|${hourSlot}`;
        if (claimTminusPullSlot('nba', oddsWindowKey)) {
          const oddsPreKey = `odds|pre-model|nba|T-${mins}`;
          jobs.push({
            jobName: 'pull_odds_hourly',
            jobKey: oddsPreKey,
            execute: pullOddsHourly,
            args: { jobKey: oddsPreKey, dryRun },
            reason: `pre-model odds refresh (T-${mins}, nba)`,
          });
        }
      }
      jobs.push({
        jobName: 'run_nba_model',
        jobKey,
        execute: runNBAModel,
        args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
        reason: `T-${mins} for ${g.game_id}${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  return jobs;
}

module.exports = { computeNbaDueJobs };
