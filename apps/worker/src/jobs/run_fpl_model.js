/**
 * FPL Sage Compatibility Runner Job
 *
 * Notes:
 * - `FPL` is the sport/domain tag in shared tables.
 * - `FPL Sage` is the FPL decision engine.
 * - This runner currently writes through the shared betting-shaped contract for
 *   cross-sport consistency during migration.
 *
 * Reads latest Fantasy Premier League snapshots from DB, runs inference, and stores:
 * - model_outputs (raw inference output)
 * - card_payloads (ready-to-render cards)
 * 
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_fpl_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-fpl-model)
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
  getLatestOdds,
  insertModelOutput,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  withDb
} = require('@cheddar-logic/data');

// Import pluggable inference layer
const { getModel } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds
} = require('@cheddar-logic/models');

/**
 * Generate a card payload from FPL inference + snapshot context.
 *
 * `recommended_bet_type` is a compatibility field for shared contract/settlement.
 * For FPL strategy cards, unknown/unset values map to PASS downstream.
 */
function generateFPLCard(gameId, modelOutput, oddsSnapshot) {
  const cardId = `card-fpl-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();
  
  // Card expires 1 hour before the game starts (if game_time_utc is known)
  let expiresAt = null;
  if (oddsSnapshot && oddsSnapshot.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    const oneHourBefore = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
    expiresAt = oneHourBefore;
  }
  
  const recommendedBetType = modelOutput.recommended_bet_type || 'unknown';
  const recommendation = buildRecommendationFromPrediction({
    prediction: modelOutput.prediction,
    recommendedBetType
  });
  const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);

  // Build the card payload
  const payloadData = {
    game_id: gameId,
    sport: 'FPL',
    model_version: 'fpl-model-v1',
    home_team: oddsSnapshot?.home_team ?? null,
    away_team: oddsSnapshot?.away_team ?? null,
    matchup,
    start_time_utc: oddsSnapshot?.game_time_utc ?? null,
    start_time_local: startTimeLocal,
    timezone,
    countdown,
    recommendation: {
      type: recommendation.type,
      text: recommendation.text,
      pass_reason: recommendation.pass_reason
    },
    projection: {
      total: null,
      margin_home: null,
      win_prob_home: null
    },
    market,
    edge: null,
    confidence_pct: Math.round(modelOutput.confidence * 100),
    drivers_active: [],
    prediction: modelOutput.prediction,
    confidence: modelOutput.confidence,
    recommended_bet_type: recommendedBetType,
    reasoning: modelOutput.reasoning,
    odds_context: {
      h2h_home: oddsSnapshot?.h2h_home,
      h2h_away: oddsSnapshot?.h2h_away,
      spread_home: oddsSnapshot?.spread_home,
      spread_away: oddsSnapshot?.spread_away,
      total: oddsSnapshot?.total,
      captured_at: oddsSnapshot?.captured_at
    },
    ev_passed: modelOutput.ev_threshold_passed,
    disclaimer: 'FPL strategy analysis for informational use only. Not gambling advice.',
    generated_at: now,
    meta: {
      inference_source: modelOutput.inference_source || 'unknown',
      model_endpoint: modelOutput.model_endpoint || null,
      is_mock: Boolean(modelOutput.is_mock),
      domain: 'fpl-sage',
      contract_mode: 'shared-betting-compat'
    }
  };
  
  return {
    id: cardId,
    gameId,
    sport: 'FPL',
    cardType: 'fpl-model-output',
    cardTitle: `FPL Sage: ${modelOutput.prediction}`,
    createdAt: now,
    expiresAt,
    payloadData,
    modelOutputIds: null // Will be linked after model_output is inserted
  };
}

/**
 * Main job entrypoint
 */
async function runFPLModel() {
  const jobRunId = `job-fpl-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  
  console.log(`[FPLSageAdapter] Starting job run: ${jobRunId}`);
  console.log(`[FPLSageAdapter] Time: ${new Date().toISOString()}`);
  
  return withDb(async () => {
    try {
      // Start job run
      console.log('[FPLSageAdapter] Recording job start...');
      insertJobRun('run_fpl_model', jobRunId);
      
      // Get latest FPL odds for all games
      console.log('[FPLSageAdapter] Fetching latest FPL snapshots...');
      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const oddsSnapshots = getOddsSnapshots('FPL', twentyFourHoursAgo);
      
      if (oddsSnapshots.length === 0) {
        console.log('[FPLSageAdapter] No recent FPL snapshots found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }
      
      console.log(`[FPLSageAdapter] Found ${oddsSnapshots.length} snapshots`);
      
      // Group by game_id and get latest for each
      const gameOdds = {};
      oddsSnapshots.forEach(snap => {
        if (!gameOdds[snap.game_id] || snap.captured_at > gameOdds[snap.game_id].captured_at) {
          gameOdds[snap.game_id] = snap;
        }
      });
      
      const gameIds = Object.keys(gameOdds);
      console.log(`[FPLSageAdapter] Running inference on ${gameIds.length} games...`);
      
      // Get model instance
      const model = getModel('FPL');
      
      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];
      
      // Process each game
      for (const gameId of gameIds) {
        try {
          const oddsSnapshot = gameOdds[gameId];
          
          // Run inference (using pluggable model)
          const modelOutput = await model.infer(gameId, oddsSnapshot);
          
          // Only generate card if inference passed confidence threshold
          if (modelOutput.ev_threshold_passed) {
            const card = generateFPLCard(gameId, modelOutput, oddsSnapshot);
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload: ${validation.errors.join('; ')}`);
            }
            
            const { deletedOutputs, deletedCards } = prepareModelAndCardWrite(
              gameId,
              'fpl-model-v1',
              'fpl-model-output'
            );
            
            if (deletedOutputs > 0 || deletedCards > 0) {
              console.log(`  🔄 ${gameId}: Removed ${deletedOutputs} output(s), ${deletedCards} card(s)`);
            }
            
            // Store model output
            const modelOutputId = `model-fpl-${gameId}-${uuidV4().slice(0, 8)}`;
            insertModelOutput({
              id: modelOutputId,
              gameId,
              sport: 'FPL',
              modelName: 'fpl-model-v1',
              modelVersion: '1.0.0',
              predictionType: 'moneyline',
              predictedAt: new Date().toISOString(),
              confidence: modelOutput.confidence,
              outputData: modelOutput,
              oddsSnapshotId: oddsSnapshot.id,
              jobRunId
            });
            
            // Generate and store card
            card.modelOutputIds = modelOutputId;
            insertCardPayload(card);
            
            cardsGenerated++;
            console.log(`  ✅ ${gameId}: ${modelOutput.prediction} (${(modelOutput.confidence * 100).toFixed(0)}% confidence)`);
          } else {
            console.log(`  ⏭️  ${gameId}: Abstained (confidence ${(modelOutput.confidence * 100).toFixed(0)}% below threshold)`);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload')) {
            throw gameError;
          }
          cardsFailed++;
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  ❌ ${gameId}: ${gameError.message}`);
        }
      }
      
      // Mark success
      markJobRunSuccess(jobRunId);
      console.log(`[FPLSageAdapter] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`);
      
      if (errors.length > 0) {
        console.error('[FPLSageAdapter] Errors:');
        errors.forEach(err => console.error(`  - ${err}`));
      }
      
      return { success: true, jobRunId, cardsGenerated, cardsFailed, errors };
      
    } catch (error) {
      console.error(`[FPLSageAdapter] ❌ Job failed:`, error.message);
      console.error(error.stack);
      
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[FPLSageAdapter] Failed to record error to DB:`, dbError.message);
      }
      
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runFPLModel()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runFPLModel, generateFPLCard };
