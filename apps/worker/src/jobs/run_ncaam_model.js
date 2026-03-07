/**
 * NCAAM Model Runner Job
 * 
 * Reads latest NCAAM (college basketball) odds from DB, runs inference model, and stores:
 * - card_payloads (ready-to-render web cards)
 * 
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_ncaam_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-ncaam-model)
 * 
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsWithUpcomingGames,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  enrichOddsSnapshotWithEspnMetrics,
} = require('@cheddar-logic/data');
const { computeNCAAMDriverCards, generateCard } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  edgeCalculator,
  marginToWinProbability,
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  applyUiActionFields,
} = require('../utils/decision-publisher');

const NCAAM_DRIVER_WEIGHTS = {
  baseProjection: 0.4,
  restAdvantage: 0.2,
  matchupStyle: 0.2,
};

const NCAAM_DRIVER_CARD_TYPES = [
  'ncaam-base-projection',
  'ncaam-rest-advantage',
  'ncaam-matchup-style',
];

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

/**
 * Generate insertable card objects from NCAAM driver descriptors.
 * Generates both moneyline AND spread cards for each driver signal.
 */
function generateNCAAMCards(gameId, driverDescriptors, oddsSnapshot) {
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  const cards = [];

  for (const descriptor of driverDescriptors) {
    // Generate MONEYLINE card
    cards.push(
      generateCard({
        sport: 'NCAAM',
        gameId,
        descriptor,
        oddsSnapshot,
        now,
        expiresAt,
        marketType: 'moneyline',
        driverWeights: NCAAM_DRIVER_WEIGHTS,
      }),
    );

    // Generate SPREAD card only when both line and price are available
    if (
      oddsSnapshot?.spread_home != null &&
      oddsSnapshot?.spread_away != null &&
      oddsSnapshot?.spread_price_home != null &&
      oddsSnapshot?.spread_price_away != null
    ) {
      cards.push(
        generateCard({
          sport: 'NCAAM',
          gameId,
          descriptor,
          oddsSnapshot,
          now,
          expiresAt,
          marketType: 'spread',
          driverWeights: NCAAM_DRIVER_WEIGHTS,
        }),
      );
    }
  }

  return cards;
}

/**
 * Generate a single card for a specific market type
 */

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNCAAMModel({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-ncaam-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NCAAMModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[NCAAMModel] Job key: ${jobKey}`);
  }
  console.log(`[NCAAMModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[NCAAMModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[NCAAMModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      // Start job run
      console.log('[NCAAMModel] Recording job start...');
      insertJobRun('run_ncaam_model', jobRunId, jobKey);

      // Get latest NCAAM odds for upcoming games
      console.log('[NCAAMModel] Fetching odds for upcoming NCAAM games...');
      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      const oddsSnapshots = getOddsWithUpcomingGames(
        'NCAAM',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        console.log('[NCAAMModel] No recent NCAAM odds found, exiting.');
        markJobRunSuccess(jobRunId);
        try {
          setCurrentRunId(jobRunId, 'ncaam');
        } catch (runStateError) {
          console.error(
            `[NCAAMModel] Failed to update run state: ${runStateError.message}`,
          );
        }
        return { success: true, jobRunId, cardsGenerated: 0 };
      }

      console.log(`[NCAAMModel] Found ${oddsSnapshots.length} odds snapshots`);

      // Group by game_id and get latest for each
      const gameOdds = {};
      oddsSnapshots.forEach((snap) => {
        if (
          !gameOdds[snap.game_id] ||
          snap.captured_at > gameOdds[snap.game_id].captured_at
        ) {
          gameOdds[snap.game_id] = snap;
        }
      });

      const gameIds = Object.keys(gameOdds);
      console.log(
        `[NCAAMModel] Running inference on ${gameIds.length} games...`,
      );

      let cardsGenerated = 0;
      let gatedCount = 0;
      let blockedCount = 0;
      let noSignalCount = 0;
      let gameErrorCount = 0;

      // Process each game independently. Missing signals for one game should not
      // block card generation for other games.
      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          const driverCards = computeNCAAMDriverCards(gameId, oddsSnapshot);
          if (driverCards.length === 0) {
            noSignalCount++;
            console.warn(
              `  [skip] ${gameId}: No actionable NCAAM driver signals`,
            );
            continue;
          }

          const driverCardTypesToClear = [
            ...new Set([
              ...NCAAM_DRIVER_CARD_TYPES,
              ...driverCards.map((c) => c.cardType),
            ]),
          ];
          for (const ct of driverCardTypesToClear) {
            prepareModelAndCardWrite(gameId, 'ncaam-drivers-v1', ct);
          }

          const cards = generateNCAAMCards(gameId, driverCards, oddsSnapshot);

          for (const card of cards) {
            const validation = validateCardPayload(
              card.cardType,
              card.payloadData,
            );
            if (!validation.success) {
              throw new Error(
                `Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`,
              );
            }

            const decisionOutcome = publishDecisionForCard({
              card,
              oddsSnapshot,
            });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(
                `  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`,
              );
            }

            applyUiActionFields(card.payloadData);
            attachRunId(card, jobRunId);
            insertCardPayload(card);
            cardsGenerated++;
            console.log(
              `  [ok] ${gameId} [${card.cardType}/${card.payloadData.market_type}]: ` +
                `${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            );
          }
        } catch (gameError) {
          gameErrorCount++;
          console.error(`  [error] ${gameId}: ${gameError.message}`);
        }
      }

      if (noSignalCount > 0) {
        console.warn(
          `[NCAAMModel] No-signal games skipped: ${noSignalCount}/${gameIds.length}`,
        );
      }
      if (gameErrorCount > 0) {
        console.warn(
          `[NCAAMModel] Game-level errors: ${gameErrorCount}/${gameIds.length}`,
        );
      }

      if (cardsGenerated === 0) {
        throw new Error(
          `NCAAM model generated 0 cards (${noSignalCount} no-signal, ${gameErrorCount} errored)`,
        );
      }

      // Mark job as success
      console.log(
        `[NCAAMModel] ✅ Complete: ${cardsGenerated} cards generated`,
      );
      console.log(
        `[NCAAMModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`,
      );
      markJobRunSuccess(jobRunId);
      try {
        setCurrentRunId(jobRunId, 'ncaam');
      } catch (runStateError) {
        console.error(
          `[NCAAMModel] Failed to update run state: ${runStateError.message}`,
        );
      }

      return { success: true, jobRunId, cardsGenerated };
    } catch (error) {
      if (error.code === 'JOB_RUN_ALREADY_CLAIMED') {
        console.log(
          `[NCAAMModel] ⏭️  Skipping (job already claimed): ${jobKey || 'none'}`,
        );
        return { success: true, jobRunId: null, skipped: true, jobKey };
      }
      console.error(`[NCAAMModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[NCAAMModel] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNCAAMModel()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNCAAMModel };
