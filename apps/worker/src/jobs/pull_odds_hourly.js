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

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

// Import cheddar-logic data layer
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertGame,
  insertOddsSnapshot,
  recordOddsIngestFailure,
  withDb,
} = require('@cheddar-logic/data');

const { resolveTeamVariant } = require('@cheddar-logic/data/src/normalize');

const { validateMarketContract } = require('@cheddar-logic/odds/src/normalize');

const { settleGameResults } = require('./settle_game_results');
const { settlePendingCards } = require('./settle_pending_cards');

// Import odds fetching package (no DB writes)
const {
  fetchOdds,
  getActiveSports,
  getTokensForFetch,
} = require('@cheddar-logic/odds');

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
      console.log(
        `[PullOdds] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[PullOdds] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      // Start job run
      console.log('[PullOdds] Recording job start...');
      insertJobRun('pull_odds_hourly', jobRunId, jobKey);

      // Fetch odds for active sports (driven by packages/odds/src/config.js active flags)
      // To add/remove sports, update the `active` field in config.js — not here.
      const activeSports = getActiveSports();

      // Token math (2026-03-07, optimized schedule):
      // NHL:   2 tokens/fetch × 21 fetches/day = 42 tokens/day
      // NBA:   3 tokens/fetch × 21 fetches/day = 63 tokens/day
      // NCAAM: 3 tokens/fetch × 21 fetches/day = 63 tokens/day
      // Total: 8 tokens/fetch × 21 fetches/day = 168 tokens/day
      // Skips 2am-5am ET (3 hours) when no games occur
      // The Odds API free tier: 500 tokens/month → not viable for production
      // Paid tier: 20,000 tokens/month → 168/day = 5,040/month (25% utilization)
      const tokenCost = getTokensForFetch(activeSports);
      console.log(
        `[PullOdds] Active sports (from config): ${activeSports.join(', ')} | tokens/fetch: ${tokenCost} | ~${tokenCost * 21}/day (skip 2am-5am)`,
      );
      console.log(`[PullOdds] Fetching odds for: ${activeSports.join(', ')}`);

      let gamesUpserted = 0;
      let snapshotsInserted = 0;
      let skippedMissingFields = 0;
      const errors = [];
      const kpis = {
        sportsProcessed: 0,
        rawGamesSeen: 0,
        normalizedGamesSeen: 0,
        fetchErrors: 0,
        fetchExceptions: 0,
        contractViolationSports: 0,
        teamMappingUnmapped: 0,
        marketSourceIncomplete: 0,
        gameWriteErrors: 0,
        gamesUpserted: 0,
        snapshotsInserted: 0,
      };

      const recordFailure = ({
        reasonCode,
        reasonDetail,
        sport,
        gameId,
        homeTeam,
        awayTeam,
        sourceContext,
      }) => {
        try {
          recordOddsIngestFailure({
            jobRunId,
            jobName: 'pull_odds_hourly',
            provider: 'odds_api',
            reasonCode,
            reasonDetail,
            sport,
            gameId,
            homeTeam,
            awayTeam,
            sourceContext,
          });
        } catch (failureErr) {
          console.warn(
            `[PullOdds] Failed to persist ingest failure ${reasonCode}: ${failureErr.message}`,
          );
        }
      };

      for (const sport of activeSports) {
        kpis.sportsProcessed += 1;
        try {
          console.log(`[PullOdds] Processing ${sport}...`);

          const {
            games: normalizedGames,
            errors: fetchErrors,
            rawCount,
          } = await fetchOdds({
            sport,
            hoursAhead: 36,
          });

          kpis.rawGamesSeen += Number(rawCount || 0);
          kpis.normalizedGamesSeen += Number(normalizedGames?.length || 0);

          if (fetchErrors && fetchErrors.length > 0) {
            fetchErrors.forEach((errorMessage) => {
              console.error(`[PullOdds]   ❌ ${errorMessage}`);
              errors.push(`${sport}: ${errorMessage}`);
              kpis.fetchErrors += 1;
              recordFailure({
                reasonCode: 'FETCH_ODDS_ERROR',
                reasonDetail: String(errorMessage),
                sport,
                sourceContext: {
                  rawCount,
                  normalizedCount: normalizedGames?.length || 0,
                },
              });
            });
          }

          // Accumulate skipped game count
          skippedMissingFields +=
            rawCount - (normalizedGames ? normalizedGames.length : 0);

          // Contract check: skip this sport if normalization drops >40% of games
          // Use continue (not return) so other sports are not aborted
          if (rawCount > 0 && normalizedGames.length < rawCount * 0.6) {
            const msg = `CONTRACT VIOLATION: ${sport} normalized ${normalizedGames.length}/${rawCount} games (threshold 60%) — skipping sport`;
            console.error(`[PullOdds] ${msg}`);
            errors.push(`${sport}: ${msg}`);
            kpis.contractViolationSports += 1;
            recordFailure({
              reasonCode: 'SOURCE_CONTRACT_VIOLATION',
              reasonDetail: msg,
              sport,
              sourceContext: {
                rawCount,
                normalizedCount: normalizedGames.length,
              },
            });
            continue;
          }

          if (!normalizedGames || normalizedGames.length === 0) {
            console.log(`[PullOdds]   No games returned for ${sport}`);
            continue;
          }

          console.log(`[PullOdds]   Fetched ${normalizedGames.length} games`);

          for (const normalized of normalizedGames) {
            try {
              // Validate team variant mapping before persisting
              const homeVariant = resolveTeamVariant(
                normalized.homeTeam,
                `pull-odds:${sport}`,
              );
              const awayVariant = resolveTeamVariant(
                normalized.awayTeam,
                `pull-odds:${sport}`,
              );

              if (!homeVariant.matched || !awayVariant.matched) {
                const msg = `TEAM_MAPPING_UNMAPPED: game=${normalized.gameId} sport=${sport} home="${normalized.homeTeam}"(matched=${homeVariant.matched}) away="${normalized.awayTeam}"(matched=${awayVariant.matched})`;
                console.warn(`[PullOdds]   ⚠️  ${msg}`);
                errors.push(`${sport}/${normalized.gameId}: ${msg}`);
                kpis.teamMappingUnmapped += 1;
                recordFailure({
                  reasonCode: 'TEAM_MAPPING_UNMAPPED',
                  reasonDetail: msg,
                  sport,
                  gameId: normalized.gameId,
                  homeTeam: normalized.homeTeam,
                  awayTeam: normalized.awayTeam,
                  sourceContext: {
                    homeMatched: homeVariant.matched,
                    awayMatched: awayVariant.matched,
                  },
                });
                continue; // Skip unmapped teams entirely
              }

              // Validate required market contract before persisting
              const marketContract = validateMarketContract(normalized, sport);
              if (!marketContract.marketOk) {
                const msg = `MARKET_SOURCE_INCOMPLETE: game=${normalized.gameId} sport=${sport} missing=[${marketContract.missing.join(',')}]`;
                console.warn(`[PullOdds]   ⚠️  ${msg}`);
                errors.push(`${sport}/${normalized.gameId}: ${msg}`);
                kpis.marketSourceIncomplete += 1;
                recordFailure({
                  reasonCode: 'MARKET_SOURCE_INCOMPLETE',
                  reasonDetail: msg,
                  sport,
                  gameId: normalized.gameId,
                  homeTeam: normalized.homeTeam,
                  awayTeam: normalized.awayTeam,
                  sourceContext: {
                    missingMarkets: marketContract.missing,
                  },
                });
                continue; // Skip incomplete markets entirely
              }

              // Upsert game record with deterministic stable ID
              const stableGameId = `game-${sport.toLowerCase()}-${normalized.gameId}`;
              upsertGame({
                id: stableGameId,
                gameId: normalized.gameId,
                sport: normalized.sport,
                homeTeam: normalized.homeTeam,
                awayTeam: normalized.awayTeam,
                gameTimeUtc: normalized.gameTimeUtc,
                status: 'scheduled',
              });
              gamesUpserted++;
              kpis.gamesUpserted += 1;

              // Insert odds snapshot
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
              kpis.snapshotsInserted += 1;
            } catch (gameErr) {
              errors.push(
                `${sport}/${normalized?.gameId || 'unknown'}: ${gameErr.message}`,
              );
              kpis.gameWriteErrors += 1;
              recordFailure({
                reasonCode: 'ODDS_WRITE_ERROR',
                reasonDetail: gameErr.message,
                sport,
                gameId: normalized?.gameId,
                homeTeam: normalized?.homeTeam,
                awayTeam: normalized?.awayTeam,
              });
            }
          }
        } catch (sportErr) {
          console.error(
            `[PullOdds]   ❌ Error fetching ${sport}: ${sportErr.message}`,
          );
          errors.push(`${sport}: ${sportErr.message}`);
          kpis.fetchExceptions += 1;
          recordFailure({
            reasonCode: 'FETCH_ODDS_EXCEPTION',
            reasonDetail: sportErr.message,
            sport,
          });
        }
      }

      // Mark success
      markJobRunSuccess(jobRunId);
      console.log(
        `[PullOdds] ✅ Job complete: ${gamesUpserted} games upserted, ${snapshotsInserted} snapshots inserted`,
      );
      console.log('[PullOdds] KPI summary:', kpis);

      if (errors.length > 0) {
        console.log(`[PullOdds] ⚠️  ${errors.length} errors:`);
        errors.forEach((e) => console.log(`  - ${e}`));
      }

      if (process.env.ENABLE_SETTLEMENT !== 'false') {
        const settleKey = jobKey
          ? `settle|after-odds|${jobKey}`
          : `settle|after-odds|${jobRunId}`;
        console.log(
          `[PullOdds] Triggering settlement sweep after odds update (${settleKey})...`,
        );

        try {
          await settleGameResults({
            jobKey: `${settleKey}|games`,
            dryRun,
            minHoursAfterStart: 0,
          });

          await settlePendingCards({
            jobKey: `${settleKey}|cards`,
            dryRun,
          });
        } catch (settleErr) {
          console.warn(
            `[PullOdds] Settlement sweep failed: ${settleErr.message}`,
          );
        }
      }

      return {
        success: true,
        jobRunId,
        jobKey,
        gamesUpserted,
        snapshotsInserted,
        skippedMissingFields,
        kpis,
        errors,
      };
    } catch (error) {
      console.error(`[PullOdds] ❌ Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[PullOdds] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  pullOddsHourly()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { pullOddsHourly };
