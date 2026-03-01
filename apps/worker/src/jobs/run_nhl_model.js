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
  withDb,
  enrichOddsSnapshotWithEspnMetrics
} = require('@cheddar-logic/data');

// Import pluggable inference layer
const {
  getModel,
  computeNHLDriverCards,
  computeNHLMarketDecisions,
  selectExpressionChoice,
  buildMarketPayload,
  determineTier
} = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds
} = require('@cheddar-logic/models');

const NHL_DRIVER_WEIGHTS = {
  baseProjection: 0.30,
  restAdvantage: 0.14,
  goalie: 0.18,
  scoringEnvironment: 0.08,
  paceTotals: 0.12,
  paceTotals1p: 0.08
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
 * Generate insertable card objects from driver descriptors.
 *
 * @param {string} gameId
 * @param {Array<object>} driverDescriptors - Output of computeNHLDriverCards()
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card objects ready for insertCardPayload()
 */
function generateNHLCards(gameId, driverDescriptors, oddsSnapshot, marketPayload) {
  const marketData = marketPayload || {};
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  return driverDescriptors.map(descriptor => {
    const cardId = `card-nhl-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
    const isPaceTotalsCard = descriptor.cardType === 'nhl-pace-totals';
    const isPace1pCard = descriptor.cardType === 'nhl-pace-1p';
    const projectedTotal = isPaceTotalsCard
      ? (descriptor.driverInputs?.expected_total ?? null)
      : isPace1pCard
        ? (descriptor.driverInputs?.expected_1p_total ?? null)
        : null;
    const projectedEdge = (isPaceTotalsCard || isPace1pCard)
      ? (descriptor.driverInputs?.edge ?? null)
      : null;
    const recommendedBetType = (isPaceTotalsCard || isPace1pCard) ? 'total' : 'moneyline';
    const recommendation = buildRecommendationFromPrediction({
      prediction: descriptor.prediction,
      recommendedBetType
    });
    const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
    const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
    const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
    const market = buildMarketFromOdds(oddsSnapshot);
    const payloadData = {
      game_id: gameId,
      sport: 'NHL',
      model_version: 'nhl-drivers-v1',
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
      tier: descriptor.tier,
      recommended_bet_type: recommendedBetType,
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
      driver_summary: buildDriverSummary(descriptor, NHL_DRIVER_WEIGHTS),
      meta: {
        inference_source: descriptor.inference_source,
        is_mock: descriptor.is_mock
      },
      ...marketData
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
 * Generate standalone market call cards (nhl-totals-call, nhl-spread-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNHLMarketCallCards(gameId, marketDecisions, oddsSnapshot) {
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);

  const cards = [];
  const CONFIDENCE_MAP = { FIRE: 0.74, WATCH: 0.61 };

  // TOTAL decision → nhl-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  if (totalDecision && (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH')) {
    const confidence = CONFIDENCE_MAP[totalDecision.status];
    const tier = determineTier(confidence);
    const { side, line } = totalDecision.best_candidate;
    const lineText = line != null ? ` ${line}` : '';
    const pickText = `${side === 'OVER' ? 'OVER' : 'UNDER'}${lineText}`;
    const activeDrivers = (totalDecision.drivers || [])
      .filter(d => d.eligible)
      .map(d => d.driverKey);
    const topDrivers = (totalDecision.drivers || [])
      .filter(d => d.eligible)
      .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
      .slice(0, 3)
      .map(d => ({ driver: d.driverKey, weight: d.weight, score: Number(((d.signal + 1) / 2).toFixed(3)) }));

    const cardId = `card-nhl-totals-call-${gameId}-${uuidV4().slice(0, 8)}`;
    cards.push({
      id: cardId,
      gameId,
      sport: 'NHL',
      cardType: 'nhl-totals-call',
      cardTitle: `NHL Totals: ${pickText}`,
      createdAt: now,
      expiresAt,
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        model_version: 'nhl-cross-market-v1',
        home_team: oddsSnapshot?.home_team ?? null,
        away_team: oddsSnapshot?.away_team ?? null,
        matchup,
        start_time_utc: oddsSnapshot?.game_time_utc ?? null,
        start_time_local: startTimeLocal,
        timezone,
        countdown,
        prediction: side,
        confidence,
        tier,
        recommended_bet_type: 'total',
        reasoning: `${pickText}: ${totalDecision.reasoning}`,
        edge: totalDecision.edge ?? null,
        projection: {
          total: line ?? null,
          margin_home: null,
          win_prob_home: null
        },
        market,
        drivers_active: activeDrivers,
        driver_summary: { weights: topDrivers, impact_note: 'Cross-market totals decision.' },
        ev_passed: totalDecision.status === 'FIRE',
        odds_context: {
          h2h_home: oddsSnapshot?.h2h_home,
          h2h_away: oddsSnapshot?.h2h_away,
          spread_home: oddsSnapshot?.spread_home,
          spread_away: oddsSnapshot?.spread_away,
          total: oddsSnapshot?.total,
          captured_at: oddsSnapshot?.captured_at
        },
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_total',
          score: totalDecision.score,
          status: totalDecision.status,
          inputs: { net: totalDecision.net, conflict: totalDecision.conflict, coverage: totalDecision.coverage }
        },
        disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now
      },
      modelOutputIds: null
    });
  }

  // SPREAD decision → nhl-spread-call
  const spreadDecision = marketDecisions?.SPREAD;
  if (spreadDecision && (spreadDecision.status === 'FIRE' || spreadDecision.status === 'WATCH')) {
    const confidence = CONFIDENCE_MAP[spreadDecision.status];
    const tier = determineTier(confidence);
    const { side, line } = spreadDecision.best_candidate;
    const lineText = line != null ? ` ${line > 0 ? '+' + line : line}` : '';
    const pickText = `${side === 'HOME' ? 'Home' : 'Away'}${lineText}`;
    const activeDrivers = (spreadDecision.drivers || [])
      .filter(d => d.eligible)
      .map(d => d.driverKey);
    const topDrivers = (spreadDecision.drivers || [])
      .filter(d => d.eligible)
      .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
      .slice(0, 3)
      .map(d => ({ driver: d.driverKey, weight: d.weight, score: Number(((d.signal + 1) / 2).toFixed(3)) }));

    const cardId = `card-nhl-spread-call-${gameId}-${uuidV4().slice(0, 8)}`;
    cards.push({
      id: cardId,
      gameId,
      sport: 'NHL',
      cardType: 'nhl-spread-call',
      cardTitle: `NHL Spread: ${pickText}`,
      createdAt: now,
      expiresAt,
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        model_version: 'nhl-cross-market-v1',
        home_team: oddsSnapshot?.home_team ?? null,
        away_team: oddsSnapshot?.away_team ?? null,
        matchup,
        start_time_utc: oddsSnapshot?.game_time_utc ?? null,
        start_time_local: startTimeLocal,
        timezone,
        countdown,
        prediction: side,
        confidence,
        tier,
        recommended_bet_type: 'spread',
        reasoning: `${pickText}: ${spreadDecision.reasoning}`,
        edge: spreadDecision.edge ?? null,
        projection: {
          total: null,
          margin_home: line ?? null,
          win_prob_home: null
        },
        market,
        drivers_active: activeDrivers,
        driver_summary: { weights: topDrivers, impact_note: 'Cross-market spread decision.' },
        ev_passed: spreadDecision.status === 'FIRE',
        odds_context: {
          h2h_home: oddsSnapshot?.h2h_home,
          h2h_away: oddsSnapshot?.h2h_away,
          spread_home: oddsSnapshot?.spread_home,
          spread_away: oddsSnapshot?.spread_away,
          total: oddsSnapshot?.total,
          captured_at: oddsSnapshot?.captured_at
        },
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_spread',
          score: spreadDecision.score,
          status: spreadDecision.status,
          inputs: { net: spreadDecision.net, conflict: spreadDecision.conflict, coverage: spreadDecision.coverage }
        },
        disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now
      },
      modelOutputIds: null
    });
  }

  return cards;
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
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          // Compute per-driver card descriptors
          const driverCards = computeNHLDriverCards(gameId, oddsSnapshot);

          const marketDecisions = computeNHLMarketDecisions(oddsSnapshot);
          const expressionChoice = selectExpressionChoice(marketDecisions);
          const marketPayload = buildMarketPayload({ decisions: marketDecisions, expressionChoice });

          if (driverCards.length === 0) {
            console.log(`  [skip] ${gameId}: No driver cards (all data missing)`);
            continue;
          }

          // Prepare write: clear old driver card types for this game
          const driverCardTypes = [...new Set(driverCards.map(c => c.cardType))];
          for (const ct of driverCardTypes) {
            prepareModelAndCardWrite(gameId, 'nhl-drivers-v1', ct);
          }

          const cards = generateNHLCards(gameId, driverCards, oddsSnapshot, marketPayload);

          for (const card of cards) {
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
            }
            insertCardPayload(card);
            cardsGenerated++;
            console.log(`  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
          }

          // Generate and insert market call cards (nhl-totals-call, nhl-spread-call)
          const marketCallCards = generateNHLMarketCallCards(gameId, marketDecisions, oddsSnapshot);
          for (const ct of ['nhl-totals-call', 'nhl-spread-call']) {
            prepareModelAndCardWrite(gameId, 'nhl-cross-market-v1', ct);
          }
          for (const card of marketCallCards) {
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

module.exports = { runNHLModel, generateNHLCards, generateNHLMarketCallCards };
