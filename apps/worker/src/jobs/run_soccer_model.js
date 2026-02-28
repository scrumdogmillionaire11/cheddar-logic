/**
 * Soccer Model Runner Job
 * 
 * Reads latest Soccer odds from DB, runs inference model, and stores:
 * - card_payloads (ready-to-render web cards)
 * 
 * Supports multiple leagues: EPL, MLS, UCL (Champions League)
 * 
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_soccer_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-soccer-model)
 * 
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  getOddsWithUpcomingGames,
  insertCardPayload,
  validateCardPayload,
  shouldRunJobKey,
  withDb
} = require('@cheddar-logic/data');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds
} = require('@cheddar-logic/models');

/**
 * Generate a basic soccer card from odds data
 */
function generateSoccerCard(gameId, oddsSnapshot) {
  const cardId = `card-soccer-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();
  
  // Basic prediction logic: compare H2H odds
  const prediction = oddsSnapshot.h2h_home < oddsSnapshot.h2h_away ? 'HOME' : 'AWAY';
  // Simple confidence based on odds gap
  const oddsGap = Math.abs(oddsSnapshot.h2h_home - oddsSnapshot.h2h_away);
  const confidence = Math.min(0.65 + (oddsGap * 0.1), 0.85);
  
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }
  
  const payloadData = {
    game_id: gameId,
    sport: 'SOCCER',
    model_version: 'soccer-model-v1',
    home_team: oddsSnapshot?.home_team ?? null,
    away_team: oddsSnapshot?.away_team ?? null,
    matchup: buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team),
    start_time_utc: oddsSnapshot?.game_time_utc ?? null,
    ...formatStartTimeLocal(oddsSnapshot?.game_time_utc),
    countdown: formatCountdown(oddsSnapshot?.game_time_utc),
    recommendation: (() => {
      const rec = buildRecommendationFromPrediction({
        prediction,
        recommendedBetType: 'unknown'
      });
      return {
        type: rec.type,
        text: rec.text,
        pass_reason: rec.pass_reason
      };
    })(),
    projection: {
      total: null,
      margin_home: null,
      win_prob_home: null
    },
    market: buildMarketFromOdds(oddsSnapshot),
    edge: null,
    confidence_pct: Math.round(confidence * 100),
    drivers_active: [],
    prediction,
    confidence,
    recommended_bet_type: 'unknown',
    reasoning: `Model prefers ${prediction} team at ${(confidence * 100).toFixed(0)}% confidence`,
    odds_context: {
      h2h_home: oddsSnapshot?.h2h_home,
      h2h_away: oddsSnapshot?.h2h_away,
      draw_odds: oddsSnapshot?.draw_odds,
      captured_at: oddsSnapshot?.captured_at
    },
    ev_passed: confidence > 0.55,
    disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    meta: {
      inference_source: 'mock',
      model_endpoint: null,
      is_mock: true
    }
  };
  
  return {
    id: cardId,
    gameId,
    sport: 'SOCCER',
    cardType: 'soccer-model-output',
    cardTitle: `Soccer Model: ${prediction}`,
    createdAt: now,
    expiresAt,
    payloadData,
    modelOutputIds: null
  };
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runSoccerModel({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-soccer-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  
  console.log(`[SoccerModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[SoccerModel] Job key: ${jobKey}`);
  }
  console.log(`[SoccerModel] Time: ${new Date().toISOString()}`);
  
  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[SoccerModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(`[SoccerModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      // Start job run
      console.log('[SoccerModel] Recording job start...');
      insertJobRun('run_soccer_model', jobRunId, jobKey);
      
      // Get latest SOCCER odds for upcoming games
      console.log('[SoccerModel] Fetching odds for upcoming SOCCER games...');
      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      const oddsSnapshots = getOddsWithUpcomingGames('SOCCER', nowUtc.toISO(), horizonUtc);
      
      if (oddsSnapshots.length === 0) {
        console.log('[SoccerModel] No recent SOCCER odds found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }
      
      console.log(`[SoccerModel] Found ${oddsSnapshots.length} odds snapshots`);
      
      // Group by game_id and get latest for each
      const gameOdds = {};
      oddsSnapshots.forEach(snap => {
        if (!gameOdds[snap.game_id] || snap.captured_at > gameOdds[snap.game_id].captured_at) {
          gameOdds[snap.game_id] = snap;
        }
      });
      
      const gameIds = Object.keys(gameOdds);
      console.log(`[SoccerModel] Running inference on ${gameIds.length} games...`);

      let cardsGenerated = 0;

      // Process each game
      for (const gameId of gameIds) {
        try {
          const oddsSnapshot = gameOdds[gameId];
          const card = generateSoccerCard(gameId, oddsSnapshot);

          const validation = validateCardPayload(card.cardType, card.payloadData);
          if (!validation.success) {
            throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
          }
          
          insertCardPayload(card);
          cardsGenerated++;
          console.log(`  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
        } catch (gameError) {
          console.error(`  [error] ${gameId}: ${gameError.message}`);
        }
      }

      // Mark job as success
      console.log(`[SoccerModel] ✅ Complete: ${cardsGenerated} cards generated`);
      markJobRunSuccess(jobRunId);
      
      return { success: true, jobRunId, cardsGenerated };
    } catch (error) {
      console.error(`[SoccerModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      markJobRunFailure(jobRunId, error.message);
      process.exit(1);
    }
  });
}

// CLI execution
if (require.main === module) {
  runSoccerModel()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runSoccerModel };
