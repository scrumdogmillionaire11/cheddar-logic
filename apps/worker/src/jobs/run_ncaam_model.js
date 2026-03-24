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
  updateOddsSnapshotRawData,
  getDatabase,
} = require('@cheddar-logic/data');
const { computeNCAAMDriverCards, generateCard } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  buildPipelineState,
  collectDecisionReasonCodes,
  edgeCalculator,
  marginToWinProbability,
  WATCHDOG_REASONS,
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  applyUiActionFields,
} = require('../utils/decision-publisher');
const {
  normalizeRawDataPayload,
} = require('../utils/normalize-raw-data-payload');
const { assessProjectionInputs } = require('../models/projections');

const NCAAM_DRIVER_WEIGHTS = {
  baseProjection: 0.4,
  restAdvantage: 0.2,
  matchupStyle: 0.2,
  freeThrowTrend: 0.2,
  // Backward compatibility for older persisted payloads.
  freeThrowEdge: 0.2,
};

const NCAAM_DRIVER_CARD_TYPES = [
  'ncaam-base-projection',
  'ncaam-rest-advantage',
  'ncaam-matchup-style',
  'ncaam-ft-trend',
  // Legacy FT driver card type retained for clear/rewrite compatibility.
  'ncaam-ft-spread',
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

function applyProjectionInputMetadata(card, projectionGate) {
  if (!card?.payloadData || !projectionGate) return;
  card.payloadData.projection_inputs_complete =
    projectionGate.projection_inputs_complete;
  card.payloadData.missing_inputs = Array.isArray(projectionGate.missing_inputs)
    ? projectionGate.missing_inputs
    : [];
}

function hasFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasMoneylineOdds(oddsSnapshot) {
  const homePrice = oddsSnapshot?.h2h_home ?? oddsSnapshot?.moneyline_home;
  const awayPrice = oddsSnapshot?.h2h_away ?? oddsSnapshot?.moneyline_away;
  return hasFiniteNumber(homePrice) && hasFiniteNumber(awayPrice);
}

function hasSpreadOdds(oddsSnapshot) {
  return (
    hasFiniteNumber(oddsSnapshot?.spread_home) &&
    hasFiniteNumber(oddsSnapshot?.spread_away) &&
    hasFiniteNumber(oddsSnapshot?.spread_price_home) &&
    hasFiniteNumber(oddsSnapshot?.spread_price_away)
  );
}

function hasTotalOdds(oddsSnapshot) {
  return (
    hasFiniteNumber(oddsSnapshot?.total) &&
    hasFiniteNumber(oddsSnapshot?.total_price_over) &&
    hasFiniteNumber(oddsSnapshot?.total_price_under)
  );
}

function buildGamePipelineState({
  oddsSnapshot,
  projectionReady,
  driversReady,
  pricingReady,
  cardReady,
  blockingReasonCodes = [],
}) {
  const teamMappingOk = Boolean(
    oddsSnapshot?.home_team && oddsSnapshot?.away_team,
  );
  const marketLinesOk =
    hasMoneylineOdds(oddsSnapshot) ||
    hasSpreadOdds(oddsSnapshot) ||
    hasTotalOdds(oddsSnapshot);

  return buildPipelineState({
    ingested: Boolean(oddsSnapshot),
    team_mapping_ok: teamMappingOk,
    odds_ok: Boolean(oddsSnapshot?.captured_at) && marketLinesOk,
    market_lines_ok: marketLinesOk,
    projection_ready: projectionReady === true,
    drivers_ready: driversReady === true,
    pricing_ready: pricingReady === true,
    card_ready: cardReady === true,
    blocking_reason_codes: blockingReasonCodes,
  });
}

function deriveGameBlockingReasonCodes({
  oddsSnapshot,
  projectionReady,
  pricingReady,
  cards = [],
}) {
  const reasonCodes = [];
  const hasTeamMapping = Boolean(
    oddsSnapshot?.home_team && oddsSnapshot?.away_team,
  );
  const hasMarketLines =
    hasMoneylineOdds(oddsSnapshot) ||
    hasSpreadOdds(oddsSnapshot) ||
    hasTotalOdds(oddsSnapshot);

  if (!hasTeamMapping) {
    reasonCodes.push(WATCHDOG_REASONS.CONSISTENCY_MISSING);
  }

  if (!hasMarketLines) {
    reasonCodes.push(WATCHDOG_REASONS.MARKET_UNAVAILABLE);
  }

  if (projectionReady === false) {
    reasonCodes.push(WATCHDOG_REASONS.CONSISTENCY_MISSING);
  }

  if (pricingReady === false) {
    cards.forEach((card) => {
      reasonCodes.push(...collectDecisionReasonCodes(card?.payloadData));
    });
  }

  return reasonCodes;
}

function canPriceCard(card) {
  const sharpPriceStatus = card?.payloadData?.decision_v2?.sharp_price_status;
  return Boolean(sharpPriceStatus && sharpPriceStatus !== 'UNPRICED');
}

/**
 * Generate insertable card objects from NCAAM driver descriptors.
 * Generates both moneyline AND spread cards for each driver signal.
 */
function generateNCAAMCards(gameId, driverDescriptors, oddsSnapshot) {
  const now = new Date().toISOString();
  const expiresAt = null;

  const cards = [];

  for (const descriptor of driverDescriptors) {
    const marketTypes = Array.isArray(descriptor?.marketTypes)
      ? descriptor.marketTypes
      : null;
    const allowMoneyline = !marketTypes || marketTypes.includes('moneyline');
    const allowSpread = !marketTypes || marketTypes.includes('spread');

    if (allowMoneyline) {
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
    }

    // Generate SPREAD card only when both line and price are available
    // and the projected margin actually beats the spread line.
    // Without the spread-line comparison, direction-only projections
    // (e.g. ncaam-base-projection) produce HOME picks on the wrong side
    // of spread markets — they win on moneyline but lose on spread.
    // Only gate when projected_margin is present; other drivers (rest-advantage,
    // matchup-style) are direction-signal based and pass through unchanged.
    //
    // Steep-ML reinforcement: when the ML is -300 or steeper for the predicted
    // side and no projected_margin is available, back-calculate an implied margin
    // from the market's own win probability via invNormCdf. This conservative
    // estimate (using market prob, not model fair prob) ensures games where the
    // market itself implies a large enough margin get a spread card with real
    // edge math rather than being blocked by missing team metrics.
    const STEEP_ML_THRESHOLD = -300;
    const NCAAM_SPREAD_SIGMA = 11;

    const projectedMargin = descriptor?.driverInputs?.projected_margin;
    const spreadHome = oddsSnapshot?.spread_home;

    // For steep-ML games without a team-metrics margin, derive one from market ML.
    let effectiveDescriptor = descriptor;
    if (
      projectedMargin == null &&
      spreadHome != null &&
      oddsSnapshot?.spread_price_home != null &&
      oddsSnapshot?.spread_price_away != null
    ) {
      const predictedML =
        descriptor.prediction === 'HOME'
          ? (oddsSnapshot?.h2h_home ?? oddsSnapshot?.moneyline_home)
          : (oddsSnapshot?.h2h_away ?? oddsSnapshot?.moneyline_away);

      if (Number.isFinite(predictedML) && predictedML <= STEEP_ML_THRESHOLD) {
        const pMarket = edgeCalculator.impliedProbFromAmerican(predictedML);
        if (pMarket != null) {
          const mlImpliedMarginAbs =
            edgeCalculator.invNormCdf(pMarket) * NCAAM_SPREAD_SIGMA;
          // Express as signed home margin matching descriptor direction
          const mlImpliedMargin =
            descriptor.prediction === 'HOME'
              ? mlImpliedMarginAbs
              : -mlImpliedMarginAbs;
          effectiveDescriptor = {
            ...descriptor,
            driverInputs: {
              ...descriptor.driverInputs,
              projected_margin: mlImpliedMargin,
              margin_source: 'ml_implied',
            },
          };
        }
      }
    }

    const effectiveMargin = effectiveDescriptor?.driverInputs?.projected_margin;
    const projectionBeatsSpread =
      effectiveMargin == null ||
      spreadHome == null ||
      (descriptor.prediction === 'HOME'
        ? effectiveMargin > -spreadHome
        : effectiveMargin < -spreadHome);

    if (
      allowSpread &&
      projectionBeatsSpread &&
      oddsSnapshot?.spread_home != null &&
      oddsSnapshot?.spread_away != null &&
      oddsSnapshot?.spread_price_home != null &&
      oddsSnapshot?.spread_price_away != null
    ) {
      cards.push(
        generateCard({
          sport: 'NCAAM',
          gameId,
          descriptor: effectiveDescriptor,
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

      // WI-0591: Compute empirical sigma from settled game history at job start.
      // Falls back to hardcoded defaults when fewer than 20 settled games exist.
      const computedSigma = edgeCalculator.computeSigmaFromHistory({
        sport: 'NCAAM',
        db: getDatabase(),
      });
      console.log('[run_ncaam_model] sigma:', JSON.stringify(computedSigma));

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
      let skippedRaceCount = 0;
      let projectionBlockedCount = 0;
      const gamePipelineStates = {};

      // Process each game independently. Missing signals for one game should not
      // block card generation for other games.
      for (const gameId of gameIds) {
        const queuedOddsSnapshot = gameOdds[gameId];
        // Scope the per-game race guard to the current parent run so that each
        // new model invocation can reprocess games. Using jobRunId (unique per run)
        // prevents two concurrent instances of the same run from double-processing a
        // game while still allowing the next scheduled run to process it fresh.
        const gameJobKey = `ncaam-model|${gameId}|${jobRunId}`;
        const gameJobRunId = `job-ncaam-game-${gameId}-${jobRunId.slice(-8)}`;

        if (!shouldRunJobKey(gameJobKey)) {
          gamePipelineStates[gameId] = buildGamePipelineState({
            oddsSnapshot: queuedOddsSnapshot,
            projectionReady: false,
            driversReady: false,
            pricingReady: false,
            cardReady: false,
          });
          console.log(
            `  [RaceGuard] Skipping ${gameId} — job key already running or successful`,
          );
          skippedRaceCount++;
          continue;
        }

        try {
          insertJobRun('run_ncaam_model_game', gameJobRunId, gameJobKey);
        } catch (claimError) {
          if (claimError.code === 'JOB_RUN_ALREADY_CLAIMED') {
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot: queuedOddsSnapshot,
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
            });
            console.log(
              `  [RaceGuard] Skipping ${gameId} — another process claimed model job`,
            );
            skippedRaceCount++;
            continue;
          }
          throw claimError;
        }

        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          const normalizedRawData = normalizeRawDataPayload(
            oddsSnapshot.raw_data,
          );
          oddsSnapshot.raw_data = normalizedRawData;

          // Persist enrichment to database so models have access to ESPN metrics
          try {
            updateOddsSnapshotRawData(oddsSnapshot.id, normalizedRawData);
          } catch (persistError) {
            console.log(
              `  [warn] ${gameId}: Failed to persist enrichment payload (${persistError.message})`,
            );
          }

          const projectionGate = assessProjectionInputs('NCAAM', oddsSnapshot);
          if (!projectionGate.projection_inputs_complete) {
            projectionBlockedCount++;
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot,
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
              blockingReasonCodes: deriveGameBlockingReasonCodes({
                oddsSnapshot,
                projectionReady: false,
                pricingReady: false,
              }),
            });
            console.log(
              `  [gate] ${gameId}: PROJECTION_INPUTS_INCOMPLETE (${projectionGate.missing_inputs.join(', ')})`,
            );
            continue;
          }

          const driverCards = computeNCAAMDriverCards(gameId, oddsSnapshot);
          if (driverCards.length === 0) {
            noSignalCount++;
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot,
              projectionReady: true,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
              blockingReasonCodes: deriveGameBlockingReasonCodes({
                oddsSnapshot,
                projectionReady: true,
                pricingReady: false,
              }),
            });
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
            prepareModelAndCardWrite(gameId, 'ncaam-drivers-v1', ct, {
              runId: jobRunId,
            });
          }

          const cards = generateNCAAMCards(gameId, driverCards, oddsSnapshot);
          const pendingCards = [];

          for (const card of cards) {
            applyProjectionInputMetadata(card, projectionGate);
            const validation = validateCardPayload(
              card.cardType,
              card.payloadData,
            );
            if (!validation.success) {
              throw new Error(
                `Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`,
              );
            }

            const allowFtTrendOverride =
              card.cardType === 'ncaam-ft-trend' &&
              card.payloadData?.market_type === 'spread';
            const decisionOutcome = publishDecisionForCard({
              card,
              oddsSnapshot,
              options: allowFtTrendOverride
                ? { criticalOverride: true, sigmaOverride: computedSigma }
                : { sigmaOverride: computedSigma },
            });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(
                `  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`,
              );
            }

            applyUiActionFields(card.payloadData, { oddsSnapshot });
            attachRunId(card, jobRunId);
            pendingCards.push({
              card,
              logLine:
                `  [ok] ${gameId} [${card.cardType}/${card.payloadData.market_type}]: ` +
                `${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            });
          }

          const pricingReady = pendingCards.some((entry) =>
            canPriceCard(entry.card),
          );
          const pipelineState = buildGamePipelineState({
            oddsSnapshot,
            projectionReady: true,
            driversReady: true,
            pricingReady,
            cardReady: pendingCards.length > 0,
            blockingReasonCodes: deriveGameBlockingReasonCodes({
              oddsSnapshot,
              projectionReady: true,
              pricingReady,
              cards: pendingCards.map((entry) => entry.card),
            }),
          });
          gamePipelineStates[gameId] = pipelineState;

          for (const entry of pendingCards) {
            entry.card.payloadData.pipeline_state = pipelineState;
            insertCardPayload(entry.card);
            cardsGenerated++;
            console.log(entry.logLine);
          }
          markJobRunSuccess(gameJobRunId);
        } catch (gameError) {
          gameErrorCount++;
          if (!gamePipelineStates[gameId]) {
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot: queuedOddsSnapshot,
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
            });
          }
          console.error(`  [error] ${gameId}: ${gameError.message}`);
          try {
            markJobRunFailure(gameJobRunId, gameError.message);
          } catch (markError) {
            console.error(
              `  [error] Failed to mark game job failure for ${gameId}: ${markError.message}`,
            );
          }
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
      if (skippedRaceCount > 0) {
        console.log(
          `[NCAAMModel] Race-guard skipped: ${skippedRaceCount}/${gameIds.length} (another process running)`,
        );
      }
      if (projectionBlockedCount > 0) {
        console.log(
          `[NCAAMModel] Projection input gate: ${projectionBlockedCount}/${gameIds.length} games blocked`,
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
      const summary = {
        cardsGenerated,
        noSignalCount,
        gameErrorCount,
        skippedRaceCount,
        projectionBlockedCount,
        pipeline_states: gamePipelineStates,
      };
      console.log(
        `[NCAAMModel] Pipeline states: ${JSON.stringify(gamePipelineStates)}`,
      );
      markJobRunSuccess(jobRunId, summary);
      try {
        setCurrentRunId(jobRunId, 'ncaam');
      } catch (runStateError) {
        console.error(
          `[NCAAMModel] Failed to update run state: ${runStateError.message}`,
        );
      }

      return { success: true, jobRunId, ...summary };
    } catch (error) {
      if (error.code === 'JOB_RUN_ALREADY_CLAIMED') {
        console.log(
          `[RaceGuard] Skipping run_ncaam_model (job already claimed): ${jobKey || 'none'}`,
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
