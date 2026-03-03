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
const { computeNCAAMDriverCards } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  edgeCalculator,
  marginToWinProbability
} = require('@cheddar-logic/models');
const { publishDecisionForCard, applyUiActionFields } = require('../utils/decision-publisher');

const NCAAM_DRIVER_WEIGHTS = {
  baseProjection: 0.40,
  restAdvantage: 0.20,
  matchupStyle: 0.20
};

function computeWinProbHome(projectedMargin, sport) {
  if (!Number.isFinite(projectedMargin)) return null;
  const sigma = edgeCalculator.getSigmaDefaults(sport)?.margin ?? 11;
  const winProb = marginToWinProbability(projectedMargin, sigma);
  return Number.isFinite(winProb) ? Number(winProb.toFixed(4)) : null;
}

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
    cards.push(generateSingleCard(gameId, descriptor, oddsSnapshot, 'moneyline', now, expiresAt));
    
    // Generate SPREAD card (if spread odds available)
    if (oddsSnapshot?.spread_home != null && oddsSnapshot?.spread_away != null) {
      cards.push(generateSingleCard(gameId, descriptor, oddsSnapshot, 'spread', now, expiresAt));
    }
  }
  
  return cards;
}

/**
 * Generate a single card for a specific market type
 */
function generateSingleCard(gameId, descriptor, oddsSnapshot, marketType, now, expiresAt) {
    const cardId = `card-ncaam-${descriptor.driverKey}-${marketType}-${gameId}-${uuidV4().slice(0, 8)}`;
    const recommendation = buildRecommendationFromPrediction({
      prediction: descriptor.prediction,
      recommendedBetType: marketType
    });

    const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
    const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
    const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
    const market = buildMarketFromOdds(oddsSnapshot);
    const selectionSide = descriptor.prediction === 'NEUTRAL' ? 'NONE' : descriptor.prediction;
    const projectedMargin = Number.isFinite(descriptor.driverInputs?.projected_margin)
      ? descriptor.driverInputs.projected_margin
      : null;
    const winProbHome = computeWinProbHome(projectedMargin, 'NCAAM');
    const isPredictionHome = descriptor.prediction === 'HOME';
    const isPredictionAway = descriptor.prediction === 'AWAY';
    
    // Market-specific odds and edge calculation
    let price = null;
    let line = null;
    let edgeResult = { edge: null, p_fair: null, p_implied: null };
    let marketTypeUpper = 'MONEYLINE';
    
    if (marketType === 'moneyline') {
      marketTypeUpper = 'MONEYLINE';
      price = isPredictionHome
        ? oddsSnapshot?.h2h_home ?? null
        : isPredictionAway
          ? oddsSnapshot?.h2h_away ?? null
          : null;
      line = null;
      
      if ((isPredictionHome || isPredictionAway) && price !== null) {
        edgeResult = edgeCalculator.computeMoneylineEdge({
          projectionWinProbHome: winProbHome,
          americanOdds: price,
          isPredictionHome
        });
      }
    } else if (marketType === 'spread') {
      marketTypeUpper = 'SPREAD';
      line = isPredictionHome
        ? oddsSnapshot?.spread_home ?? null
        : isPredictionAway
          ? oddsSnapshot?.spread_away ?? null
          : null;
      price = isPredictionHome
        ? oddsSnapshot?.spread_price_home ?? null
        : isPredictionAway
          ? oddsSnapshot?.spread_price_away ?? null
          : null;
      
      if ((isPredictionHome || isPredictionAway) && line !== null && price !== null) {
        edgeResult = edgeCalculator.computeSpreadEdge({
          projectionMarginHome: projectedMargin,
          spreadLine: line,
          americanOdds: price,
          isPredictionHome
        });
      }
    }

    const payloadData = {
      game_id: gameId,
      sport: 'NCAAM',
      model_version: 'ncaam-drivers-v1',
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
        margin_home: projectedMargin,
        win_prob_home: winProbHome
      },
      market,
      edge: edgeResult.edge ?? null,
      p_fair: edgeResult.p_fair ?? null,
      p_implied: edgeResult.p_implied ?? null,
      confidence_pct: Math.round(descriptor.confidence * 100),
      drivers_active: [descriptor.driverKey],
      prediction: descriptor.prediction,
      confidence: descriptor.confidence,
      recommended_bet_type: marketType,
      kind: 'PLAY',
      market_type: marketTypeUpper,
      selection: {
        side: selectionSide,
        team:
          descriptor.prediction === 'HOME'
            ? oddsSnapshot?.home_team ?? undefined
            : descriptor.prediction === 'AWAY'
              ? oddsSnapshot?.away_team ?? undefined
              : undefined
      },
      line,
      price,
      reason_codes: edgeResult.edge == null ? ['PASS_MISSING_EDGE'] : [],
      tags: [],
      consistency: {
        total_bias: 'INSUFFICIENT_DATA'
      },
      tier: descriptor.tier,
      reasoning: descriptor.reasoning,
      odds_context: {
        h2h_home: oddsSnapshot?.h2h_home,
        h2h_away: oddsSnapshot?.h2h_away,
        spread_home: oddsSnapshot?.spread_home,
        spread_away: oddsSnapshot?.spread_away,
        total: oddsSnapshot?.total,
        spread_price_home: oddsSnapshot?.spread_price_home,
        spread_price_away: oddsSnapshot?.spread_price_away,
        total_price_over: oddsSnapshot?.total_price_over,
        total_price_under: oddsSnapshot?.total_price_under,
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
      driver_summary: buildDriverSummary(descriptor, NCAAM_DRIVER_WEIGHTS),
      meta: {
        inference_source: descriptor.inference_source,
        is_mock: descriptor.is_mock
      }
    };

    return {
      id: cardId,
      gameId,
      sport: 'NCAAM',
      cardType: descriptor.cardType,
      cardTitle: `${descriptor.cardTitle} (${marketTypeUpper})`,
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
      console.log(`[NCAAMModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(`[NCAAMModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
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
      const oddsSnapshots = getOddsWithUpcomingGames('NCAAM', nowUtc.toISO(), horizonUtc);
      
      if (oddsSnapshots.length === 0) {
        console.log('[NCAAMModel] No recent NCAAM odds found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }
      
      console.log(`[NCAAMModel] Found ${oddsSnapshots.length} odds snapshots`);
      
      // Group by game_id and get latest for each
      const gameOdds = {};
      oddsSnapshots.forEach(snap => {
        if (!gameOdds[snap.game_id] || snap.captured_at > gameOdds[snap.game_id].captured_at) {
          gameOdds[snap.game_id] = snap;
        }
      });
      
      const gameIds = Object.keys(gameOdds);
      console.log(`[NCAAMModel] Running inference on ${gameIds.length} games...`);

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
            console.warn(`  [skip] ${gameId}: No actionable NCAAM driver signals`);
            continue;
          }

          const driverCardTypes = [...new Set(driverCards.map(c => c.cardType))];
          for (const ct of driverCardTypes) {
            prepareModelAndCardWrite(gameId, 'ncaam-drivers-v1', ct);
          }

          const cards = generateNCAAMCards(gameId, driverCards, oddsSnapshot);

          for (const card of cards) {
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
            }

            const decisionOutcome = publishDecisionForCard({ card, oddsSnapshot });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(`  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`);
            }

            applyUiActionFields(card.payloadData);
            insertCardPayload(card);
            cardsGenerated++;
            console.log(`  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
          }
        } catch (gameError) {
          gameErrorCount++;
          console.error(`  [error] ${gameId}: ${gameError.message}`);
        }
      }

      if (noSignalCount > 0) {
        console.warn(`[NCAAMModel] No-signal games skipped: ${noSignalCount}/${gameIds.length}`);
      }
      if (gameErrorCount > 0) {
        console.warn(`[NCAAMModel] Game-level errors: ${gameErrorCount}/${gameIds.length}`);
      }

      if (cardsGenerated === 0) {
        throw new Error(
          `NCAAM model generated 0 cards (${noSignalCount} no-signal, ${gameErrorCount} errored)`
        );
      }

      // Mark job as success
      console.log(`[NCAAMModel] ✅ Complete: ${cardsGenerated} cards generated`);
      console.log(`[NCAAMModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`);
      markJobRunSuccess(jobRunId);
      
      return { success: true, jobRunId, cardsGenerated };
    } catch (error) {
      console.error(`[NCAAMModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[NCAAMModel] Failed to record error to DB:`, dbError.message);
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNCAAMModel()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNCAAMModel };
