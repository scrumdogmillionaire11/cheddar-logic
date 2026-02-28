/**
 * NBA Model Runner Job
 *
 * Reads latest NBA odds from DB, runs per-driver inference, and stores
 * card_payloads (one per active driver: rest-advantage, travel, lineup,
 * matchup-style, blowout-risk). Drivers only emit when their signal is
 * actionable — neutral/missing data produces no card.
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_nba_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-nba-model)
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
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  enrichOddsSnapshotWithEspnMetrics
} = require('@cheddar-logic/data');

const { computeNBADriverCards } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds
} = require('@cheddar-logic/models');

const NBA_DRIVER_WEIGHTS = {
  baseProjection: 0.35,
  restAdvantage: 0.15,
  welcomeHomeV2: 0.10,
  matchupStyle: 0.20,
  blowoutRisk: 0.07,
  totalProjection: 0.13
};

function buildDriverSummary(descriptor, weightMap) {
  const weight = descriptor.driverWeight ?? weightMap[descriptor.driverKey] ?? 1;
  const score = descriptor.driverScore ?? null;
  const impact = score !== null ? Number(((score - 0.5) * weight).toFixed(3)) : null;

  return {
    weights: [
      {
        driver: descriptor.driverKey,
        weight,
        score,
        impact,
        status: descriptor.driverStatus ?? null
      }
    ],
    impact_note: 'Impact = (score - 0.5) * weight. Positive favors HOME, negative favors AWAY.'
  };
}

/**
 * Generate insertable card objects from NBA driver descriptors.
 *
 * @param {string} gameId
 * @param {Array<object>} driverDescriptors - Output of computeNBADriverCards()
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card objects ready for insertCardPayload()
 */
function generateNBACards(gameId, driverDescriptors, oddsSnapshot) {
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  return driverDescriptors.map(descriptor => {
    const cardId = `card-nba-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
    const recommendation = buildRecommendationFromPrediction({
      prediction: descriptor.prediction,
      recommendedBetType: 'moneyline'
    });
    const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
    const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
    const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
    const market = buildMarketFromOdds(oddsSnapshot);
    // For totals cards, populate projection.total and edge from driver inputs
    const isTotalsCard = descriptor.cardType === 'nba-total-projection';
    const projectedTotal = isTotalsCard ? (descriptor.driverInputs?.projected_total ?? null) : null;
    const projectedEdge = isTotalsCard ? (descriptor.driverInputs?.edge ?? null) : null;
    const recommendedBetType = isTotalsCard ? 'total' : 'moneyline';

    const payloadData = {
      game_id: gameId,
      sport: 'NBA',
      model_version: 'nba-drivers-v1',
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
        total: projectedTotal,
        margin_home: null,
        win_prob_home: null
      },
      market,
      edge: projectedEdge,
      confidence_pct: Math.round(descriptor.confidence * 100),
      drivers_active: [descriptor.driverKey],
      prediction: descriptor.prediction,
      confidence: descriptor.confidence,
      recommended_bet_type: recommendedBetType,
      tier: descriptor.tier,
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
      driver_summary: buildDriverSummary(descriptor, NBA_DRIVER_WEIGHTS),
      meta: {
        inference_source: descriptor.inference_source,
        is_mock: descriptor.is_mock
      }
    };

    return {
      id: cardId,
      gameId,
      sport: 'NBA',
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
 * @param {object} options
 * @param {string|null} options.jobKey - Deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNBAModel({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-nba-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NBAModel] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[NBAModel] Job key: ${jobKey}`);
  console.log(`[NBAModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[NBAModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[NBAModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun('run_nba_model', jobRunId, jobKey);

      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      console.log('[NBAModel] Fetching odds for upcoming NBA games...');
      const oddsSnapshots = getOddsWithUpcomingGames('NBA', nowUtc.toISO(), horizonUtc);

      if (oddsSnapshots.length === 0) {
        console.log('[NBAModel] No upcoming NBA games found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }

      console.log(`[NBAModel] Found ${oddsSnapshots.length} odds snapshots`);

      // Dedupe: latest snapshot per game
      const gameOdds = {};
      oddsSnapshots.forEach(snap => {
        if (!gameOdds[snap.game_id] || snap.captured_at > gameOdds[snap.game_id].captured_at) {
          gameOdds[snap.game_id] = snap;
        }
      });

      const gameIds = Object.keys(gameOdds);
      console.log(`[NBAModel] Running NBA driver inference on ${gameIds.length} games...`);

      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];

      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          const driverCards = computeNBADriverCards(gameId, oddsSnapshot);

          if (driverCards.length === 0) {
            console.log(`  [skip] ${gameId}: No actionable NBA driver signals`);
            continue;
          }

          // Clear old driver card types for this game before writing
          const driverCardTypes = [...new Set(driverCards.map(c => c.cardType))];
          for (const ct of driverCardTypes) {
            prepareModelAndCardWrite(gameId, 'nba-drivers-v1', ct);
          }

          const cards = generateNBACards(gameId, driverCards, oddsSnapshot);

          for (const card of cards) {
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
            }
            insertCardPayload(card);
            cardsGenerated++;
            const tierLabel = card.payloadData.tier ? ` [${card.payloadData.tier}]` : '';
            console.log(`  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload')) throw gameError;
          cardsFailed++;
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  [err] ${gameId}: ${gameError.message}`);
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(`[NBAModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`);
      if (errors.length > 0) errors.forEach(err => console.error(`  - ${err}`));

      return { success: true, jobRunId, cardsGenerated, cardsFailed, errors };

    } catch (error) {
      console.error(`[NBAModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try { markJobRunFailure(jobRunId, error.message); } catch (_) {}
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNBAModel()
    .then(result => process.exit(result.success ? 0 : 1))
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNBAModel, generateNBACards };
