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

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsWithUpcomingGames,
  insertCardPayload,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  applyUiActionFields,
} = require('../utils/decision-publisher');

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

function toImpliedProbability(americanOdds) {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return null;
  return americanOdds < 0
    ? -americanOdds / (-americanOdds + 100)
    : 100 / (americanOdds + 100);
}

function deriveWinProbHome(h2hHome, h2hAway) {
  const pHome = toImpliedProbability(h2hHome);
  const pAway = toImpliedProbability(h2hAway);

  if (Number.isFinite(pHome) && Number.isFinite(pAway) && pHome + pAway > 0) {
    return Number((pHome / (pHome + pAway)).toFixed(4));
  }
  if (Number.isFinite(pHome)) {
    return Number(pHome.toFixed(4));
  }
  return null;
}

function parseRawData(rawData) {
  if (!rawData) return null;
  if (typeof rawData === 'object') return rawData;
  if (typeof rawData !== 'string') return null;
  try {
    return JSON.parse(rawData);
  } catch {
    return null;
  }
}

function deriveLeagueTag(oddsSnapshot) {
  const rawData = parseRawData(oddsSnapshot?.raw_data);
  const league = rawData?.league;
  if (typeof league !== 'string' || league.trim().length === 0) {
    return 'unknown';
  }
  return league.trim().toUpperCase();
}

function derivePredictionFromMoneyline(h2hHome, h2hAway) {
  const hasHome = Number.isFinite(h2hHome);
  const hasAway = Number.isFinite(h2hAway);

  if (hasHome && hasAway) {
    if (h2hHome === h2hAway) {
      return { prediction: 'HOME', price: h2hHome };
    }
    return h2hHome < h2hAway
      ? { prediction: 'HOME', price: h2hHome }
      : { prediction: 'AWAY', price: h2hAway };
  }
  if (hasHome) return { prediction: 'HOME', price: h2hHome };
  if (hasAway) return { prediction: 'AWAY', price: h2hAway };
  return { prediction: 'HOME', price: null };
}

function deriveConfidence({ h2hHome, h2hAway, winProbHome }) {
  const homeImplied = toImpliedProbability(h2hHome);
  const awayImplied = toImpliedProbability(h2hAway);
  if (Number.isFinite(homeImplied) && Number.isFinite(awayImplied)) {
    const impliedGap = Math.abs(homeImplied - awayImplied);
    return Math.min(0.55 + impliedGap * 1.25, 0.85);
  }

  if (Number.isFinite(winProbHome)) {
    return Math.min(0.54 + Math.abs(winProbHome - 0.5), 0.75);
  }

  return 0.55;
}

/**
 * Generate a basic soccer card from odds data
 */
function generateSoccerCard(gameId, oddsSnapshot) {
  const cardId = `card-soccer-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();
  const { prediction, price } = derivePredictionFromMoneyline(
    oddsSnapshot?.h2h_home,
    oddsSnapshot?.h2h_away,
  );
  const selectionTeam =
    prediction === 'HOME'
      ? oddsSnapshot?.home_team ?? null
      : oddsSnapshot?.away_team ?? null;
  const winProbHome = deriveWinProbHome(
    oddsSnapshot?.h2h_home,
    oddsSnapshot?.h2h_away,
  );
  const confidence = deriveConfidence({
    h2hHome: oddsSnapshot?.h2h_home,
    h2hAway: oddsSnapshot?.h2h_away,
    winProbHome,
  });
  const leagueTag = deriveLeagueTag(oddsSnapshot);

  const driversActive = [
    'moneyline_favorite_signal',
    'vig_normalized_home_probability',
    `league_context_${leagueTag.toLowerCase()}`,
  ];

  const missingContextFields = [];
  if (!Number.isFinite(oddsSnapshot?.h2h_home)) missingContextFields.push('h2h_home');
  if (!Number.isFinite(oddsSnapshot?.h2h_away)) missingContextFields.push('h2h_away');
  if (!Number.isFinite(price)) missingContextFields.push('locked_price');
  if (!selectionTeam) missingContextFields.push('selection_team');
  if (!Number.isFinite(winProbHome)) missingContextFields.push('projection.win_prob_home');
  const isMock = missingContextFields.length > 0;

  const expiresAt = null;

  const payloadData = {
    kind: 'PLAY',
    game_id: gameId,
    sport: 'SOCCER',
    model_version: 'soccer-model-v1',
    market_type: 'MONEYLINE',
    period: 'FULL_GAME',
    selection: {
      side: prediction,
      team: selectionTeam,
    },
    price,
    line: null,
    home_team: oddsSnapshot?.home_team ?? null,
    away_team: oddsSnapshot?.away_team ?? null,
    matchup: buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team),
    start_time_utc: oddsSnapshot?.game_time_utc ?? null,
    ...formatStartTimeLocal(oddsSnapshot?.game_time_utc),
    countdown: formatCountdown(oddsSnapshot?.game_time_utc),
    recommendation: (() => {
      const rec = buildRecommendationFromPrediction({
        prediction,
        recommendedBetType: 'moneyline',
      });
      return {
        type: rec.type,
        text: rec.text,
        pass_reason: rec.pass_reason,
      };
    })(),
    projection: {
      total: null,
      margin_home: null,
      win_prob_home: Number.isFinite(winProbHome) ? winProbHome : null,
    },
    projection_context: {
      source: 'vig_normalized_moneyline',
      available: Number.isFinite(winProbHome),
      unsupported_projection_fields: ['total', 'margin_home'],
      missing_fields:
        missingContextFields.length > 0 ? [...missingContextFields] : [],
      fallback_mode:
        missingContextFields.length > 0
          ? 'moneyline-partial-context'
          : null,
    },
    market: buildMarketFromOdds(oddsSnapshot),
    edge: null,
    confidence_pct: Math.round(confidence * 100),
    drivers_active: driversActive,
    prediction,
    confidence,
    recommended_bet_type: 'moneyline',
    reasoning: `Model prefers ${prediction} team at ${(confidence * 100).toFixed(0)}% confidence`,
    market_context: {
      version: 'v1',
      market_type: 'MONEYLINE',
      period: 'FULL_GAME',
      selection_side: prediction,
      selection_team: selectionTeam,
      projection: {
        win_prob_home: Number.isFinite(winProbHome) ? winProbHome : null,
        total: null,
        margin_home: null,
      },
      wager: {
        called_line: null,
        called_price: Number.isFinite(price) ? price : null,
        line_source: null,
        price_source: Number.isFinite(price) ? 'odds_snapshot' : null,
        period: 'FULL_GAME',
      },
    },
    odds_context: {
      h2h_home: oddsSnapshot?.h2h_home,
      h2h_away: oddsSnapshot?.h2h_away,
      moneyline_home: oddsSnapshot?.h2h_home ?? null,
      moneyline_away: oddsSnapshot?.h2h_away ?? null,
      draw_odds: null,
      captured_at: oddsSnapshot?.captured_at,
    },
    ev_passed: confidence > 0.55,
    disclaimer:
      'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    meta: {
      inference_source: isMock
        ? 'soccer-moneyline-hardening-fallback'
        : 'soccer-moneyline-hardening-v1',
      model_endpoint: null,
      is_mock: isMock,
      hardening_version: 'soccer-hardening-v1',
      league_context: leagueTag,
      missing_context_fields:
        missingContextFields.length > 0 ? [...missingContextFields] : [],
    },
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
    modelOutputIds: null,
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
      console.log(
        `[SoccerModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[SoccerModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
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
      const oddsSnapshots = getOddsWithUpcomingGames(
        'SOCCER',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        console.log('[SoccerModel] No recent SOCCER odds found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }

      console.log(`[SoccerModel] Found ${oddsSnapshots.length} odds snapshots`);

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
        `[SoccerModel] Running inference on ${gameIds.length} games...`,
      );

      let cardsGenerated = 0;

      // Process each game
      for (const gameId of gameIds) {
        try {
          const oddsSnapshot = gameOdds[gameId];
          const card = generateSoccerCard(gameId, oddsSnapshot);

          const validation = validateCardPayload(
            card.cardType,
            card.payloadData,
          );
          if (!validation.success) {
            throw new Error(
              `Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`,
            );
          }

          publishDecisionForCard({ card, oddsSnapshot });
          applyUiActionFields(card.payloadData);
          attachRunId(card, jobRunId);
          insertCardPayload(card);
          cardsGenerated++;
          console.log(
            `  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
          );
        } catch (gameError) {
          console.error(`  [error] ${gameId}: ${gameError.message}`);
        }
      }

      // Mark job as success
      console.log(
        `[SoccerModel] ✅ Complete: ${cardsGenerated} cards generated`,
      );
      markJobRunSuccess(jobRunId);
      try {
        setCurrentRunId(jobRunId, 'soccer');
      } catch (runStateError) {
        console.error(
          `[SoccerModel] Failed to update run state: ${runStateError.message}`,
        );
      }

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
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = {
  runSoccerModel,
  generateSoccerCard,
  deriveWinProbHome,
  derivePredictionFromMoneyline,
};
