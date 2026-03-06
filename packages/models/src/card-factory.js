const { v4: uuidV4 } = require('uuid');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
} = require('./card-model');
const { buildDriverSummary, computeWinProbHome } = require('./card-utilities');

/**
 * Unified card factory for all sports (NBA, NHL, NCAAM)
 * Consolidates generateNBACards, generateNHLCards, and generateSingleCard
 *
 * @param {Object} params
 * @param {string} params.sport - 'NBA', 'NHL', or 'NCAAM'
 * @param {string} params.gameId - game identifier
 * @param {Object} params.descriptor - driver descriptor
 * @param {Object} params.oddsSnapshot - odds data
 * @param {Object} params.marketPayload - market decisions payload (optional for NCAAM)
 * @param {string} params.now - ISO timestamp
 * @param {string} params.expiresAt - ISO expiry timestamp
 * @param {string} params.marketType - market type for NCAAM (moneyline, spread)
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

  // Calculate expiresAt if not provided (1 hour before game time)
  let finalExpiresAt = expiresAt;
  if (!finalExpiresAt && oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    finalExpiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  // Generate unique card ID
  const cardIdSuffix = `${descriptor.driverKey}${marketType ? `-${marketType}` : ''}-${gameId}-${uuidV4().slice(0, 8)}`;
  const cardId = `card-${sport.toLowerCase()}-${cardIdSuffix}`;

  // Validate that expiresAt was calculated or provided
  if (!finalExpiresAt) {
    throw new Error('Missing expiresAt and cannot calculate from game_time_utc');
  }

  // Build common card metadata
  const recommendation = buildRecommendationFromPrediction({
    prediction: descriptor.prediction,
    recommendedBetType:
      sport === 'NCAAM' ? marketType || 'moneyline' : 'moneyline',
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

  // Sport-specific payload construction
  let payloadData;

  if (sport === 'NBA' || sport === 'NHL') {
    // NBA/NHL use marketPayload from cross-market decisions
    payloadData = buildBallSportPayload({
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
    });
  } else if (sport === 'NCAAM') {
    // NCAAM builds payload per market type
    payloadData = buildNCAAMPayload({
      descriptor,
      oddsSnapshot,
      matchup,
      startTimeLocal,
      timezone,
      countdown,
      market,
      recommendation,
      marketType,
      driverWeights,
      now,
    });
  }

  // Determine card type and title
  let cardType = descriptor.cardType;
  let cardTitle = descriptor.cardTitle;

  if (sport === 'NCAAM') {
    cardTitle = `${descriptor.cardTitle} (${marketType.toUpperCase()})`;
  }

  // Return unified card object
  return {
    id: cardId,
    gameId,
    sport,
    cardType,
    cardTitle,
    createdAt: now,
    expiresAt: finalExpiresAt,
    payloadData,
    modelOutputIds: null,
  };
}

/**
 * Build payload for NBA/NHL ball sports
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
    : null;

  const winProbHome = computeWinProbHome(projectedMargin, sport);

  // Derive status from expression_choice if available (prioritize cross-market decision)
  const crossMarketStatus = marketPayload?.expression_choice?.status;
  const derivedStatus = crossMarketStatus || undefined;
  const derivedAction = derivedStatus === 'FIRE' ? 'FIRE' : derivedStatus === 'WATCH' ? 'HOLD' : derivedStatus === 'PASS' ? 'PASS' : undefined;

  const payloadData = {
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
    market,
    edge: undefined,
    p_fair: undefined,
    p_implied: undefined,
    confidence_pct: Math.round(descriptor.confidence * 100),
    drivers_active: [descriptor.driverKey],
    prediction: descriptor.prediction,
    confidence: descriptor.confidence,
    recommended_bet_type: 'moneyline',
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
    ev_passed: descriptor.ev_threshold_passed,
    disclaimer:
      'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    meta: {
      inference_source: descriptor.inference_source,
      is_mock: descriptor.is_mock,
    },
  };

  return payloadData;
}

/**
 * Build payload for NCAAM (college basketball)
 */
function buildNCAAMPayload({
  descriptor,
  oddsSnapshot,
  matchup,
  startTimeLocal,
  timezone,
  countdown,
  market,
  recommendation,
  marketType,
  driverWeights,
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
    : null;

  const winProbHome = computeWinProbHome(projectedMargin, 'NCAAM');
  const isPredictionHome = descriptor.prediction === 'HOME';
  const isPredictionAway = descriptor.prediction === 'AWAY';

  let line = null;
  let price = null;
  let reasonCodes = [];
  let isPlayableMarket = false;

  if (marketType === 'moneyline') {
    price = isPredictionHome
      ? (oddsSnapshot?.h2h_home ?? null)
      : isPredictionAway
        ? (oddsSnapshot?.h2h_away ?? null)
        : null;
    isPlayableMarket = (isPredictionHome || isPredictionAway) && price !== null;
  } else if (marketType === 'spread') {
    line = isPredictionHome
      ? (oddsSnapshot?.spread_home ?? null)
      : isPredictionAway
        ? (oddsSnapshot?.spread_away ?? null)
        : null;
    price = isPredictionHome
      ? (oddsSnapshot?.spread_price_home ?? null)
      : isPredictionAway
        ? (oddsSnapshot?.spread_price_away ?? null)
        : null;
    isPlayableMarket =
      (isPredictionHome || isPredictionAway) && line !== null && price !== null;
  }

  const payloadData = {
    game_id: oddsSnapshot?.game_id ?? null,
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
      pass_reason: recommendation.pass_reason,
    },
    prediction: descriptor.prediction,
    confidence: descriptor.confidence,
    recommended_bet_type: marketType || 'moneyline',
    projection: {
      total: projectedTotal,
      margin_home: projectedMargin,
      win_prob_home: winProbHome,
    },
    market,
    market_type: marketType,
    line: isPlayableMarket ? line : null,
    price: isPlayableMarket ? price : null,
    reason_codes: reasonCodes,
    tags: [],
    consistency: {
      total_bias: 'INSUFFICIENT_DATA',
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
      captured_at: oddsSnapshot?.captured_at,
    },
    ev_passed: descriptor.ev_threshold_passed,
    disclaimer:
      'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    driver: {
      key: descriptor.driverKey,
      score: descriptor.driverScore,
      status: descriptor.driverStatus,
      inputs: descriptor.driverInputs,
    },
    driver_summary: buildDriverSummary(descriptor, driverWeights),
    meta: {
      inference_source: descriptor.inference_source,
      is_mock: descriptor.is_mock,
    },
  };

  return payloadData;
}

module.exports = { generateCard };
