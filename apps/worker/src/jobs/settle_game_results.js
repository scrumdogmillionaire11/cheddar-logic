/**
 * Settle Game Results Job
 *
 * Fetches final scores from ESPN public scoreboard for completed games
 * and upserts them into the game_results table (Gap 1 from SETTLEMENT_AUDIT.md).
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/settle_game_results.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:settle-games)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

'use strict';

const { v4: uuidV4 } = require('uuid');

const {
  upsertGameResult,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb
} = require('@cheddar-logic/data');

const { espnGet } = require('../espn-client');

/**
 * ESPN sport path mapping
 * Keys are uppercase sport codes from our games table
 */
const ESPN_SPORT_MAP = {
  NHL:   'hockey/nhl',
  NBA:   'basketball/nba',
  NCAAM: 'basketball/mens-college-basketball',
};

/**
 * Case-insensitive substring team name matching.
 * Returns true if any word from espnName appears in our team name (or vice versa).
 * @param {string} ourName - Team name from our games table
 * @param {string} espnName - ESPN competitor displayName
 * @returns {boolean}
 */
function teamsMatch(ourName, espnName) {
  if (!ourName || !espnName) return false;
  const a = ourName.toLowerCase();
  const b = espnName.toLowerCase();
  // Try substring match in either direction first
  if (a.includes(b) || b.includes(a)) return true;
  // Word-level: any word from ESPN display name found in our name
  const espnWords = b.split(/\s+/).filter(w => w.length > 2);
  return espnWords.some(word => a.includes(word));
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 * @param {number} options.minHoursAfterStart - Minimum hours after start time before settling
 */
async function settleGameResults({ jobKey = null, dryRun = false, minHoursAfterStart = 3 } = {}) {
  const jobRunId = `job-settle-games-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[SettleGames] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[SettleGames] Job key: ${jobKey}`);
  }
  console.log(`[SettleGames] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[SettleGames] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(`[SettleGames] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      console.log('[SettleGames] Recording job start...');
      insertJobRun('settle_game_results', jobRunId, jobKey);

      const db = getDatabase();
      const now = new Date();
      const safeHoursAfterStart = Number.isFinite(minHoursAfterStart) ? Math.max(0, minHoursAfterStart) : 3;
      // Allow faster settlement when upstream confirms status is final
      const cutoffUtc = new Date(now.getTime() - safeHoursAfterStart * 60 * 60 * 1000).toISOString();

      // Query games that are past the cutoff and not yet in game_results as 'final'
      const pendingGamesStmt = db.prepare(`
        SELECT g.game_id, g.sport, g.home_team, g.away_team, g.game_time_utc
        FROM games g
        WHERE g.game_time_utc < ?
          AND g.game_id NOT IN (
            SELECT game_id FROM game_results WHERE status = 'final'
          )
        ORDER BY g.game_time_utc ASC
      `);

      const pendingGames = pendingGamesStmt.all(cutoffUtc);
      console.log(`[SettleGames] Found ${pendingGames.length} unsettled past games`);

      if (pendingGames.length === 0) {
        markJobRunSuccess(jobRunId);
        console.log('[SettleGames] Job complete — 0 games settled (none pending)');
        return { success: true, jobRunId, jobKey, gamesSettled: 0, sportsProcessed: [], errors: [] };
      }

      // Group games by sport for ESPN API efficiency
      const bySport = {};
      for (const game of pendingGames) {
        const sport = String(game.sport).toUpperCase();
        if (!bySport[sport]) bySport[sport] = [];
        bySport[sport].push(game);
      }

      let gamesSettled = 0;
      const sportsProcessed = [];
      const errors = [];

      for (const [sport, sportGames] of Object.entries(bySport)) {
        const espnPath = ESPN_SPORT_MAP[sport];
        if (!espnPath) {
          console.log(`[SettleGames] No ESPN mapping for sport: ${sport} — skipping`);
          continue;
        }

        console.log(`[SettleGames] Fetching ESPN scoreboard for ${sport} (${espnPath})...`);

        const scoreboardData = await espnGet(`${espnPath}/scoreboard`);
        if (!scoreboardData || !scoreboardData.events) {
          console.warn(`[SettleGames] No scoreboard data returned for ${sport}`);
          errors.push(`${sport}: ESPN scoreboard returned no data`);
          continue;
        }

        const events = scoreboardData.events;
        console.log(`[SettleGames] ${sport}: ${events.length} ESPN events, ${sportGames.length} DB games to match`);
        sportsProcessed.push(sport);

        // Only work with completed events
        const completedEvents = events.filter(e => {
          return e.competitions?.[0]?.status?.type?.completed === true;
        });

        console.log(`[SettleGames] ${sport}: ${completedEvents.length} completed events on ESPN`);

        for (const dbGame of sportGames) {
          // Try to find a matching ESPN event
          let matched = null;
          let homeScore = null;
          let awayScore = null;

          for (const event of completedEvents) {
            const comp = event.competitions?.[0];
            if (!comp) continue;

            const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
            const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
            if (!homeComp || !awayComp) continue;

            const espnHomeName = homeComp.team?.displayName || '';
            const espnAwayName = awayComp.team?.displayName || '';

            if (teamsMatch(dbGame.home_team, espnHomeName) && teamsMatch(dbGame.away_team, espnAwayName)) {
              matched = event;
              homeScore = parseFloat(homeComp.score) || 0;
              awayScore = parseFloat(awayComp.score) || 0;
              break;
            }
          }

          if (!matched) {
            console.warn(`[SettleGames] No ESPN match for: ${dbGame.game_id} (${dbGame.home_team} vs ${dbGame.away_team})`);
            continue;
          }

          console.log(`[SettleGames] Settling ${dbGame.game_id}: ${dbGame.home_team} ${homeScore} - ${awayScore} ${dbGame.away_team}`);

          if (dryRun) {
            console.log(`[SettleGames] DRY_RUN: would upsert game_result for ${dbGame.game_id}`);
            gamesSettled++;
            continue;
          }

          try {
            upsertGameResult({
              id: `result-${dbGame.game_id}-${Date.now()}`,
              gameId: dbGame.game_id,
              sport: dbGame.sport,
              finalScoreHome: homeScore,
              finalScoreAway: awayScore,
              status: 'final',
              resultSource: 'primary_api',
              settledAt: new Date().toISOString(),
              metadata: { espnEventId: matched.id }
            });
            gamesSettled++;
          } catch (gameErr) {
            console.error(`[SettleGames] Error upserting result for ${dbGame.game_id}: ${gameErr.message}`);
            errors.push(`${dbGame.game_id}: ${gameErr.message}`);
          }
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(`[SettleGames] Job complete — ${gamesSettled} games settled across ${sportsProcessed.join(', ') || 'no sports'}`);

      if (errors.length > 0) {
        console.log(`[SettleGames] ${errors.length} errors:`);
        errors.forEach(e => console.log(`  - ${e}`));
      }

      return { success: true, jobRunId, jobKey, gamesSettled, sportsProcessed, errors };

    } catch (error) {
      console.error(`[SettleGames] Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[SettleGames] Failed to record error to DB:`, dbError.message);
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  settleGameResults()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { settleGameResults };
