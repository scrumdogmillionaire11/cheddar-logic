'use strict';

/**
 * NHL Sub-Scheduler
 *
 * Handles NHL job registrations including:
 * - SOG player ID sync (2.55) — daily 04:00 ET
 * - Team stats pull (2.6) — daily 06:00 ET
 * - Player availability sync (2.8) — hourly
 * - Goalie starters pre-fetch (2.9) — hourly
 * - NHL model at fixed (09:00, 12:00 ET) and T-minus windows
 *
 * Interface:
 *   computeNhlDueJobs(nowEt, { nowUtc, games, dryRun, quotaTier,
 *     maybeQueueTeamMetricsRefresh, claimTminusPullSlot, pullOddsHourly,
 *     ENABLE_WITHOUT_ODDS_MODE })
 */

const {
  isFixedDue,
  keyFixed,
  keyTminus,
  dueTminusMinutes,
  keyNhlPlayerAvailabilitySync,
  keyNhlGoalieStarters,
  keyNhlSogPlayerSync,
  keyNhlTeamStats,
} = require('./windows');

const { runNHLModel } = require('../jobs/run_nhl_model');
const { syncNhlPlayerAvailability } = require('../jobs/sync_nhl_player_availability');
const { pullNhlGoalieStarters } = require('../jobs/pull_nhl_goalie_starters');
const { syncNhlSogPlayerIds } = require('../jobs/sync_nhl_sog_player_ids');
const { pullNhlTeamStats } = require('../jobs/pull_nhl_team_stats');
const { isFeatureEnabled } = require('@cheddar-logic/data/src/feature-flags');

/**
 * Compute due NHL jobs for this tick
 * @param {DateTime} nowEt - Current ET time
 * @param {object} ctx - Scheduler context
 * @returns {Array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeNhlDueJobs(nowEt, {
  nowUtc,
  games,
  dryRun,
  quotaTier,
  maybeQueueTeamMetricsRefresh,
  claimTminusPullSlot,
  pullOddsHourly,
  ENABLE_WITHOUT_ODDS_MODE,
}) {
  const ENABLE_NHL_MODEL = isFeatureEnabled('nhl', 'model');
  const ENABLE_NHL_PLAYER_AVAILABILITY_SYNC = isFeatureEnabled('nhl', 'player-availability-sync');
  const ENABLE_NHL_GOALIE_STARTERS = isFeatureEnabled('nhl', 'goalie-starters');
  const ENABLE_NHL_SOG_PLAYER_SYNC = isFeatureEnabled('nhl', 'sog-sync');

  if (
    !ENABLE_NHL_MODEL &&
    !ENABLE_NHL_PLAYER_AVAILABILITY_SYNC &&
    !ENABLE_NHL_GOALIE_STARTERS &&
    !ENABLE_NHL_SOG_PLAYER_SYNC
  ) return [];

  const jobs = [];

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

  // ========== NHL GOALIE STARTERS PRE-FETCH (2.9) ==========
  if (ENABLE_NHL_GOALIE_STARTERS) {
    const jobKey = keyNhlGoalieStarters(nowEt);
    jobs.push({
      jobName: 'pull_nhl_goalie_starters',
      jobKey,
      execute: pullNhlGoalieStarters,
      args: { jobKey, dryRun },
      reason: `hourly NHL goalie starter pre-fetch (${nowEt.toISODate()} ${nowEt.hour}h)`,
    });
  }

  if (!ENABLE_NHL_MODEL) return jobs;

  // ========== NHL FIXED-TIME MODEL RUNS ==========
  const fixedTimes = ['09:00', '12:00'];
  for (const t of fixedTimes) {
    if (!isFixedDue(nowEt, t)) continue;
    maybeQueueTeamMetricsRefresh(`fixed ${t} ET`, 'nhl');
    const jobKey = keyFixed('nhl', nowEt, t);
    jobs.push({
      jobName: 'run_nhl_model',
      jobKey,
      execute: runNHLModel,
      args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
      reason: `fixed ${t} ET${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
    });
  }

  // ========== NHL T-MINUS MODEL RUNS ==========
  const hourSlot = nowUtc.toISO().slice(0, 13); // YYYY-MM-DDTHH
  const nhlGames = games.filter((g) => String(g.sport).toLowerCase() === 'nhl');

  for (const g of nhlGames) {
    const { DateTime } = require('luxon');
    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      maybeQueueTeamMetricsRefresh(`T-${mins} for ${g.game_id}`, 'nhl');

      const jobKey = keyTminus('nhl', g.game_id, mins);
      // NHL is a projection-model sport: force fresh odds pull before T-minus model.
      // Deduped per sport per T-minus window via claimTminusPullSlot.
      if (
        !ENABLE_WITHOUT_ODDS_MODE &&
        process.env.ENABLE_ODDS_PULL !== 'false' &&
        quotaTier === 'FULL'
      ) {
        const oddsWindowKey = `nhl|T-${mins}|${hourSlot}`;
        if (claimTminusPullSlot('nhl', oddsWindowKey)) {
          const oddsPreKey = `odds|pre-model|nhl|T-${mins}`;
          jobs.push({
            jobName: 'pull_odds_hourly',
            jobKey: oddsPreKey,
            execute: pullOddsHourly,
            args: { jobKey: oddsPreKey, dryRun },
            reason: `pre-model odds refresh (T-${mins}, nhl)`,
          });
        }
      }
      jobs.push({
        jobName: 'run_nhl_model',
        jobKey,
        execute: runNHLModel,
        args: { jobKey, dryRun, withoutOddsMode: ENABLE_WITHOUT_ODDS_MODE },
        reason: `T-${mins} for ${g.game_id}${ENABLE_WITHOUT_ODDS_MODE ? ' [WITHOUT_ODDS]' : ''}`,
      });
    }
  }

  return jobs;
}

module.exports = { computeNhlDueJobs };
