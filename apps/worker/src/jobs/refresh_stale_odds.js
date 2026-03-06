/**
 * Refresh Stale Odds Job
 *
 * Global backstop job that runs every 10 minutes to:
 * 1. Find games within T-6h with stale odds (snapshots older than recommended interval)
 * 2. Re-pull odds for those games
 * 3. Write new snapshots
 *
 * This acts as a safety net when time-aware per-game pulls miss a window.
 *
 * Portable job runner that can be called from:
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (node apps/worker/src/jobs/refresh_stale_odds.js)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');

// Import cheddar-logic data layer
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  getDatabase,
  upsertGame,
  insertOddsSnapshot,
  withDb,
} = require('@cheddar-logic/data');

// Import odds fetching package
const {
  fetchOdds,
  getActiveSports,
} = require('@cheddar-logic/odds');

/**
 * Get odds interval minutes based on time-to-start
 * (Copied from scheduler helper)
 */
function getOddsIntervalMinutes(minsUntilStart) {
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
 * Find games within T-6h that have stale odds
 */
function findGamesWithStaleOdds() {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc.minus({ minutes: 30 }); // Include games that just started
  const endUtc = nowUtc.plus({ hours: 6 }); // T-6h window

  // Find all games within window
  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, sport, game_time_utc
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
      AND LOWER(status) NOT IN ('final', 'ft', 'completed', 'cancelled')
    ORDER BY game_time_utc ASC
  `,
    )
    .all(startUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    console.log('[RefreshStaleOdds] No games within T-6h window');
    return [];
  }

  console.log(
    `[RefreshStaleOdds] Found ${upcomingGames.length} games within T-6h`,
  );

  // For each game, check if latest odds snapshot is stale
  const staleGames = [];

  for (const game of upcomingGames) {
    const gameTimeUtc = DateTime.fromISO(game.game_time_utc, { zone: 'utc' });
    const minsUntilStart = Math.round(gameTimeUtc.diff(nowUtc, 'minutes').minutes);
    const targetInterval = getOddsIntervalMinutes(minsUntilStart);

    if (!targetInterval) {
      continue; // Too far out or too old
    }

    // Get latest odds snapshot for this game
    const latestOdds = db
      .prepare(
        `
      SELECT captured_at
      FROM odds_snapshots
      WHERE game_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `,
      )
      .get(game.game_id);

    if (!latestOdds) {
      // No odds at all — mark as stale
      staleGames.push({
        game_id: game.game_id,
        sport: game.sport,
        game_time_utc: game.game_time_utc,
        minsUntilStart,
        targetInterval,
        lastOddsAge: null,
        reason: 'no_odds',
      });
      continue;
    }

    // Check if latest snapshot is older than target interval
    const capturedAt = DateTime.fromISO(latestOdds.captured_at, { zone: 'utc' });
    const ageMinutes = Math.round(nowUtc.diff(capturedAt, 'minutes').minutes);

    if (ageMinutes > targetInterval) {
      staleGames.push({
        game_id: game.game_id,
        sport: game.sport,
        game_time_utc: game.game_time_utc,
        minsUntilStart,
        targetInterval,
        lastOddsAge: ageMinutes,
        reason: 'stale',
      });
    }
  }

  return staleGames;
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function refreshStaleOdds({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-refresh-stale-odds-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[RefreshStaleOdds] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[RefreshStaleOdds] Job key: ${jobKey}`);
  }
  console.log(`[RefreshStaleOdds] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[RefreshStaleOdds] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[RefreshStaleOdds] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      // Start job run
      console.log('[RefreshStaleOdds] Recording job start...');
      insertJobRun('refresh_stale_odds', jobRunId, jobKey);

      // Find games with stale odds
      const staleGames = findGamesWithStaleOdds();

      if (staleGames.length === 0) {
        console.log('[RefreshStaleOdds] ✅ No stale odds found — all fresh');
        markJobRunSuccess(jobRunId, {
          gamesChecked: 0,
          staleGames: 0,
          snapshotsInserted: 0,
        });
        return {
          success: true,
          jobRunId,
          gamesChecked: 0,
          staleGames: 0,
          snapshotsInserted: 0,
        };
      }

      console.log(`[RefreshStaleOdds] Found ${staleGames.length} games with stale odds:`);
      for (const g of staleGames.slice(0, 5)) {
        console.log(
          `  - ${g.game_id} (T-${g.minsUntilStart}m, last: ${g.lastOddsAge || 'never'}m, target: ${g.targetInterval}m)`,
        );
      }
      if (staleGames.length > 5) {
        console.log(`  ... and ${staleGames.length - 5} more`);
      }

      // Group by sport (API calls are sport-level)
      const sportMap = {};
      for (const g of staleGames) {
        const sport = String(g.sport).toLowerCase();
        if (!sportMap[sport]) sportMap[sport] = [];
        sportMap[sport].push(g);
      }

      const activeSports = getActiveSports();
      let snapshotsInserted = 0;
      const errors = [];

      // Re-fetch odds for each sport that has stale games
      for (const sport of Object.keys(sportMap)) {
        if (!activeSports.includes(sport)) {
          console.log(
            `[RefreshStaleOdds] Skipping ${sport} (not in active sports)`,
          );
          continue;
        }

        const gamesForSport = sportMap[sport];
        console.log(
          `[RefreshStaleOdds] Re-fetching odds for ${sport} (${gamesForSport.length} stale games)`,
        );

        try {
          const {
            games: normalizedGames,
            errors: fetchErrors,
          } = await fetchOdds({
            sport,
            hoursAhead: 6, // Only fetch T-6h window
          });

          if (fetchErrors && fetchErrors.length > 0) {
            fetchErrors.forEach((errorMessage) => {
              console.error(`[RefreshStaleOdds]   ❌ ${errorMessage}`);
              errors.push(`${sport}: ${errorMessage}`);
            });
          }

          if (!normalizedGames || normalizedGames.length === 0) {
            console.log(`[RefreshStaleOdds]   No games returned for ${sport}`);
            continue;
          }

          console.log(
            `[RefreshStaleOdds]   Fetched ${normalizedGames.length} games`,
          );

          // Insert new odds snapshots for stale games only
          const staleGameIds = new Set(
            gamesForSport.map((g) => g.game_id.split('-').pop()),
          );

          for (const normalized of normalizedGames) {
            if (!staleGameIds.has(normalized.gameId)) {
              continue; // Skip games that aren't stale
            }

            try {
              const stableGameId = `game-${sport.toLowerCase()}-${normalized.gameId}`;

              // Update game record (may have status changes)
              upsertGame({
                id: stableGameId,
                gameId: normalized.gameId,
                sport: normalized.sport,
                homeTeam: normalized.homeTeam,
                awayTeam: normalized.awayTeam,
                gameTimeUtc: normalized.gameTimeUtc,
                status: normalized.status || 'scheduled',
              });

              // Insert fresh odds snapshot
              insertOddsSnapshot({
                id: `odds-${sport.toLowerCase()}-${normalized.gameId}-${uuidV4().slice(0, 8)}`,
                gameId: normalized.gameId,
                sport: normalized.sport,
                capturedAt: normalized.capturedAtUtc,
                h2hHome: normalized.odds?.h2hHome,
                h2hAway: normalized.odds?.h2hAway,
                total: normalized.odds?.total,
                totalPriceOver: normalized.odds?.totalPriceOver,
                totalPriceUnder: normalized.odds?.totalPriceUnder,
                spreadHome: normalized.odds?.spreadHome,
                spreadAway: normalized.odds?.spreadAway,
                spreadPriceHome: normalized.odds?.spreadPriceHome,
                spreadPriceAway: normalized.odds?.spreadPriceAway,
                monelineHome: normalized.odds?.monelineHome,
                monelineAway: normalized.odds?.monelineAway,
                rawData: normalized.market,
                jobRunId,
              });
              snapshotsInserted++;
            } catch (gameErr) {
              errors.push(
                `${sport}/${normalized?.gameId || 'unknown'}: ${gameErr.message}`,
              );
            }
          }
        } catch (sportErr) {
          console.error(
            `[RefreshStaleOdds] Error fetching ${sport}:`,
            sportErr,
          );
          errors.push(`${sport}: ${sportErr.message}`);
        }
      }

      // Mark success
      const summary = {
        staleGames: staleGames.length,
        snapshotsInserted,
        errors: errors.length > 0 ? errors : undefined,
      };

      markJobRunSuccess(jobRunId, summary);

      console.log(
        `[RefreshStaleOdds] ✅ Completed: ${snapshotsInserted} new snapshots inserted`,
      );
      if (errors.length > 0) {
        console.warn(
          `[RefreshStaleOdds] ⚠️  ${errors.length} errors encountered (see logs)`,
        );
      }

      return {
        success: true,
        jobRunId,
        ...summary,
      };
    } catch (error) {
      console.error('[RefreshStaleOdds] ❌ Job failed:', error);
      markJobRunFailure(jobRunId, error.message);
      throw error;
    }
  });
}

// CLI execution
if (require.main === module) {
  console.log('[RefreshStaleOdds] Running as standalone CLI job...');
  refreshStaleOdds({ dryRun: process.env.DRY_RUN === 'true' })
    .then((result) => {
      console.log('[RefreshStaleOdds] Job completed:', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('[RefreshStaleOdds] Job failed:', error);
      process.exit(1);
    });
}

module.exports = { refreshStaleOdds };
