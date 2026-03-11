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

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

// Import cheddar-logic data layer
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
const { enrichOddsSnapshotWithMoneyPuck } = require('../moneypuck');

// Import pluggable inference layer
const {
  getModel,
  computeNHLDriverCards,
  generateCard,
  computeNHLMarketDecisions,
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
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  applyUiActionFields,
} = require('../utils/decision-publisher');
const {
  normalizeRawDataPayload,
} = require('../utils/normalize-raw-data-payload');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';

const NHL_DRIVER_WEIGHTS = {
  baseProjection: 0.3,
  restAdvantage: 0.14,
  goalie: 0.18,
  goalieCertainty: 0.06,
  shotEnvironment: 0.06,
  scoringEnvironment: 0.08,
  paceTotals: 0.12,
  paceTotals1p: 0.08,
};

const NHL_DRIVER_CARD_TYPES = [
  'nhl-base-projection',
  'nhl-rest-advantage',
  'welcome-home-v2',
  'nhl-goalie',
  'nhl-goalie-certainty',
  'nhl-model-output',
  'nhl-shot-environment',
  'nhl-pace-totals',
  'nhl-pace-1p',
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

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveOnePeriodSelection(payloadData) {
  const classification = String(
    payloadData?.classification || payloadData?.prediction || '',
  ).toUpperCase();
  if (classification.includes('OVER')) return 'OVER';
  if (classification.includes('UNDER')) return 'UNDER';
  return null;
}

function applyNhlSettlementMarketContext(card, oddsSnapshot) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;
  const payload = card.payloadData;
  const marketType = String(payload.market_type || '').toUpperCase();

  if (marketType === 'TOTAL') {
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
    return;
  }

  if (card.cardType !== 'nhl-pace-1p') return;

  const selection = deriveOnePeriodSelection(payload);
  const modelLine = toFiniteNumber(payload?.driver?.inputs?.market_1p_total);
  const line = modelLine !== null ? modelLine : 1.5;
  const proxyPrice =
    selection === 'OVER'
      ? toFiniteNumber(oddsSnapshot?.total_price_over)
      : selection === 'UNDER'
        ? toFiniteNumber(oddsSnapshot?.total_price_under)
        : null;
  const defaultOnePeriodPrice = Math.trunc(
    toFiniteNumber(process.env.NHL_1P_DEFAULT_PRICE) || -110,
  );
  const price = proxyPrice !== null ? proxyPrice : defaultOnePeriodPrice;
  const statusToken = String(payload.status || '').toUpperCase();
  const isPlayable =
    (statusToken === 'FIRE' || statusToken === 'WATCH') &&
    (selection === 'OVER' || selection === 'UNDER');

  payload.market_type = 'TOTAL';
  payload.recommended_bet_type = 'total';
  payload.period = '1P';
  payload.kind = isPlayable ? 'PLAY' : 'EVIDENCE';
  payload.selection =
    selection !== null
      ? {
          ...(payload.selection && typeof payload.selection === 'object'
            ? payload.selection
            : {}),
          side: selection,
        }
      : null;
  payload.line = line;
  payload.price = price;
  payload.line_source = payload.line_source || 'model_reference';
  payload.price_source =
    proxyPrice !== null ? 'odds_snapshot_proxy' : 'synthetic_default';
  payload.market_variant = 'NHL_1P_TOTAL';
  payload.market = {
    ...(payload.market && typeof payload.market === 'object'
      ? payload.market
      : {}),
    period: '1P',
  };
  payload.market_context = {
    ...(payload.market_context && typeof payload.market_context === 'object'
      ? payload.market_context
      : {}),
    version: 'v1',
    market_type: 'TOTAL',
    selection_side: selection,
    period: '1P',
    wager: {
      ...(payload.market_context?.wager &&
      typeof payload.market_context.wager === 'object'
        ? payload.market_context.wager
        : {}),
      called_line: line,
      called_price: price,
      line_source: payload.line_source,
      price_source: payload.price_source,
      period: '1P',
    },
  };
  payload.pricing_trace = {
    ...(payload.pricing_trace && typeof payload.pricing_trace === 'object'
      ? payload.pricing_trace
      : {}),
    called_market_type: 'TOTAL',
    called_side: selection,
    called_line: line,
    called_price: price,
    line_source: payload.line_source,
    price_source: payload.price_source,
    period: '1P',
  };
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
 * Generate standalone market call cards
 * (nhl-totals-call, nhl-spread-call, nhl-moneyline-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNHLMarketCallCards(gameId, marketDecisions, oddsSnapshot) {
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

  const cards = [];
  const CONFIDENCE_MAP = { FIRE: 0.74, WATCH: 0.61 };

  // TOTAL decision → nhl-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  const totalBias = computeTotalBias(totalDecision);
  if (
    totalDecision &&
    (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH')
  ) {
    const status = totalDecision.status || 'PASS';
    const confidence = CONFIDENCE_MAP[status] ?? 0.5;
    const tier = determineTier(confidence);
    const { side, line } = totalDecision.best_candidate;
    const totalPrice =
      side === 'OVER'
        ? (oddsSnapshot?.total_price_over ?? null)
        : (oddsSnapshot?.total_price_under ?? null);
    const hasLine = line != null;
    const hasPrice = totalPrice != null;
    if (hasLine && hasPrice) {
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
        tags: [],
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
            line_source: totalDecision.line_source ?? 'odds_snapshot',
            price_source: totalDecision.price_source ?? 'odds_snapshot',
          },
        },
        market,
        line_source: totalDecision.line_source ?? 'odds_snapshot',
        price_source: totalDecision.price_source ?? 'odds_snapshot',
        pricing_trace: {
          called_market_type: 'TOTAL',
          called_side: side,
          called_line: line ?? null,
          called_price: totalPrice ?? null,
          line_source: totalDecision.line_source ?? 'odds_snapshot',
          price_source: totalDecision.price_source ?? 'odds_snapshot',
          proxy_used: totalDecision?.projection?.projected_total == null,
        },
        drivers_active: activeDrivers,
        driver_summary: {
          weights: topDrivers,
          impact_note: 'Cross-market totals decision.',
        },
        ev_passed: totalDecision.status === 'FIRE',
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
        },
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
          sport: 'NHL',
          gameId,
          cardType: 'nhl-totals-call',
          cardTitle: `NHL Totals: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  // SPREAD decision → nhl-spread-call
  const spreadDecision = marketDecisions?.SPREAD;
  if (
    spreadDecision &&
    (spreadDecision.status === 'FIRE' || spreadDecision.status === 'WATCH')
  ) {
    const confidence = CONFIDENCE_MAP[spreadDecision.status];
    const tier = determineTier(confidence);
    const { side, line } = spreadDecision.best_candidate;
    if (line == null) {
      return cards;
    }
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
        },
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
          sport: 'NHL',
          gameId,
          cardType: 'nhl-spread-call',
          cardTitle: `NHL Spread: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  // MONEYLINE decision → nhl-moneyline-call
  const moneylineDecision = marketDecisions?.ML;
  if (
    moneylineDecision &&
    (moneylineDecision.status === 'FIRE' ||
      moneylineDecision.status === 'WATCH')
  ) {
    const confidence = CONFIDENCE_MAP[moneylineDecision.status];
    const tier = determineTier(confidence);
    const side = moneylineDecision.best_candidate?.side;
    const moneylinePrice =
      side === 'HOME'
        ? (oddsSnapshot?.h2h_home ?? null)
        : side === 'AWAY'
          ? (oddsSnapshot?.h2h_away ?? null)
          : null;

    if ((side === 'HOME' || side === 'AWAY') && moneylinePrice != null) {
      const teamName =
        side === 'HOME'
          ? (oddsSnapshot?.home_team ?? 'Home')
          : (oddsSnapshot?.away_team ?? 'Away');
      const pickText = `${teamName} ML`;
      const activeDrivers = (moneylineDecision.drivers || [])
        .filter((d) => d.eligible)
        .map((d) => d.driverKey);
      const topDrivers = (moneylineDecision.drivers || [])
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
        status: moneylineDecision.status,
        recommended_bet_type: 'moneyline',
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: {
          side,
          team: teamName,
        },
        price: moneylinePrice,
        reason_codes: [],
        tags: [],
        consistency: {
          total_bias: totalBias,
        },
        reasoning: `${pickText}: ${moneylineDecision.reasoning}`,
        edge: moneylineDecision.edge ?? null,
        edge_pct: moneylineDecision.edge ?? null,
        p_fair: moneylineDecision.p_fair ?? null,
        p_implied: moneylineDecision.p_implied ?? null,
        model_prob: moneylineDecision.p_fair ?? null,
        projection: {
          total: null,
          margin_home: moneylineDecision?.projection?.projected_margin ?? null,
          win_prob_home: moneylineDecision?.projection?.win_prob_home ?? null,
        },
        market_context: {
          version: 'v1',
          market_type: 'MONEYLINE',
          selection_side: side,
          selection_team: teamName,
          projection: {
            margin_home:
              moneylineDecision?.projection?.projected_margin ?? null,
            total: null,
            team_total: null,
            win_prob_home: moneylineDecision?.projection?.win_prob_home ?? null,
            score_home: null,
            score_away: null,
          },
          wager: {
            called_line: null,
            called_price: moneylinePrice ?? null,
            line_source: null,
            price_source: moneylineDecision.price_source ?? 'odds_snapshot',
          },
        },
        market,
        line_source: null,
        price_source: moneylineDecision.price_source ?? 'odds_snapshot',
        pricing_trace: {
          called_market_type: 'ML',
          called_side: side,
          called_line: null,
          called_price: moneylinePrice ?? null,
          line_source: null,
          price_source: moneylineDecision.price_source ?? 'odds_snapshot',
          proxy_used: false,
        },
        drivers_active: activeDrivers,
        driver_summary: {
          weights: topDrivers,
          impact_note: 'Cross-market moneyline decision.',
        },
        ev_passed: moneylineDecision.status === 'FIRE',
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
        },
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_ml',
          score: moneylineDecision.score,
          status: moneylineDecision.status,
          inputs: {
            net: moneylineDecision.net,
            conflict: moneylineDecision.conflict,
            coverage: moneylineDecision.coverage,
          },
        },
        disclaimer:
          'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now,
      };

      cards.push(
        buildMarketCallCard({
          sport: 'NHL',
          gameId,
          cardType: 'nhl-moneyline-call',
          cardTitle: `NHL ML: ${pickText}`,
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
      console.log(
        `[NHLModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[NHLModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
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
      const oddsSnapshots = getOddsWithUpcomingGames(
        'NHL',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        console.log('[NHLModel] No recent NHL odds found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }

      console.log(`[NHLModel] Found ${oddsSnapshots.length} odds snapshots`);
      if (!ENABLE_WELCOME_HOME) {
        console.log(
          '[NHLModel] Welcome Home driver disabled (ENABLE_WELCOME_HOME=false)',
        );
      }

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
      console.log(`[NHLModel] Running inference on ${gameIds.length} games...`);

      let cardsGenerated = 0;
      let cardsFailed = 0;
      let gatedCount = 0;
      let blockedCount = 0;
      let projectionBlockedCount = 0;
      const gamePipelineStates = {};
      const errors = [];

      // Process each game
      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);
          oddsSnapshot = await enrichOddsSnapshotWithMoneyPuck(oddsSnapshot);

          // Persist enrichment to database so models have access to ESPN metrics
          const rawData = normalizeRawDataPayload(oddsSnapshot.raw_data);
          oddsSnapshot.raw_data = rawData;
          try {
            updateOddsSnapshotRawData(oddsSnapshot.id, rawData);
          } catch (persistError) {
            console.log(
              `  [warn] ${gameId}: Failed to persist enrichment payload (${persistError.message})`,
            );
          }

          const projectionGate = assessProjectionInputs('NHL', oddsSnapshot);
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
                'nhl',
                oddsSnapshot.game_time_utc,
                10,
              )
            : [];

          // Compute per-driver card descriptors
          const driverCards = computeNHLDriverCards(gameId, oddsSnapshot, {
            recentRoadGames: homeTeamRoadTrip,
          });

          const marketDecisions = computeNHLMarketDecisions(oddsSnapshot);
          const expressionChoice = selectExpressionChoice(marketDecisions);
          const marketPayload = buildMarketPayload({
            decisions: marketDecisions,
            expressionChoice,
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
            console.log(
              `  [skip] ${gameId}: No driver cards (all data missing)`,
            );
            continue;
          }

          // Only clear/write when we have actionable output; avoids wiping prior cards on transient data gaps.
          const driverCardTypesToClear = [
            ...new Set([
              ...NHL_DRIVER_CARD_TYPES,
              ...driverCards.map((card) => card.cardType),
            ]),
          ];
          for (const ct of driverCardTypesToClear) {
            prepareModelAndCardWrite(gameId, 'nhl-drivers-v1', ct, {
              runId: jobRunId,
            });
          }

          const cards = driverCards.map((descriptor) =>
            generateCard({
              sport: 'NHL',
              gameId,
              descriptor,
              oddsSnapshot,
              marketPayload,
              now: new Date().toISOString(),
              expiresAt: null,
              driverWeights: NHL_DRIVER_WEIGHTS,
            }),
          );

          const pendingCards = [];

          for (const card of cards) {
            applyProjectionInputMetadata(card, projectionGate);
            applyNhlSettlementMarketContext(card, oddsSnapshot);
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
              logLine: `  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            });
          }

          // Generate and insert market call cards
          // (nhl-totals-call, nhl-spread-call, nhl-moneyline-call)
          const marketCallCards = generateNHLMarketCallCards(
            gameId,
            marketDecisions,
            oddsSnapshot,
          );
          if (marketCallCards.length > 0) {
            for (const ct of [
              'nhl-totals-call',
              'nhl-spread-call',
              'nhl-moneyline-call',
            ]) {
              prepareModelAndCardWrite(gameId, 'nhl-cross-market-v1', ct, {
                runId: jobRunId,
              });
            }
          }
          for (const card of marketCallCards) {
            applyProjectionInputMetadata(card, projectionGate);
            applyNhlSettlementMarketContext(card, oddsSnapshot);
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
              logLine: `  [ok] ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
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
          if (gameError.message.startsWith('Invalid card payload')) {
            throw gameError;
          }
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

      // Mark success
      const summary = {
        cardsGenerated,
        cardsFailed,
        errors,
        pipeline_states: gamePipelineStates,
      };

      markJobRunSuccess(jobRunId, summary);
      try {
        setCurrentRunId(jobRunId, 'nhl');
      } catch (runStateError) {
        console.error(
          `[NHLModel] Failed to update run state: ${runStateError.message}`,
        );
      }
      console.log(
        `[NHLModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`,
      );
      console.log(
        `[NHLModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`,
      );
      if (projectionBlockedCount > 0) {
        console.log(
          `[NHLModel] Projection input gate: ${projectionBlockedCount}/${gameIds.length} games blocked`,
        );
      }
      console.log(
        `[NHLModel] Pipeline states: ${JSON.stringify(gamePipelineStates)}`,
      );

      if (errors.length > 0) {
        console.error('[NHLModel] Errors:');
        errors.forEach((err) => console.error(`  - ${err}`));
      }

      return { success: true, jobRunId, ...summary };
    } catch (error) {
      console.error(`[NHLModel] ❌ Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[NHLModel] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  const jobKey = process.env.CHEDDAR_JOB_KEY || process.env.JOB_KEY || null;
  const dryRun =
    process.env.CHEDDAR_DRY_RUN === 'true' || process.env.DRY_RUN === 'true';

  runNHLModel({ jobKey, dryRun })
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNHLModel, generateNHLMarketCallCards };
