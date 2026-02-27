/**
 * Pull Odds Hourly Job
 * 
 * Fetches current odds from The Odds API and persists both:
 * - game records (with start times)
 * - odds snapshots
 * 
 * Makes games table authoritative for scheduler time-window queries.
 * 
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/pull_odds_hourly.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:pull-odds)
 * 
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

const { v4: uuidV4 } = require('uuid');

// Import cheddar-logic data layer
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertGame,
  insertOddsSnapshot,
  withDb
} = require('@cheddar-logic/data');

// Import odds fetching package (no DB writes)
const { fetchOdds } = require('@cheddar-logic/odds');

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function pullOddsHourly({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-pull-odds-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[PullOdds] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[PullOdds] Job key: ${jobKey}`);
  }
  console.log(`[PullOdds] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[PullOdds] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(`[PullOdds] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      // Start job run
      console.log('[PullOdds] Recording job start...');
      insertJobRun('pull_odds_hourly', jobRunId, jobKey);
  
      // Fetch odds for active sports
      const activeSports = ['NHL', 'NBA', 'MLB', 'NFL'];
      console.log(`[PullOdds] Fetching odds for: ${activeSports.join(', ')}`);
  
      let gamesUpserted = 0;
      let snapshotsInserted = 0;
      let skippedMissingFields = 0;
      const errors = [];

      for (const sport of activeSports) {
        try {
          console.log(`[PullOdds] Processing ${sport}...`);

          const { games: normalizedGames, errors: fetchErrors, rawCount } = await fetchOdds({
            sport,
            hoursAhead: 36
          });

          if (fetchErrors && fetchErrors.length > 0) {
            fetchErrors.forEach(errorMessage => {
              console.error(`[PullOdds]   ❌ ${errorMessage}`);
              errors.push(`${sport}: ${errorMessage}`);
            });
          }

          // Accumulate skipped game count
          skippedMissingFields += (rawCount - (normalizedGames ? normalizedGames.length : 0));

          // Contract check: fail job if normalization drops >40% of games
          if (rawCount > 0 && normalizedGames.length < rawCount * 0.6) {
            console.error(`[PullOdds] CONTRACT VIOLATION: ${sport} normalized ${normalizedGames.length}/${rawCount} games (threshold 60%). Marking job failed.`);
            markJobRunFailure(jobRunId, `Normalization dropped too many games for ${sport}: ${normalizedGames.length}/${rawCount}`);
            return { success: false, jobRunId, jobKey, contractViolation: true, sport, normalizedCount: normalizedGames.length, rawCount };
          }

          if (!normalizedGames || normalizedGames.length === 0) {
            console.log(`[PullOdds]   No games returned for ${sport}`);
            continue;
          }

          console.log(`[PullOdds]   Fetched ${normalizedGames.length} games`);

          for (const normalized of normalizedGames) {
            try {
              // Upsert game record with deterministic stable ID
              const stableGameId = `game-${sport.toLowerCase()}-${normalized.gameId}`;
              upsertGame({
                id: stableGameId,
                gameId: normalized.gameId,
                sport: normalized.sport,
                homeTeam: normalized.homeTeam,
                awayTeam: normalized.awayTeam,
                gameTimeUtc: normalized.gameTimeUtc,
                status: 'scheduled'
              });
              gamesUpserted++;

              // Insert odds snapshot
              insertOddsSnapshot({
                id: `odds-${sport.toLowerCase()}-${normalized.gameId}-${uuidV4().slice(0, 8)}`,
                gameId: normalized.gameId,
                sport: normalized.sport,
                capturedAt: normalized.capturedAtUtc,
                h2hHome: normalized.odds?.h2hHome,
                h2hAway: normalized.odds?.h2hAway,
                total: normalized.odds?.total,
                spreadHome: normalized.odds?.spreadHome,
                spreadAway: normalized.odds?.spreadAway,
                monelineHome: normalized.odds?.monelineHome,
                monelineAway: normalized.odds?.monelineAway,
                rawData: normalized.market,
                jobRunId
              });
              snapshotsInserted++;
            } catch (gameErr) {
              errors.push(`${sport}/${normalized?.gameId || 'unknown'}: ${gameErr.message}`);
            }
          }
        } catch (sportErr) {
          console.error(`[PullOdds]   ❌ Error fetching ${sport}: ${sportErr.message}`);
          errors.push(`${sport}: ${sportErr.message}`);
        }
      }

      // Mark success
      markJobRunSuccess(jobRunId);
      console.log(`[PullOdds] ✅ Job complete: ${gamesUpserted} games upserted, ${snapshotsInserted} snapshots inserted`);
      
      if (errors.length > 0) {
        console.log(`[PullOdds] ⚠️  ${errors.length} errors:`);
        errors.forEach(e => console.log(`  - ${e}`));
      }

      return { success: true, jobRunId, jobKey, gamesUpserted, snapshotsInserted, skippedMissingFields, errors };
  
    } catch (error) {
      console.error(`[PullOdds] ❌ Job failed:`, error.message);
      console.error(error.stack);
  
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[PullOdds] Failed to record error to DB:`, dbError.message);
      }
  
      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  pullOddsHourly()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { pullOddsHourly };

