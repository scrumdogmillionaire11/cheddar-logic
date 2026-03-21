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
const nodeCrypto = require('crypto');

// ============================================================================
// Soccer market scope constants
// ============================================================================
const SOCCER_TIER1_MARKETS = new Set([
  'player_shots',
  'team_totals',
  'to_score_or_assist',
]);
const SOCCER_ODDS_BACKED_MARKETS = new Set([
  'soccer_ml',
  'soccer_game_total',
  'soccer_double_chance',
  'asian_handicap_home',
  'asian_handicap_away',
]);
const FOOTIE_MAIN_MARKETS = new Set([...SOCCER_ODDS_BACKED_MARKETS]);
const SOCCER_TIER2_MARKETS = new Set([
  'player_shots_on_target',
  'anytime_goalscorer',
  'team_corners',
]);
const SOCCER_BANNED_MARKETS = new Set([
  'draw_no_bet',
  'asian_handicap',
  'match_total',
  'btts',
  'cards',
  'fouls',
  '1x2',
]);

// Mapping from Odds API market keys → canonical soccer card type keys
// These are checked FIRST, before Tier1/Tier2/banned set lookups
const ODDS_API_MARKET_MAP = {
  'h2h': 'soccer_ml',
  'moneyline': 'soccer_ml',
  'soccer_ml': 'soccer_ml',
  'totals': 'soccer_game_total',
  'game_total': 'soccer_game_total',
  'soccer_game_total': 'soccer_game_total',
  'double_chance': 'soccer_double_chance',
  'doublechance': 'soccer_double_chance',
  'soccer_double_chance': 'soccer_double_chance',
  'asian_handicap_home': 'asian_handicap_home',
  'asian_handicap_away': 'asian_handicap_away',
  'ah_home': 'asian_handicap_home',
  'ah_away': 'asian_handicap_away',
};
const TIER1_PLAYER_MARKETS = new Set(['player_shots', 'to_score_or_assist']);
const ALLOWED_TEAM_TOTAL_LINES = new Set(['o0.5', 'o1.5', 'u2.5']);
const TSOA_QUALIFYING_ROLE_TAGS = new Set([
  'TERMINAL_NODE',
  'PRIMARY_CREATOR',
  'SET_PIECE_ROLE',
]);
const SOCCER_TIER1_PROP_TYPES = ['player_shots', 'to_score_or_assist'];
const DEFAULT_SOCCER_PROP_PLAYER_BLOCKLIST = ['matheus cunha'];
const SOCCER_PLAYER_SHOTS_MIN_LINE = Number(
  process.env.SOCCER_PLAYER_SHOTS_MIN_LINE || 0.5,
);
const SOCCER_PLAYER_SHOTS_MAX_LINE = Number(
  process.env.SOCCER_PLAYER_SHOTS_MAX_LINE || 3.5,
);
const SOCCER_TIER1_PROP_MAX_CARDS_PER_GAME = Number(
  process.env.SOCCER_TIER1_PROP_MAX_CARDS_PER_GAME || 12,
);
const SOCCER_MODEL_MODES = new Set([
  'OHIO_PROPS_ONLY',
  'SIDES_AND_PROPS',
]);
const DEFAULT_SOCCER_MODEL_MODE = 'SIDES_AND_PROPS';
const SOCCER_SIDE_MARKETS = new Set([
  'soccer_ml',
  'asian_handicap_home',
  'asian_handicap_away',
]);
const SOCCER_AH_MARKETS = new Set([
  'asian_handicap_home',
  'asian_handicap_away',
]);
const FOOTIE_LAMBDA_SOURCE = {
  STATS_PRIMARY: 'STATS_PRIMARY',
  STATS_MARKET_BLEND: 'STATS_MARKET_BLEND',
  MARKET_FALLBACK: 'MARKET_FALLBACK',
};
const FOOTIE_LAMBDA_QUALITY = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};
const FOOTIE_DEFAULT_TOTAL_GOALS = 2.6;
const FOOTIE_MARKET_ANCHOR_WEIGHT = 0.25;
const FOOTIE_STATS_WEIGHT = 1 - FOOTIE_MARKET_ANCHOR_WEIGHT;
const FOOTIE_LEAGUE_HOME_EDGE = {
  EPL: 0.12,
  MLS: 0.09,
  UCL: 0.1,
};
const FOOTIE_MAX_GOALS = 10;
const FOOTIE_REASON_CODES = {
  MISSING_EDGE: 'PASS_MISSING_EDGE',
  MISSING_LAMBDAS: 'BLOCKED_NO_PRIMARY_LAMBDA',
  MARKET_FALLBACK_ONLY: 'BLOCKED_MARKET_FALLBACK_ONLY',
  DRAW_RISK_HIGH: 'BLOCKED_ML_DRAW_RISK_HIGH',
  LINEUP_UNCONFIRMED: 'BLOCKED_UNCONFIRMED_LINEUP',
  CONTRADICTORY_SIGNAL: 'BLOCKED_CONTRADICTORY_SIDE_SIGNAL',
  NO_PRIMARY_STATS: 'BLOCKED_NO_PRIMARY_TEAM_STATS',
};
const soccerXgCacheMemo = new Map();

function normalizePlayerToken(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getSoccerPropPlayerBlocklist() {
  const raw = process.env.SOCCER_PROP_PLAYER_BLOCKLIST;
  const source =
    typeof raw === 'string' && raw.trim().length > 0
      ? raw.split(',')
      : DEFAULT_SOCCER_PROP_PLAYER_BLOCKLIST;
  return new Set(source.map((entry) => normalizePlayerToken(entry)).filter(Boolean));
}

function isBlockedSoccerPropPlayer(playerName) {
  const normalized = normalizePlayerToken(playerName);
  if (!normalized) return false;
  return getSoccerPropPlayerBlocklist().has(normalized);
}

function resolveSoccerModelMode(rawMode = process.env.SOCCER_MODEL_MODE ?? process.env.soccer_model_mode) {
  const normalized = String(rawMode || '')
    .trim()
    .toUpperCase();
  if (SOCCER_MODEL_MODES.has(normalized)) {
    return normalized;
  }
  return DEFAULT_SOCCER_MODEL_MODE;
}

function isSoccerSideMarket(canonicalMarket) {
  return SOCCER_SIDE_MARKETS.has(String(canonicalMarket || ''));
}

function shouldEmitOddsBackedCard(modelMode, canonicalMarket) {
  if (!SOCCER_ODDS_BACKED_MARKETS.has(canonicalMarket)) {
    return true;
  }
  return modelMode !== 'OHIO_PROPS_ONLY';
}

/**
 * Normalize a raw market key string to its canonical soccer market key.
 * Returns null if out-of-scope or banned.
 * @param {string|undefined} rawKey
 * @returns {string|null}
 */
function normalizeToCanonicalSoccerMarket(rawKey) {
  if (rawKey === undefined || rawKey === null) return null;
  const normalized = String(rawKey)
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');

  // Check Odds API market key mapping first (h2h, totals, doubleChance, double_chance)
  if (ODDS_API_MARKET_MAP[normalized]) {
    return ODDS_API_MARKET_MAP[normalized];
  }

  if (
    SOCCER_TIER1_MARKETS.has(normalized) ||
    SOCCER_ODDS_BACKED_MARKETS.has(normalized) ||
    SOCCER_TIER2_MARKETS.has(normalized)
  ) {
    return normalized;
  }

  if (SOCCER_BANNED_MARKETS.has(normalized)) {
    console.debug(
      `[SoccerModel] normalizeToCanonicalSoccerMarket: blocked banned market "${normalized}"`,
    );
    return null;
  }

  console.debug(
    `[SoccerModel] normalizeToCanonicalSoccerMarket: "${normalized}" is out of soccer scope`,
  );
  return null;
}

/**
 * Build a Tier 1 (or qualifying Tier 2) soccer card payload.
 * Returns { cardType, payloadData, pass_reason }.
 * pass_reason is null when the card is actionable; non-null when downgraded to PASS.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {string} canonicalMarket - canonical soccer market key
 * @returns {{ cardType: string, payloadData: object, pass_reason: string|null }}
 */
function buildSoccerTier1Payload(gameId, oddsSnapshot, canonicalMarket) {
  const now = new Date().toISOString();
  const rawData = parseRawData(oddsSnapshot?.raw_data) || {};
  const missing_context_flags = [];
  let pass_reason = null;

  const marketFamily = SOCCER_TIER1_MARKETS.has(canonicalMarket)
    ? 'tier1'
    : 'tier2';

  // ------------------------------------------------------------------
  // Base fields always required
  // ------------------------------------------------------------------
  const homeTeam = oddsSnapshot?.home_team || null;
  const awayTeam = oddsSnapshot?.away_team || null;
  const matchup =
    homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : null;

  // ------------------------------------------------------------------
  // Price
  // ------------------------------------------------------------------
  const rawPrice = rawData.price ?? null;
  const price =
    typeof rawPrice === 'number' && Number.isFinite(rawPrice)
      ? Math.trunc(rawPrice)
      : null;
  if (price === null) {
    missing_context_flags.push('price');
  }

  // ------------------------------------------------------------------
  // Projection basis
  // ------------------------------------------------------------------
  const PLACEHOLDER_VALUES = new Set(['unknown', 'tbd', 'n/a', '']);
  let projection_basis = rawData.projection_basis || null;
  if (
    projection_basis !== null &&
    PLACEHOLDER_VALUES.has(String(projection_basis).toLowerCase())
  ) {
    missing_context_flags.push('projection_basis');
    projection_basis = null;
  } else if (!projection_basis) {
    missing_context_flags.push('projection_basis');
    projection_basis = null;
  }

  // ------------------------------------------------------------------
  // Edge / EV
  // ------------------------------------------------------------------
  const fairProb = typeof rawData.fair_prob === 'number' ? rawData.fair_prob : null;
  const impliedProb =
    typeof rawData.implied_prob === 'number' ? rawData.implied_prob : null;
  let edge_ev = null;
  if (fairProb !== null && impliedProb !== null) {
    edge_ev = Number((fairProb - impliedProb).toFixed(4));
  } else {
    missing_context_flags.push('edge_ev');
  }

  // ------------------------------------------------------------------
  // Market-specific logic
  // ------------------------------------------------------------------
  let line = null;
  let eligibility = undefined;
  let market_type = 'INFO';
  let selection = null;
  let player_name = null;
  let team_abbr = null;

  const normalizeSelectionSide = (value) => {
    if (!value) return null;
    const upper = String(value).trim().toUpperCase();
    if (upper === 'OVER' || upper === 'UNDER') return upper;
    return null;
  };

  if (canonicalMarket === 'team_totals') {
    // Line validation
    const rawLine = rawData.line || null;
    if (rawLine && ALLOWED_TEAM_TOTAL_LINES.has(String(rawLine).toLowerCase())) {
      line = String(rawLine).toLowerCase();
    } else if (rawLine) {
      // Line present but not in allowed set — treat as present but non-standard
      line = String(rawLine).toLowerCase();
    } else {
      missing_context_flags.push('line');
    }

    market_type = 'TEAM_TOTAL';
    selection = {
      side: normalizeSelectionSide(rawData.selection_side ?? rawData.selection ?? 'OVER') || 'OVER',
      team: rawData.team ?? homeTeam ?? null,
    };
    team_abbr = typeof rawData.team_abbr === 'string' ? rawData.team_abbr : null;

    if (missing_context_flags.includes('line')) {
      pass_reason = 'MISSING_LINE';
    } else if (missing_context_flags.includes('price')) {
      pass_reason = 'MISSING_PRICE';
    }
  } else if (TIER1_PLAYER_MARKETS.has(canonicalMarket)) {
    // Player context
    const playerCtx = rawData.player_context || {};
    player_name =
      (typeof rawData.player_name === 'string' && rawData.player_name.trim()) ||
      (typeof playerCtx.player_name === 'string' && playerCtx.player_name.trim()) ||
      null;
    team_abbr =
      (typeof rawData.team_abbr === 'string' && rawData.team_abbr.trim()) ||
      (typeof playerCtx.team_abbr === 'string' && playerCtx.team_abbr.trim()) ||
      null;
    const starterSignal = playerCtx.is_starter === true;
    const projMinutes =
      typeof playerCtx.projected_minutes === 'number'
        ? playerCtx.projected_minutes
        : null;
    const roleTags = Array.isArray(playerCtx.role_tags) ? playerCtx.role_tags : [];
    const per90Hints = {};
    if (typeof playerCtx.shots_per90 === 'number') {
      per90Hints.shots_per90 = playerCtx.shots_per90;
    }
    if (typeof playerCtx.xg_per90 === 'number') {
      per90Hints.xg_per90 = playerCtx.xg_per90;
    }
    if (typeof playerCtx.xa_per90 === 'number') {
      per90Hints.xa_per90 = playerCtx.xa_per90;
    }

    eligibility = {
      starter_signal: starterSignal,
      proj_minutes: projMinutes,
      role_tags: roleTags,
      per90_hints: per90Hints,
    };

    market_type = 'PROP';
    selection = {
      side: normalizeSelectionSide(rawData.selection_side ?? rawData.selection ?? 'OVER') || 'OVER',
      team: player_name,
    };

    if (!starterSignal) {
      missing_context_flags.push('starter_signal');
      if (!pass_reason) pass_reason = 'NO_STARTER_SIGNAL';
    }

    // Price caps per market
    if (canonicalMarket === 'player_shots') {
      if (price !== null && price < -150) {
        missing_context_flags.push('price_cap_shots');
        pass_reason = 'PRICE_CAP_VIOLATION';
      }
    } else if (canonicalMarket === 'to_score_or_assist') {
      if (price !== null && price < -140) {
        missing_context_flags.push('price_cap_tsoa');
        pass_reason = 'PRICE_CAP_VIOLATION';
      }
      // Role tag requirement for TSOA
      const hasQualifyingRole = roleTags.some((t) =>
        TSOA_QUALIFYING_ROLE_TAGS.has(t),
      );
      if (!hasQualifyingRole && !pass_reason) {
        missing_context_flags.push('tsoa_role_tag');
        pass_reason = 'MISSING_ROLE_TAG';
      } else if (!hasQualifyingRole) {
        missing_context_flags.push('tsoa_role_tag');
      }
    }
  } else if (canonicalMarket === 'player_shots_on_target') {
    // Tier 2: only emit when shots unavailable or poor-priced and price cap passes
    market_type = 'PROP';
    selection = {
      side: normalizeSelectionSide(rawData.selection_side ?? rawData.selection ?? 'OVER') || 'OVER',
      team:
        (rawData.player_name && String(rawData.player_name).trim()) ||
        null,
    };
    if (price === null || price < -130) {
      if (!pass_reason) pass_reason = 'TIER2_NOT_QUALIFIED';
    }
  } else if (canonicalMarket === 'anytime_goalscorer') {
    const playerCtx = rawData.player_context || {};
    const roleTags = Array.isArray(playerCtx.role_tags) ? playerCtx.role_tags : [];
    const isTerminalNode = roleTags.includes('TERMINAL_NODE');
    market_type = 'PROP';
    player_name =
      (typeof rawData.player_name === 'string' && rawData.player_name.trim()) ||
      (typeof playerCtx.player_name === 'string' && playerCtx.player_name.trim()) ||
      null;
    team_abbr =
      (typeof rawData.team_abbr === 'string' && rawData.team_abbr.trim()) ||
      (typeof playerCtx.team_abbr === 'string' && playerCtx.team_abbr.trim()) ||
      null;
    selection = {
      side: normalizeSelectionSide(rawData.selection_side ?? rawData.selection ?? 'OVER') || 'OVER',
      team: player_name,
    };
    if (!isTerminalNode || price === null || price <= 180) {
      if (!pass_reason) pass_reason = 'TIER2_NOT_QUALIFIED';
    }
    eligibility = {
      starter_signal: playerCtx.is_starter === true,
      proj_minutes: playerCtx.projected_minutes || null,
      role_tags: roleTags,
      per90_hints: {},
    };
  } else if (canonicalMarket === 'team_corners') {
    market_type = 'TEAM_TOTAL';
    selection = {
      side: normalizeSelectionSide(rawData.selection_side ?? rawData.selection ?? 'OVER') || 'OVER',
      team: rawData.team ?? homeTeam ?? null,
    };
    team_abbr = typeof rawData.team_abbr === 'string' ? rawData.team_abbr : null;
    const extremeMismatch = rawData.extreme_mismatch === true;
    const cornersDataAvailable = rawData.corners_data_available === true;
    if (!extremeMismatch || !cornersDataAvailable) {
      if (!pass_reason) pass_reason = 'TIER2_NOT_QUALIFIED';
    }
  }

  const isPlayerMarket =
    canonicalMarket === 'player_shots' ||
    canonicalMarket === 'to_score_or_assist' ||
    canonicalMarket === 'player_shots_on_target' ||
    canonicalMarket === 'anytime_goalscorer';

  if (isPlayerMarket && !player_name) {
    missing_context_flags.push('player_identity');
    market_type = 'INFO';
    if (!pass_reason) {
      pass_reason = 'MISSING_PLAYER_IDENTITY';
    }
  }

  // ------------------------------------------------------------------
  // Final degradation (Stage E): if missing_context_flags non-empty
  // and no specific pass_reason set yet, use generic reason
  // ------------------------------------------------------------------
  if (!pass_reason && missing_context_flags.length > 0) {
    pass_reason = 'INSUFFICIENT_PROJECTION_CONTEXT';
  }

  const payloadData = {
    canonical_market_key: canonicalMarket,
    market_family: marketFamily,
    kind: 'PLAY',
    market_type,
    sport: 'SOCCER',
    game_id: gameId,
    home_team: homeTeam,
    away_team: awayTeam,
    matchup,
    start_time_utc: oddsSnapshot?.game_time_utc ?? null,
    generated_at: now,
    missing_context_flags,
    pass_reason,
    projection_basis,
    model_confidence: null,
    edge_ev,
    price,
    line: line || null,
    selection,
    player_name,
    team_abbr,
    ...(eligibility !== undefined ? { eligibility } : {}),
    projection_context: {
      source: rawData.projection_source || 'odds_snapshot',
      available: projection_basis !== null,
      missing_fields: [...missing_context_flags],
    },
  };

  return {
    cardType: 'soccer',
    payloadData,
    pass_reason,
  };
}

/**
 * Build an odds-backed soccer card for Tier-1 main-market card types.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {string} canonicalCardType - Tier-1 canonical market key
 * @returns {{ id, gameId, sport, cardType, cardTitle, createdAt, expiresAt, payloadData, modelOutputIds }}
 */
function buildSoccerOddsBackedCard(gameId, oddsSnapshot, canonicalCardType) {
  const cardId = `card-soccer-odds-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();
  const rawData = parseRawData(oddsSnapshot?.raw_data) || {};
  const missing_context_flags = [];

  const homeTeam = oddsSnapshot?.home_team ?? null;
  const awayTeam = oddsSnapshot?.away_team ?? null;

  let payloadData;

  if (canonicalCardType === 'soccer_ml') {
    const marketSignal = derivePredictionFromMoneyline(
      oddsSnapshot?.h2h_home,
      oddsSnapshot?.h2h_away,
    );
    const lambdaModel = computeFootieLambdas({
      oddsSnapshot,
      rawData,
      side: 'HOME',
      offeredLine: null,
    });
    const lambdaHome = toFiniteNumber(lambdaModel?.lambda_home);
    const lambdaAway = toFiniteNumber(lambdaModel?.lambda_away);
    const leagueTag = deriveLeagueTag(oddsSnapshot);
    const mlProbabilities = computeFootieMlProbabilities({
      lambdaHome,
      lambdaAway,
      leagueTag,
    });

    if (!Number.isFinite(oddsSnapshot?.h2h_home)) missing_context_flags.push('h2h_home');
    if (!Number.isFinite(oddsSnapshot?.h2h_away)) missing_context_flags.push('h2h_away');
    if (!Number.isFinite(lambdaHome)) missing_context_flags.push('lambda_home');
    if (!Number.isFinite(lambdaAway)) missing_context_flags.push('lambda_away');
    if (!mlProbabilities) missing_context_flags.push('model_probabilities');

    const pHomeWin = mlProbabilities?.p_home_win ?? null;
    const pDraw = mlProbabilities?.p_draw ?? null;
    const pAwayWin = mlProbabilities?.p_away_win ?? null;
    const prediction =
      Number.isFinite(pHomeWin) && Number.isFinite(pAwayWin)
        ? pHomeWin >= pAwayWin
          ? 'HOME'
          : 'AWAY'
        : marketSignal.prediction;

    const selectionTeam = prediction === 'HOME' ? homeTeam : awayTeam;
    const priceRaw = prediction === 'HOME' ? oddsSnapshot?.h2h_home : oddsSnapshot?.h2h_away;
    const price = Number.isFinite(priceRaw) ? Math.trunc(priceRaw) : null;
    if (!Number.isFinite(priceRaw)) missing_context_flags.push('price');

    const impliedMlProbabilities = deriveDevigTwoWay(
      oddsSnapshot?.h2h_home,
      oddsSnapshot?.h2h_away,
    );
    const impliedProb = prediction === 'HOME'
      ? impliedMlProbabilities.home
      : impliedMlProbabilities.away;
    const modelProb = prediction === 'HOME' ? pHomeWin : pAwayWin;
    const edgeEv =
      Number.isFinite(modelProb) && Number.isFinite(impliedProb)
        ? Number((modelProb - impliedProb).toFixed(4))
        : null;
    const sideMarketGap =
      Number.isFinite(modelProb) && Number.isFinite(impliedProb)
        ? Math.abs(modelProb - impliedProb)
        : null;
    const confidence = deriveSideConfidence({
      modelProb,
      lambdaSource: lambdaModel?.lambda_source,
      lambdaSourceQuality: lambdaModel?.lambda_source_quality,
      statsCompleteness: lambdaModel?.stats_completeness,
      lineupCertainty: lambdaModel?.lineup?.certainty,
      sideMarketGap,
    });
    const baseTier = deriveTierFromEdge(edgeEv);
    const sideGuards = applySideRiskGuards({
      marketType: 'MONEYLINE',
      edge: edgeEv,
      tier: baseTier,
      lambdaSource: lambdaModel?.lambda_source,
      lineup: lambdaModel?.lineup,
      drawProbability: pDraw,
      modelSide: prediction,
      marketSide: marketSignal.prediction,
    });
    const pass_reason =
      missing_context_flags.length > 0
        ? (lambdaModel?.lambda_source ? 'MISSING_ML_INPUTS' : FOOTIE_REASON_CODES.MISSING_LAMBDAS)
        : sideGuards.pass_reason;
    const reason_codes = Array.from(
      new Set([
        ...(Array.isArray(sideGuards.reason_codes) ? sideGuards.reason_codes : []),
        lambdaModel?.lambda_source === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK
          ? FOOTIE_REASON_CODES.NO_PRIMARY_STATS
          : null,
        pass_reason,
      ].filter(Boolean)),
    );
    const fairMlHome = probabilityToAmerican(pHomeWin);
    const fairMlDraw = probabilityToAmerican(pDraw);
    const fairMlAway = probabilityToAmerican(pAwayWin);

    payloadData = {
      sport: 'SOCCER',
      game_id: gameId,
      market_type: 'MONEYLINE',
      home_team: homeTeam,
      away_team: awayTeam,
      matchup: buildMatchup(homeTeam, awayTeam),
      start_time_utc: oddsSnapshot?.game_time_utc ?? null,
      generated_at: now,
      model_confidence: null,
      selection: { side: prediction, team: selectionTeam },
      price,
      model_prob: Number.isFinite(modelProb) ? modelProb : null,
      p_home_win: Number.isFinite(pHomeWin) ? pHomeWin : null,
      p_draw: Number.isFinite(pDraw) ? pDraw : null,
      p_away_win: Number.isFinite(pAwayWin) ? pAwayWin : null,
      fair_ml_home: Number.isFinite(fairMlHome) ? fairMlHome : null,
      fair_ml_draw: Number.isFinite(fairMlDraw) ? fairMlDraw : null,
      fair_ml_away: Number.isFinite(fairMlAway) ? fairMlAway : null,
      lambda_home: Number.isFinite(lambdaHome) ? safeRound(lambdaHome, 4) : null,
      lambda_away: Number.isFinite(lambdaAway) ? safeRound(lambdaAway, 4) : null,
      lambda_source: lambdaModel?.lambda_source ?? null,
      lambda_source_quality: lambdaModel?.lambda_source_quality ?? null,
      stats_completeness: Number.isFinite(lambdaModel?.stats_completeness)
        ? lambdaModel.stats_completeness
        : null,
      edge: edgeEv,
      edge_ev: edgeEv,
      confidence,
      tier: sideGuards.tier,
      edge_basis: 'stats_poisson_vs_devig_moneyline',
      missing_context_flags,
      pass_reason,
      reason_codes,
      confidence_components: {
        lambda_source: lambdaModel?.lambda_source ?? null,
        lambda_source_quality: lambdaModel?.lambda_source_quality ?? null,
        lineup_certainty: lambdaModel?.lineup?.certainty ?? null,
        lineup_unresolved: Boolean(lambdaModel?.lineup?.unresolved),
        stats_completeness: Number.isFinite(lambdaModel?.stats_completeness)
          ? lambdaModel.stats_completeness
          : null,
      },
      side_model: {
        p_home_win: Number.isFinite(pHomeWin) ? pHomeWin : null,
        p_draw: Number.isFinite(pDraw) ? pDraw : null,
        p_away_win: Number.isFinite(pAwayWin) ? pAwayWin : null,
        implied_home_prob: Number.isFinite(impliedMlProbabilities.home)
          ? safeRound(impliedMlProbabilities.home, 6)
          : null,
        implied_away_prob: Number.isFinite(impliedMlProbabilities.away)
          ? safeRound(impliedMlProbabilities.away, 6)
          : null,
      },
    };
  } else if (canonicalCardType === 'soccer_game_total') {
    const totalLine = rawData.total_line ?? null;
    const overPrice = rawData.over_price ?? null;
    const underPrice = rawData.under_price ?? null;
    const selection = rawData.selection ?? null;

    let pass_reason = null;
    if (totalLine === null) {
      missing_context_flags.push('total_line');
      pass_reason = 'MISSING_LINE';
    }

    payloadData = {
      sport: 'SOCCER',
      game_id: gameId,
      market_type: 'GAME_TOTAL',
      home_team: homeTeam,
      away_team: awayTeam,
      matchup: buildMatchup(homeTeam, awayTeam),
      start_time_utc: oddsSnapshot?.game_time_utc ?? null,
      generated_at: now,
      model_confidence: null,
      line: totalLine,
      over_price: typeof overPrice === 'number' ? Math.trunc(overPrice) : null,
      under_price: typeof underPrice === 'number' ? Math.trunc(underPrice) : null,
      selection,
      edge_basis: rawData.edge_basis ?? null,
      missing_context_flags,
      pass_reason,
    };
  } else if (canonicalCardType === 'soccer_double_chance') {
    const outcome = rawData.dc_outcome ?? null;
    const dcPrice = rawData.dc_price ?? null;
    const edgeBasis = rawData.edge_basis ?? null;

    if (outcome === null) missing_context_flags.push('dc_outcome');
    if (dcPrice === null) missing_context_flags.push('dc_price');

    payloadData = {
      sport: 'SOCCER',
      game_id: gameId,
      market_type: 'DOUBLE_CHANCE',
      home_team: homeTeam,
      away_team: awayTeam,
      matchup: buildMatchup(homeTeam, awayTeam),
      start_time_utc: oddsSnapshot?.game_time_utc ?? null,
      generated_at: now,
      model_confidence: null,
      outcome,
      price: typeof dcPrice === 'number' ? Math.trunc(dcPrice) : null,
      edge_basis: edgeBasis,
      missing_context_flags,
      pass_reason: null,
    };
  } else if (
    canonicalCardType === 'asian_handicap_home' ||
    canonicalCardType === 'asian_handicap_away'
  ) {
    const side = canonicalCardType === 'asian_handicap_home' ? 'HOME' : 'AWAY';
    const selectionTeam = side === 'HOME' ? homeTeam : awayTeam;
    const snapshotLineRaw =
      side === 'HOME' ? oddsSnapshot?.spread_home : oddsSnapshot?.spread_away;
    const snapshotOfferedPriceRaw =
      side === 'HOME'
        ? oddsSnapshot?.spread_price_home
        : oddsSnapshot?.spread_price_away;
    const snapshotOppositePriceRaw =
      side === 'HOME'
        ? oddsSnapshot?.spread_price_away
        : oddsSnapshot?.spread_price_home;

    const lineRaw = rawData.ah_line ?? rawData.line ?? snapshotLineRaw ?? null;
    const offeredPriceRaw =
      rawData.ah_price ?? rawData.price ?? snapshotOfferedPriceRaw ?? null;
    const oppositePriceRaw =
      rawData.ah_opposite_price ?? rawData.opposite_price ?? snapshotOppositePriceRaw ?? null;

    const line =
      typeof lineRaw === 'number'
        ? lineRaw
        : (typeof lineRaw === 'string' ? Number(lineRaw) : null);
    const offeredPrice =
      typeof offeredPriceRaw === 'number'
        ? Math.trunc(offeredPriceRaw)
        : (typeof offeredPriceRaw === 'string' ? Math.trunc(Number(offeredPriceRaw)) : null);
    const oppositePrice =
      typeof oppositePriceRaw === 'number'
        ? Math.trunc(oppositePriceRaw)
        : (typeof oppositePriceRaw === 'string' ? Math.trunc(Number(oppositePriceRaw)) : null);
    const lambdaModel = computeFootieLambdas({
      oddsSnapshot,
      rawData,
      side,
      offeredLine: Number.isFinite(line) ? Number(line) : null,
    });
    const lambdaHome = toFiniteNumber(lambdaModel?.lambda_home);
    const lambdaAway = toFiniteNumber(lambdaModel?.lambda_away);
    const lambdaSource = lambdaModel?.lambda_source ?? null;

    if (!Number.isFinite(line)) missing_context_flags.push('line');
    if (!Number.isFinite(offeredPrice)) missing_context_flags.push('price');
    if (!Number.isFinite(oppositePrice)) missing_context_flags.push('opposite_price');
    if (!Number.isFinite(lambdaHome)) missing_context_flags.push('lambda_home');
    if (!Number.isFinite(lambdaAway)) missing_context_flags.push('lambda_away');

    const pricing =
      missing_context_flags.length === 0
        ? priceAsianHandicap({
            lambda_home: lambdaHome,
            lambda_away: lambdaAway,
            line,
            side,
            offered_price: offeredPrice,
            opposite_price: oppositePrice,
          })
        : null;

    const splitFlag =
      Number.isFinite(line) &&
      (Math.abs(Math.abs(line) % 1 - 0.25) < 1e-9 || Math.abs(Math.abs(line) % 1 - 0.75) < 1e-9);

    const modelProb =
      pricing?.success && Number.isFinite(pricing.model_prob_no_push)
        ? Number(pricing.model_prob_no_push.toFixed(4))
        : null;
    const edgeEv =
      pricing?.success && Number.isFinite(pricing.edge_no_push)
        ? Number(pricing.edge_no_push.toFixed(4))
        : null;
    const marketSideFromLine = Number.isFinite(oddsSnapshot?.spread_home)
      ? oddsSnapshot.spread_home <= 0
        ? 'HOME'
        : 'AWAY'
      : null;
    const confidence = deriveSideConfidence({
      modelProb,
      lambdaSource,
      lambdaSourceQuality: lambdaModel?.lambda_source_quality,
      statsCompleteness: lambdaModel?.stats_completeness,
      lineupCertainty: lambdaModel?.lineup?.certainty,
      sideMarketGap: null,
    });
    const baseTier = deriveTierFromEdge(edgeEv);
    const sideGuards = applySideRiskGuards({
      marketType: 'ASIAN_HANDICAP',
      edge: edgeEv,
      tier: baseTier,
      lambdaSource,
      lineup: lambdaModel?.lineup,
      drawProbability: null,
      modelSide: side,
      marketSide: marketSideFromLine,
    });
    const pass_reason =
      missing_context_flags.length > 0
        ? 'MISSING_AH_INPUTS'
        : sideGuards.pass_reason ?? (pricing && pricing.success ? null : (pricing?.reason_code || 'AH_PRICING_FAILED'));
    const reason_codes = Array.from(
      new Set([
        ...(Array.isArray(sideGuards.reason_codes) ? sideGuards.reason_codes : []),
        lambdaSource === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK
          ? FOOTIE_REASON_CODES.NO_PRIMARY_STATS
          : null,
        pass_reason,
      ].filter(Boolean)),
    );
    const probabilities = pricing?.success ? pricing.probabilities : null;
    const pFullWin = toFiniteNumber(probabilities?.P_full_win);
    const pHalfWin = toFiniteNumber(probabilities?.P_half_win);
    const pPush = toFiniteNumber(probabilities?.P_push);
    const pHalfLoss = toFiniteNumber(probabilities?.P_half_loss);
    const pFullLoss = toFiniteNumber(probabilities?.P_full_loss);
    const pWin = toFiniteNumber(probabilities?.P_win);
    const pLoss = toFiniteNumber(probabilities?.P_loss);
    const fairPrice =
      Number.isFinite(pricing?.fair_price_american)
        ? Math.trunc(pricing.fair_price_american)
        : (Number.isFinite(modelProb) ? probabilityToAmerican(modelProb) : null);

    payloadData = {
      kind: 'PLAY',
      sport: 'SOCCER',
      game_id: gameId,
      recommended_bet_type: 'spread',
      prediction: side,
      selection: {
        side,
        team: selectionTeam,
      },
      canonical_market_key: canonicalCardType,
      market_type: 'ASIAN_HANDICAP',
      home_team: homeTeam,
      away_team: awayTeam,
      matchup: buildMatchup(homeTeam, awayTeam),
      start_time_utc: oddsSnapshot?.game_time_utc ?? null,
      generated_at: now,
      side,
      line: Number.isFinite(line) ? Number(line) : null,
      split_flag: splitFlag,
      price: Number.isFinite(offeredPrice) ? offeredPrice : null,
      opposite_price: Number.isFinite(oppositePrice) ? oppositePrice : null,
      lambda_home: Number.isFinite(lambdaHome) ? Number(lambdaHome.toFixed(4)) : null,
      lambda_away: Number.isFinite(lambdaAway) ? Number(lambdaAway.toFixed(4)) : null,
      lambda_source: lambdaSource,
      lambda_source_quality: lambdaModel?.lambda_source_quality ?? null,
      stats_completeness: Number.isFinite(lambdaModel?.stats_completeness)
        ? lambdaModel.stats_completeness
        : null,
      probabilities,
      p_full_win: Number.isFinite(pFullWin) ? pFullWin : null,
      p_half_win: Number.isFinite(pHalfWin) ? pHalfWin : null,
      p_push: Number.isFinite(pPush) ? pPush : null,
      p_half_loss: Number.isFinite(pHalfLoss) ? pHalfLoss : null,
      p_full_loss: Number.isFinite(pFullLoss) ? pFullLoss : null,
      p_win: Number.isFinite(pWin) ? pWin : null,
      p_loss: Number.isFinite(pLoss) ? pLoss : null,
      model_prob_no_push: pricing?.success ? pricing.model_prob_no_push : null,
      model_prob: modelProb,
      edge: edgeEv,
      edge_ev: edgeEv,
      expected_value: pricing?.success ? pricing.expected_value : null,
      fair_line: pricing?.success ? pricing.fair_line : null,
      fair_price: Number.isFinite(fairPrice) ? fairPrice : null,
      fair_price_american: Number.isFinite(fairPrice) ? fairPrice : null,
      confidence,
      tier: sideGuards.tier,
      projection_basis: lambdaSource,
      edge_basis: 'ah_de_vig_poisson_goal_diff',
      missing_context_flags,
      pass_reason,
      reason_codes,
      confidence_components: {
        lambda_source: lambdaSource,
        lambda_source_quality: lambdaModel?.lambda_source_quality ?? null,
        lineup_certainty: lambdaModel?.lineup?.certainty ?? null,
        lineup_unresolved: Boolean(lambdaModel?.lineup?.unresolved),
        stats_completeness: Number.isFinite(lambdaModel?.stats_completeness)
          ? lambdaModel.stats_completeness
          : null,
      },
      side_watchdog: {
        blocked_no_primary_lambda:
          !Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway),
        blocked_market_fallback_only:
          lambdaSource === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK,
        blocked_unconfirmed_lineup: Boolean(lambdaModel?.lineup?.unresolved),
        blocked_contradictory_side_signal:
          Number.isFinite(oddsSnapshot?.spread_home)
            ? (oddsSnapshot.spread_home <= 0 ? 'HOME' : 'AWAY') !== side
            : false,
      },
      odds_context: {
        spread_home: Number.isFinite(line) ? (side === 'HOME' ? line : -line) : null,
        spread_away: Number.isFinite(line) ? (side === 'AWAY' ? line : -line) : null,
        spread_price_home: side === 'HOME' ? offeredPrice : oppositePrice,
        spread_price_away: side === 'AWAY' ? offeredPrice : oppositePrice,
        captured_at: oddsSnapshot?.captured_at ?? null,
      },
    };
  } else {
    throw new Error(`buildSoccerOddsBackedCard: unknown canonicalCardType "${canonicalCardType}"`);
  }

  return {
    id: cardId,
    gameId,
    sport: 'SOCCER',
    cardType: canonicalCardType,
    cardTitle: `Soccer: ${canonicalCardType}`,
    createdAt: now,
    expiresAt: null,
    payloadData,
    modelOutputIds: null,
  };
}

function buildSoccerSideMarketCard(gameId, oddsSnapshot, canonicalCardType) {
  if (!isSoccerSideMarket(canonicalCardType)) {
    throw new Error(
      `buildSoccerSideMarketCard: "${canonicalCardType}" is not a soccer side market`,
    );
  }
  const card = buildSoccerOddsBackedCard(gameId, oddsSnapshot, canonicalCardType);
  const payload = card?.payloadData;
  if (payload && typeof payload === 'object') {
    payload.footie_engine = 'FOOTIE_SIDES_ENGINE';
    payload.model_inputs_source = 'stats_team_strength';
    payload.fallback_source =
      payload.lambda_source === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK
        ? 'market_implied_lambda'
        : null;
    payload.confidence_source = 'input_quality_components';
    payload.reason_code = payload.pass_reason ?? null;
    payload.reason_codes = Array.from(
      new Set([...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []), payload.reason_code].filter(Boolean)),
    );
  }
  return card;
}

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsWithUpcomingGames,
  getPlayerPropLinesForGame,
  insertCardPayload,
  recordProjectionEntry,
  deleteCardPayloadsForGame,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  db: dataDb,
} = require('@cheddar-logic/data');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
} = require('@cheddar-logic/models');
const {
  computeXgWinProbs,
} = require('@cheddar-logic/models/src/xg-model');
const {
  publishDecisionForCard,
  applyUiActionFields,
} = require('../utils/decision-publisher');
const {
  applySoccerDecisionBasisMeta,
  recordSoccerProjectionTelemetry,
} = require('../utils/soccer-patch');
const {
  gradeAsianHandicap,
} = require('../models/soccer/asian-handicap-grader');
const {
  priceAsianHandicap,
} = require('../models/soccer/asian-handicap-pricing');

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

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getNestedValue(target, path) {
  if (!target || typeof target !== 'object') return undefined;
  return String(path || '')
    .split('.')
    .reduce((acc, segment) => {
      if (acc === null || acc === undefined) return undefined;
      if (typeof acc !== 'object') return undefined;
      return acc[segment];
    }, target);
}

function pickFiniteFromPaths(target, candidatePaths) {
  for (const path of candidatePaths) {
    const value = getNestedValue(target, path);
    const numeric = toFiniteNumber(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function weightedAverage(weightedValues, fallback = null) {
  let weightTotal = 0;
  let weightedSum = 0;
  for (const entry of weightedValues) {
    if (!entry) continue;
    const value = toFiniteNumber(entry.value);
    const weight = toFiniteNumber(entry.weight);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    weightedSum += value * weight;
    weightTotal += weight;
  }
  if (weightTotal <= 0) return fallback;
  return weightedSum / weightTotal;
}

function clampProbability(probability) {
  const numeric = toFiniteNumber(probability);
  if (!Number.isFinite(numeric)) return null;
  return clampToRange(numeric, 0, 1);
}

function safeRound(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function probabilityToAmerican(probability) {
  const p = clampProbability(probability);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  if (p >= 0.5) {
    return Math.round((-100 * p) / (1 - p));
  }
  return Math.round((100 * (1 - p)) / p);
}

function deriveDevigTwoWay(homeOdds, awayOdds) {
  const impliedHome = toImpliedProbability(homeOdds);
  const impliedAway = toImpliedProbability(awayOdds);
  if (
    Number.isFinite(impliedHome) &&
    Number.isFinite(impliedAway) &&
    impliedHome + impliedAway > 0
  ) {
    const total = impliedHome + impliedAway;
    return {
      home: impliedHome / total,
      away: impliedAway / total,
    };
  }
  return {
    home: Number.isFinite(impliedHome) ? impliedHome : null,
    away: Number.isFinite(impliedAway) ? impliedAway : null,
  };
}

function normalizeTeamToken(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getSoccerXgCacheDateEt() {
  try {
    const { DateTime } = require('luxon');
    return DateTime.now()
      .setZone(process.env.TZ || 'America/New_York')
      .toISODate();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function getSoccerXgCacheRow({ league, teamName }) {
  const normalizedLeague = String(league || '').trim().toUpperCase();
  const normalizedTeam = String(teamName || '').trim();
  const cacheDate = getSoccerXgCacheDateEt();
  if (!normalizedLeague || !normalizedTeam || normalizedLeague === 'UNKNOWN') {
    return null;
  }

  const cacheKey = `${normalizedLeague}|${normalizeTeamToken(normalizedTeam)}|${cacheDate}`;
  if (soccerXgCacheMemo.has(cacheKey)) {
    return soccerXgCacheMemo.get(cacheKey);
  }

  let row = null;
  try {
    if (dataDb && typeof dataDb.getSoccerTeamXgCache === 'function') {
      row = dataDb.getSoccerTeamXgCache({
        sport: 'SOCCER',
        league: normalizedLeague,
        teamName: normalizedTeam,
        cacheDate,
      });
    }
  } catch {
    row = null;
  }

  soccerXgCacheMemo.set(cacheKey, row || null);
  return row || null;
}

function getLineupContext(rawData) {
  const lineupContext =
    rawData?.lineup_context ||
    rawData?.lineups ||
    rawData?.lineup ||
    {};

  const homeConfirmed = lineupContext?.home_confirmed_xi;
  const awayConfirmed = lineupContext?.away_confirmed_xi;
  const anyExplicitFalse = homeConfirmed === false || awayConfirmed === false;
  const bothConfirmed = homeConfirmed === true && awayConfirmed === true;
  const partialConfirmed = homeConfirmed === true || awayConfirmed === true;

  const homeAbsences = toFiniteNumber(
    lineupContext?.home_absences ??
      lineupContext?.home_starters_out ??
      rawData?.home_absences,
  ) || 0;
  const awayAbsences = toFiniteNumber(
    lineupContext?.away_absences ??
      lineupContext?.away_starters_out ??
      rawData?.away_absences,
  ) || 0;

  return {
    home_absences: Math.max(0, homeAbsences),
    away_absences: Math.max(0, awayAbsences),
    certainty:
      bothConfirmed ? 'HIGH' : anyExplicitFalse ? 'LOW' : partialConfirmed ? 'MEDIUM' : 'MEDIUM',
    unresolved: anyExplicitFalse || partialConfirmed,
  };
}

function getStatsBlock(rawData, side) {
  if (side === 'home') {
    return (
      rawData?.stats_home ||
      rawData?.home_stats ||
      rawData?.team_stats?.home ||
      {}
    );
  }
  return (
    rawData?.stats_away ||
    rawData?.away_stats ||
    rawData?.team_stats?.away ||
    {}
  );
}

function deriveStatsLambdas({ oddsSnapshot, rawData }) {
  const homeStats = getStatsBlock(rawData, 'home');
  const awayStats = getStatsBlock(rawData, 'away');
  const leagueTag = deriveLeagueTag(oddsSnapshot);
  const lineup = getLineupContext(rawData);
  const homeCache = getSoccerXgCacheRow({
    league: leagueTag,
    teamName: oddsSnapshot?.home_team,
  });
  const awayCache = getSoccerXgCacheRow({
    league: leagueTag,
    teamName: oddsSnapshot?.away_team,
  });

  const providedHomeLambda = toFiniteNumber(rawData?.lambda_home);
  const providedAwayLambda = toFiniteNumber(rawData?.lambda_away);
  const providedLambdaSource = String(rawData?.lambda_source || '').toLowerCase();
  const providedLambdaLooksMarket =
    providedLambdaSource.includes('market') ||
    providedLambdaSource.includes('moneyline') ||
    providedLambdaSource.includes('spread');

  if (
    Number.isFinite(providedHomeLambda) &&
    Number.isFinite(providedAwayLambda) &&
    !providedLambdaLooksMarket
  ) {
    return {
      lambda_home: clampToRange(providedHomeLambda, 0.25, 4.5),
      lambda_away: clampToRange(providedAwayLambda, 0.25, 4.5),
      stats_completeness: 1,
      lineup,
      notes: ['provided_lambda_input'],
    };
  }

  const homeSeasonXgFor = pickFiniteFromPaths(homeStats, [
    'season_xg_for',
    'xg_for',
    'xg_for_l6',
  ]);
  const homeRecentXgFor = pickFiniteFromPaths(homeStats, [
    'recent_xg_for',
    'xg_for_recent',
    'xg_for_l6',
  ]) ?? toFiniteNumber(homeCache?.home_xg_l6);
  const awaySeasonXgFor = pickFiniteFromPaths(awayStats, [
    'season_xg_for',
    'xg_for',
    'xg_for_l6',
  ]);
  const awayRecentXgFor = pickFiniteFromPaths(awayStats, [
    'recent_xg_for',
    'xg_for_recent',
    'xg_for_l6',
  ]) ?? toFiniteNumber(awayCache?.away_xg_l6);

  const homeSeasonXgAgainst = pickFiniteFromPaths(homeStats, [
    'season_xg_against',
    'xg_against',
    'xga',
    'xga_l6',
  ]);
  const homeRecentXgAgainst = pickFiniteFromPaths(homeStats, [
    'recent_xg_against',
    'xga_recent',
    'xga_l6',
  ]);
  const awaySeasonXgAgainst = pickFiniteFromPaths(awayStats, [
    'season_xg_against',
    'xg_against',
    'xga',
    'xga_l6',
  ]);
  const awayRecentXgAgainst = pickFiniteFromPaths(awayStats, [
    'recent_xg_against',
    'xga_recent',
    'xga_l6',
  ]);

  const homeDefensiveXga = weightedAverage([
    { value: homeSeasonXgAgainst, weight: 0.6 },
    { value: homeRecentXgAgainst, weight: 0.4 },
  ]);
  const awayDefensiveXga = weightedAverage([
    { value: awaySeasonXgAgainst, weight: 0.6 },
    { value: awayRecentXgAgainst, weight: 0.4 },
  ]);

  const homeCore = weightedAverage([
    { value: homeSeasonXgFor, weight: 0.5 },
    { value: homeRecentXgFor, weight: 0.25 },
    { value: awayDefensiveXga, weight: 0.25 },
  ]);
  const awayCore = weightedAverage([
    { value: awaySeasonXgFor, weight: 0.5 },
    { value: awayRecentXgFor, weight: 0.25 },
    { value: homeDefensiveXga, weight: 0.25 },
  ]);

  const homeSotFor = pickFiniteFromPaths(homeStats, ['sot_for', 'shots_on_target_for']);
  const awaySotFor = pickFiniteFromPaths(awayStats, ['sot_for', 'shots_on_target_for']);
  const homeSotAgainst = pickFiniteFromPaths(homeStats, ['sot_against', 'shots_on_target_against']);
  const awaySotAgainst = pickFiniteFromPaths(awayStats, ['sot_against', 'shots_on_target_against']);
  const homeShotNudge =
    Number.isFinite(homeSotFor) && Number.isFinite(awaySotAgainst)
      ? clampToRange((homeSotFor - awaySotAgainst) * 0.03, -0.12, 0.12)
      : 0;
  const awayShotNudge =
    Number.isFinite(awaySotFor) && Number.isFinite(homeSotAgainst)
      ? clampToRange((awaySotFor - homeSotAgainst) * 0.03, -0.12, 0.12)
      : 0;

  const homeHomeEdge = FOOTIE_LEAGUE_HOME_EDGE[leagueTag] || 0;
  const homeAbsencePenalty = clampToRange(lineup.home_absences * 0.05, 0, 0.35);
  const awayAbsencePenalty = clampToRange(lineup.away_absences * 0.05, 0, 0.35);
  const context = rawData?.context || {};
  const motivation = rawData?.motivation_context || {};
  const weather = rawData?.weather_context || {};

  const homeMotivationNudge = clampToRange(
    toFiniteNumber(motivation?.home_delta ?? context?.home_delta ?? 0) || 0,
    -0.15,
    0.15,
  );
  const awayMotivationNudge = clampToRange(
    toFiniteNumber(motivation?.away_delta ?? context?.away_delta ?? 0) || 0,
    -0.15,
    0.15,
  );
  const weatherTotalPenalty = clampToRange(
    toFiniteNumber(weather?.goal_suppression ?? weather?.total_delta ?? 0) || 0,
    -0.25,
    0.25,
  );

  const lambdaHome = Number.isFinite(homeCore)
    ? clampToRange(
        homeCore + homeHomeEdge - homeAbsencePenalty + homeMotivationNudge + homeShotNudge - weatherTotalPenalty,
        0.25,
        4.5,
      )
    : null;
  const lambdaAway = Number.isFinite(awayCore)
    ? clampToRange(
        awayCore - awayAbsencePenalty + awayMotivationNudge + awayShotNudge - weatherTotalPenalty,
        0.25,
        4.5,
      )
    : null;

  const coreSignals = [
    homeSeasonXgFor,
    homeRecentXgFor,
    awayDefensiveXga,
    awaySeasonXgFor,
    awayRecentXgFor,
    homeDefensiveXga,
  ];
  const statsCompleteness =
    coreSignals.filter((value) => Number.isFinite(value)).length / coreSignals.length;

  return {
    lambda_home: Number.isFinite(lambdaHome) ? lambdaHome : null,
    lambda_away: Number.isFinite(lambdaAway) ? lambdaAway : null,
    stats_completeness: statsCompleteness,
    lineup,
    notes: [
      homeCache ? 'xg_cache_home_hit' : 'xg_cache_home_miss',
      awayCache ? 'xg_cache_away_hit' : 'xg_cache_away_miss',
    ],
  };
}

function computeFootieLambdas({ oddsSnapshot, rawData, side, offeredLine }) {
  const stats = deriveStatsLambdas({ oddsSnapshot, rawData });
  const marketFallback = deriveAhLambdaFallback({
    rawData,
    oddsSnapshot,
    side: side || 'HOME',
    offeredLine,
  });

  const hasStatsLambdas =
    Number.isFinite(stats?.lambda_home) && Number.isFinite(stats?.lambda_away);
  const hasMarketFallback =
    Number.isFinite(marketFallback?.lambda_home) &&
    Number.isFinite(marketFallback?.lambda_away);

  const notes = Array.isArray(stats?.notes) ? [...stats.notes] : [];
  if (hasMarketFallback) notes.push('market_anchor_available');

  if (hasStatsLambdas && hasMarketFallback) {
    const lambdaHome = clampToRange(
      stats.lambda_home * FOOTIE_STATS_WEIGHT +
        marketFallback.lambda_home * FOOTIE_MARKET_ANCHOR_WEIGHT,
      0.25,
      4.5,
    );
    const lambdaAway = clampToRange(
      stats.lambda_away * FOOTIE_STATS_WEIGHT +
        marketFallback.lambda_away * FOOTIE_MARKET_ANCHOR_WEIGHT,
      0.25,
      4.5,
    );
    return {
      lambda_home: safeRound(lambdaHome, 4),
      lambda_away: safeRound(lambdaAway, 4),
      lambda_source: FOOTIE_LAMBDA_SOURCE.STATS_MARKET_BLEND,
      lambda_source_quality:
        stats.stats_completeness >= 0.75
          ? FOOTIE_LAMBDA_QUALITY.HIGH
          : FOOTIE_LAMBDA_QUALITY.MEDIUM,
      stats_completeness: safeRound(stats.stats_completeness, 4),
      lineup: stats.lineup,
      notes,
    };
  }

  if (hasStatsLambdas) {
    return {
      lambda_home: safeRound(stats.lambda_home, 4),
      lambda_away: safeRound(stats.lambda_away, 4),
      lambda_source: FOOTIE_LAMBDA_SOURCE.STATS_PRIMARY,
      lambda_source_quality:
        stats.stats_completeness >= 0.75
          ? FOOTIE_LAMBDA_QUALITY.HIGH
          : stats.stats_completeness >= 0.5
            ? FOOTIE_LAMBDA_QUALITY.MEDIUM
            : FOOTIE_LAMBDA_QUALITY.LOW,
      stats_completeness: safeRound(stats.stats_completeness, 4),
      lineup: stats.lineup,
      notes,
    };
  }

  if (hasMarketFallback) {
    notes.push('fallback_only');
    return {
      lambda_home: safeRound(marketFallback.lambda_home, 4),
      lambda_away: safeRound(marketFallback.lambda_away, 4),
      lambda_source: FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK,
      lambda_source_quality: FOOTIE_LAMBDA_QUALITY.LOW,
      stats_completeness: safeRound(stats?.stats_completeness || 0, 4),
      lineup: stats?.lineup || getLineupContext(rawData),
      notes,
    };
  }

  notes.push('missing_all_lambda_inputs');
  return {
    lambda_home: null,
    lambda_away: null,
    lambda_source: null,
    lambda_source_quality: FOOTIE_LAMBDA_QUALITY.LOW,
    stats_completeness: safeRound(stats?.stats_completeness || 0, 4),
    lineup: stats?.lineup || getLineupContext(rawData),
    notes,
  };
}

function computeFootieMlProbabilities({ lambdaHome, lambdaAway }) {
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) {
    return null;
  }

  // Lambdas already include league/context adjustments upstream.
  // Keep xg-model home adjustment neutral here to avoid double-counting home edge.
  const probabilities = computeXgWinProbs({
    homeXg: lambdaHome,
    awayXg: lambdaAway,
    league: 'UNKNOWN',
    maxGoals: FOOTIE_MAX_GOALS,
  });

  const pHome = clampProbability(probabilities?.homeWin);
  const pDraw = clampProbability(probabilities?.draw);
  const pAway = clampProbability(probabilities?.awayWin);
  if (!Number.isFinite(pHome) || !Number.isFinite(pDraw) || !Number.isFinite(pAway)) {
    return null;
  }

  const total = pHome + pDraw + pAway;
  if (total <= 0) return null;
  return {
    p_home_win: safeRound(pHome / total, 6),
    p_draw: safeRound(pDraw / total, 6),
    p_away_win: safeRound(pAway / total, 6),
  };
}

function deriveSideConfidence({
  modelProb,
  lambdaSource,
  lambdaSourceQuality,
  statsCompleteness,
  lineupCertainty,
  sideMarketGap,
}) {
  if (!Number.isFinite(modelProb)) return null;

  let confidence = 0.52 + Math.abs(modelProb - 0.5) * 0.65;
  if (lambdaSourceQuality === FOOTIE_LAMBDA_QUALITY.HIGH) confidence += 0.08;
  if (lambdaSourceQuality === FOOTIE_LAMBDA_QUALITY.MEDIUM) confidence += 0.04;

  if (Number.isFinite(statsCompleteness)) {
    confidence += clampToRange((statsCompleteness - 0.5) * 0.14, -0.06, 0.06);
  }

  if (lineupCertainty === 'HIGH') confidence += 0.03;
  if (lineupCertainty === 'LOW') confidence -= 0.04;

  if (lambdaSource === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK) {
    confidence -= 0.12;
  }
  if (Number.isFinite(sideMarketGap) && sideMarketGap > 0.12) {
    confidence -= clampToRange((sideMarketGap - 0.12) * 0.4, 0, 0.08);
  }

  return safeRound(clampToRange(confidence, 0.5, 0.86), 4);
}

function applySideRiskGuards({
  marketType,
  edge,
  tier,
  lambdaSource,
  lineup,
  drawProbability,
  modelSide,
  marketSide,
}) {
  const reasonCodes = [];
  let passReason = null;
  let guardedTier = tier;

  if (!Number.isFinite(edge) || edge <= 0) {
    passReason = FOOTIE_REASON_CODES.MISSING_EDGE;
    reasonCodes.push(FOOTIE_REASON_CODES.MISSING_EDGE);
  }

  if (lambdaSource === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK) {
    // Fallback-only lambdas remain a hard block for moneyline,
    // but side/spread markets can still surface with explicit diagnostics.
    if (marketType === 'MONEYLINE') {
      passReason = FOOTIE_REASON_CODES.MARKET_FALLBACK_ONLY;
      reasonCodes.push(FOOTIE_REASON_CODES.MARKET_FALLBACK_ONLY);
      guardedTier = null;
    } else if (!passReason) {
      guardedTier = guardedTier === 'SUPER' || guardedTier === 'BEST' ? 'WATCH' : guardedTier;
    }
  }

  if (lineup?.unresolved) {
    reasonCodes.push(FOOTIE_REASON_CODES.LINEUP_UNCONFIRMED);
    if (!passReason) {
      guardedTier = guardedTier === 'SUPER' || guardedTier === 'BEST' ? 'WATCH' : guardedTier;
    }
  }

  if (marketType === 'MONEYLINE' && Number.isFinite(drawProbability)) {
    if (drawProbability >= 0.31 && (!Number.isFinite(edge) || edge < 0.05)) {
      passReason = FOOTIE_REASON_CODES.DRAW_RISK_HIGH;
      reasonCodes.push(FOOTIE_REASON_CODES.DRAW_RISK_HIGH);
    }
  }

  if (modelSide && marketSide && modelSide !== marketSide) {
    reasonCodes.push(FOOTIE_REASON_CODES.CONTRADICTORY_SIGNAL);
    if (!passReason) {
      guardedTier = guardedTier === 'SUPER' || guardedTier === 'BEST' ? 'WATCH' : guardedTier;
    }
  }

  return {
    tier: guardedTier,
    pass_reason: passReason,
    reason_codes: Array.from(new Set(reasonCodes)),
  };
}

function clampToRange(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function deriveTierFromEdge(edge) {
  if (!Number.isFinite(edge) || edge <= 0) return null;
  if (edge >= 0.06) return 'SUPER';
  if (edge >= 0.03) return 'BEST';
  return 'WATCH';
}

function deriveConfidenceFromModelProb(modelProb, options = {}) {
  if (!Number.isFinite(modelProb)) return null;
  const centeredDistance = Math.abs(modelProb - 0.5);
  let confidence = clampToRange(0.55 + centeredDistance * 0.6, 0.55, 0.82);
  if (options.lambdaSource === FOOTIE_LAMBDA_SOURCE.MARKET_FALLBACK) {
    confidence = Math.min(confidence, 0.62);
  }
  return Number(confidence.toFixed(4));
}

function resolveHomeHandicapLine({ rawData, oddsSnapshot, side, offeredLine }) {
  const explicitHomeLine = toFiniteNumber(
    rawData?.ah_home_line ?? rawData?.spread_home,
  );
  if (Number.isFinite(explicitHomeLine)) return explicitHomeLine;

  const snapshotHomeLine = toFiniteNumber(oddsSnapshot?.spread_home);
  if (Number.isFinite(snapshotHomeLine)) return snapshotHomeLine;

  const snapshotAwayLine = toFiniteNumber(oddsSnapshot?.spread_away);
  if (Number.isFinite(snapshotAwayLine)) return -snapshotAwayLine;

  if (Number.isFinite(offeredLine)) {
    return side === 'HOME' ? offeredLine : -offeredLine;
  }

  return null;
}

function deriveAhLambdaFallback({ rawData, oddsSnapshot, side, offeredLine }) {
  const totalLine = toFiniteNumber(
    rawData?.total_line ?? rawData?.game_total ?? rawData?.expected_total_goals,
  );
  const snapshotTotal = toFiniteNumber(oddsSnapshot?.total);
  const totalGoals = clampToRange(
    totalLine ?? snapshotTotal ?? FOOTIE_DEFAULT_TOTAL_GOALS,
    1.4,
    5.2,
  );

  const winProbHome = deriveWinProbHome(
    oddsSnapshot?.h2h_home,
    oddsSnapshot?.h2h_away,
  );
  const hasMoneylineSignal = Number.isFinite(winProbHome);
  const mlDiff =
    hasMoneylineSignal && winProbHome > 0 && winProbHome < 1
      ? clampToRange(Math.log(winProbHome / (1 - winProbHome)) * 0.85, -1.8, 1.8)
      : null;

  const homeHandicapLine = resolveHomeHandicapLine({
    rawData,
    oddsSnapshot,
    side,
    offeredLine,
  });
  const hasSpreadSignal = Number.isFinite(homeHandicapLine);
  const spreadDiff = hasSpreadSignal
    ? clampToRange(-homeHandicapLine * 0.9, -1.8, 1.8)
    : null;
  const hasTotalSignal = Number.isFinite(totalLine) || Number.isFinite(snapshotTotal);
  if (!hasSpreadSignal && !hasMoneylineSignal && !hasTotalSignal) {
    return null;
  }

  let expectedDiff = 0;
  if (Number.isFinite(spreadDiff) && Number.isFinite(mlDiff)) {
    expectedDiff = spreadDiff * 0.7 + mlDiff * 0.3;
  } else if (Number.isFinite(spreadDiff)) {
    expectedDiff = spreadDiff;
  } else if (Number.isFinite(mlDiff)) {
    expectedDiff = mlDiff;
  }

  const maxAbsDiff = Math.max(0.15, totalGoals - 0.15);
  expectedDiff = clampToRange(expectedDiff, -maxAbsDiff, maxAbsDiff);

  const lambdaHome = Number(((totalGoals + expectedDiff) / 2).toFixed(4));
  const lambdaAway = Number((totalGoals - lambdaHome).toFixed(4));
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return null;
  if (lambdaHome <= 0 || lambdaAway <= 0) return null;

  const sourceParts = [];
  if (hasSpreadSignal) sourceParts.push('spread_line');
  if (hasMoneylineSignal) sourceParts.push('moneyline');
  if (hasTotalSignal) {
    sourceParts.push('total_line');
  } else {
    sourceParts.push('default_total');
  }

  return {
    lambda_home: lambdaHome,
    lambda_away: lambdaAway,
    source: `derived_${sourceParts.join('_')}`,
  };
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

function buildDeterministicSoccerPlayerId({ gameId, playerName }) {
  const normalizedName = String(playerName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const digest = nodeCrypto
    .createHash('sha256')
    .update(`SOCCER|${String(gameId || '').trim()}|${normalizedName}`)
    .digest('hex');
  return `soccer-${digest.slice(0, 16)}`;
}

function getPreferredPriceAndSelection(propLineRow) {
  const overPrice = Number.isFinite(propLineRow?.over_price)
    ? Math.trunc(propLineRow.over_price)
    : null;
  const underPrice = Number.isFinite(propLineRow?.under_price)
    ? Math.trunc(propLineRow.under_price)
    : null;

  if (overPrice !== null) {
    return { price: overPrice, selectionSide: 'OVER' };
  }
  if (underPrice !== null) {
    return { price: underPrice, selectionSide: 'UNDER' };
  }
  return { price: null, selectionSide: null };
}

function isTier1PriceCapValid(canonicalMarket, price) {
  if (!Number.isFinite(price)) return false;
  if (canonicalMarket === 'player_shots') return price >= -150;
  if (canonicalMarket === 'to_score_or_assist') return price >= -140;
  return true;
}

function isReasonableSoccerTier1Line(canonicalMarket, line) {
  if (!Number.isFinite(line)) return false;
  if (canonicalMarket === 'player_shots') {
    return line >= SOCCER_PLAYER_SHOTS_MIN_LINE && line <= SOCCER_PLAYER_SHOTS_MAX_LINE;
  }
  if (canonicalMarket === 'to_score_or_assist') {
    return line === 0.5;
  }
  return true;
}

function estimateSoccerPropPriorityScore(card) {
  const price = Number.isFinite(card?.payloadData?.price) ? card.payloadData.price : null;
  const line = Number.isFinite(card?.payloadData?.line) ? card.payloadData.line : null;
  const impliedProb = price !== null ? toImpliedProbability(price) : 0;
  const linePenalty = line !== null ? line * 0.01 : 0;
  return impliedProb - linePenalty;
}

function buildSoccerTier1CardFromPropLine(gameId, oddsSnapshot, propLineRow) {
  const canonicalMarket = String(propLineRow?.prop_type || '')
    .trim()
    .toLowerCase();
  // ADR-0006 contract guard: Asian Handicap must remain a FOOTIE_MAIN_MARKETS
  // side market and can never be emitted through the player-prop path.
  if (SOCCER_AH_MARKETS.has(canonicalMarket)) {
    return null;
  }
  if (!SOCCER_TIER1_PROP_TYPES.includes(canonicalMarket)) {
    return null;
  }

  const playerName = String(propLineRow?.player_name || '').trim();
  if (!playerName) {
    return null;
  }

  if (isBlockedSoccerPropPlayer(playerName)) {
    return null;
  }

  const line = Number.isFinite(propLineRow?.line) ? propLineRow.line : null;
  if (line === null) {
    return null;
  }

  if (!isReasonableSoccerTier1Line(canonicalMarket, line)) {
    return null;
  }

  const { price, selectionSide } = getPreferredPriceAndSelection(propLineRow);
  if (price === null || !selectionSide) {
    return null;
  }

  if (!isTier1PriceCapValid(canonicalMarket, price)) {
    return null;
  }

  const impliedProbability = toImpliedProbability(price);
  const nowIso = new Date().toISOString();
  const cardId = `card-soccer-tier1-prop-${gameId}-${canonicalMarket}-${buildDeterministicSoccerPlayerId({ gameId, playerName }).slice(-8)}-${uuidV4().slice(0, 6)}`;
  const payloadData = {
    canonical_market_key: canonicalMarket,
    market_family: 'tier1',
    kind: 'PLAY',
    market_type: 'PROP',
    sport: 'SOCCER',
    game_id: gameId,
    home_team: oddsSnapshot?.home_team || null,
    away_team: oddsSnapshot?.away_team || null,
    matchup:
      oddsSnapshot?.home_team && oddsSnapshot?.away_team
        ? `${oddsSnapshot.home_team} vs ${oddsSnapshot.away_team}`
        : null,
    start_time_utc: oddsSnapshot?.game_time_utc ?? null,
    generated_at: nowIso,
    missing_context_flags: [],
    pass_reason: null,
    projection_basis: 'market_line_observed',
    model_confidence: null,
    edge_ev:
      impliedProbability !== null
        ? 0.0001
        : null,
    price,
    line,
    selection: {
      side: selectionSide,
      team: playerName,
    },
    player_name: playerName,
    player_id: buildDeterministicSoccerPlayerId({ gameId, playerName }),
    team_abbr: null,
    projection_context: {
      source: 'player_prop_lines',
      available: true,
      missing_fields: [],
    },
  };

  return {
    id: cardId,
    gameId,
    sport: 'SOCCER',
    cardType: 'soccer',
    cardTitle: `Soccer Tier1: ${canonicalMarket}`,
    createdAt: nowIso,
    expiresAt: null,
    payloadData,
    modelOutputIds: null,
  };
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
    model_confidence: null,
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

      console.log(`[SoccerModel] Track 1 (odds-backed): ${oddsSnapshots.length} odds snapshots found`);

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
        `[SoccerModel] Track 1: running inference on ${gameIds.length} games...`,
      );
      const soccerModelMode = resolveSoccerModelMode();
      console.log(`[SoccerModel] Mode: ${soccerModelMode}`);

      let cardsGenerated = 0;
      let track1Cards = 0;

      // TRACK 1: Process each odds-backed game (may be 0 iterations — no bail-out)
      const ODDS_BACKED_CARD_TYPES = new Set([...FOOTIE_MAIN_MARKETS]);
      const PROJECTION_MARKET_TYPES = new Set([
        'player_shots', 'team_totals', 'to_score_or_assist',
        'player_shots_on_target', 'anytime_goalscorer', 'team_corners',
      ]);

      for (const gameId of gameIds) {
        try {
          const oddsSnapshot = gameOdds[gameId];

          // Ensure stale projection/prop cards from prior runs do not linger.
          // This keeps player-prop output aligned to current ingest snapshot.
          deleteCardPayloadsForGame(gameId, 'soccer');

          const propRows = getPlayerPropLinesForGame(
            'SOCCER',
            gameId,
            SOCCER_TIER1_PROP_TYPES,
          );

          const propCards = [];
          for (const propRow of propRows) {
            try {
              const propCard = buildSoccerTier1CardFromPropLine(
                gameId,
                oddsSnapshot,
                propRow,
              );
              if (!propCard) continue;

              const propValidation = validateCardPayload(
                propCard.cardType,
                propCard.payloadData,
              );
              if (!propValidation.success) {
                continue;
              }

              propCards.push(propCard);
            } catch (propCardError) {
              console.error(
                `  [error] Track1 ${gameId} [prop-line]: ${propCardError.message}`,
              );
            }
          }

          const prioritizedPropCards = propCards
            .sort((left, right) => {
              return estimateSoccerPropPriorityScore(right) - estimateSoccerPropPriorityScore(left);
            })
            .slice(0, SOCCER_TIER1_PROP_MAX_CARDS_PER_GAME);

          if (propCards.length > prioritizedPropCards.length) {
            console.log(
              `  [info] Track1 ${gameId} trimmed soccer tier1 props ${propCards.length} -> ${prioritizedPropCards.length}`,
            );
          }

          for (const propCard of prioritizedPropCards) {
            applySoccerDecisionBasisMeta(propCard.payloadData, {
              isProjectionOnly: false,
              marketLineSource: 'odds_api',
            });
            publishDecisionForCard({ card: propCard, oddsSnapshot });
            applyUiActionFields(propCard.payloadData);
            attachRunId(propCard, jobRunId);
            insertCardPayload(propCard);
            cardsGenerated++;
            track1Cards++;
            console.log(
              `  [ok] Track1 ${gameId} [${propCard.payloadData.canonical_market_key}] ${propCard.payloadData.player_name}`,
            );
          }

          const rawData = parseRawData(oddsSnapshot?.raw_data) || {};
          // Check both raw_data.market (odds API market key) and raw_data.soccer_market (projection key)
          const rawMarket = rawData.market ?? rawData.soccer_market ?? null;
          const canonicalMarket = rawMarket
            ? normalizeToCanonicalSoccerMarket(rawMarket)
            : null;

          const hasSpreadInputs =
            Number.isFinite(oddsSnapshot?.spread_home) &&
            Number.isFinite(oddsSnapshot?.spread_away) &&
            Number.isFinite(oddsSnapshot?.spread_price_home) &&
            Number.isFinite(oddsSnapshot?.spread_price_away);

          if (
            soccerModelMode === 'SIDES_AND_PROPS' &&
            hasSpreadInputs &&
            canonicalMarket !== 'asian_handicap_home' &&
            canonicalMarket !== 'asian_handicap_away'
          ) {
            for (const ahMarket of ['asian_handicap_home', 'asian_handicap_away']) {
              const ahCard = buildSoccerSideMarketCard(gameId, oddsSnapshot, ahMarket);
              const ahValidation = validateCardPayload(ahCard.cardType, ahCard.payloadData);
              if (!ahValidation.success) {
                throw new Error(
                  `Invalid card payload for ${ahCard.cardType}: ${ahValidation.errors.join('; ')}`,
                );
              }
              applySoccerDecisionBasisMeta(ahCard.payloadData, {
                isProjectionOnly: false,
                canonicalMarketKey: ahCard.payloadData.canonical_market_key,
                marketLineSource: 'odds_api',
              });
              publishDecisionForCard({ card: ahCard, oddsSnapshot });
              applyUiActionFields(ahCard.payloadData);
              attachRunId(ahCard, jobRunId);
              insertCardPayload(ahCard);
              cardsGenerated++;
              track1Cards++;
              console.log(
                `  [ok] Track1 ${gameId} [${ahCard.cardType}] ${String(ahCard.payloadData.line)}`,
              );
            }
          }

          let card;
          if (canonicalMarket && ODDS_BACKED_CARD_TYPES.has(canonicalMarket)) {
            if (!shouldEmitOddsBackedCard(soccerModelMode, canonicalMarket)) {
              console.log(
                `  [skip] Track1 ${gameId} [${canonicalMarket}] gated by mode=${soccerModelMode}`,
              );
              continue;
            }
            card = isSoccerSideMarket(canonicalMarket)
              ? buildSoccerSideMarketCard(gameId, oddsSnapshot, canonicalMarket)
              : buildSoccerOddsBackedCard(gameId, oddsSnapshot, canonicalMarket);
          } else if (canonicalMarket && PROJECTION_MARKET_TYPES.has(canonicalMarket)) {
            if (TIER1_PLAYER_MARKETS.has(canonicalMarket)) {
              card =
                soccerModelMode === 'OHIO_PROPS_ONLY'
                  ? null
                  : generateSoccerCard(gameId, oddsSnapshot);
            } else {
            // Projection-only player markets found in odds snapshot raw_data
            const tier1Result = buildSoccerTier1Payload(gameId, oddsSnapshot, canonicalMarket);
            const cardId = `card-soccer-scope-${gameId}-${uuidV4().slice(0, 8)}`;
            card = {
              id: cardId,
              gameId,
              sport: 'SOCCER',
              cardType: tier1Result.cardType,
              cardTitle: `Soccer Tier1: ${canonicalMarket}`,
              createdAt: tier1Result.payloadData.generated_at,
              expiresAt: null,
              payloadData: tier1Result.payloadData,
              modelOutputIds: null,
            };
            }
          } else {
            // Fallback moneyline card is only emitted in sides-enabled mode.
            card =
              soccerModelMode === 'OHIO_PROPS_ONLY'
                ? null
                : generateSoccerCard(gameId, oddsSnapshot);
          }

          if (!card) {
            continue;
          }

          const validation = validateCardPayload(card.cardType, card.payloadData);
          if (!validation.success) {
            throw new Error(
              `Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`,
            );
          }

          applySoccerDecisionBasisMeta(card.payloadData, {
            isProjectionOnly: false,
            canonicalMarketKey: card.payloadData.canonical_market_key,
            marketLineSource: 'odds_api',
          });

          publishDecisionForCard({ card, oddsSnapshot });
          applyUiActionFields(card.payloadData);
          attachRunId(card, jobRunId);
          insertCardPayload(card);
          cardsGenerated++;
          track1Cards++;
          const logDetail = card.payloadData.prediction
            ? `${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`
            : card.cardType;
          console.log(`  [ok] Track1 ${gameId} [${card.cardType}]: ${logDetail}`);
        } catch (gameError) {
          console.error(`  [error] Track1 ${gameId}: ${gameError.message}`);
        }
      }

      // TRACK 2: Projection-only — runs unconditionally regardless of odds availability
      console.log('[SoccerModel] Track 2 (projection-only): fetching upcoming games...');
      let upcomingGames = [];
      try {
        const dataExports = require('@cheddar-logic/data');
        if (typeof dataExports.getUpcomingGames === 'function') {
          upcomingGames = dataExports.getUpcomingGames({ startUtcIso: nowUtc.toISO(), endUtcIso: horizonUtc, sports: ['SOCCER'] });
        } else {
          // Fallback: use game IDs already seen in Track 1
          upcomingGames = Object.values(gameOdds);
          console.log('[SoccerModel] Track 2: getUpcomingGames not available, using Track 1 game IDs');
        }
      } catch (e) {
        console.warn('[SoccerModel] Track 2: could not fetch upcoming games:', e.message);
      }

      let track2Cards = 0;
      const TRACK2_PROJECTION_MARKETS = ['to_score_or_assist', 'player_shots', 'team_totals'];

      for (const gameOrSnap of upcomingGames) {
        const gameId = gameOrSnap.game_id || gameOrSnap.id;
        if (!gameId) continue;

        for (const market of TRACK2_PROJECTION_MARKETS) {
          try {
            const tier1Result = buildSoccerTier1Payload(gameId, gameOrSnap, market);
            // Mark as projection-only
            tier1Result.payloadData.projection_only = true;
            applySoccerDecisionBasisMeta(tier1Result.payloadData, {
              isProjectionOnly: true,
              canonicalMarketKey: market,
              marketLineSource: 'synthetic',
            });

            const cardId = `card-soccer-proj-${gameId}-${market}-${uuidV4().slice(0, 8)}`;
            const card = {
              id: cardId,
              gameId,
              sport: 'SOCCER',
              cardType: tier1Result.cardType,
              cardTitle: `Soccer Projection: ${market}`,
              createdAt: tier1Result.payloadData.generated_at,
              expiresAt: null,
              payloadData: tier1Result.payloadData,
              modelOutputIds: null,
            };

            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(
                `Invalid Track 2 card payload for ${market}: ${validation.errors.join('; ')}`,
              );
            }

            attachRunId(card, jobRunId);
            insertCardPayload(card);
            try {
              recordSoccerProjectionTelemetry(
                recordProjectionEntry,
                card,
                tier1Result.payloadData,
              );
            } catch (telemetryErr) {
              console.warn(
                `  [warn] Track2 ${gameId} [${market}] telemetry skipped: ${telemetryErr.message}`,
              );
            }
            cardsGenerated++;
            track2Cards++;
            console.log(`  [ok] Track2 ${gameId} [${market}]: projection_only`);
          } catch (projError) {
            console.error(`  [error] Track2 ${gameId} [${market}]: ${projError.message}`);
          }
        }
      }

      // Mark job as success
      console.log(
        `[SoccerModel] Complete: ${cardsGenerated} cards generated (track1=${track1Cards}, track2=${track2Cards})`,
      );
      markJobRunSuccess(jobRunId);
      try {
        setCurrentRunId(jobRunId, 'soccer');
      } catch (runStateError) {
        console.error(
          `[SoccerModel] Failed to update run state: ${runStateError.message}`,
        );
      }

      return { success: true, jobRunId, cardsGenerated, track1Cards, track2Cards };
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
  gradeAsianHandicap,
  priceAsianHandicap,
  resolveSoccerModelMode,
  shouldEmitOddsBackedCard,
  isSoccerSideMarket,
  normalizeToCanonicalSoccerMarket,
  computeFootieLambdas,
  computeFootieMlProbabilities,
  buildSoccerTier1Payload,
  buildSoccerOddsBackedCard,
  buildSoccerSideMarketCard,
  buildDeterministicSoccerPlayerId,
  buildSoccerTier1CardFromPropLine,
  isBlockedSoccerPropPlayer,
};
