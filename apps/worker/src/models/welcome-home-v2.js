/**
 * Welcome Home v2 Driver
 *
 * Cross-sport road trip strength signal based on:
 * - Trip length (games in road stretch)
 * - Travel disruption (consecutive road games)
 * - Compression (games per day ratio)
 * - Opponent quality
 * - Back-to-back penalties
 *
 * Generates tier-based recommendations: S(≥7), A(4-6), B(2-3), NO_PLAY(≤1)
 */

/**
 * Convert to number, return null if invalid
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Score trip length component
 * @param {number} roadsGamesCount - number of consecutive road games
 * @returns {number} points (0-3)
 */
function scoreTripLength(roadsGamesCount) {
  if (roadsGamesCount >= 4) return 3;
  if (roadsGamesCount === 3) return 2;
  if (roadsGamesCount === 2) return 1;
  return 0;
}

/**
 * Score travel disruption component
 * @param {number} roadsGamesCount - number of consecutive road games
 * @returns {number} points (0-2)
 */
function scoreTravelDisruption(roadsGamesCount) {
  if (roadsGamesCount >= 3) return 2;
  if (roadsGamesCount >= 2) return 1;
  return 0;
}

/**
 * Score compression component (games per days ratio)
 * @param {number} roadsGamesCount
 * @param {number} daysBetweenFirstAndLast - elapsed days in road stretch
 * @returns {number} points (0-2)
 */
function scoreCompression(roadsGamesCount, daysBetweenFirstAndLast) {
  if (!daysBetweenFirstAndLast || daysBetweenFirstAndLast === 0) {
    // Consecutive games = maximum compression
    return roadsGamesCount >= 3 ? 2 : 0;
  }

  const gamesPerDay = roadsGamesCount / daysBetweenFirstAndLast;
  if (gamesPerDay >= 0.6) return 2;  // ≥3 games in ≤5 days
  if (gamesPerDay >= 0.33) return 1; // ≤3 games in ≤3 days
  return 0;
}

/**
 * Score opponent quality component
 * @param {number} opponentNetRating - opponent's net rating (offense - defense)
 * @param {number} opponentWinPct - opponent's win percentage
 * @returns {number} points (0-2)
 */
function scoreOpponentQuality(opponentNetRating, opponentWinPct) {
  let points = 0;

  if (opponentNetRating && opponentNetRating >= 3) {
    points += 1;  // Strong opponent
  }

  if (opponentWinPct && opponentWinPct >= 0.60) {
    points += 1;  // Elite opponent
  }

  return Math.min(points, 2);
}

/**
 * Score spot risk component
 * @param {boolean} isBackToBack - was this team on B2B yesterday?
 * @returns {number} points (0-2)
 */
function scoreSpotRisk(isBackToBack) {
  // Back-to-back on road is a compound penalty
  return isBackToBack ? 2 : 1;
}

/**
 * Calculate Welcome Home v2 tier
 * @param {object} awayTeam - { restDays, record, netRating, recentGames }
 * @param {object} homeTeam - { netRating, record }
 * @param {object} context - { sport, isBackToBack, recentRoadGames }
 * @returns {object} { tier, score, components, signal }
 */
function calculateWelcomeHome(awayTeam, homeTeam, context = {}) {
  const { sport = 'NBA', isBackToBack = false, recentRoadGames = [] } = context;

  // Require minimum road trip length (2+ games)
  if (!recentRoadGames || recentRoadGames.length < 2) {
    return {
      tier: 'NO_PLAY',
      score: 0,
      components: {},
      signal: 'Insufficient road games (need 2+)',
      reasoning: 'Not on meaningful road trip'
    };
  }

  // Calculate components
  const tripLength = scoreTripLength(recentRoadGames.length);
  const travelDisruption = scoreTravelDisruption(recentRoadGames.length);
  
  // Calculate days elapsed (simplified: each game is ~1-2 days apart)
  const daysBetween = recentRoadGames.length > 1 
    ? (recentRoadGames.length - 1) * 1.5  // Rough estimate
    : 0;
  const compression = scoreCompression(recentRoadGames.length, daysBetween);

  const awayNetRating = toNumber(awayTeam?.netRating);
  const homeNetRating = toNumber(homeTeam?.netRating);
  const opponentQuality = scoreOpponentQuality(homeNetRating, null);
  
  const spotRisk = scoreSpotRisk(isBackToBack);

  // Total score
  const totalScore = tripLength + travelDisruption + compression + spotRisk + opponentQuality;

  // Tier determination
  let tier = 'NO_PLAY';
  if (totalScore >= 7) tier = 'S';
  else if (totalScore >= 4) tier = 'A';
  else if (totalScore >= 2) tier = 'B';

  return {
    tier,
    score: totalScore,
    components: {
      tripLength,
      travelDisruption,
      compression,
      spotRisk,
      opponentQuality
    },
    reasoning: `Road trip strength: ${recentRoadGames.length} games, compression=${compression}pts, opponent=${opponentQuality}pts`,
    signal: tier !== 'NO_PLAY'
  };
}

/**
 * Generate Welcome Home v2 card descriptor
 * Emits only for tiers S, A (high conviction) and optionally B
 * @param {object} gameCtx - { gameId, awayTeam, homeTeam, sport, isBackToBack, recentRoadGames }
 * @returns {object|null} Card descriptor or null if NO_PLAY tier
 */
function generateWelcomeHomeCard(gameCtx) {
  const {
    gameId,
    awayTeam = {},
    homeTeam = {},
    sport = 'NBA',
    isBackToBack = false,
    recentRoadGames = []
  } = gameCtx;

  const analysis = calculateWelcomeHome(awayTeam, homeTeam, { sport, isBackToBack, recentRoadGames });

  // Only emit for meaningful signals
  if (!analysis.signal || analysis.tier === 'NO_PLAY') {
    return null;
  }

  // Confidence mapping
  const confidenceMap = {
    'S': 0.78,  // S-tier = SUPER
    'A': 0.68,  // A-tier = BEST/WATCH
    'B': 0.58   // B-tier = WATCH
  };

  // Prediction: away team fatigue → favor home
  const confidence = confidenceMap[analysis.tier] || 0.55;
  const tier = confidence >= 0.75 ? 'SUPER' : confidence >= 0.70 ? 'BEST' : 'WATCH';

  return {
    cardType: 'welcome-home-v2',
    cardTitle: `[${sport}] Road Fatigue: Home Advantage Signal`,
    confidence,
    tier,
    prediction: 'HOME',
    reasoning: `Away team on ${recentRoadGames.length}-game road trip (tier: ${analysis.tier}). ${analysis.reasoning}`,
    ev_threshold_passed: confidence > 0.60,
    driverKey: 'welcomeHomeV2',
    driverInputs: {
      road_games_count: recentRoadGames.length,
      is_back_to_back: isBackToBack,
      away_team_rest: toNumber(awayTeam?.restDays),
      home_net_rating: toNumber(homeTeam?.netRating)
    },
    driverScore: Math.min(analysis.score / 10, 1.0),  // Normalize 0-10 to 0-1
    driverStatus: 'ok',
    inference_source: 'driver',
    is_mock: false,
    welcomeHomeComponents: analysis.components
  };
}

module.exports = {
  calculateWelcomeHome,
  generateWelcomeHomeCard,
  scoreTripLength,
  scoreTravelDisruption,
  scoreCompression,
  scoreOpponentQuality,
  scoreSpotRisk
};
