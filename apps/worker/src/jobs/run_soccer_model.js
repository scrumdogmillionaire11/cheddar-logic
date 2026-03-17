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
// Ohio soccer market scope constants
// ============================================================================
const OHIO_TIER1_MARKETS = new Set([
  'player_shots',
  'team_totals',
  'to_score_or_assist',
]);
const OHIO_ODDS_BACKED_MARKETS = new Set([
  'soccer_ml',
  'soccer_game_total',
  'soccer_double_chance',
]);
const OHIO_TIER2_MARKETS = new Set([
  'player_shots_on_target',
  'anytime_goalscorer',
  'team_corners',
]);
const OHIO_BANNED_MARKETS = new Set([
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

/**
 * Normalize a raw market key string to its canonical Ohio soccer market key.
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
    OHIO_TIER1_MARKETS.has(normalized) ||
    OHIO_ODDS_BACKED_MARKETS.has(normalized) ||
    OHIO_TIER2_MARKETS.has(normalized)
  ) {
    return normalized;
  }

  if (OHIO_BANNED_MARKETS.has(normalized)) {
    console.debug(
      `[SoccerModel] normalizeToCanonicalSoccerMarket: blocked banned market "${normalized}"`,
    );
    return null;
  }

  console.debug(
    `[SoccerModel] normalizeToCanonicalSoccerMarket: "${normalized}" is out of Ohio scope`,
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
 * @param {string} canonicalMarket - canonical Ohio market key
 * @returns {{ cardType: string, payloadData: object, pass_reason: string|null }}
 */
function buildSoccerTier1Payload(gameId, oddsSnapshot, canonicalMarket) {
  const now = new Date().toISOString();
  const rawData = parseRawData(oddsSnapshot?.raw_data) || {};
  const missing_context_flags = [];
  let pass_reason = null;

  const marketFamily = OHIO_TIER1_MARKETS.has(canonicalMarket)
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
    cardType: 'soccer-ohio-scope',
    payloadData,
    pass_reason,
  };
}

/**
 * Build an odds-backed soccer card for one of the three new card types:
 * soccer_ml, soccer_game_total, or soccer_double_chance.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {string} canonicalCardType - 'soccer_ml' | 'soccer_game_total' | 'soccer_double_chance'
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
    const { prediction, price: derivedPrice } = derivePredictionFromMoneyline(
      oddsSnapshot?.h2h_home,
      oddsSnapshot?.h2h_away,
    );
    const selectionTeam = prediction === 'HOME' ? homeTeam : awayTeam;
    const price = typeof derivedPrice === 'number' && Number.isFinite(derivedPrice)
      ? Math.trunc(derivedPrice)
      : null;

    if (!Number.isFinite(oddsSnapshot?.h2h_home)) missing_context_flags.push('h2h_home');
    if (!Number.isFinite(oddsSnapshot?.h2h_away)) missing_context_flags.push('h2h_away');

    payloadData = {
      sport: 'SOCCER',
      game_id: gameId,
      market_type: 'MONEYLINE',
      home_team: homeTeam,
      away_team: awayTeam,
      matchup: buildMatchup(homeTeam, awayTeam),
      start_time_utc: oddsSnapshot?.game_time_utc ?? null,
      generated_at: now,
      selection: { side: prediction, team: selectionTeam },
      price,
      edge_basis: 'vig_normalized_moneyline',
      missing_context_flags,
      pass_reason: null,
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
      outcome,
      price: typeof dcPrice === 'number' ? Math.trunc(dcPrice) : null,
      edge_basis: edgeBasis,
      missing_context_flags,
      pass_reason: null,
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
const {
  applySoccerDecisionBasisMeta,
  recordSoccerProjectionTelemetry,
} = require('../utils/soccer-patch');

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
  const canonicalMarket = String(propLineRow?.prop_type || '').trim();
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
    cardType: 'soccer-ohio-scope',
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

      let cardsGenerated = 0;
      let track1Cards = 0;

      // TRACK 1: Process each odds-backed game (may be 0 iterations — no bail-out)
      const ODDS_BACKED_CARD_TYPES = new Set(['soccer_ml', 'soccer_game_total', 'soccer_double_chance']);
      const PROJECTION_MARKET_TYPES = new Set([
        'player_shots', 'team_totals', 'to_score_or_assist',
        'player_shots_on_target', 'anytime_goalscorer', 'team_corners',
      ]);

      for (const gameId of gameIds) {
        try {
          const oddsSnapshot = gameOdds[gameId];

          // Ensure stale projection/prop cards from prior runs do not linger.
          // This keeps player-prop output aligned to current ingest snapshot.
          deleteCardPayloadsForGame(gameId, 'soccer-ohio-scope');

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

          let card;
          if (canonicalMarket && ODDS_BACKED_CARD_TYPES.has(canonicalMarket)) {
            // New odds-backed card types
            card = buildSoccerOddsBackedCard(gameId, oddsSnapshot, canonicalMarket);
          } else if (canonicalMarket && PROJECTION_MARKET_TYPES.has(canonicalMarket)) {
            if (TIER1_PLAYER_MARKETS.has(canonicalMarket)) {
              card = generateSoccerCard(gameId, oddsSnapshot);
            } else {
            // Projection-only player markets found in odds snapshot raw_data
            const tier1Result = buildSoccerTier1Payload(gameId, oddsSnapshot, canonicalMarket);
            const cardId = `card-soccer-ohio-${gameId}-${uuidV4().slice(0, 8)}`;
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
            // Fallback to legacy soccer-model-output moneyline card
            card = generateSoccerCard(gameId, oddsSnapshot);
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
  normalizeToCanonicalSoccerMarket,
  buildSoccerTier1Payload,
  buildSoccerOddsBackedCard,
  buildDeterministicSoccerPlayerId,
  buildSoccerTier1CardFromPropLine,
  isBlockedSoccerPropPlayer,
};
