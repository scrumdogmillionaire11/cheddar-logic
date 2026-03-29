const { v4: uuidV4 } = require('uuid');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
} = require('./card-model');
const { buildDriverSummary, computeWinProbHome } = require('./card-utilities');

function toCanonicalMarketType(rawMarketType) {
  if (typeof rawMarketType !== 'string') return null;
  const upper = rawMarketType.trim().toUpperCase();
  if (upper === 'MONEYLINE' || upper === 'ML') return 'MONEYLINE';
  if (upper === 'FIRST_PERIOD') return 'FIRST_PERIOD';
  if (upper === 'SPREAD' || upper === 'PUCKLINE' || upper === 'PUCK_LINE') {
    return 'SPREAD';
  }
  if (upper === 'TOTAL' || upper === 'TEAM_TOTAL' || upper === 'TEAMTOTAL') {
    return 'TOTAL';
  }
  return null;
}

/**
 * Unified card factory for active driver sports.
 *
 * @param {Object} params
 * @param {string} params.sport - 'NBA' or 'NHL'
 * @param {string} params.gameId - game identifier
 * @param {Object} params.descriptor - driver descriptor
 * @param {Object} params.oddsSnapshot - odds data
 * @param {Object} params.marketPayload - market decisions payload
 * @param {string} params.now - ISO timestamp
 * @param {string} params.expiresAt - ISO expiry timestamp
 * @param {string} params.marketType - optional market type suffix for card ID
 * @param {Object} params.driverWeights - sport-specific driver weights
 * @returns {Object} card object
 */
function generateCard({
  sport,
  gameId,
  descriptor,
  oddsSnapshot,
  marketPayload,
  now,
  expiresAt,
  marketType,
  driverWeights,
}) {
  if (!sport || !gameId || !descriptor || !oddsSnapshot || !now) {
    throw new Error('Missing required card generation parameters');
  }

  const normalizedSport =
    typeof sport === 'string' ? sport.toUpperCase() : sport;

  if (normalizedSport !== 'NBA' && normalizedSport !== 'NHL') {
    throw new Error(`Unsupported card factory sport: ${normalizedSport}`);
  }

  const cardIdSuffix = `${descriptor.driverKey}${marketType ? `-${marketType}` : ''}-${gameId}-${uuidV4().slice(0, 8)}`;
  const cardId = `card-${normalizedSport.toLowerCase()}-${cardIdSuffix}`;
  const recommendation = buildRecommendationFromPrediction({
    prediction: descriptor.prediction,
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

  const payloadData = buildBallSportPayload({
    sport: normalizedSport,
    descriptor,
    oddsSnapshot,
    matchup,
    startTimeLocal,
    timezone,
    countdown,
    market,
    recommendation,
    driverWeights,
    marketPayload,
    now,
  });

  return {
    id: cardId,
    gameId,
    sport: normalizedSport,
    cardType: descriptor.cardType,
    cardTitle: descriptor.cardTitle,
    createdAt: now,
    expiresAt: expiresAt || null,
    payloadData,
    modelOutputIds: null,
  };
}

/**
 * Build a market call card (totals/spread) with shared metadata.
 */
function buildMarketCallCard({
  sport,
  gameId,
  cardType,
  cardTitle,
  payloadData,
  now,
  expiresAt,
}) {
  if (!sport || !gameId || !cardType || !payloadData || !now) {
    throw new Error('Missing required market call card parameters');
  }

  const normalizedSport =
    typeof sport === 'string' ? sport.toUpperCase() : sport;

  const cardId = `card-${cardType}-${gameId}-${uuidV4().slice(0, 8)}`;

  return {
    id: cardId,
    gameId,
    sport: normalizedSport,
    cardType,
    cardTitle,
    createdAt: now,
    expiresAt: expiresAt || null,
    payloadData,
    modelOutputIds: null,
  };
}

/**
 * Build payload for NBA/NHL ball sports.
 */
function buildBallSportPayload({
  sport,
  descriptor,
  oddsSnapshot,
  matchup,
  startTimeLocal,
  timezone,
  countdown,
  market,
  recommendation,
  driverWeights,
  marketPayload,
  now,
}) {
  const projectedMargin = Number.isFinite(
    descriptor.driverInputs?.projected_margin,
  )
    ? descriptor.driverInputs.projected_margin
    : null;
  const projectedTotal = Number.isFinite(
    descriptor.driverInputs?.projected_total,
  )
    ? descriptor.driverInputs.projected_total
    : Number.isFinite(descriptor.driverInputs?.expected_total)
      ? descriptor.driverInputs.expected_total
      : Number.isFinite(descriptor.driverInputs?.projection_final)
        ? descriptor.driverInputs.projection_final
        : Number.isFinite(descriptor.driverInputs?.expected_1p_total)
          ? descriptor.driverInputs.expected_1p_total
          : null;

  const winProbHome = computeWinProbHome(projectedMargin, sport);
  const normalizedMarketType =
    typeof descriptor.market_type === 'string'
      ? descriptor.market_type.toUpperCase()
      : null;
  const selectionSide = descriptor.selection?.side;
  const hasPrice = Number.isFinite(descriptor.price);
  const hasLine = Number.isFinite(descriptor.line);
  const isPlayableMarket =
    (normalizedMarketType === 'MONEYLINE' &&
      (selectionSide === 'HOME' || selectionSide === 'AWAY') &&
      hasPrice) ||
    ((normalizedMarketType === 'SPREAD' ||
      normalizedMarketType === 'PUCKLINE') &&
      (selectionSide === 'HOME' || selectionSide === 'AWAY') &&
      hasLine &&
      hasPrice) ||
    ((normalizedMarketType === 'TOTAL' ||
      normalizedMarketType === 'TEAM_TOTAL' ||
      normalizedMarketType === 'FIRST_PERIOD') &&
      (selectionSide === 'OVER' || selectionSide === 'UNDER') &&
      hasLine);

  const crossMarketStatus = marketPayload?.expression_choice?.status;
  const derivedStatus = crossMarketStatus || undefined;
  const derivedAction =
    derivedStatus === 'FIRE'
      ? 'FIRE'
      : derivedStatus === 'WATCH'
        ? 'HOLD'
        : derivedStatus === 'PASS'
          ? 'PASS'
          : undefined;

  return {
    game_id: oddsSnapshot?.game_id ?? null,
    sport,
    model_version: `${sport.toLowerCase()}-drivers-v1`,
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
      total: projectedTotal,
      margin_home: projectedMargin,
      win_prob_home: winProbHome,
    },
    market_context: {
      version: 'v1',
      market_type: toCanonicalMarketType(normalizedMarketType),
      selection_side:
        descriptor.selection?.side ?? descriptor.prediction ?? null,
      selection_team: descriptor.selection?.team ?? null,
      projection: {
        margin_home: projectedMargin,
        total: projectedTotal,
        team_total: Number.isFinite(
          descriptor.driverInputs?.projected_team_total,
        )
          ? descriptor.driverInputs.projected_team_total
          : Number.isFinite(descriptor.driverInputs?.team_total)
            ? descriptor.driverInputs.team_total
            : null,
        win_prob_home: winProbHome,
        score_home: Number.isFinite(
          descriptor.driverInputs?.projected_score_home,
        )
          ? descriptor.driverInputs.projected_score_home
          : Number.isFinite(descriptor.driverInputs?.score_home)
            ? descriptor.driverInputs.score_home
            : null,
        score_away: Number.isFinite(
          descriptor.driverInputs?.projected_score_away,
        )
          ? descriptor.driverInputs.projected_score_away
          : Number.isFinite(descriptor.driverInputs?.score_away)
            ? descriptor.driverInputs.score_away
            : null,
      },
      wager: {
        called_line: descriptor.line ?? null,
        called_price: descriptor.price ?? null,
        line_source: descriptor.line_source ?? 'odds_snapshot',
        price_source: descriptor.price_source ?? 'odds_snapshot',
      },
    },
    market,
    goalie_home_name:
      typeof descriptor.driverInputs?.home_goalie_name === 'string'
        ? descriptor.driverInputs.home_goalie_name
        : null,
    goalie_away_name:
      typeof descriptor.driverInputs?.away_goalie_name === 'string'
        ? descriptor.driverInputs.away_goalie_name
        : null,
    goalie_home_status:
      typeof descriptor.driverInputs?.home_goalie_certainty === 'string'
        ? descriptor.driverInputs.home_goalie_certainty
        : null,
    goalie_away_status:
      typeof descriptor.driverInputs?.away_goalie_certainty === 'string'
        ? descriptor.driverInputs.away_goalie_certainty
        : null,
    market_type: normalizedMarketType ?? null,
    selection: descriptor.selection ?? null,
    line: descriptor.line ?? null,
    price: descriptor.price ?? null,
    line_source: descriptor.line_source ?? 'odds_snapshot',
    price_source: descriptor.price_source ?? 'odds_snapshot',
    kind: isPlayableMarket ? 'PLAY' : 'EVIDENCE',
    edge_available: Number.isFinite(descriptor.edge),
    edge: Number.isFinite(descriptor.edge) ? descriptor.edge : null,
    p_fair: null,
    p_implied: undefined,
    confidence_pct: Math.round(descriptor.confidence * 100),
    drivers_active: [descriptor.driverKey],
    prediction: descriptor.prediction,
    confidence: descriptor.confidence,
    recommended_bet_type:
      normalizedMarketType === 'TOTAL' || normalizedMarketType === 'TEAM_TOTAL'
        ? 'total'
        : normalizedMarketType === 'FIRST_PERIOD'
          ? 'total'
          : normalizedMarketType === 'PUCKLINE'
            ? 'puck_line'
            : normalizedMarketType === 'SPREAD'
              ? 'spread'
              : 'moneyline',
    consistency: marketPayload?.consistency || {},
    expression_choice: marketPayload?.expression_choice || {},
    market_narrative: marketPayload?.market_narrative || {},
    all_markets: marketPayload?.all_markets || {},
    status: derivedStatus,
    action: derivedAction,
    tier: descriptor.tier,
    reasoning: descriptor.reasoning,
    driver: {
      key: descriptor.driverKey,
      score: descriptor.driverScore,
      status: descriptor.driverStatus,
      inputs: descriptor.driverInputs,
    },
    driver_summary: buildDriverSummary(descriptor, driverWeights),
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
    pricing_trace: {
      called_market_type: normalizedMarketType ?? null,
      called_side: descriptor.selection?.side ?? descriptor.prediction ?? null,
      called_line: descriptor.line ?? null,
      called_price: descriptor.price ?? null,
      line_source: descriptor.line_source ?? 'odds_snapshot',
      price_source: descriptor.price_source ?? 'odds_snapshot',
      proxy_used: false,
    },
    ev_passed: descriptor.ev_threshold_passed,
    disclaimer:
      'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    meta: {
      inference_source: descriptor.inference_source,
      model_endpoint: descriptor.model_endpoint ?? null,
      is_mock: descriptor.is_mock,
    },
  };
}

module.exports = { generateCard, buildMarketCallCard };
