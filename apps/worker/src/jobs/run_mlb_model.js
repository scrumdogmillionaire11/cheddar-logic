/**
 * MLB Model Runner Job
 *
 * Reads latest MLB odds from DB, runs inference model, and stores:
 * - model_outputs (predictions + confidence)
 * - card_payloads (ready-to-render web cards)
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_mlb_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-mlb-model)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

// Import cheddar-logic data layer
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsSnapshots,
  getOddsWithUpcomingGames,
  getUpcomingGamesAsSyntheticSnapshots,
  getLatestOdds,
  insertModelOutput,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

// Import pluggable inference layer
const { getModel, computeMLBDriverCards, computePitcherKDriverCards } = require('../models');
const { selectMlbGameMarket, projectF5ML } = require('../models/mlb-model');

// WI-0648: Empirical sigma recalibration gate
// Threshold: once a team has accumulated >= MIN_MLB_GAMES_FOR_RECAL settled games
// in the 2026 season, computeSigmaFromHistory replaces MLB_SIGMA_DEFAULT constants.
const edgeCalculator = require('@cheddar-logic/models/src/edge-calculator');
const MIN_MLB_GAMES_FOR_RECAL = parseInt(process.env.MIN_MLB_GAMES_FOR_RECAL || '20', 10);

// Pitcher K model mode: 'PROJECTION_ONLY' enables the Sharp Cheddar K pipeline
// without requiring market odds. Set PITCHER_KS_MODEL_MODE=PROJECTION_ONLY.
const PITCHER_KS_MODEL_MODE = process.env.PITCHER_KS_MODEL_MODE || null;
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  buildPipelineState,
  WATCHDOG_REASONS,
  PRICE_REASONS,
} = require('@cheddar-logic/models');

// MLB-specific watchdog vocabulary stays local to this runner so WI-0604 can
// document the new codes without widening shared registries.
const MLB_PIPELINE_REASON_CODES = Object.freeze({
  F5_TOTAL_UNAVAILABLE: 'F5_TOTAL_UNAVAILABLE',
  F5_ML_UNAVAILABLE: 'F5_ML_UNAVAILABLE',
});

const MLB_TEAM_ABBREVIATIONS = Object.freeze({
  'Arizona Diamondbacks': 'AZ',
  'Athletics': 'ATH',
  'Atlanta Braves': 'ATL',
  'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS',
  'Chicago Cubs': 'CHC',
  'Chicago White Sox': 'CWS',
  'Cincinnati Reds': 'CIN',
  'Cleveland Guardians': 'CLE',
  'Colorado Rockies': 'COL',
  'Detroit Tigers': 'DET',
  'Houston Astros': 'HOU',
  'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA',
  'Los Angeles Dodgers': 'LAD',
  'Miami Marlins': 'MIA',
  'Milwaukee Brewers': 'MIL',
  'Minnesota Twins': 'MIN',
  'New York Mets': 'NYM',
  'New York Yankees': 'NYY',
  'Philadelphia Phillies': 'PHI',
  'Pittsburgh Pirates': 'PIT',
  'San Diego Padres': 'SD',
  'San Francisco Giants': 'SF',
  'Seattle Mariners': 'SEA',
  'St. Louis Cardinals': 'STL',
  'Tampa Bay Rays': 'TB',
  'Texas Rangers': 'TEX',
  'Toronto Blue Jays': 'TOR',
  'Washington Nationals': 'WSH',
});

const MLB_PROP_BOOKMAKER_PRIORITY = Object.freeze({
  draftkings: 1,
  fanduel: 2,
  betmgm: 3,
});

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickFirstFinite(...values) {
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function uniqueReasonCodes(codes = []) {
  return Array.from(
    new Set(
      (Array.isArray(codes) ? codes : [codes]).filter(
        (code) => typeof code === 'string' && code.length > 0,
      ),
    ),
  );
}

function resolveMlbTeamLookupKeys(teamName) {
  if (!teamName || typeof teamName !== 'string') return [];
  const cleaned = teamName.trim();
  if (!cleaned) return [];
  // Case-insensitive lookup: games table stores names in ALL CAPS (e.g. "NEW YORK METS")
  const cleanedLower = cleaned.toLowerCase();
  const matchedKey = Object.keys(MLB_TEAM_ABBREVIATIONS).find(
    (k) => k.toLowerCase() === cleanedLower,
  );
  const abbreviation = matchedKey ? MLB_TEAM_ABBREVIATIONS[matchedKey] : null;
  return abbreviation ? [cleaned, abbreviation] : [cleaned];
}

function parseMlbRawData(oddsSnapshot) {
  try {
    if (typeof oddsSnapshot?.raw_data === 'string') {
      const parsed = JSON.parse(oddsSnapshot.raw_data);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    if (oddsSnapshot?.raw_data && typeof oddsSnapshot.raw_data === 'object') {
      return oddsSnapshot.raw_data;
    }
  } catch (_error) {
    return {};
  }
  return {};
}

function getMarketEntry(rawData, keys) {
  for (const key of keys) {
    const value = rawData?.[key];
    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }
    if (value && typeof value === 'object') {
      return value;
    }
  }
  return null;
}

function resolveMlbF5TotalContext(oddsSnapshot) {
  const rawData = parseMlbRawData(oddsSnapshot);
  const mlb = rawData?.mlb && typeof rawData.mlb === 'object' ? rawData.mlb : {};
  const rawEntry = getMarketEntry(rawData, [
    'totals_f5',
    'f5_totals',
    'total_f5',
    'first_5_totals',
    'totals_first_5',
  ]);

  const line = pickFirstFinite(
    oddsSnapshot?.total_f5,
    oddsSnapshot?.f5_total,
    mlb?.f5_line,
    mlb?.total_f5,
    rawEntry?.line,
    rawEntry?.total,
    rawEntry?.f5_line,
  );
  const overPrice = pickFirstFinite(
    oddsSnapshot?.total_price_over_f5,
    oddsSnapshot?.total_f5_price_over,
    mlb?.total_price_over_f5,
    mlb?.total_f5_price_over,
    rawEntry?.over,
    rawEntry?.over_price,
  );
  const underPrice = pickFirstFinite(
    oddsSnapshot?.total_price_under_f5,
    oddsSnapshot?.total_f5_price_under,
    mlb?.total_price_under_f5,
    mlb?.total_f5_price_under,
    rawEntry?.under,
    rawEntry?.under_price,
  );

  return { line, over_price: overPrice, under_price: underPrice };
}

function resolveMlbF5MoneylineContext(oddsSnapshot) {
  const rawData = parseMlbRawData(oddsSnapshot);
  const mlb = rawData?.mlb && typeof rawData.mlb === 'object' ? rawData.mlb : {};
  const rawEntry = getMarketEntry(rawData, [
    'h2h_f5',
    'ml_f5',
    'moneyline_f5',
    'first_5_h2h',
  ]);

  const home = pickFirstFinite(
    oddsSnapshot?.ml_f5_home,
    oddsSnapshot?.h2h_home_f5,
    oddsSnapshot?.moneyline_home_f5,
    mlb?.ml_f5_home,
    mlb?.h2h_home_f5,
    rawEntry?.home,
    rawEntry?.home_price,
  );
  const away = pickFirstFinite(
    oddsSnapshot?.ml_f5_away,
    oddsSnapshot?.h2h_away_f5,
    oddsSnapshot?.moneyline_away_f5,
    mlb?.ml_f5_away,
    mlb?.h2h_away_f5,
    rawEntry?.away,
    rawEntry?.away_price,
  );

  return { home, away };
}

function resolveMlbFullGameTotalContext(oddsSnapshot) {
  const rawData = parseMlbRawData(oddsSnapshot);
  const rawEntry = getMarketEntry(rawData, ['totals']);

  const line = pickFirstFinite(oddsSnapshot?.total, rawEntry?.line, rawEntry?.total);
  const overPrice = pickFirstFinite(
    oddsSnapshot?.total_price_over,
    rawEntry?.over,
    rawEntry?.over_price,
  );
  const underPrice = pickFirstFinite(
    oddsSnapshot?.total_price_under,
    rawEntry?.under,
    rawEntry?.under_price,
  );

  return { line, over_price: overPrice, under_price: underPrice };
}

function buildMlbMarketAvailability(oddsSnapshot, { expectF5Ml = false, withoutOddsMode = false, projectionFloorF5 = null } = {}) {
  const f5TotalContext = resolveMlbF5TotalContext(oddsSnapshot);
  const f5MoneylineContext = resolveMlbF5MoneylineContext(oddsSnapshot);
  const fullGameTotalContext = resolveMlbFullGameTotalContext(oddsSnapshot);
  const blockingReasonCodes = [];

  const f5LineOk = f5TotalContext.line !== null;
  const useFloor = withoutOddsMode && projectionFloorF5 !== null && !f5LineOk;
  const effectiveF5LineOk = f5LineOk || useFloor;

  const f5MlOk =
    f5MoneylineContext.home !== null && f5MoneylineContext.away !== null;
  const fullGameTotalOk = fullGameTotalContext.line !== null;

  if (!effectiveF5LineOk) {
    blockingReasonCodes.push(MLB_PIPELINE_REASON_CODES.F5_TOTAL_UNAVAILABLE);
  }
  if (useFloor) {
    blockingReasonCodes.push(PRICE_REASONS.MARKET_PRICE_MISSING);
  }
  if (expectF5Ml && !f5MlOk) {
    blockingReasonCodes.push(MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE);
  }
  if (!fullGameTotalOk) {
    blockingReasonCodes.push(WATCHDOG_REASONS.MARKET_UNAVAILABLE);
  }

  return {
    f5_line_ok: effectiveF5LineOk,
    f5_ml_ok: f5MlOk,
    full_game_total_ok: fullGameTotalOk,
    expect_f5_total: true,
    expect_f5_ml: expectF5Ml === true,
    blocking_reason_codes: uniqueReasonCodes(blockingReasonCodes),
    ...(useFloor ? { projection_floor: true, f5_total: projectionFloorF5 } : {}),
  };
}

function buildMlbPipelineState({
  oddsSnapshot,
  marketAvailability,
  projectionReady,
  driversReady,
  pricingReady,
  cardReady,
}) {
  const availability =
    marketAvailability || buildMlbMarketAvailability(oddsSnapshot);
  const marketLinesOk =
    availability.f5_line_ok ||
    availability.full_game_total_ok ||
    (availability.expect_f5_ml && availability.f5_ml_ok);

  return {
    ...buildPipelineState({
      ingested: Boolean(oddsSnapshot),
      team_mapping_ok: Boolean(
        oddsSnapshot?.home_team && oddsSnapshot?.away_team,
      ),
      odds_ok: Boolean(oddsSnapshot?.captured_at) && marketLinesOk,
      market_lines_ok: marketLinesOk,
      projection_ready: projectionReady === true,
      drivers_ready: driversReady === true,
      pricing_ready: pricingReady === true,
      card_ready: cardReady === true,
      blocking_reason_codes: availability.blocking_reason_codes,
    }),
    f5_line_ok: availability.f5_line_ok,
    f5_ml_ok: availability.f5_ml_ok,
    full_game_total_ok: availability.full_game_total_ok,
    expect_f5_total: availability.expect_f5_total,
    expect_f5_ml: availability.expect_f5_ml,
  };
}

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

function resolvePitcherKsMode() {
  return PITCHER_KS_MODEL_MODE === 'ODDS_BACKED'
    ? 'ODDS_BACKED'
    : 'PROJECTION_ONLY';
}

function normalizePitcherLookupKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPitcherPropBookmakerPriority(bookmaker) {
  const normalized = String(bookmaker || '').toLowerCase();
  return MLB_PROP_BOOKMAKER_PRIORITY[normalized] ?? 99;
}

function selectBestPitcherUnderMarket(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const sorted = [...rows].sort((left, right) => {
    const leftLine = toFiniteNumber(left?.line) ?? Number.NEGATIVE_INFINITY;
    const rightLine = toFiniteNumber(right?.line) ?? Number.NEGATIVE_INFINITY;
    if (rightLine !== leftLine) return rightLine - leftLine;

    const leftUnder = toFiniteNumber(left?.under_price) ?? Number.NEGATIVE_INFINITY;
    const rightUnder = toFiniteNumber(right?.under_price) ?? Number.NEGATIVE_INFINITY;
    if (rightUnder !== leftUnder) return rightUnder - leftUnder;

    return (
      getPitcherPropBookmakerPriority(left?.bookmaker) -
      getPitcherPropBookmakerPriority(right?.bookmaker)
    );
  });

  const best = sorted[0];
  return best
    ? {
        line: toFiniteNumber(best.line),
        over_price: toFiniteNumber(best.over_price),
        under_price: toFiniteNumber(best.under_price),
        bookmaker: best.bookmaker ?? null,
        fetched_at: best.fetched_at ?? null,
      }
    : null;
}

function loadPitcherStrikeoutMarkets(db, gameId) {
  if (!db || !gameId) return {};
  const rows = db
    .prepare(`
      SELECT player_name, line, over_price, under_price, bookmaker, fetched_at
      FROM player_prop_lines
      WHERE sport = 'MLB'
        AND game_id = ?
        AND prop_type = 'pitcher_strikeouts'
        AND period = 'full_game'
    `)
    .all(gameId);

  const grouped = new Map();
  for (const row of rows) {
    const key = normalizePitcherLookupKey(row.player_name);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const selected = {};
  for (const [key, group] of grouped.entries()) {
    const best = selectBestPitcherUnderMarket(group);
    if (best) selected[key] = best;
  }
  return selected;
}

function buildPitcherStrikeoutLookback(
  db,
  mlbPitcherId,
  currentSeason = new Date().getUTCFullYear(),
  limit = 10,
) {
  if (!db || !mlbPitcherId || !Number.isFinite(Number(limit)) || limit <= 0) {
    return [];
  }

  const currentRows = db
    .prepare(`
      SELECT season, game_date, strikeouts, number_of_pitches, innings_pitched
      FROM mlb_pitcher_game_logs
      WHERE mlb_pitcher_id = ?
        AND season = ?
        AND innings_pitched > 0
      ORDER BY game_date DESC
      LIMIT ?
    `)
    .all(mlbPitcherId, currentSeason, limit);

  const remaining = Math.max(limit - currentRows.length, 0);
  const priorRows =
    remaining > 0
      ? db
          .prepare(`
            SELECT season, game_date, strikeouts, number_of_pitches, innings_pitched
            FROM mlb_pitcher_game_logs
            WHERE mlb_pitcher_id = ?
              AND season < ?
              AND innings_pitched > 0
            ORDER BY season DESC, game_date DESC
            LIMIT ?
          `)
          .all(mlbPitcherId, currentSeason, remaining)
      : [];

  return [...currentRows, ...priorRows].map((row) => ({
    season: toFiniteNumber(row.season),
    game_date: row.game_date,
    strikeouts: toFiniteNumber(row.strikeouts),
    number_of_pitches: toFiniteNumber(row.number_of_pitches),
    innings_pitched: toFiniteNumber(row.innings_pitched),
  }));
}

// F5 total last-resort fallback (when both pitcher ERAs are unavailable).
// F5 spans 5 innings ≈ 55% of a full game. MLB avg full-game total ~8.5 → F5 ≈ 4.5.
const PROJECTION_FLOOR_F5_FALLBACK = 4.5;

/**
 * Look up ERA for a team from mlb_pitcher_stats. Returns null if not found.
 * Used as a DB fallback when raw_data has no embedded pitcher info (WITHOUT_ODDS_MODE).
 * Tries all lookup keys (full name + abbreviation) via resolveMlbTeamLookupKeys.
 * @param {string} team - Full team name or abbreviation (e.g. 'Toronto Blue Jays' or 'TOR')
 * @returns {number|null}
 */
function getPitcherEraFromDb(team) {
  if (!team) return null;
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      'SELECT era FROM mlb_pitcher_stats WHERE team = ? AND era IS NOT NULL AND era > 0 ORDER BY updated_at DESC LIMIT 1',
    );
    for (const key of resolveMlbTeamLookupKeys(team)) {
      const row = stmt.get(key);
      if (row) return toFiniteNumber(row.era);
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Derive a synthetic F5 total projection floor from pitcher ERA stats.
 * First attempts to read ERA from oddsSnapshot.raw_data.mlb (enriched snapshots).
 * Falls back to a direct mlb_pitcher_stats DB lookup by home_team/away_team
 * (used in WITHOUT_ODDS_MODE where raw_data is null).
 * Returns a value rounded to the nearest 0.5, or the fallback constant if
 * pitcher stats are unavailable for both teams.
 *
 * @param {object} oddsSnapshot - Enriched or synthetic odds snapshot
 * @returns {number}
 */
function computeProjectionFloorF5(oddsSnapshot) {
  try {
    const rawData = parseMlbRawData(oddsSnapshot);
    const mlb = rawData?.mlb && typeof rawData.mlb === 'object' ? rawData.mlb : {};
    let homeEra = toFiniteNumber(mlb.home_pitcher?.era);
    let awayEra = toFiniteNumber(mlb.away_pitcher?.era);

    // WITHOUT_ODDS_MODE: raw_data is null — fall back to DB lookup by team abbreviation
    // Also skip era=0 (Opening Day pitcher with 0 IP so far — not a real ERA signal)
    if ((homeEra === null || homeEra === 0) && oddsSnapshot?.home_team) {
      homeEra = getPitcherEraFromDb(oddsSnapshot.home_team);
    }
    if ((awayEra === null || awayEra === 0) && oddsSnapshot?.away_team) {
      awayEra = getPitcherEraFromDb(oddsSnapshot.away_team);
    }

    if (homeEra === null || awayEra === null) return PROJECTION_FLOOR_F5_FALLBACK;
    const raw = (homeEra / 9) * 5 + (awayEra / 9) * 5;
    return Math.round(raw * 2) / 2;
  } catch (_) {
    return PROJECTION_FLOOR_F5_FALLBACK;
  }
}

function buildMlbDualRunRecord(gameId, oddsSnapshot, selection) {
  return {
    game_id: gameId,
    matchup:
      selection?.matchup ??
      `${oddsSnapshot?.away_team ?? 'unknown'} @ ${oddsSnapshot?.home_team ?? 'unknown'}`,
    run_at: new Date().toISOString(),
    chosen_market: selection?.chosen_market ?? 'F5_TOTAL',
    why_this_market:
      selection?.why_this_market ?? 'Rule 1: only configured MLB game market',
    markets: Array.isArray(selection?.markets) ? selection.markets : [],
    rejected:
      selection?.rejected && typeof selection.rejected === 'object'
        ? selection.rejected
        : {},
  };
}

function buildMlbF5OddsContext(oddsSnapshot) {
  return {
    total_f5: oddsSnapshot?.total_f5 ?? null,
    total_price_over_f5:
      oddsSnapshot?.total_price_over_f5 ??
      oddsSnapshot?.total_f5_price_over ??
      null,
    total_price_under_f5:
      oddsSnapshot?.total_price_under_f5 ??
      oddsSnapshot?.total_f5_price_under ??
      null,
    captured_at: oddsSnapshot?.captured_at ?? null,
  };
}

/**
 * Generate a card payload from model output + odds
 */
function generateMLBCard(gameId, modelOutput, oddsSnapshot) {
  const cardId = `card-mlb-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();

  const expiresAt = null;

  // Build the card payload
  const recommendation = buildRecommendationFromPrediction({
    prediction: modelOutput.prediction,
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
  const payloadData = {
    game_id: gameId,
    sport: 'MLB',
    model_version: 'mlb-model-v1',
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
      total: null,
      margin_home: null,
      win_prob_home: null,
    },
    market,
    edge: null,
    confidence_pct: Math.round(modelOutput.confidence * 100),
    drivers_active: [],
    prediction: modelOutput.prediction,
    confidence: modelOutput.confidence,
    recommended_bet_type: 'moneyline',
    reasoning: modelOutput.reasoning,
    odds_context: {
      h2h_home: oddsSnapshot?.h2h_home,
      h2h_away: oddsSnapshot?.h2h_away,
      spread_home: oddsSnapshot?.spread_home,
      spread_away: oddsSnapshot?.spread_away,
      total: oddsSnapshot?.total,
      captured_at: oddsSnapshot?.captured_at,
    },
    ev_passed: modelOutput.ev_threshold_passed,
    disclaimer:
      'Analysis provided for educational purposes. Not a recommendation.',
    generated_at: now,
    meta: {
      inference_source: modelOutput.inference_source || 'unknown',
      model_endpoint: modelOutput.model_endpoint || null,
      is_mock: Boolean(modelOutput.is_mock),
    },
  };

  return {
    id: cardId,
    gameId,
    sport: 'MLB',
    cardType: 'mlb-model-output',
    cardTitle: `MLB Model: ${modelOutput.prediction}`,
    createdAt: now,
    expiresAt,
    payloadData,
    modelOutputIds: null, // Will be linked after model_output is inserted
  };
}

// K engine — required pitcher fields that must be non-null before scoring.
// Based on pitcher_input_schema.md "Halt if missing" rows.
const PITCHER_K_REQUIRED_FIELDS = [
  'k_per_9',              // season_k9 — primary stat
  'season_starts',        // must be >= 3 for projection to be calculable
  'handedness',           // required for opp splits
  'days_since_last_start', // required for rest/leash gate
];

/**
 * Check whether a pitcher_stats DB row is fresh relative to today.
 *
 * Returns:
 *   'MISSING' — no row
 *   'STALE'   — row exists but was not updated today
 *   'FRESH'   — row updated today
 *
 * Exported for unit tests.
 *
 * @param {object|null} row
 * @param {string} [todayDate] YYYY-MM-DD override (defaults to UTC today)
 * @returns {'MISSING'|'STALE'|'FRESH'}
 */
function checkPitcherFreshness(row, todayDate) {
  if (!row) return 'MISSING';
  const today = todayDate || new Date().toISOString().slice(0, 10);
  const rowDate = (row.updated_at || '').slice(0, 10);
  return rowDate === today ? 'FRESH' : 'STALE';
}

/**
 * Validate that a pitcher object contains all required K engine fields (non-null).
 *
 * Returns null if valid, or { code, missing_fields } if any required field is absent.
 * Exported for unit tests.
 *
 * @param {object} pitcher
 * @returns {null | { code: string, missing_fields: string[] }}
 */
function validatePitcherKInputs(pitcher) {
  const missing = PITCHER_K_REQUIRED_FIELDS.filter((f) => pitcher[f] == null);
  if (missing.length === 0) return null;
  return { code: 'PITCHER_REQUIRED_FIELD_NULL', missing_fields: missing };
}

/**
 * Map a fresh mlb_pitcher_stats DB row to the full K engine pitcher object.
 * Parses JSON fields (last_three_pitch_counts, last_three_ip) to arrays.
 *
 * @param {object} row
 * @returns {object}
 */
function buildPitcherKObject(row) {
  let last_three_pitch_counts = null;
  try {
    if (row.last_three_pitch_counts) {
      const parsed = JSON.parse(row.last_three_pitch_counts);
      if (Array.isArray(parsed) && parsed.length >= 3) last_three_pitch_counts = parsed;
    }
  } catch (_) { /* leave null */ }

  let last_three_ip = null;
  try {
    if (row.last_three_ip) {
      const parsed = JSON.parse(row.last_three_ip);
      if (Array.isArray(parsed) && parsed.length >= 3) last_three_ip = parsed;
    }
  } catch (_) { /* leave null */ }

  return {
    mlb_id: row.mlb_id ?? null,
    full_name: row.full_name ?? null,
    // Moneyline-compat fields (kept so computeMLBDriverCards still works)
    era: row.era,
    whip: row.whip,
    avg_ip: row.recent_ip,
    // K engine fields
    k_per_9: row.k_per_9,
    recent_k_per_9: row.recent_k_per_9,
    recent_ip: row.recent_ip,
    season_starts: row.season_starts,
    handedness: row.handedness,
    season_k_pct: row.season_k_pct,
    k_pct_last_4_starts: row.k_pct_last_4_starts,
    k_pct_prior_4_starts: row.k_pct_prior_4_starts,
    last_three_pitch_counts,
    last_three_ip,
    days_since_last_start: row.days_since_last_start,
    il_status: Boolean(row.il_status),
    il_return: Boolean(row.il_return),
    role: row.role ?? 'starter',
    // Statcast — null until pull_mlb_statcast is added
    swstr_pct: row.season_swstr_pct ?? null,
    season_avg_velo: row.season_avg_velo ?? null,
  };
}

/**
 * Enrich an odds snapshot with pitcher stats from the mlb_pitcher_stats table.
 *
 * In standard mode (forKEngine=false): attaches 5 moneyline fields per pitcher,
 * falls back silently when no row found today (existing behavior).
 *
 * In K engine mode (forKEngine=true): attaches all K engine fields, enforces
 * per-pitcher freshness and required-field gates. Failed pitchers are set to null
 * with an explicit ingest_failure_reason_code logged and stored in
 * snapshot.pitcher_k_diagnostics. Does NOT abort the other pitcher.
 *
 * Also attaches market lines (total, f5) from the snapshot into raw_data.mlb.
 *
 * @param {object} oddsSnapshot
 * @param {object} [opts]
 * @param {boolean} [opts.forKEngine=false] Enable K engine enrichment mode
 * @returns {object} Enriched snapshot (or original if DB unavailable)
 */
function enrichMlbPitcherData(oddsSnapshot, { forKEngine = false } = {}) {
  const homeTeam = oddsSnapshot?.home_team ?? '';
  const awayTeam = oddsSnapshot?.away_team ?? '';

  try {
    const db = getDatabase();

    // K mode: query without date filter so we can distinguish STALE vs MISSING.
    // Standard mode: keep today-only filter (existing behavior).
    const byTeam = forKEngine
      ? db.prepare('SELECT * FROM mlb_pitcher_stats WHERE team = ? ORDER BY updated_at DESC LIMIT 1')
      : db.prepare("SELECT * FROM mlb_pitcher_stats WHERE team = ? AND date(updated_at) = date('now') LIMIT 1");

    function getPitcherRowForTeam(team) {
      for (const key of resolveMlbTeamLookupKeys(team)) {
        const row = byTeam.get(key);
        if (row) return row;
      }
      return null;
    }

    const homeRow = getPitcherRowForTeam(homeTeam);
    const awayRow = getPitcherRowForTeam(awayTeam);

    const existingRaw =
      typeof oddsSnapshot.raw_data === 'string'
        ? JSON.parse(oddsSnapshot.raw_data)
        : (oddsSnapshot.raw_data ?? {});

    const mlb = existingRaw.mlb ?? {};

    // Attach market lines from odds snapshot to raw_data.mlb
    mlb.total_line = oddsSnapshot.total ?? mlb.total_line ?? null;
    mlb.f5_line = oddsSnapshot.total_f5 ?? mlb.f5_line ?? null;

    // Strikeout lines: look up player_prop_lines for pitcher_strikeouts when in
    // ODDS_BACKED mode. Best-line logic: lowest over_line among DraftKings/FanDuel/BetMGM.
    // In PROJECTION_ONLY mode, leave strikeout_lines as-is (null or existing).
    if (forKEngine && PITCHER_KS_MODEL_MODE === 'ODDS_BACKED') {
      try {
        const gameId = oddsSnapshot?.game_id ?? oddsSnapshot?.id ?? null;
        if (gameId) {
          mlb.strikeout_lines = loadPitcherStrikeoutMarkets(db, gameId);
        }
      } catch (_propErr) {
        // Non-fatal — K engine falls back to PROJECTION_ONLY gating if no line found
        console.warn(`[MLBModel] [pitcher-k] Failed to load strikeout_lines from player_prop_lines: ${_propErr.message}`);
      }
    } else if (!forKEngine) {
      // Standard moneyline mode: leave strikeout_lines as-is (from existing raw_data or null)
    }

    // Look up weather for this game by (game_date, home_team)
    try {
      const today = new Date().toISOString().slice(0, 10);
      const weatherRow = db.prepare(
        'SELECT temp_f, wind_mph, wind_dir, conditions FROM mlb_game_weather WHERE game_date = ? AND home_team = ? LIMIT 1',
      ).get(today, homeTeam);

      if (weatherRow && weatherRow.conditions !== 'INDOOR') {
        mlb.temp_f = weatherRow.temp_f ?? mlb.temp_f ?? null;
        mlb.wind_mph = weatherRow.wind_mph ?? mlb.wind_mph ?? null;
      }
    } catch (_weatherErr) {
      // Non-fatal — model uses neutral defaults
    }

    const today = new Date().toISOString().slice(0, 10);
    const pitcherKDiagnostics = {};

    /**
     * Build the pitcher entry for raw_data.mlb, applying K engine gates when
     * forKEngine is true. Returns the pitcher object, or null on gate failure.
     */
    function buildPitcherEntry(row, side, team, existingPitcher) {
      if (!forKEngine) {
        // Standard moneyline mode — original 5-field enrichment, silent fallback
        return row
          ? { era: row.era, whip: row.whip, k_per_9: row.k_per_9, recent_k_per_9: row.recent_k_per_9, avg_ip: row.recent_ip }
          : (existingPitcher ?? null);
      }

      // K engine mode — per-pitcher fail-closed with explicit reason codes
      const freshness = checkPitcherFreshness(row, today);

      if (freshness === 'MISSING') {
        pitcherKDiagnostics[side] = { ingest_failure_reason_code: 'PITCHER_DATA_MISSING', team };
        console.warn(`[MLBModel] [pitcher-k] ${team || side}: PITCHER_DATA_MISSING — no row in mlb_pitcher_stats`);
        return null;
      }

      if (freshness === 'STALE') {
        pitcherKDiagnostics[side] = {
          ingest_failure_reason_code: 'PITCHER_DATA_STALE',
          team,
          stale_since: row.updated_at,
        };
        console.warn(`[MLBModel] [pitcher-k] ${team || side}: PITCHER_DATA_STALE — last updated ${row.updated_at}`);
        return null;
      }

      // Fresh row — validate required K engine fields
      const pitcherObj = buildPitcherKObject(row);
      const validationErr = validatePitcherKInputs(pitcherObj);
      if (validationErr) {
        pitcherKDiagnostics[side] = {
          ingest_failure_reason_code: validationErr.code,
          team,
          missing_fields: validationErr.missing_fields,
        };
        console.warn(
          `[MLBModel] [pitcher-k] ${team || side}: ${validationErr.code} — missing: ${validationErr.missing_fields.join(', ')}`,
        );
        return null;
      }

      pitcherObj.strikeout_history = buildPitcherStrikeoutLookback(
        db,
        row.mlb_id,
        new Date().getUTCFullYear(),
        10,
      );

      return pitcherObj;
    }

    mlb.home_pitcher = buildPitcherEntry(homeRow, 'home', homeTeam, mlb.home_pitcher);
    mlb.away_pitcher = buildPitcherEntry(awayRow, 'away', awayTeam, mlb.away_pitcher);

    const enriched = {
      ...oddsSnapshot,
      raw_data: { ...existingRaw, mlb },
    };

    // Attach per-pitcher diagnostics so callers and tests can inspect them
    if (forKEngine && Object.keys(pitcherKDiagnostics).length > 0) {
      enriched.pitcher_k_diagnostics = pitcherKDiagnostics;
    }

    return enriched;
  } catch (err) {
    console.warn(`[MLBModel] Pitcher enrichment failed: ${err.message}`);
    return oddsSnapshot; // proceed without enrichment
  }
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 * @param {boolean} options.expectF5Ml - Enable F5 ML watchdog expectations
 */
async function runMLBModel({
  jobKey = null,
  dryRun = false,
  expectF5Ml = true,
  withoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true',
} = {}) {
  const jobRunId = `job-mlb-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[MLBModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[MLBModel] Job key: ${jobKey}`);
  }
  console.log(`[MLBModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[MLBModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[MLBModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }
    try {
      // Start job run
      console.log('[MLBModel] Recording job start...');
      insertJobRun('run_mlb_model', jobRunId, jobKey);

      // WI-0648: MLB empirical sigma recalibration gate.
      // Queries settled game_results for MLB. Falls back to getSigmaDefaults('MLB')
      // when fewer than MIN_MLB_GAMES_FOR_RECAL (20) settled games exist — typical
      // during the first ~3 weeks of the season. Once the threshold is met, logs
      // [MLB_SIGMA_EMPIRICAL] and the computed values are available for future use.
      const mlbSigma = edgeCalculator.computeSigmaFromHistory({
        sport: 'MLB',
        db: getDatabase(),
        windowGames: MIN_MLB_GAMES_FOR_RECAL * 30, // pool: up to 30 teams × threshold
      });
      if (mlbSigma.sigma_source === 'computed') {
        console.log(
          `[MLB_SIGMA_EMPIRICAL] games_sampled=${mlbSigma.games_sampled} sigma=${JSON.stringify(mlbSigma)}`,
        );
      } else {
        console.log(
          `[MLB_SIGMA_PRESEASON_DEFAULT] threshold=${MIN_MLB_GAMES_FOR_RECAL} sigma=${JSON.stringify(mlbSigma)}`,
        );
      }

      // Get latest MLB odds for UPCOMING games only (prevents stale data processing)
      console.log('[MLBModel] Fetching odds for upcoming MLB games...');
      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      const oddsSnapshots = getOddsWithUpcomingGames(
        'MLB',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        if (!withoutOddsMode) {
          console.log('[MLBModel] No recent MLB odds found, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
        // Without-Odds-Mode: no odds_snapshots but games exist — synthesize from games table
        console.log('[MLBModel] WITHOUT_ODDS_MODE: no odds snapshots, building synthetic snapshots from games table');
        oddsSnapshots.push(...getUpcomingGamesAsSyntheticSnapshots('MLB', nowUtc.toISO(), horizonUtc));
        if (oddsSnapshots.length === 0) {
          console.log('[MLBModel] No upcoming MLB games found in games table, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
      }

      console.log(`[MLBModel] Found ${oddsSnapshots.length} odds snapshots`);

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
      console.log(`[MLBModel] Running inference on ${gameIds.length} games...`);

      // Get model instance
      const model = getModel('MLB');

      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];
      const gamePipelineStates = {};

      // Process each game — emit one card per qualifying driver market
      for (const gameId of gameIds) {
        try {
          const baseOddsSnapshot = gameOdds[gameId];
          const gameOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
            forKEngine: false,
          });
          const pitcherKOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
            forKEngine: true,
          });

          const gameDriverCards = computeMLBDriverCards(gameId, gameOddsSnapshot);
          const pitcherKDriverCards = computePitcherKDriverCards(gameId, pitcherKOddsSnapshot, {
            mode: resolvePitcherKsMode(),
          });
          const gameSelection = selectMlbGameMarket(
            gameId,
            gameOddsSnapshot,
            gameDriverCards,
          );
          const dualRunRecord = buildMlbDualRunRecord(
            gameId,
            gameOddsSnapshot,
            gameSelection,
          );
          console.log(`[MLB_DUAL_RUN] ${JSON.stringify(dualRunRecord)}`);
          const f5TotalContextForFloor = resolveMlbF5TotalContext(gameOddsSnapshot);
          const projectionFloorF5 = (withoutOddsMode && f5TotalContextForFloor.line === null)
            ? computeProjectionFloorF5(gameOddsSnapshot)
            : null;
          const marketAvailability = buildMlbMarketAvailability(gameOddsSnapshot, {
            expectF5Ml,
            withoutOddsMode,
            projectionFloorF5,
          });
          if (projectionFloorF5 !== null) {
            console.log(`[MLBModel] WITHOUT_ODDS_MODE: ${gameId} — using projection floor F5=${projectionFloorF5}`);
          }

          // F5 ML side-projection card
          const f5MlContext = resolveMlbF5MoneylineContext(gameOddsSnapshot);
          let f5MlDriverCard = null;
          if (f5MlContext.home !== null && f5MlContext.away !== null) {
            const mlbRaw = (typeof gameOddsSnapshot.raw_data === 'string'
              ? JSON.parse(gameOddsSnapshot.raw_data)
              : gameOddsSnapshot.raw_data) ?? {};
            const mlb = mlbRaw.mlb ?? {};
            const f5MlResult = projectF5ML(
              mlb.home_pitcher ?? null,
              mlb.away_pitcher ?? null,
              f5MlContext.home,
              f5MlContext.away,
            );
            if (f5MlResult) {
              f5MlDriverCard = {
                market: 'f5_ml',
                prediction: f5MlResult.prediction,
                confidence: f5MlResult.confidence / 10,
                ev_threshold_passed: f5MlResult.ev_threshold_passed,
                reasoning: f5MlResult.reasoning,
                drivers: [{
                  type: 'mlb-f5-ml',
                  edge: f5MlResult.edge,
                  projected_win_prob_home: f5MlResult.projected_win_prob_home,
                }],
                ml_f5_home: f5MlContext.home,
                ml_f5_away: f5MlContext.away,
              };
            }
          } else {
            console.log(`[MLBModel] NO_F5_ML_LINE: ${gameId} — ml_f5 price absent, F5 ML card blocked`);
          }

          const selectedGameDriver = gameSelection.selected_driver;

          // Without-odds mode: synthesize a PROJECTION_ONLY F5 driver when the floor was applied
          const projectionFloorDriver = (withoutOddsMode && marketAvailability.projection_floor && projectionFloorF5 !== null)
            ? {
                market: 'f5_total',
                prediction: 'OVER',
                confidence: 0.5,
                ev_threshold_passed: true,
                reasoning: `Without-odds mode: synthetic F5 total projection floor (${projectionFloorF5}) derived from pitcher ERA`,
                drivers: [{ type: 'mlb-f5-projection-floor', projected: projectionFloorF5, edge: 0 }],
                without_odds_mode: true,
                projection_floor: true,
                projection_floor_line: projectionFloorF5,
              }
            : null;

          const qualified = [
            ...(selectedGameDriver?.ev_threshold_passed ? [selectedGameDriver] : []),
            ...pitcherKDriverCards.filter((d) => d.emit_card === true),
            ...(f5MlDriverCard?.ev_threshold_passed ? [f5MlDriverCard] : []),
            ...(projectionFloorDriver ? [projectionFloorDriver] : []),
          ];

          // Clean up stale cards from previous runs for this game
          prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-model-output', { runId: jobRunId });
          prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-strikeout', { runId: jobRunId });
          prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-f5', { runId: jobRunId });
          prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-f5-ml', { runId: jobRunId });
          prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-pitcher-k', { runId: jobRunId });

          // pricing_ready = true only when odds-backed qualified cards exist (not floor-only)
          const oddsBackedQualified = qualified.filter((d) => !d.projection_floor);
          const pipelineState = buildMlbPipelineState({
            oddsSnapshot: gameOddsSnapshot,
            marketAvailability,
            projectionReady: true,
            driversReady:
              gameDriverCards.length > 0 || pitcherKDriverCards.length > 0 || projectionFloorDriver !== null,
            pricingReady: oddsBackedQualified.length > 0,
            cardReady: qualified.length > 0,
          });
          gamePipelineStates[gameId] = pipelineState;
          console.log(
            `[MLB_PIPELINE_STATE] ${JSON.stringify({
              game_id: gameId,
              ...pipelineState,
            })}`,
          );

          if (qualified.length === 0) {
            console.log(`  ⏭️  ${gameId}: No markets passed threshold`);
            continue;
          }

          const now = new Date().toISOString();
          const matchup = buildMatchup(
            gameOddsSnapshot?.home_team,
            gameOddsSnapshot?.away_team,
          );

          for (const driver of qualified) {
            const isF5 = driver.market === 'f5_total';
            const isF5ML = driver.market === 'f5_ml';
            const isPitcherK = driver.market?.startsWith('pitcher_k_');
            const cardType = isF5 ? 'mlb-f5' : isF5ML ? 'mlb-f5-ml' : isPitcherK ? 'mlb-pitcher-k' : 'mlb-strikeout';

            const driverDetail = driver.drivers?.[0] ?? {};
            const projected =
              driverDetail.projected ?? driverDetail.projection ?? null;
            const edge = driverDetail.edge ?? driverDetail.line_delta ?? null;
            const line = isPitcherK && driver.line != null
              ? driver.line
              : projected !== null && edge !== null
                ? Math.round((projected - edge) * 10) / 10
                : null;

            const pitcherTeam = driver.pitcher_team
              ?? (driver.market === 'strikeouts_home' || driver.market === 'pitcher_k_home'
                  ? (pitcherKOddsSnapshot?.home_team ?? null)
                  : driver.market === 'strikeouts_away' || driver.market === 'pitcher_k_away'
                    ? (pitcherKOddsSnapshot?.away_team ?? null)
                    : null);

            const tier = isPitcherK
              ? (driver.card_verdict === 'PLAY' ? 'BEST' : 'WATCH')
              : driver.confidence >= 0.8
                ? 'BEST'
                : 'WATCH';

            const payloadData = {
              game_id: gameId,
              sport: 'MLB',
              model_version: 'mlb-model-v1',
              home_team: gameOddsSnapshot?.home_team ?? null,
              away_team: gameOddsSnapshot?.away_team ?? null,
              matchup,
              start_time_utc: gameOddsSnapshot?.game_time_utc ?? null,
              market_type: (isF5 || isF5ML) ? 'FIRST_PERIOD' : 'PROP',
              prediction: driver.prediction,
              selection: { side: driver.prediction },
              line,
              confidence: driver.confidence,
              tier,
              ev_passed: isPitcherK ? driver.card_verdict !== 'NO_PLAY' : true,
              reasoning: driver.reasoning,
              disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
              generated_at: now,
              ...(driver.without_odds_mode ? { without_odds_mode: true, projection_floor: true, tags: ['no_odds_mode'] } : {}),
              ...(isF5
                ? {
                    projection: { projected_total: projected },
                    recommended_bet_type: 'total',
                    odds_context: buildMlbF5OddsContext(gameOddsSnapshot),
                    primary_game_market: true,
                    chosen_market: gameSelection.chosen_market,
                    why_this_market: gameSelection.why_this_market,
                  }
                : isF5ML
                  ? {
                      recommended_bet_type: 'moneyline',
                      odds_context: {
                        ml_f5_home: driver.ml_f5_home ?? null,
                        ml_f5_away: driver.ml_f5_away ?? null,
                        captured_at: gameOddsSnapshot?.captured_at ?? null,
                      },
                      projection: {
                        projected_win_prob_home: driver.drivers?.[0]?.projected_win_prob_home ?? null,
                      },
                    }
                : isPitcherK
                  ? {
                      player_name: pitcherTeam ? `${pitcherTeam} SP` : 'SP',
                      canonical_market_key: 'pitcher_strikeouts',
                      basis: driver.basis || 'PROJECTION_ONLY',
                      tags: (driver.basis === 'ODDS_BACKED') ? [] : ['no_odds_mode'],
                      prop_decision: driver.prop_decision ?? null,
                      pitcher_k_result: driver.pitcher_k_result ?? null,
                      // Odds-backed enrichment (null in PROJECTION_ONLY)
                      line_source: driver.line_source ?? null,
                      over_price: driver.over_price ?? null,
                      under_price: driver.under_price ?? null,
                      best_line_bookmaker: driver.best_line_bookmaker ?? null,
                      margin: driver.margin ?? null,
                    }
                  : {
                      player_name: pitcherTeam ? `${pitcherTeam} SP` : 'SP',
                      canonical_market_key: 'pitcher_strikeouts',
                    }),
            };

            const cardTitle = isF5
              ? `F5 ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
              : isF5ML
                ? `F5 ML ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
              : isPitcherK
                ? `${pitcherTeam ?? '?'} SP Ks ${driver.prediction} [${driver.basis === 'ODDS_BACKED' ? 'ODDS_BACKED' : 'PROJECTION_ONLY'}]`
                : `${pitcherTeam ?? '?'} SP Strikeouts ${driver.prediction}`;

            const cardId = `card-mlb-${cardType}-${gameId}-${uuidV4().slice(0, 8)}`;
            const card = {
              id: cardId,
              gameId,
              sport: 'MLB',
              cardType,
              cardTitle,
              createdAt: now,
              expiresAt: null,
              payloadData,
            };

            const validation = validateCardPayload(cardType, payloadData);
            if (!validation.success) {
              throw new Error(`Invalid ${cardType} payload: ${validation.errors.join('; ')}`);
            }

            const modelOutputId = `model-mlb-${gameId}-${uuidV4().slice(0, 8)}`;
            insertModelOutput({
              id: modelOutputId,
              gameId,
              sport: 'MLB',
              modelName: 'mlb-model-v1',
              modelVersion: '1.0.0',
              predictionType: cardType,
              predictedAt: now,
              confidence: driver.confidence,
              outputData: driver,
              oddsSnapshotId: baseOddsSnapshot.id,
              jobRunId,
            });

            card.modelOutputIds = modelOutputId;
            attachRunId(card, jobRunId);
            card.payloadData.pipeline_state = pipelineState;
            insertCardPayload(card);

            cardsGenerated++;
            console.log(`  ✅ ${gameId} [${cardType}]: ${driver.prediction} (${(driver.confidence * 100).toFixed(0)}%)`);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid')) {
            throw gameError;
          }
          cardsFailed++;
          if (!gamePipelineStates[gameId]) {
            const fallbackOddsSnapshot = gameOdds[gameId];
            gamePipelineStates[gameId] = buildMlbPipelineState({
              oddsSnapshot: fallbackOddsSnapshot,
              marketAvailability: buildMlbMarketAvailability(fallbackOddsSnapshot, {
                expectF5Ml,
              }),
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
            });
          }
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  ❌ ${gameId}: ${gameError.message}`);
        }
      }

      // Mark success
      markJobRunSuccess(jobRunId);
      try {
        setCurrentRunId(jobRunId, 'mlb');
      } catch (runStateError) {
        console.error(
          `[MLBModel] Failed to update run state: ${runStateError.message}`,
        );
      }
      console.log(
        `[MLBModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`,
      );
      console.log(
        `[MLBModel] Pipeline states: ${JSON.stringify(gamePipelineStates)}`,
      );

      if (errors.length > 0) {
        console.error('[MLBModel] Errors:');
        errors.forEach((err) => console.error(`  - ${err}`));
      }

      return {
        success: true,
        jobRunId,
        cardsGenerated,
        cardsFailed,
        errors,
        pipeline_states: gamePipelineStates,
      };
    } catch (error) {
      console.error(`[MLBModel] ❌ Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[MLBModel] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runMLBModel()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = {
  runMLBModel,
  generateMLBCard,
  buildMlbDualRunRecord,
  buildMlbF5OddsContext,
  buildMlbMarketAvailability,
  buildMlbPipelineState,
  MLB_PIPELINE_REASON_CODES,
  resolveMlbTeamLookupKeys,
  resolvePitcherKsMode,
  // Exported for WI-0596 unit tests
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
  selectBestPitcherUnderMarket,
  buildPitcherStrikeoutLookback,
  // Exported for WI-0637 unit tests
  computeProjectionFloorF5,
  // Exported for WI-0648 unit tests
  MIN_MLB_GAMES_FOR_RECAL,
};
