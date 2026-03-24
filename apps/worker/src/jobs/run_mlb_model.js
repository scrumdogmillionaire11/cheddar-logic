/**
 * MLB Model Runner Job
 *
 * Reads latest MLB odds from DB, runs inference model, and stores:
 * - model_outputs (predictions + confidence)
 * - card_payloads (ready-to-render web cards)
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_mlb_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-mlb-model)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

// Import cheddar-logic data layer
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsSnapshots,
  getOddsWithUpcomingGames,
  getLatestOdds,
  insertModelOutput,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

// Import pluggable inference layer
const { getModel } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
} = require('@cheddar-logic/models');

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
 * Generate a card payload from model output + odds
 */
function generateMLBCard(gameId, modelOutput, oddsSnapshot) {
  const cardId = `card-mlb-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();

  const expiresAt = null;

  // Build the card payload
  const recommendation = buildRecommendationFromPrediction({
    prediction: modelOutput.prediction,
    recommendedBetType: 'moneyline',
  });
  const matchup = buildMatchup(
    oddsSnapshot?.home_team,
    oddsSnapshot?.away_team,
  );
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(
    oddsSnapshot?.game_time_utc,
  );
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);
  const payloadData = {
    game_id: gameId,
    sport: 'MLB',
    model_version: 'mlb-model-v1',
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
      pass_reason: recommendation.pass_reason,
    },
    projection: {
      total: null,
      margin_home: null,
      win_prob_home: null,
    },
    market,
    edge: null,
    confidence_pct: Math.round(modelOutput.confidence * 100),
    drivers_active: [],
    prediction: modelOutput.prediction,
    confidence: modelOutput.confidence,
    recommended_bet_type: 'moneyline',
    reasoning: modelOutput.reasoning,
    odds_context: {
      h2h_home: oddsSnapshot?.h2h_home,
      h2h_away: oddsSnapshot?.h2h_away,
      spread_home: oddsSnapshot?.spread_home,
      spread_away: oddsSnapshot?.spread_away,
      total: oddsSnapshot?.total,
      captured_at: oddsSnapshot?.captured_at,
    },
    ev_passed: modelOutput.ev_threshold_passed,
    disclaimer:
      'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    meta: {
      inference_source: modelOutput.inference_source || 'unknown',
      model_endpoint: modelOutput.model_endpoint || null,
      is_mock: Boolean(modelOutput.is_mock),
    },
  };

  return {
    id: cardId,
    gameId,
    sport: 'MLB',
    cardType: 'mlb-model-output',
    cardTitle: `MLB Model: ${modelOutput.prediction}`,
    createdAt: now,
    expiresAt,
    payloadData,
    modelOutputIds: null, // Will be linked after model_output is inserted
  };
}

/**
 * Enrich an odds snapshot with pitcher stats from the mlb_pitcher_stats table.
 *
 * Queries by team name for rows updated today. Falls back gracefully when no
 * rows are found (returns original oddsSnapshot unchanged).
 *
 * Also attaches market lines (total, f5) from the snapshot into raw_data.mlb
 * so computeMLBDriverCards can read them without needing the top-level fields.
 *
 * @param {object} oddsSnapshot
 * @returns {object} Enriched snapshot (or original if DB unavailable / no data)
 */
function enrichMlbPitcherData(oddsSnapshot) {
  const homeTeam = oddsSnapshot?.home_team ?? '';
  const awayTeam = oddsSnapshot?.away_team ?? '';

  try {
    const db = getDatabase();
    const byTeam = db.prepare(
      "SELECT * FROM mlb_pitcher_stats WHERE team = ? AND date(updated_at) = date('now') LIMIT 1",
    );

    const homePitcher = homeTeam ? (byTeam.get(homeTeam) ?? null) : null;
    const awayPitcher = awayTeam ? (byTeam.get(awayTeam) ?? null) : null;

    const existingRaw =
      typeof oddsSnapshot.raw_data === 'string'
        ? JSON.parse(oddsSnapshot.raw_data)
        : (oddsSnapshot.raw_data ?? {});

    const mlb = existingRaw.mlb ?? {};

    // Attach market lines from odds snapshot to raw_data.mlb
    mlb.total_line = oddsSnapshot.total ?? mlb.total_line ?? null;
    mlb.f5_line = oddsSnapshot.total_f5 ?? mlb.f5_line ?? null;
    // Strikeout lines come from player_prop_lines table — out of scope for this WI.
    // Leave strikeout_lines as-is (from existing raw_data or null).

    // Look up weather for this game by (game_date, home_team)
    try {
      const today = new Date().toISOString().slice(0, 10);
      const weatherRow = db.prepare(
        'SELECT temp_f, wind_mph, wind_dir, conditions FROM mlb_game_weather WHERE game_date = ? AND home_team = ? LIMIT 1',
      ).get(today, homeTeam);

      if (weatherRow && weatherRow.conditions !== 'INDOOR') {
        mlb.temp_f = weatherRow.temp_f ?? mlb.temp_f ?? null;
        mlb.wind_mph = weatherRow.wind_mph ?? mlb.wind_mph ?? null;
      }
    } catch (weatherErr) {
      // Non-fatal — model uses neutral defaults
    }

    return {
      ...oddsSnapshot,
      raw_data: {
        ...existingRaw,
        mlb: {
          ...mlb,
          home_pitcher: homePitcher
            ? {
                era: homePitcher.era,
                whip: homePitcher.whip,
                k_per_9: homePitcher.k_per_9,
                recent_k_per_9: homePitcher.recent_k_per_9,
                avg_ip: homePitcher.recent_ip,
              }
            : mlb.home_pitcher ?? null,
          away_pitcher: awayPitcher
            ? {
                era: awayPitcher.era,
                whip: awayPitcher.whip,
                k_per_9: awayPitcher.k_per_9,
                recent_k_per_9: awayPitcher.recent_k_per_9,
                avg_ip: awayPitcher.recent_ip,
              }
            : mlb.away_pitcher ?? null,
        },
      },
    };
  } catch (err) {
    console.warn(`[MLBModel] Pitcher enrichment failed: ${err.message}`);
    return oddsSnapshot; // proceed without enrichment
  }
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runMLBModel({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-mlb-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[MLBModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[MLBModel] Job key: ${jobKey}`);
  }
  console.log(`[MLBModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[MLBModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[MLBModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }
    try {
      // Start job run
      console.log('[MLBModel] Recording job start...');
      insertJobRun('run_mlb_model', jobRunId, jobKey);

      // Get latest MLB odds for UPCOMING games only (prevents stale data processing)
      console.log('[MLBModel] Fetching odds for upcoming MLB games...');
      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      const oddsSnapshots = getOddsWithUpcomingGames(
        'MLB',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        console.log('[MLBModel] No recent MLB odds found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }

      console.log(`[MLBModel] Found ${oddsSnapshots.length} odds snapshots`);

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
      console.log(`[MLBModel] Running inference on ${gameIds.length} games...`);

      // Get model instance
      const model = getModel('MLB');

      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];

      // Process each game
      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];
          oddsSnapshot = enrichMlbPitcherData(oddsSnapshot);

          // Run inference (using pluggable model)
          const modelOutput = await model.infer(gameId, oddsSnapshot);

          // Only generate card if model passed confidence threshold
          if (modelOutput.ev_threshold_passed) {
            const card = generateMLBCard(gameId, modelOutput, oddsSnapshot);
            const validation = validateCardPayload(
              card.cardType,
              card.payloadData,
            );
            if (!validation.success) {
              throw new Error(
                `Invalid card payload: ${validation.errors.join('; ')}`,
              );
            }

            const { deletedOutputs, deletedCards } = prepareModelAndCardWrite(
              gameId,
              'mlb-model-v1',
              'mlb-model-output',
              { runId: jobRunId },
            );

            if (deletedOutputs > 0 || deletedCards > 0) {
              console.log(
                `  🔄 ${gameId}: Removed ${deletedOutputs} output(s), ${deletedCards} card(s)`,
              );
            }

            // Store model output
            const modelOutputId = `model-mlb-${gameId}-${uuidV4().slice(0, 8)}`;
            insertModelOutput({
              id: modelOutputId,
              gameId,
              sport: 'MLB',
              modelName: 'mlb-model-v1',
              modelVersion: '1.0.0',
              predictionType: 'moneyline',
              predictedAt: new Date().toISOString(),
              confidence: modelOutput.confidence,
              outputData: modelOutput,
              oddsSnapshotId: oddsSnapshot.id,
              jobRunId,
            });

            // Generate and store card
            card.modelOutputIds = modelOutputId;
            attachRunId(card, jobRunId);
            insertCardPayload(card);

            cardsGenerated++;
            console.log(
              `  ✅ ${gameId}: ${modelOutput.prediction} (${(modelOutput.confidence * 100).toFixed(0)}% confidence)`,
            );
          } else {
            console.log(
              `  ⏭️  ${gameId}: Abstained (confidence ${(modelOutput.confidence * 100).toFixed(0)}% below threshold)`,
            );
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
      try {
        setCurrentRunId(jobRunId, 'mlb');
      } catch (runStateError) {
        console.error(
          `[MLBModel] Failed to update run state: ${runStateError.message}`,
        );
      }
      console.log(
        `[MLBModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`,
      );

      if (errors.length > 0) {
        console.error('[MLBModel] Errors:');
        errors.forEach((err) => console.error(`  - ${err}`));
      }

      return { success: true, jobRunId, cardsGenerated, cardsFailed, errors };
    } catch (error) {
      console.error(`[MLBModel] ❌ Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[MLBModel] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runMLBModel()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runMLBModel, generateMLBCard };
