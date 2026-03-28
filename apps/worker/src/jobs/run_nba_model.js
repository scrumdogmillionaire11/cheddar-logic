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

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsWithUpcomingGames,
  getUpcomingGamesAsSyntheticSnapshots,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  enrichOddsSnapshotWithEspnMetrics,
  updateOddsSnapshotRawData,
  getDatabase,
  computeLineDelta,
} = require('@cheddar-logic/data');

const {
  computeNBADriverCards,
  generateCard,
  computeNBAMarketDecisions,
  selectExpressionChoice,
  computeTotalBias,
  buildMarketPayload,
  determineTier,
  buildMarketCallCard,
} = require('../models');
const { assessProjectionInputs } = require('../models/projections');
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
  buildDecisionBasisMeta,
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  applyUiActionFields,
} = require('../utils/decision-publisher');
const {
  normalizeRawDataPayload,
} = require('../utils/normalize-raw-data-payload');
const {
  resolveThresholdProfile,
} = require('@cheddar-logic/models');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';

const NBA_DRIVER_WEIGHTS = {
  baseProjection: 0.35,
  restAdvantage: 0.15,
  welcomeHomeV2: 0.1,
  matchupStyle: 0.2,
  blowoutRisk: 0.07,
  totalProjection: 0.13,
};

const NBA_DRIVER_CARD_TYPES = [
  'nba-base-projection',
  'nba-rest-advantage',
  'welcome-home',
  'welcome-home-v2', // alias: backward compat with existing DB rows
  'nba-matchup-style',
  'nba-blowout-risk',
  'nba-total-projection',
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computePricedCallCardConfidence({ edgePct, conflictScore }) {
  const normalizedEdgePct = hasFiniteNumber(edgePct) ? edgePct : 0;
  const normalizedConflictScore = hasFiniteNumber(conflictScore)
    ? conflictScore
    : 0;
  const baseConfidence = clamp(0.5 + normalizedEdgePct * 3, 0.5, 0.9);

  return edgeCalculator.computeConfidence({
    baseConfidence,
    watchdogStatus: 'OK',
    missingFieldCount: 0,
    proxyUsed: false,
    conflictScore: normalizedConflictScore,
  });
}

function buildMarketLineContext({
  sport,
  gameId,
  marketType,
  selectionSide = null,
}) {
  try {
    return computeLineDelta({
      sport,
      gameId,
      marketType,
      selectionSide,
    });
  } catch (error) {
    console.warn(
      `[NBAModel] Failed to compute ${marketType} line delta for ${gameId}: ${error.message}`,
    );
    return null;
  }
}

function buildLineContextPayload(lineContext, selectionSide) {
  if (!lineContext || typeof lineContext !== 'object') return null;
  return {
    ...lineContext,
    selection_side: selectionSide || null,
  };
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

function applyNbaSettlementMarketContext(card) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;
  const payload = card.payloadData;
  if (String(payload.market_type || '').toUpperCase() !== 'TOTAL') return;

  payload.period = payload.period || 'FULL_GAME';
  payload.market = {
    ...(payload.market && typeof payload.market === 'object'
      ? payload.market
      : {}),
    period: payload.period,
  };
  if (payload.market_context && typeof payload.market_context === 'object') {
    payload.market_context = {
      ...payload.market_context,
      period: payload.period,
      wager: {
        ...(payload.market_context.wager &&
        typeof payload.market_context.wager === 'object'
          ? payload.market_context.wager
          : {}),
        period: payload.period,
      },
    };
  }
}

/**
 * Get home team's recent road trip (consecutive away games)
 * Returns if the team JUST COMPLETED a road trip and is now playing at home
 * Welcome Home Fade: Home team's first game after returning from road trip
 *
 * @param {string} teamName - Team display name
 * @param {string} sport - Sport code (lowercase)
 * @param {string} currentGameTime - Current game time in UTC
 * @param {number} limit - Max games to retrieve
 * @returns {Array<{isHome: boolean, date: string}>} Recent road games if just returning home, else []
 */
function getHomeTeamRecentRoadTrip(
  teamName,
  sport,
  currentGameTime,
  limit = 10,
) {
  if (!teamName || !currentGameTime) return [];

  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT game_id, game_time_utc, home_team, away_team, status
    FROM games
    WHERE LOWER(sport) = ?
      AND (UPPER(away_team) = UPPER(?) OR UPPER(home_team) = UPPER(?))
      AND game_time_utc < ?
    ORDER BY game_time_utc DESC
    LIMIT ?
  `);

  try {
    const results = stmt.all(
      sport.toLowerCase(),
      teamName,
      teamName,
      currentGameTime,
      limit,
    );
    const completedGames = results
      .filter((g) => g.status === 'final' || g.status === 'STATUS_FINAL')
      .reverse(); // Chronological order (oldest to newest)

    if (!completedGames.length) return [];

    // Find the most recent game to see if it started a change pattern
    // Pattern: if recent games are [away, away, away, ...]
    // and we're now at a home game, that's Welcome Home Fade

    const roadTrip = [];

    // Start from most recent game and work backwards
    // Collect consecutive AWAY games
    for (let i = completedGames.length - 1; i >= 0; i--) {
      const game = completedGames[i];
      const isAway =
        game.away_team &&
        game.away_team.toUpperCase() === teamName.toUpperCase();
      const isHome =
        game.home_team &&
        game.home_team.toUpperCase() === teamName.toUpperCase();

      if (isAway) {
        // Team was away in this game - part of road trip
        roadTrip.unshift({
          isHome: false,
          date: game.game_time_utc,
          opponent: game.home_team,
          location: 'away',
        });
      } else if (isHome) {
        // Team was home - this breaks the road trip
        // If we have a road trip, return it (the next game is home after road trip)
        break;
      }
    }

    // Need at least 2 away games to be a meaningful road trip
    return roadTrip.length >= 2 ? roadTrip : [];
  } catch (error) {
    console.error(
      `[WhF] Failed to query road trip for ${teamName}:`,
      error.message,
    );
    return [];
  }
}

/**
 * Generate standalone market call cards (nba-totals-call, nba-spread-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNBAMarketCallCards(
  gameId,
  marketDecisions,
  oddsSnapshot,
  { withoutOddsMode = false, lineContexts = {} } = {},
) {
  const now = new Date().toISOString();
  const expiresAt = null;

  const matchup = buildMatchup(
    oddsSnapshot?.home_team,
    oddsSnapshot?.away_team,
  );
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(
    oddsSnapshot?.game_time_utc,
  );
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);
  const totalLineContext = lineContexts?.TOTAL || null;
  const spreadLineContext = lineContexts?.SPREAD || null;

  const cards = [];

  // TOTAL decision → nba-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  const totalBias = computeTotalBias(totalDecision);
  const _totalProjection = totalDecision?.projection?.projected_total ?? null;
  if (
    totalDecision &&
    (
      (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH') ||
      // Without Odds Mode: emit lean whenever projection is available regardless of edge-based status
      (withoutOddsMode && _totalProjection != null)
    )
  ) {
    const rawStatus = totalDecision.status || 'PASS';
    const status = withoutOddsMode && rawStatus === 'PASS' ? 'LEAN' : rawStatus;
    const confidence = withoutOddsMode
      ? 0.52
      : computePricedCallCardConfidence({
          edgePct: totalDecision.edge,
          conflictScore: totalDecision.conflict,
        });
    const tier = determineTier(confidence);
    const { side, line: marketLine } = totalDecision.best_candidate;
    // In Without Odds Mode there is no market line — fall back to projection.
    const projectedTotal = totalDecision.projection?.projected_total ?? null;
    const line = withoutOddsMode ? (projectedTotal ?? marketLine) : marketLine;
    const totalPrice = withoutOddsMode
      ? null
      : side === 'OVER'
        ? (oddsSnapshot?.total_price_over ?? null)
        : (oddsSnapshot?.total_price_under ?? null);
    const hasLine = line != null;
    const hasPrice = totalPrice != null;
    if (hasLine && (hasPrice || withoutOddsMode)) {
      const lineText = line != null ? ` ${line}` : '';
      const pickText = `${side === 'OVER' ? 'OVER' : 'UNDER'}${lineText}`;
      const reasonCodes = [];
      if (totalBias !== 'OK') reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
      const activeDrivers = (totalDecision.drivers || [])
        .filter((d) => d.eligible)
        .map((d) => d.driverKey);
      const topDrivers = (totalDecision.drivers || [])
        .filter((d) => d.eligible)
        .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
        .slice(0, 3)
        .map((d) => ({
          driver: d.driverKey,
          weight: d.weight,
          score: Number(((d.signal + 1) / 2).toFixed(3)),
        }));

      const payloadData = {
        game_id: gameId,
        sport: 'NBA',
        model_version: 'nba-cross-market-v1',
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
        status,
        recommended_bet_type: 'total',
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: {
          side,
        },
        line,
        price: totalPrice,
        reason_codes: reasonCodes,
        tags: withoutOddsMode ? ['no_odds_mode'] : [],
        consistency: {
          total_bias: totalBias,
        },
        reasoning: `${pickText}: ${totalDecision.reasoning}`,
        edge: totalDecision.edge ?? null,
        edge_pct: totalDecision.edge ?? null,
        edge_points: totalDecision.edge_points ?? null,
        p_fair: totalDecision.p_fair ?? null,
        p_implied: totalDecision.p_implied ?? null,
        model_prob: totalDecision.p_fair ?? null,
        projection: {
          total: totalDecision?.projection?.projected_total ?? line ?? null,
          margin_home: null,
          win_prob_home: null,
        },
        market_context: {
          version: 'v1',
          market_type: 'TOTAL',
          selection_side: side,
          selection_team: null,
          projection: {
            margin_home: null,
            total: totalDecision?.projection?.projected_total ?? line ?? null,
            team_total: null,
            win_prob_home: null,
            score_home: null,
            score_away: null,
          },
          wager: {
            called_line: line ?? null,
            called_price: totalPrice ?? null,
            line_source: withoutOddsMode ? 'projection_floor' : (totalDecision.line_source ?? 'odds_snapshot'),
            price_source: withoutOddsMode ? null : (totalDecision.price_source ?? 'odds_snapshot'),
          },
        },
        market,
        line_source: withoutOddsMode ? 'projection_floor' : (totalDecision.line_source ?? 'odds_snapshot'),
        price_source: withoutOddsMode ? null : (totalDecision.price_source ?? 'odds_snapshot'),
        decision_basis_meta: buildDecisionBasisMeta({
          usingRealLine: !withoutOddsMode,
          edgePct: withoutOddsMode ? null : (totalDecision.edge ?? null),
          marketLineSource: withoutOddsMode ? 'projection_floor' : 'odds_api',
          marketOrPropType: 'total_pace',
        }),
        pricing_trace: {
          called_market_type: 'TOTAL',
          called_side: side,
          called_line: line ?? null,
          called_price: totalPrice ?? null,
          line_source: withoutOddsMode ? 'projection_floor' : (totalDecision.line_source ?? 'odds_snapshot'),
          price_source: withoutOddsMode ? null : (totalDecision.price_source ?? 'odds_snapshot'),
          proxy_used: withoutOddsMode || totalDecision?.projection?.projected_total == null,
        },
        drivers_active: activeDrivers,
        driver_summary: {
          weights: topDrivers,
          impact_note: 'Cross-market totals decision.',
        },
        ev_passed: !withoutOddsMode && totalDecision.status === 'FIRE',
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
          captured_at: oddsSnapshot?.captured_at,
          projection_comparison: totalDecision.projection_comparison ?? null,
        },
        line_context: buildLineContextPayload(totalLineContext, side),
        line_delta: totalLineContext?.delta ?? null,
        line_delta_pct: totalLineContext?.delta_pct ?? null,
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_total',
          score: totalDecision.score,
          status: totalDecision.status,
          inputs: {
            net: totalDecision.net,
            conflict: totalDecision.conflict,
            coverage: totalDecision.coverage,
          },
        },
        disclaimer:
          'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now,
      };

      cards.push(
        buildMarketCallCard({
          sport: 'NBA',
          gameId,
          cardType: 'nba-totals-call',
          cardTitle: `NBA Totals: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  // SPREAD decision → nba-spread-call
  const spreadDecision = marketDecisions?.SPREAD;
  const nbaSpreadProfile = resolveThresholdProfile({ sport: 'NBA', marketType: 'SPREAD' });
  const SPREAD_LEAN_MIN = nbaSpreadProfile.edge.lean_edge_min; // 0.035 via v2 profile
  if (
    spreadDecision &&
    (spreadDecision.status === 'FIRE' || spreadDecision.status === 'WATCH') &&
    (spreadDecision.edge == null || spreadDecision.edge > SPREAD_LEAN_MIN)
  ) {
    const confidence = computePricedCallCardConfidence({
      edgePct: spreadDecision.edge,
      conflictScore: spreadDecision.conflict,
    });
    const tier = determineTier(confidence);
    const { side, line } = spreadDecision.best_candidate;
    const spreadPrice =
      side === 'HOME'
        ? (oddsSnapshot?.spread_price_home ?? null)
        : (oddsSnapshot?.spread_price_away ?? null);
    if (spreadPrice != null) {
      const lineText = line != null ? ` ${line > 0 ? '+' + line : line}` : '';
      const pickText = `${side === 'HOME' ? 'Home' : 'Away'}${lineText}`;
      const activeDrivers = (spreadDecision.drivers || [])
        .filter((d) => d.eligible)
        .map((d) => d.driverKey);
      const topDrivers = (spreadDecision.drivers || [])
        .filter((d) => d.eligible)
        .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
        .slice(0, 3)
        .map((d) => ({
          driver: d.driverKey,
          weight: d.weight,
          score: Number(((d.signal + 1) / 2).toFixed(3)),
        }));

      const payloadData = {
        game_id: gameId,
        sport: 'NBA',
        model_version: 'nba-cross-market-v1',
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
        kind: 'PLAY',
        market_type: 'SPREAD',
        selection: {
          side,
          team:
            side === 'HOME'
              ? (oddsSnapshot?.home_team ?? undefined)
              : (oddsSnapshot?.away_team ?? undefined),
        },
        line: line ?? null,
        price: spreadPrice,
        reason_codes: [],
        tags: [],
        consistency: {
          total_bias: totalBias,
        },
        reasoning: `${pickText}: ${spreadDecision.reasoning}`,
        edge: spreadDecision.edge ?? null,
        edge_pct: spreadDecision.edge ?? null,
        edge_points: spreadDecision.edge_points ?? null,
        p_fair: spreadDecision.p_fair ?? null,
        p_implied: spreadDecision.p_implied ?? null,
        model_prob: spreadDecision.p_fair ?? null,
        projection: {
          total: null,
          margin_home: spreadDecision?.projection?.projected_margin ?? null,
          win_prob_home: null,
        },
        market_context: {
          version: 'v1',
          market_type: 'SPREAD',
          selection_side: side,
          selection_team:
            side === 'HOME'
              ? (oddsSnapshot?.home_team ?? null)
              : (oddsSnapshot?.away_team ?? null),
          projection: {
            margin_home: spreadDecision?.projection?.projected_margin ?? null,
            total: null,
            team_total: null,
            win_prob_home: null,
            score_home: null,
            score_away: null,
          },
          wager: {
            called_line: line ?? null,
            called_price: spreadPrice ?? null,
            line_source: spreadDecision.line_source ?? 'odds_snapshot',
            price_source: spreadDecision.price_source ?? 'odds_snapshot',
          },
        },
        market,
        line_source: spreadDecision.line_source ?? 'odds_snapshot',
        price_source: spreadDecision.price_source ?? 'odds_snapshot',
        pricing_trace: {
          called_market_type: 'SPREAD',
          called_side: side,
          called_line: line ?? null,
          called_price: spreadPrice ?? null,
          line_source: spreadDecision.line_source ?? 'odds_snapshot',
          price_source: spreadDecision.price_source ?? 'odds_snapshot',
          proxy_used: false,
        },
        drivers_active: activeDrivers,
        driver_summary: {
          weights: topDrivers,
          impact_note: 'Cross-market spread decision.',
        },
        ev_passed: spreadDecision.status === 'FIRE',
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
          captured_at: oddsSnapshot?.captured_at,
          projection_comparison: spreadDecision.projection_comparison ?? null,
        },
        line_context: buildLineContextPayload(spreadLineContext, side),
        line_delta: spreadLineContext?.delta ?? null,
        line_delta_pct: spreadLineContext?.delta_pct ?? null,
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_spread',
          score: spreadDecision.score,
          status: spreadDecision.status,
          inputs: {
            net: spreadDecision.net,
            conflict: spreadDecision.conflict,
            coverage: spreadDecision.coverage,
          },
        },
        disclaimer:
          'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now,
      };

      cards.push(
        buildMarketCallCard({
          sport: 'NBA',
          gameId,
          cardType: 'nba-spread-call',
          cardTitle: `NBA Spread: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  return cards;
}

/**
 * Main job entrypoint
 * @param {object} options
 * @param {string|null} options.jobKey - Deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNBAModel({ jobKey = null, dryRun = false, withoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true' } = {}) {
  const jobRunId = `job-nba-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NBAModel] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[NBAModel] Job key: ${jobKey}`);
  if (withoutOddsMode) {
    console.log('[NBAModel] WITHOUT_ODDS_MODE=true — projection-floor lines, PROJECTION_ONLY cards, no settlement');
  }
  console.log(`[NBAModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[NBAModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(
        `[NBAModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun('run_nba_model', jobRunId, jobKey);

      // WI-0552: Compute empirical sigma from settled game history at job start.
      // Falls back to hardcoded defaults when fewer than 20 settled games exist.
      const computedSigma = edgeCalculator.computeSigmaFromHistory({
        sport: 'NBA',
        db: getDatabase(),
      });
      console.log('[run_nba_model] sigma:', JSON.stringify(computedSigma));

      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      console.log('[NBAModel] Fetching odds for upcoming NBA games...');
      const oddsSnapshots = getOddsWithUpcomingGames(
        'NBA',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        if (!withoutOddsMode) {
          console.log('[NBAModel] No upcoming NBA games found, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
        // Without-Odds-Mode: no odds_snapshots but games exist — synthesize from games table
        console.log('[NBAModel] WITHOUT_ODDS_MODE: no odds snapshots, building synthetic snapshots from games table');
        oddsSnapshots.push(...getUpcomingGamesAsSyntheticSnapshots('NBA', nowUtc.toISO(), horizonUtc));
        if (oddsSnapshots.length === 0) {
          console.log('[NBAModel] No upcoming NBA games found in games table, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
      }

      console.log(`[NBAModel] Found ${oddsSnapshots.length} odds snapshots`);
      if (!ENABLE_WELCOME_HOME) {
        console.log(
          '[NBAModel] Welcome Home driver disabled (ENABLE_WELCOME_HOME=false)',
        );
      }

      // Dedupe: latest snapshot per game
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
        `[NBAModel] Running NBA driver inference on ${gameIds.length} games...`,
      );

      let cardsGenerated = 0;
      let cardsFailed = 0;
      let gatedCount = 0;
      let blockedCount = 0;
      let projectionBlockedCount = 0;
      const gamePipelineStates = {};
      const errors = [];

      for (const gameId of gameIds) {
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

          const projectionGate = assessProjectionInputs('NBA', oddsSnapshot);
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

          // Query schedule for Welcome Home Fade
          // Welcome Home Fade: Home team coming back from a road trip (first game back)
          const homeTeamRoadTrip = ENABLE_WELCOME_HOME
            ? getHomeTeamRecentRoadTrip(
                oddsSnapshot.home_team,
                'nba',
                oddsSnapshot.game_time_utc,
                10,
              )
            : [];

          const driverCards = computeNBADriverCards(gameId, oddsSnapshot, {
            recentRoadGames: homeTeamRoadTrip,
          });

          if (driverCards.length === 0) {
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
            console.log(`  [skip] ${gameId}: No actionable NBA driver signals`);
            continue;
          }

          // Only clear/write when we have actionable output; avoids wiping prior cards on transient data gaps.
          const driverCardTypesToClear = [
            ...new Set([
              ...NBA_DRIVER_CARD_TYPES,
              ...driverCards.map((card) => card.cardType),
            ]),
          ];
          for (const ct of driverCardTypesToClear) {
            prepareModelAndCardWrite(gameId, 'nba-drivers-v1', ct, {
              runId: jobRunId,
            });
          }

          const nbaMarketDecisions = computeNBAMarketDecisions(oddsSnapshot);

          // WI-0571: log projection comparison per game
          const totalPC = nbaMarketDecisions?.TOTAL?.projection_comparison;
          const spreadPC = nbaMarketDecisions?.SPREAD?.projection_comparison;
          if (totalPC) {
            console.log(
              `  [proj] ${gameId} TOTAL: consensus edge=${totalPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${totalPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${totalPC.execution_alpha_pts ?? 'n/a'} pts, playable=${totalPC.playable_edge}`,
            );
          }
          if (spreadPC) {
            console.log(
              `  [proj] ${gameId} SPREAD: consensus edge=${spreadPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${spreadPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${spreadPC.execution_alpha_pts ?? 'n/a'} pts, playable=${spreadPC.playable_edge}`,
            );
          }

          const nbaLineContexts = {
            TOTAL: buildMarketLineContext({
              sport: 'NBA',
              gameId,
              marketType: 'TOTAL',
              selectionSide:
                nbaMarketDecisions?.TOTAL?.best_candidate?.side ?? null,
            }),
            SPREAD: buildMarketLineContext({
              sport: 'NBA',
              gameId,
              marketType: 'SPREAD',
              selectionSide:
                nbaMarketDecisions?.SPREAD?.best_candidate?.side ?? null,
            }),
          };
          const nbaExpressionChoice =
            selectExpressionChoice(nbaMarketDecisions);
          const nbaMarketPayload = buildMarketPayload({
            decisions: nbaMarketDecisions,
            expressionChoice: nbaExpressionChoice,
          });

          const cards = driverCards.map((descriptor) =>
            generateCard({
              sport: 'NBA',
              gameId,
              descriptor,
              oddsSnapshot,
              marketPayload: nbaMarketPayload,
              now: new Date().toISOString(),
              expiresAt: null,
              driverWeights: NBA_DRIVER_WEIGHTS,
            }),
          );

          const pendingCards = [];

          for (const card of cards) {
            applyProjectionInputMetadata(card, projectionGate);
            applyNbaSettlementMarketContext(card);
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
              // WI-0591: thread empirical sigma so decisioning uses computed
              // values instead of silently falling back to static defaults.
              options: { sigmaOverride: computedSigma },
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
            const tierLabel = card.payloadData.tier
              ? ` [${card.payloadData.tier}]`
              : '';
            pendingCards.push({
              card,
              logLine: `  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            });
          }

          // Generate and insert NBA market call cards (nba-totals-call, nba-spread-call)
          const nbaMarketCallCards = generateNBAMarketCallCards(
            gameId,
            nbaMarketDecisions,
            oddsSnapshot,
            { withoutOddsMode, lineContexts: nbaLineContexts },
          );
          if (nbaMarketCallCards.length > 0) {
            for (const ct of ['nba-totals-call', 'nba-spread-call']) {
              prepareModelAndCardWrite(gameId, 'nba-cross-market-v1', ct, {
                runId: jobRunId,
              });
            }
          }
          for (const card of nbaMarketCallCards) {
            applyProjectionInputMetadata(card, projectionGate);
            applyNbaSettlementMarketContext(card);
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
              // WI-0591: thread empirical sigma so decisioning uses computed
              // values instead of silently falling back to static defaults.
              options: { sigmaOverride: computedSigma },
            });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(
                `  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`,
              );
            }
            applyUiActionFields(card.payloadData, { oddsSnapshot });
            // Without Odds Mode: buildDecisionV2 always returns PASS when edgePct=null.
            // Override to LEAN AFTER applyUiActionFields so the last write wins.
            if (
              withoutOddsMode &&
              Array.isArray(card.payloadData.tags) &&
              card.payloadData.tags.includes('no_odds_mode')
            ) {
              card.payloadData.classification = 'LEAN';
              card.payloadData.action = 'HOLD';
              card.payloadData.status = 'WATCH';
              card.payloadData.pass_reason_code = null;
              if (card.payloadData.decision_v2) {
                card.payloadData.decision_v2.official_status = 'LEAN';
              }
            }
            attachRunId(card, jobRunId);
            const tierLabel = card.payloadData.tier
              ? ` [${card.payloadData.tier}]`
              : '';
            pendingCards.push({
              card,
              logLine: `  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
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
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload'))
            throw gameError;
          cardsFailed++;
          if (!gamePipelineStates[gameId]) {
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot: gameOdds[gameId],
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
            });
          }
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  [err] ${gameId}: ${gameError.message}`);
        }
      }

      const summary = {
        cardsGenerated,
        cardsFailed,
        errors,
        pipeline_states: gamePipelineStates,
      };

      markJobRunSuccess(jobRunId, summary);
      try {
        setCurrentRunId(jobRunId, 'nba');
      } catch (runStateError) {
        console.error(
          `[NBAModel] Failed to update run state: ${runStateError.message}`,
        );
      }
      console.log(
        `[NBAModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`,
      );
      console.log(
        `[NBAModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`,
      );
      if (projectionBlockedCount > 0) {
        console.log(
          `[NBAModel] Projection input gate: ${projectionBlockedCount}/${gameIds.length} games blocked`,
        );
      }
      console.log(
        `[NBAModel] Pipeline states: ${JSON.stringify(gamePipelineStates)}`,
      );
      if (errors.length > 0)
        errors.forEach((err) => console.error(`  - ${err}`));

      return { success: true, jobRunId, ...summary };
    } catch (error) {
      console.error(`[NBAModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (_) {}
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNBAModel()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNBAModel, generateNBAMarketCallCards };
