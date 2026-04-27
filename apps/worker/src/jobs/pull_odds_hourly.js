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

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../.env') });
const { v4: uuidV4 } = require('uuid');

// Import cheddar-logic data layer
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  getDatabase,
  upsertGame,
  insertOddsSnapshot,
  recordOddsIngestFailure,
  withDb,
  getQuotaLedger,
  upsertQuotaLedger,
  isQuotaCircuitOpen,
  resolveSnapshotAge,
  enrichOddsSnapshotWithEspnMetrics,
} = require('@cheddar-logic/data');

const { resolveTeamVariant } = require('@cheddar-logic/data/src/normalize');

const { validateMarketContract } = require('@cheddar-logic/odds/src/normalize');

const { settleGameResults } = require('./settle_game_results');
const { settleProjections } = require('./settle_projections');
const { settlePendingCards } = require('./settle_pending_cards');

// Import odds fetching package (no DB writes)
const {
  fetchOdds,
  getActiveSports,
  getTokensForFetch,
} = require('@cheddar-logic/odds');

const PREGAME_STATUSES = new Set(['scheduled', 'not_started', 'pre']);

// In-memory 401 circuit breaker — set when any sport fetch returns HTTP 401.
// Also backed by DB-persisted circuit_open_until (survives restarts).
let _apiKeyExhaustedAt = null;
const ODDS_401_COOLDOWN_MS =
  Number(process.env.ODDS_401_COOLDOWN_MS) || 2 * 60 * 60 * 1000; // 2h default

const QUOTA_PROVIDER = 'odds_api';
function getCurrentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getTokenCostPerFetch() {
  // Token cost is determined once per invocation — same value used for all sports
  const {
    getActiveSports,
    getTokensForFetch,
  } = require('@cheddar-logic/odds');
  return getTokensForFetch(getActiveSports());
}

function chooseStatusForUpsert(existingStatus, incomingStatus) {
  const existing =
    typeof existingStatus === 'string' && existingStatus.trim().length > 0
      ? existingStatus.trim()
      : null;
  const incoming =
    typeof incomingStatus === 'string' && incomingStatus.trim().length > 0
      ? incomingStatus.trim()
      : null;

  if (!incoming) {
    return existing || 'scheduled';
  }

  const incomingLower = incoming.toLowerCase();
  const existingLower = existing ? existing.toLowerCase() : null;

  if (
    existingLower &&
    !PREGAME_STATUSES.has(existingLower) &&
    PREGAME_STATUSES.has(incomingLower)
  ) {
    return existing;
  }

  return incoming;
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function pullOddsHourly({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-pull-odds-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  // Dev environment hard gate — local must never hit the live odds API
  if (process.env.APP_ENV === 'local' && process.env.ENABLE_ODDS_PULL === 'true') {
    throw new Error(
      '[PullOdds] Dev environment must not hit the odds API. ' +
        'Set ENABLE_ODDS_PULL=false in .env, or use a read-only prod DB mount. ' +
        'See ARCHITECTURE_SEPARATION.md for the sshfs mount command.',
    );
  }

  // Circuit breaker — check both in-memory flag and DB-persisted state (survives restarts)
  const _period = getCurrentPeriod();
  if (_apiKeyExhaustedAt !== null) {
    const elapsed = Date.now() - _apiKeyExhaustedAt;
    if (elapsed < ODDS_401_COOLDOWN_MS) {
      const remainingMins = Math.ceil((ODDS_401_COOLDOWN_MS - elapsed) / 60000);
      console.warn(
        `[PullOdds] 🔴 Circuit open (in-memory) — API key exhausted ${Math.floor(elapsed / 60000)}m ago. Skipping for ${remainingMins}m more.`,
      );
      return { success: false, skipped: true, reason: '401_circuit_open', jobKey };
    }
    // Cooldown expired — reset and try again
    console.log('[PullOdds] In-memory circuit cooldown expired — resetting flag.');
    _apiKeyExhaustedAt = null;
  }
  // DB-persisted circuit check (survives process restarts)
  try {
    const dbCircuit = isQuotaCircuitOpen(QUOTA_PROVIDER, _period);
    if (dbCircuit.open) {
      console.warn(
        `[PullOdds] 🔴 Circuit open (DB-persisted) — reason: ${dbCircuit.reason}, until: ${dbCircuit.until}. Skipping.`,
      );
      return { success: false, skipped: true, reason: 'db_circuit_open', jobKey };
    }
  } catch (_circuitErr) {
    // DB not yet initialized (e.g. migration not run) — fall through to in-memory guard
  }

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

      // Token math (featured markets only; per-event/alternate markets removed):
      // NHL:   1 token/fetch × 5 fetches/day  =  5 tokens/day  (180-min slots, START_HOUR=10)
      // NBA:   2 tokens/fetch × 5 fetches/day = 10 tokens/day
      // MLB:   DISABLED — active:false in config. No odds-backed model. ESPN-direct seeds games.
      // Total: 3 tokens/fetch × 5 fetches/day = 15 tokens/day
      // April 2026 budget: 2,000 tokens. 15/day × 28 days = 420 tokens → 1,580 buffer.
      // Paid tier (normal): 20,000 tokens/month. Restore MLB + 120-min slots on May 1.
      const tokenCost = getTokensForFetch(activeSports);
      console.log(
        `[PullOdds] Active sports (from config): ${activeSports.join(', ')} | tokens/fetch: ${tokenCost} | ~${tokenCost * 42}/day (30-min buckets, skip 2am-5am)`,
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

      // Pessimistic token pre-deduct: charge before each sport fetch, reconcile after
      let sessionTokensSpent = 0;
      const tokenCostPerSport = Math.ceil(getTokenCostPerFetch() / activeSports.length);

      for (const sport of activeSports) {
        kpis.sportsProcessed += 1;
        try {
          console.log(`[PullOdds] Processing ${sport}...`);

          // Pre-deduct tokens before the network call
          sessionTokensSpent += tokenCostPerSport;
          try {
            upsertQuotaLedger({
              provider: QUOTA_PROVIDER,
              period: _period,
              tokens_spent_session: sessionTokensSpent,
              updated_by: jobRunId,
            });
          } catch (_ledgerErr) {
            // DB not yet migrated — safe to continue without ledger
          }

          const {
            games: normalizedGames,
            errors: fetchErrors,
            rawCount,
            windowRawCount,
            remainingTokens,
          } = await fetchOdds({
            sport,
            hoursAhead: 36,
          });

          // Reconcile: write actual remaining balance from API header
          if (remainingTokens !== null) {
            try {
              upsertQuotaLedger({
                provider: QUOTA_PROVIDER,
                period: _period,
                tokens_remaining: remainingTokens,
                tokens_spent_session: sessionTokensSpent,
                monthly_limit: Number(process.env.ODDS_MONTHLY_LIMIT) || 20000,
                updated_by: jobRunId,
              });
            } catch (_ledgerErr) {
              // DB not yet migrated — safe to continue without ledger
            }
          }

          const contractRawCount = Number.isFinite(windowRawCount)
            ? windowRawCount
            : rawCount;

          kpis.rawGamesSeen += Number(rawCount || 0);
          kpis.normalizedGamesSeen += Number(normalizedGames?.length || 0);

          if (fetchErrors && fetchErrors.length > 0) {
            // Check for 401 — both keys exhausted. Trip circuit breaker and abort all remaining sports.
            const is401 = fetchErrors.some(
              (e) => String(e).includes('401') || String(e).includes('Unauthorized'),
            );
            if (is401) {
              _apiKeyExhaustedAt = Date.now();
              const circuitUntil = new Date(Date.now() + ODDS_401_COOLDOWN_MS).toISOString();
              console.error(
                `[PullOdds] 🔴 HTTP 401 on ${sport} — API key(s) exhausted. Circuit open until ${circuitUntil}. Aborting remaining sports.`,
              );
              try {
                upsertQuotaLedger({
                  provider: QUOTA_PROVIDER,
                  period: _period,
                  circuit_open_until: circuitUntil,
                  circuit_reason: '401',
                  updated_by: jobRunId,
                });
              } catch (_ledgerErr) { /* DB not yet migrated */ }
              errors.push(`${sport}: 401 — API key exhausted, circuit tripped`);
              kpis.fetchErrors += 1;
              break;
            }

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
                  windowRawCount: contractRawCount,
                  normalizedCount: normalizedGames?.length || 0,
                },
              });
            });
          }

          // Accumulate skipped game count
          skippedMissingFields +=
            contractRawCount - (normalizedGames ? normalizedGames.length : 0);

          // Contract check: skip this sport if normalization drops >40% of games
          // Use continue (not return) so other sports are not aborted
          if (
            contractRawCount > 0 &&
            normalizedGames.length < contractRawCount * 0.6
          ) {
            const msg = `CONTRACT VIOLATION: ${sport} normalized ${normalizedGames.length}/${contractRawCount} in-window games (threshold 60%) — skipping sport`;
            console.error(`[PullOdds] ${msg}`);
            errors.push(`${sport}: ${msg}`);
            kpis.contractViolationSports += 1;
            recordFailure({
              reasonCode: 'SOURCE_CONTRACT_VIOLATION',
              reasonDetail: msg,
              sport,
              sourceContext: {
                rawCount,
                windowRawCount: contractRawCount,
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
              const existingGame = getDatabase()
                .prepare('SELECT status FROM games WHERE game_id = ? LIMIT 1')
                .get(normalized.gameId);
              const resolvedStatus = chooseStatusForUpsert(
                existingGame?.status,
                normalized.status,
              );

              upsertGame({
                id: stableGameId,
                gameId: normalized.gameId,
                sport: normalized.sport,
                homeTeam: normalized.homeTeam,
                awayTeam: normalized.awayTeam,
                gameTimeUtc: normalized.gameTimeUtc,
                status: resolvedStatus,
              });
              gamesUpserted++;
              kpis.gamesUpserted += 1;

              // Enrich with ESPN metrics before inserting snapshot
              // Build a temporary snapshot for enrichment
              let enrichedRawData = {
                ...(normalized.market && typeof normalized.market === 'object'
                  ? normalized.market
                  : {}),
                _execution_pairs: {
                  total_same_book_under_for_over:
                    normalized.odds?.totalSameBookUnderForOver ?? null,
                  total_same_book_over_for_under:
                    normalized.odds?.totalSameBookOverForUnder ?? null,
                  spread_same_book_away_for_home:
                    normalized.odds?.spreadSameBookAwayForHome ?? null,
                  spread_same_book_home_for_away:
                    normalized.odds?.spreadSameBookHomeForAway ?? null,
                  h2h_same_book_away_for_home:
                    normalized.odds?.h2hSameBookAwayForHome ?? null,
                  h2h_same_book_home_for_away:
                    normalized.odds?.h2hSameBookHomeForAway ?? null,
                },
              };

              try {
                const tempSnapshot = {
                  sport: normalized.sport,
                  home_team: normalized.homeTeam,
                  away_team: normalized.awayTeam,
                  raw_data: enrichedRawData,
                };
                const enrichedSnapshot =
                  await enrichOddsSnapshotWithEspnMetrics(tempSnapshot);
                enrichedRawData = enrichedSnapshot.raw_data || enrichedRawData;
              } catch (enrichErr) {
                // Log enrichment error but continue — ESPN enrichment is optional
                console.warn(
                  `[PullOdds] ⚠️  ESPN enrichment failed for ${normalized.sport}/${normalized.gameId}: ${enrichErr.message}`,
                );
              }

              // Insert odds snapshot
              insertOddsSnapshot({
                id: `odds-${sport.toLowerCase()}-${normalized.gameId}-${uuidV4().slice(0, 8)}`,
                gameId: normalized.gameId,
                sport: normalized.sport,
                capturedAt: normalized.capturedAtUtc,
                h2hHome: normalized.odds?.h2hHome,
                h2hAway: normalized.odds?.h2hAway,
                h2hBook: normalized.odds?.h2hBook,
                h2hHomeBook: normalized.odds?.h2hHomeBook,
                h2hAwayBook: normalized.odds?.h2hAwayBook,
                total: normalized.odds?.total,
                totalLineOver: normalized.odds?.totalLineOver,
                totalLineOverBook: normalized.odds?.totalLineOverBook,
                totalLineUnder: normalized.odds?.totalLineUnder,
                totalLineUnderBook: normalized.odds?.totalLineUnderBook,
                totalPriceOver: normalized.odds?.totalPriceOver,
                totalPriceOverBook: normalized.odds?.totalPriceOverBook,
                totalPriceUnder: normalized.odds?.totalPriceUnder,
                totalPriceUnderBook: normalized.odds?.totalPriceUnderBook,
                totalBook: normalized.odds?.totalBook,
                totalIsMispriced: normalized.odds?.totalIsMispriced,
                totalMispriceType: normalized.odds?.totalMispriceType,
                totalMispriceStrength: normalized.odds?.totalMispriceStrength,
                totalOutlierBook: normalized.odds?.totalOutlierBook,
                totalOutlierDelta: normalized.odds?.totalOutlierDelta,
                totalReviewFlag: normalized.odds?.totalReviewFlag,
                spreadHome: normalized.odds?.spreadHome,
                spreadAway: normalized.odds?.spreadAway,
                spreadHomeBook: normalized.odds?.spreadHomeBook,
                spreadAwayBook: normalized.odds?.spreadAwayBook,
                spreadPriceHome: normalized.odds?.spreadPriceHome,
                spreadPriceHomeBook: normalized.odds?.spreadPriceHomeBook,
                spreadPriceAway: normalized.odds?.spreadPriceAway,
                spreadPriceAwayBook: normalized.odds?.spreadPriceAwayBook,
                spreadIsMispriced: normalized.odds?.spreadIsMispriced,
                spreadMispriceType: normalized.odds?.spreadMispriceType,
                spreadMispriceStrength: normalized.odds?.spreadMispriceStrength,
                spreadOutlierBook: normalized.odds?.spreadOutlierBook,
                spreadOutlierDelta: normalized.odds?.spreadOutlierDelta,
                spreadReviewFlag: normalized.odds?.spreadReviewFlag,
                spreadConsensusLine: normalized.odds?.spreadConsensusLine,
                spreadConsensusConfidence:
                  normalized.odds?.spreadConsensusConfidence,
                spreadDispersionStddev:
                  normalized.odds?.spreadDispersionStddev,
                spreadSourceBookCount: normalized.odds?.spreadSourceBookCount,
                monelineHome: normalized.odds?.monelineHome,
                monelineAway: normalized.odds?.monelineAway,
                totalConsensusLine: normalized.odds?.totalConsensusLine,
                totalConsensusConfidence:
                  normalized.odds?.totalConsensusConfidence,
                totalDispersionStddev:
                  normalized.odds?.totalDispersionStddev,
                totalSourceBookCount: normalized.odds?.totalSourceBookCount,
                h2hConsensusHome: normalized.odds?.h2hConsensusHome,
                h2hConsensusAway: normalized.odds?.h2hConsensusAway,
                h2hConsensusConfidence:
                  normalized.odds?.h2hConsensusConfidence,
                mlF5Home: normalized.odds?.mlF5Home ?? null,
                mlF5Away: normalized.odds?.mlF5Away ?? null,
                totalF5Line: normalized.odds?.totalF5Line ?? null,
                totalF5Over: normalized.odds?.totalF5Over ?? null,
                totalF5Under: normalized.odds?.totalF5Under ?? null,
                // Deprecated F5 / 1P snapshot columns remain in the schema but are
                // now intentionally left null by the shared odds normalizer.
                rawData: enrichedRawData,
                jobRunId,
              });
              
              // Resolve and audit timestamp provenance from ingest
              resolveSnapshotAge(
                {
                  captured_at: normalized.capturedAtUtc,
                  pulled_at: null, // set at ingest time
                  updated_at: null, // set at DB persist time
                },
                {
                  snapshotId: `odds-${sport.toLowerCase()}-${normalized.gameId}`,
                  sport: normalized.sport,
                  gameId: normalized.gameId,
                  jobRunId,
                },
              );
              
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
        const settlementJobKeys = {
          gameResults: `${settleKey}|game-results`,
          projections: `${settleKey}|projections`,
          pendingCards: `${settleKey}|pending-cards`,
        };
        console.log(
          `[PullOdds] Triggering settlement sweep after odds update (${settleKey})...`,
        );

        try {
          await settleGameResults({
            jobKey: settlementJobKeys.gameResults,
            dryRun,
            minHoursAfterStart: 0,
          });

          await settleProjections({
            jobKey: settlementJobKeys.projections,
            dryRun,
          });

          await settlePendingCards({
            jobKey: settlementJobKeys.pendingCards,
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
