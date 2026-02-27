/**
 * NHL Model Runner Job
 * 
 * Reads latest NHL odds from DB, runs inference model, and stores:
 * - model_outputs (predictions + confidence)
 * - card_payloads (ready-to-render web cards)
 * 
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_nhl_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-nhl-model)
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
  getOddsSnapshots,
  getOddsWithUpcomingGames,
  getLatestOdds,
  insertModelOutput,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb
} = require('@cheddar-logic/data');

// Import pluggable inference layer
const { getModel, computeNHLDriverCards } = require('../models');

/**
 * Generate insertable card objects from driver descriptors.
 *
 * @param {string} gameId
 * @param {Array<object>} driverDescriptors - Output of computeNHLDriverCards()
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card objects ready for insertCardPayload()
 */
function generateNHLCards(gameId, driverDescriptors, oddsSnapshot) {
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  return driverDescriptors.map(descriptor => {
    const cardId = `card-nhl-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
    const payloadData = {
      game_id: gameId,
      sport: 'NHL',
      model_version: 'nhl-drivers-v1',
      prediction: descriptor.prediction,
      confidence: descriptor.confidence,
      reasoning: descriptor.reasoning,
      odds_context: {
        h2h_home: oddsSnapshot?.h2h_home,
        h2h_away: oddsSnapshot?.h2h_away,
        spread_home: oddsSnapshot?.spread_home,
        spread_away: oddsSnapshot?.spread_away,
        total: oddsSnapshot?.total,
        captured_at: oddsSnapshot?.captured_at
      },
      ev_passed: descriptor.ev_threshold_passed,
      disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
      generated_at: now,
      driver: {
        key: descriptor.driverKey,
        score: descriptor.driverScore,
        status: descriptor.driverStatus,
        inputs: descriptor.driverInputs
      },
      meta: {
        inference_source: descriptor.inference_source,
        is_mock: descriptor.is_mock
      }
    };

    return {
      id: cardId,
      gameId,
      sport: 'NHL',
      cardType: descriptor.cardType,
      cardTitle: descriptor.cardTitle,
      createdAt: now,
      expiresAt,
      payloadData,
      modelOutputIds: null
    };
  });
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNHLModel({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-nhl-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  
  console.log(`[NHLModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[NHLModel] Job key: ${jobKey}`);
  }
  console.log(`[NHLModel] Time: ${new Date().toISOString()}`);
  
  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[NHLModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(`[NHLModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      // Start job run
      console.log('[NHLModel] Recording job start...');
      insertJobRun('run_nhl_model', jobRunId, jobKey);
      
      // Get latest NHL odds for UPCOMING games only (prevents stale data processing)
      console.log('[NHLModel] Fetching odds for upcoming NHL games...');
      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      const oddsSnapshots = getOddsWithUpcomingGames('NHL', nowUtc.toISO(), horizonUtc);
      
      if (oddsSnapshots.length === 0) {
        console.log('[NHLModel] No recent NHL odds found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }
      
      console.log(`[NHLModel] Found ${oddsSnapshots.length} odds snapshots`);
      
      // Group by game_id and get latest for each
      const gameOdds = {};
      oddsSnapshots.forEach(snap => {
        if (!gameOdds[snap.game_id] || snap.captured_at > gameOdds[snap.game_id].captured_at) {
          gameOdds[snap.game_id] = snap;
        }
      });
      
      const gameIds = Object.keys(gameOdds);
      console.log(`[NHLModel] Running inference on ${gameIds.length} games...`);

      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];

      // Process each game
      for (const gameId of gameIds) {
        try {
          const oddsSnapshot = gameOdds[gameId];

          // Compute per-driver card descriptors
          const driverCards = computeNHLDriverCards(gameId, oddsSnapshot);

          if (driverCards.length === 0) {
            console.log(`  [skip] ${gameId}: No driver cards (all data missing)`);
            continue;
          }

          // Prepare write: clear old driver card types for this game
          const driverCardTypes = [...new Set(driverCards.map(c => c.cardType))];
          for (const ct of driverCardTypes) {
            prepareModelAndCardWrite(gameId, 'nhl-drivers-v1', ct);
          }

          const cards = generateNHLCards(gameId, driverCards, oddsSnapshot);

          for (const card of cards) {
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
            }
            insertCardPayload(card);
            cardsGenerated++;
            console.log(`  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload')) {
            throw gameError;
          }
          cardsFailed++;
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  [err] ${gameId}: ${gameError.message}`);
        }
      }
      
      // Mark success
      markJobRunSuccess(jobRunId);
      console.log(`[NHLModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`);
      
      if (errors.length > 0) {
        console.error('[NHLModel] Errors:');
        errors.forEach(err => console.error(`  - ${err}`));
      }
      
      return { success: true, jobRunId, cardsGenerated, cardsFailed, errors };
      
    } catch (error) {
      console.error(`[NHLModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[NHLModel] Failed to record error to DB:`, dbError.message);
      }
      
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNHLModel()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNHLModel, generateNHLCards };
