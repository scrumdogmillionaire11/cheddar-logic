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

// Auto-detect projection-only period: when MLB odds are disabled in config,
// always run in without-odds mode regardless of what the caller passes.
const { SPORTS_CONFIG: ODDS_SPORTS_CONFIG } = require('@cheddar-logic/odds/src/config');
const MIN_MLB_GAMES_FOR_RECAL = parseInt(process.env.MIN_MLB_GAMES_FOR_RECAL || '20', 10);

// Pitcher K runtime mode: ODDS_BACKED when player_prop_lines has a recent
// strikeout line for the pitcher; PROJECTION_ONLY per-pitcher when absent.
const MLB_K_PROP_FRESHNESS_MINUTES = Number(
  process.env.MLB_K_PROP_FRESHNESS_MINUTES || 75,
);
const MLB_K_PROP_ODDS_MAX_AGE_MINUTES = Number(
  process.env.MLB_K_PROP_FRESHNESS_MINUTES || 75,
);
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

// WI-0747: MLB K explicit input contract — deterministic quality classifier
const {
  classifyMlbPitcherKQuality,
  dedupeFlags,
} = require('./mlb-k-input-classifier');

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
  oddstrader: 3,
  oddsjam: 4,
  betmgm: 5,
});

const MLB_F5_TEAM_OFFENSE_SPLITS = Object.freeze({
  AZ: { wrc_plus_vs_lhp: 104, wrc_plus_vs_rhp: 98, k_pct_vs_lhp: 0.212, k_pct_vs_rhp: 0.222, iso_vs_lhp: 0.172, iso_vs_rhp: 0.165 },
  ATH: { wrc_plus_vs_lhp: 96, wrc_plus_vs_rhp: 91, k_pct_vs_lhp: 0.236, k_pct_vs_rhp: 0.241, iso_vs_lhp: 0.155, iso_vs_rhp: 0.146 },
  ATL: { wrc_plus_vs_lhp: 107, wrc_plus_vs_rhp: 105, k_pct_vs_lhp: 0.218, k_pct_vs_rhp: 0.226, iso_vs_lhp: 0.188, iso_vs_rhp: 0.181 },
  BAL: { wrc_plus_vs_lhp: 102, wrc_plus_vs_rhp: 105, k_pct_vs_lhp: 0.219, k_pct_vs_rhp: 0.224, iso_vs_lhp: 0.175, iso_vs_rhp: 0.184 },
  BOS: { wrc_plus_vs_lhp: 100, wrc_plus_vs_rhp: 103, k_pct_vs_lhp: 0.232, k_pct_vs_rhp: 0.228, iso_vs_lhp: 0.169, iso_vs_rhp: 0.178 },
  CHC: { wrc_plus_vs_lhp: 103, wrc_plus_vs_rhp: 97, k_pct_vs_lhp: 0.222, k_pct_vs_rhp: 0.229, iso_vs_lhp: 0.171, iso_vs_rhp: 0.16 },
  CWS: { wrc_plus_vs_lhp: 89, wrc_plus_vs_rhp: 86, k_pct_vs_lhp: 0.243, k_pct_vs_rhp: 0.247, iso_vs_lhp: 0.138, iso_vs_rhp: 0.134 },
  CIN: { wrc_plus_vs_lhp: 98, wrc_plus_vs_rhp: 101, k_pct_vs_lhp: 0.225, k_pct_vs_rhp: 0.231, iso_vs_lhp: 0.17, iso_vs_rhp: 0.176 },
  CLE: { wrc_plus_vs_lhp: 102, wrc_plus_vs_rhp: 100, k_pct_vs_lhp: 0.196, k_pct_vs_rhp: 0.204, iso_vs_lhp: 0.151, iso_vs_rhp: 0.157 },
  COL: { wrc_plus_vs_lhp: 98, wrc_plus_vs_rhp: 93, k_pct_vs_lhp: 0.238, k_pct_vs_rhp: 0.247, iso_vs_lhp: 0.176, iso_vs_rhp: 0.163 },
  DET: { wrc_plus_vs_lhp: 99, wrc_plus_vs_rhp: 101, k_pct_vs_lhp: 0.231, k_pct_vs_rhp: 0.235, iso_vs_lhp: 0.164, iso_vs_rhp: 0.168 },
  HOU: { wrc_plus_vs_lhp: 112, wrc_plus_vs_rhp: 108, k_pct_vs_lhp: 0.193, k_pct_vs_rhp: 0.202, iso_vs_lhp: 0.184, iso_vs_rhp: 0.179 },
  KC: { wrc_plus_vs_lhp: 101, wrc_plus_vs_rhp: 103, k_pct_vs_lhp: 0.197, k_pct_vs_rhp: 0.206, iso_vs_lhp: 0.168, iso_vs_rhp: 0.171 },
  LAA: { wrc_plus_vs_lhp: 97, wrc_plus_vs_rhp: 95, k_pct_vs_lhp: 0.234, k_pct_vs_rhp: 0.242, iso_vs_lhp: 0.164, iso_vs_rhp: 0.162 },
  LAD: { wrc_plus_vs_lhp: 113, wrc_plus_vs_rhp: 112, k_pct_vs_lhp: 0.206, k_pct_vs_rhp: 0.213, iso_vs_lhp: 0.195, iso_vs_rhp: 0.191 },
  MIA: { wrc_plus_vs_lhp: 92, wrc_plus_vs_rhp: 90, k_pct_vs_lhp: 0.226, k_pct_vs_rhp: 0.234, iso_vs_lhp: 0.146, iso_vs_rhp: 0.141 },
  MIL: { wrc_plus_vs_lhp: 103, wrc_plus_vs_rhp: 101, k_pct_vs_lhp: 0.231, k_pct_vs_rhp: 0.226, iso_vs_lhp: 0.171, iso_vs_rhp: 0.167 },
  MIN: { wrc_plus_vs_lhp: 105, wrc_plus_vs_rhp: 102, k_pct_vs_lhp: 0.238, k_pct_vs_rhp: 0.233, iso_vs_lhp: 0.183, iso_vs_rhp: 0.176 },
  NYM: { wrc_plus_vs_lhp: 106, wrc_plus_vs_rhp: 102, k_pct_vs_lhp: 0.214, k_pct_vs_rhp: 0.221, iso_vs_lhp: 0.177, iso_vs_rhp: 0.169 },
  NYY: { wrc_plus_vs_lhp: 114, wrc_plus_vs_rhp: 109, k_pct_vs_lhp: 0.223, k_pct_vs_rhp: 0.229, iso_vs_lhp: 0.202, iso_vs_rhp: 0.191 },
  PHI: { wrc_plus_vs_lhp: 105, wrc_plus_vs_rhp: 104, k_pct_vs_lhp: 0.217, k_pct_vs_rhp: 0.223, iso_vs_lhp: 0.182, iso_vs_rhp: 0.176 },
  PIT: { wrc_plus_vs_lhp: 93, wrc_plus_vs_rhp: 91, k_pct_vs_lhp: 0.236, k_pct_vs_rhp: 0.241, iso_vs_lhp: 0.148, iso_vs_rhp: 0.145 },
  SD: { wrc_plus_vs_lhp: 107, wrc_plus_vs_rhp: 104, k_pct_vs_lhp: 0.204, k_pct_vs_rhp: 0.211, iso_vs_lhp: 0.172, iso_vs_rhp: 0.168 },
  SF: { wrc_plus_vs_lhp: 100, wrc_plus_vs_rhp: 96, k_pct_vs_lhp: 0.229, k_pct_vs_rhp: 0.237, iso_vs_lhp: 0.161, iso_vs_rhp: 0.155 },
  SEA: { wrc_plus_vs_lhp: 99, wrc_plus_vs_rhp: 101, k_pct_vs_lhp: 0.247, k_pct_vs_rhp: 0.239, iso_vs_lhp: 0.168, iso_vs_rhp: 0.172 },
  STL: { wrc_plus_vs_lhp: 100, wrc_plus_vs_rhp: 99, k_pct_vs_lhp: 0.205, k_pct_vs_rhp: 0.214, iso_vs_lhp: 0.157, iso_vs_rhp: 0.153 },
  TB: { wrc_plus_vs_lhp: 101, wrc_plus_vs_rhp: 100, k_pct_vs_lhp: 0.227, k_pct_vs_rhp: 0.232, iso_vs_lhp: 0.166, iso_vs_rhp: 0.169 },
  TEX: { wrc_plus_vs_lhp: 103, wrc_plus_vs_rhp: 102, k_pct_vs_lhp: 0.221, k_pct_vs_rhp: 0.225, iso_vs_lhp: 0.175, iso_vs_rhp: 0.172 },
  TOR: { wrc_plus_vs_lhp: 106, wrc_plus_vs_rhp: 100, k_pct_vs_lhp: 0.21, k_pct_vs_rhp: 0.217, iso_vs_lhp: 0.171, iso_vs_rhp: 0.164 },
  WSH: { wrc_plus_vs_lhp: 96, wrc_plus_vs_rhp: 94, k_pct_vs_lhp: 0.215, k_pct_vs_rhp: 0.219, iso_vs_lhp: 0.152, iso_vs_rhp: 0.149 },
});

const MLB_F5_PARK_RUN_FACTORS = Object.freeze({
  AZ: 1.03,
  ATH: 0.96,
  ATL: 1.02,
  BAL: 0.97,
  BOS: 1.04,
  CHC: 1.01,
  CWS: 1.01,
  CIN: 1.08,
  CLE: 0.98,
  COL: 1.15,
  DET: 0.97,
  HOU: 1,
  KC: 0.99,
  LAA: 0.99,
  LAD: 1,
  MIA: 0.96,
  MIL: 1.01,
  MIN: 1,
  NYM: 0.97,
  NYY: 1.04,
  PHI: 1.03,
  PIT: 0.98,
  SD: 0.97,
  SF: 0.95,
  SEA: 0.96,
  STL: 0.98,
  TB: 0.97,
  TEX: 1.03,
  TOR: 1.02,
  WSH: 0.99,
});

const MLB_TEAM_VARIANT_ALIASES = Object.freeze({
  'D BACKS': 'Arizona Diamondbacks',
  'DBACKS': 'Arizona Diamondbacks',
  'DIAMONDBACKS': 'Arizona Diamondbacks',
  'ARIZONA D BACKS': 'Arizona Diamondbacks',
  'A S': 'Athletics',
  'AS': 'Athletics',
  'ATHLETICS': 'Athletics',
  'WHITE SOX': 'Chicago White Sox',
  'RED SOX': 'Boston Red Sox',
  'BLUE JAYS': 'Toronto Blue Jays',
  'METS': 'New York Mets',
  'YANKEES': 'New York Yankees',
  'GIANTS': 'San Francisco Giants',
  'PADRES': 'San Diego Padres',
  'ROYALS': 'Kansas City Royals',
  'TWINS': 'Minnesota Twins',
  'BRAVES': 'Atlanta Braves',
});

const loggedUnknownMlbTeamVariants = new Set();
const MLB_TEAM_CANONICAL_BY_TOKEN = Object.freeze(
  Object.entries(MLB_TEAM_ABBREVIATIONS).reduce((acc, [fullName, abbreviation]) => {
    acc[normalizeTokenForMap(fullName)] = fullName;
    acc[normalizeTokenForMap(abbreviation)] = fullName;
    return acc;
  }, {}),
);

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

function normalizeMlbTeamVariant(value) {
  if (!value || typeof value !== 'string') return '';
  return normalizeTokenForMap(value);
}

function normalizeTokenForMap(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function logUnknownMlbTeamVariant(rawValue, normalizedValue) {
  const key = `${normalizedValue}|${String(rawValue || '').trim()}`;
  if (!normalizedValue || loggedUnknownMlbTeamVariants.has(key)) return;
  loggedUnknownMlbTeamVariants.add(key);
  console.warn(
    `[MLB_TEAM_VARIANT_UNKNOWN] raw="${String(rawValue || '').trim()}" normalized="${normalizedValue}"`,
  );
}

function resolveMlbTeamLookupKeys(teamName) {
  if (!teamName || typeof teamName !== 'string') return [];
  const cleaned = teamName.trim();
  if (!cleaned) return [];

  const normalized = normalizeMlbTeamVariant(cleaned);
  const directCanonical = MLB_TEAM_CANONICAL_BY_TOKEN[normalized] ?? null;
  const aliasedCanonical = directCanonical ?? MLB_TEAM_VARIANT_ALIASES[normalized] ?? null;
  const canonicalFullName = directCanonical ?? aliasedCanonical;
  const abbreviation =
    canonicalFullName && MLB_TEAM_ABBREVIATIONS[canonicalFullName]
      ? MLB_TEAM_ABBREVIATIONS[canonicalFullName]
      : /^[A-Z]{2,4}$/.test(normalized)
        ? normalized
        : null;

  if (!canonicalFullName && !abbreviation) {
    logUnknownMlbTeamVariant(cleaned, normalized);
  }

  return Array.from(
    new Set(
      [
        cleaned,
        canonicalFullName,
        abbreviation,
      ].filter((value) => typeof value === 'string' && value.trim().length > 0),
    ),
  );
}

function resolveMlbTeamAbbreviation(teamName) {
  for (const key of resolveMlbTeamLookupKeys(teamName)) {
    const normalized = normalizeTokenForMap(key);
    if (/^[A-Z]{2,4}$/.test(normalized)) return normalized;
    const canonical =
      MLB_TEAM_CANONICAL_BY_TOKEN[normalized] ??
      MLB_TEAM_VARIANT_ALIASES[normalized] ??
      null;
    if (canonical && MLB_TEAM_ABBREVIATIONS[canonical]) {
      return MLB_TEAM_ABBREVIATIONS[canonical];
    }
  }
  return null;
}

function resolveMlbF5OffenseProfile(teamName) {
  const abbreviation = resolveMlbTeamAbbreviation(teamName);
  return abbreviation ? (MLB_F5_TEAM_OFFENSE_SPLITS[abbreviation] ?? null) : null;
}

function resolveMlbF5ParkRunFactor(homeTeamName) {
  const abbreviation = resolveMlbTeamAbbreviation(homeTeamName);
  return abbreviation ? toFiniteNumber(MLB_F5_PARK_RUN_FACTORS[abbreviation]) : null;
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
  const useFloor = projectionFloorF5 !== null && !f5LineOk;
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
  executionEnvelopes = [],
}) {
  const availability =
    marketAvailability || buildMlbMarketAvailability(oddsSnapshot);
  const marketLinesOk =
    availability.f5_line_ok ||
    availability.full_game_total_ok ||
    (availability.expect_f5_ml && availability.f5_ml_ok);
  const derivedPricingReady =
    Array.isArray(executionEnvelopes) && executionEnvelopes.length > 0
      ? executionEnvelopes.some(
          (envelope) => envelope?._pricing_state?.status === 'FRESH',
        )
      : pricingReady === true;
  const derivedCardReady =
    Array.isArray(executionEnvelopes) && executionEnvelopes.length > 0
      ? executionEnvelopes.some(
          (envelope) => envelope?._publish_state?.emit_allowed === true,
        )
      : cardReady === true;

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
      pricing_ready: derivedPricingReady,
      card_ready: derivedCardReady,
      blocking_reason_codes: availability.blocking_reason_codes,
    }),
    f5_line_ok: availability.f5_line_ok,
    f5_ml_ok: availability.f5_ml_ok,
    full_game_total_ok: availability.full_game_total_ok,
    expect_f5_total: availability.expect_f5_total,
    expect_f5_ml: availability.expect_f5_ml,
  };
}

function deriveMlbExecutionEnvelope({
  driver,
  pricingStatus = 'FRESH',
  pricingReason = null,
  pricingCapturedAt = null,
  isPitcherK = false,
  rolloutState = null,
} = {}) {
  const normalizedPricingStatus = ['FRESH', 'STALE', 'MISSING', 'NOT_REQUIRED'].includes(
    String(pricingStatus || '').toUpperCase(),
  )
    ? String(pricingStatus || '').toUpperCase()
    : 'MISSING';
  const predictionState = {
    status: driver ? 'QUALIFIED' : 'UNQUALIFIED',
    reason: driver ? null : 'DRIVER_UNQUALIFIED',
  };
  const pricingState = {
    status: normalizedPricingStatus,
    reason: pricingReason ?? null,
    captured_at: pricingCapturedAt ?? null,
  };

  let executionStatus = 'BLOCKED';
  let publishReady = false;
  let emitAllowed = false;
  let blockReason = pricingReason ?? null;
  let kPropExecutionPath = null;

  const isProjectionOnly =
    driver?.projection_floor === true ||
    driver?.without_odds_mode === true ||
    driver?.basis === 'PROJECTION_ONLY';

  if (isPitcherK) {
    if (rolloutState === 'OFF') {
      blockReason = 'rollout_state=OFF';
      kPropExecutionPath = 'DISABLED';
    } else if (driver?.basis === 'ODDS_BACKED') {
      // WI-0771: K card produced by ODDS_BACKED path (live line from player_prop_lines)
      // — treat like a priced card; execution is EXECUTABLE when verdict is PLAY/WATCH.
      const oddsBackedVerdict = driver?.card_verdict ?? driver?.verdict ?? null;
      if (oddsBackedVerdict === 'PLAY' || oddsBackedVerdict === 'WATCH') {
        executionStatus = 'EXECUTABLE';
        publishReady = true;
        emitAllowed = true;
        blockReason = null;
        kPropExecutionPath = 'ODDS_BACKED';
        // Mark pricing as FRESH so invariant check passes (line came from player_prop_lines)
        if (normalizedPricingStatus === 'NOT_REQUIRED') {
          pricingState.status = 'FRESH';
          pricingState.reason = 'k_market_line_from_player_prop_lines';
        }
      } else {
        executionStatus = 'PROJECTION_ONLY';
        emitAllowed = true;
        blockReason = 'k_odds_backed_no_edge';
        kPropExecutionPath = 'ODDS_BACKED_NO_EDGE';
      }
    } else {
      // No live line — stay PROJECTION_ONLY
      executionStatus = 'PROJECTION_ONLY';
      emitAllowed = true;
      blockReason = pricingReason ?? null;
      kPropExecutionPath = 'PROJECTION_ONLY';
    }
  } else if (isProjectionOnly || normalizedPricingStatus === 'NOT_REQUIRED') {
    executionStatus = 'PROJECTION_ONLY';
    emitAllowed = true;
    blockReason = pricingReason || 'pricing_status=NOT_REQUIRED';
  } else if (normalizedPricingStatus === 'FRESH') {
    executionStatus = 'EXECUTABLE';
    publishReady = true;
    emitAllowed = true;
    blockReason = null;
  } else if (normalizedPricingStatus === 'MISSING') {
    blockReason = pricingReason || 'pricing_status=MISSING';
  } else if (normalizedPricingStatus === 'STALE') {
    blockReason = pricingReason || 'pricing_status=STALE';
  }

  return {
    execution_status: executionStatus,
    actionable: executionStatus === 'EXECUTABLE',
    _prediction_state: predictionState,
    _pricing_state: pricingState,
    _publish_state: {
      publish_ready: publishReady,
      emit_allowed: emitAllowed,
      execution_status: executionStatus,
      block_reason: blockReason,
    },
    ...(isPitcherK ? { k_prop_execution_path: kPropExecutionPath } : {}),
  };
}

function assertMlbExecutionInvariant(payload) {
  if (!payload || typeof payload !== 'object') return;

  const executionStatus = String(payload.execution_status || '').toUpperCase();
  const pricingStatus = String(payload?._pricing_state?.status || '').toUpperCase();
  const publishReady = payload?._publish_state?.publish_ready === true;
  const actionable = payload.actionable === true;
  const projectionFloor = payload.projection_floor === true;
  const failures = [];

  if (executionStatus === 'EXECUTABLE' && pricingStatus !== 'FRESH') {
    failures.push(
      `execution_status=EXECUTABLE requires _pricing_state.status=FRESH (actual=${pricingStatus || 'MISSING'})`,
    );
  }
  if (executionStatus === 'EXECUTABLE' && publishReady !== true) {
    failures.push('execution_status=EXECUTABLE requires _publish_state.publish_ready=true');
  }
  if (executionStatus === 'PROJECTION_ONLY' && actionable) {
    failures.push('execution_status=PROJECTION_ONLY requires actionable=false');
  }
  if (projectionFloor && executionStatus !== 'PROJECTION_ONLY') {
    failures.push(
      `projection_floor=true requires execution_status=PROJECTION_ONLY (actual=${executionStatus || 'MISSING'})`,
    );
  }
  if (actionable !== (executionStatus === 'EXECUTABLE')) {
    failures.push(
      `actionable must equal execution_status===EXECUTABLE (execution_status=${executionStatus || 'MISSING'}, actionable=${String(actionable)})`,
    );
  }

  if (failures.length === 0) return;

  const error = new Error(`[INVARIANT_BREACH] ${failures.join('; ')}`);
  error.code = 'INVARIANT_BREACH';
  error.failures = failures;

  if (process.env.NODE_ENV === 'test') {
    throw error;
  }

  console.warn(error.message);
}

function computePitcherKPropDisplayState(verdict) {
  if (verdict === 'PLAY') return 'PLAY';
  if (verdict === 'WATCH') return 'WATCH';
  return 'PROJECTION_ONLY';
}

function resolvePitcherKPayloadIdentity(driver = {}, pitcherTeam = null) {
  return {
    playerId: driver.player_id != null ? String(driver.player_id) : null,
    playerName: driver.player_name || (pitcherTeam ? `${pitcherTeam} SP` : 'SP'),
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
  // WI-0771: ODDS_BACKED mode is now active by default. Strikeout lines are
  // read from player_prop_lines (populated by pull_odds_hourly) — no live
  // API calls, no quota drain. When a line is absent the K engine falls back
  // to PROJECTION_ONLY per-pitcher automatically.
  // WI-0791: Respect PITCHER_KS_MODEL_MODE env override (used in tests).
  const envMode = process.env.PITCHER_KS_MODEL_MODE;
  if (envMode === 'PROJECTION_ONLY' || envMode === 'ODDS_BACKED') return envMode;
  return 'ODDS_BACKED';
}

function resolveMlbPitcherPropRolloutState() {
  const value = String(process.env.MLB_K_PROPS || 'SHADOW').toUpperCase();
  if (['OFF', 'SHADOW', 'LIMITED_LIVE', 'FULL'].includes(value)) {
    return value;
  }
  return 'SHADOW';
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

function normalizePitcherKPrice(value) {
  const price = toFiniteNumber(value);
  return price === null ? null : Math.trunc(price);
}

function buildPitcherKLineContract(rawEntry = null) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;

  const line = toFiniteNumber(rawEntry.line);
  const bookmaker = String(rawEntry.bookmaker || rawEntry.book || '').trim() || null;
  const lineSource =
    String(rawEntry.line_source || rawEntry.source || bookmaker || '').trim() || null;
  const currentTimestamp =
    String(rawEntry.current_timestamp || rawEntry.fetched_at || '').trim() || null;
  const altLines = (Array.isArray(rawEntry.alt_lines) ? rawEntry.alt_lines : [])
    .map((altLine) => {
      if (!altLine || typeof altLine !== 'object') return null;
      const altLineValue = toFiniteNumber(altLine.line);
      const side = String(altLine.side || '').trim().toLowerCase();
      const juice = normalizePitcherKPrice(altLine.juice ?? altLine.price);
      const book = String(altLine.book || altLine.bookmaker || '').trim() || null;
      if (altLineValue === null || !['over', 'under'].includes(side)) return null;
      return {
        line: altLineValue,
        side,
        juice,
        book,
        source: String(altLine.source || altLine.line_source || lineSource || '').trim() || null,
        captured_at:
          String(altLine.captured_at || altLine.current_timestamp || currentTimestamp || '').trim() ||
          null,
      };
    })
    .filter(Boolean);

  if (
    line === null &&
    normalizePitcherKPrice(rawEntry.over_price) === null &&
    normalizePitcherKPrice(rawEntry.under_price) === null &&
    altLines.length === 0
  ) {
    return null;
  }

  return {
    line,
    over_price: normalizePitcherKPrice(rawEntry.over_price),
    under_price: normalizePitcherKPrice(rawEntry.under_price),
    bookmaker,
    line_source: lineSource,
    opening_line: toFiniteNumber(rawEntry.opening_line),
    opening_over_price: normalizePitcherKPrice(rawEntry.opening_over_price),
    opening_under_price: normalizePitcherKPrice(rawEntry.opening_under_price),
    best_available_line: pickFirstFinite(rawEntry.best_available_line, line),
    best_available_over_price: normalizePitcherKPrice(
      rawEntry.best_available_over_price ?? rawEntry.over_price,
    ),
    best_available_under_price: normalizePitcherKPrice(
      rawEntry.best_available_under_price ?? rawEntry.under_price,
    ),
    best_available_bookmaker:
      String(rawEntry.best_available_bookmaker || bookmaker || '').trim() || null,
    current_timestamp: currentTimestamp,
    alt_lines: altLines,
  };
}

function isTimestampFresh(timestamp, maxAgeMinutes = MLB_K_PROP_FRESHNESS_MINUTES, now = Date.now()) {
  if (!timestamp) return false;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return false;
  return now - parsed <= maxAgeMinutes * 60 * 1000;
}

function filterSnapshotsByGameIds(snapshots = [], gameIds = null) {
  const targetIds = new Set(
    Array.isArray(gameIds)
      ? gameIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  );
  if (targetIds.size === 0) return Array.isArray(snapshots) ? snapshots : [];
  return (Array.isArray(snapshots) ? snapshots : []).filter((snapshot) =>
    targetIds.has(String(snapshot?.game_id || '')),
  );
}

function getPitcherRoleFromDriver(driver) {
  if (!driver?.market) return null;
  if (String(driver.market).endsWith('_home')) return 'home';
  if (String(driver.market).endsWith('_away')) return 'away';
  return null;
}

function evaluatePitcherPropPublishability(_oddsSnapshot, _driver) {
  return {
    publishable: false,
    status: 'NOT_REQUIRED',
    reason: null,
    fetched_at: null,
    line_contract: null,
  };
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
      SELECT season, game_date, strikeouts, number_of_pitches, innings_pitched,
             walks, batters_faced, home_away
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
            SELECT season, game_date, strikeouts, number_of_pitches, innings_pitched,
                   walks, batters_faced, home_away
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
    // WI-0763: walks + batters_faced feed BB% modifier; home_away feeds split adjustment
    walks: toFiniteNumber(row.walks ?? 0),
    batters_faced: toFiniteNumber(row.batters_faced ?? 0),
    home_away: row.home_away ?? null,
    // hits and earned_runs are fetched by pull_mlb_pitcher_stats.js but intentionally
    // excluded here — H/9 and ERA-proxy carry negligible K rate signal value.
  }));
}

const PROJECTION_FLOOR_F5_FALLBACK = 4.5;

/**
 * Look up starter skill RA9 for a team from mlb_pitcher_stats.
 * Uses normalized weighted blend: SIERA (0.40) + xFIP (0.35) + xERA (0.25).
 * Only non-null signals contribute; weights are re-normalized so the result is
 * never silently miscalibrated by absent inputs.
 * Currently: SIERA is computed from K%/BB% (estimated via league-avg GB rate);
 * xERA requires Statcast barrel data and is null until that WI ships.
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
      'SELECT siera, x_fip, x_era FROM mlb_pitcher_stats WHERE team = ? ORDER BY updated_at DESC LIMIT 1',
    );
    for (const key of resolveMlbTeamLookupKeys(team)) {
      const row = stmt.get(key);
      if (!row) continue;
      const parts = [
        { value: row.siera != null ? toFiniteNumber(row.siera) : null, weight: 0.4 },
        { value: row.x_fip != null ? toFiniteNumber(row.x_fip) : null, weight: 0.35 },
        { value: row.x_era != null ? toFiniteNumber(row.x_era) : null, weight: 0.25 },
      ].filter((part) => part.value !== null);
      if (parts.length === 0) continue;
      const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
      return parts.reduce(
        (sum, part) => sum + (part.value * part.weight),
        0,
      ) / totalWeight;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Derive a synthetic F5 total projection floor from starter skill metrics.
 * First attempts to read normalized weighted blend SIERA/xFIP/xERA from oddsSnapshot.raw_data.mlb.
 * Only non-null signals contribute; weights are re-normalized automatically.
 * Currently: SIERA computed from K%/BB%; xERA null until Statcast WI ships.
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
    function resolvePitcherSkill(pitcher) {
      const parts = [
        { value: pitcher?.siera != null ? toFiniteNumber(pitcher.siera) : null, weight: 0.4 },
        { value: pitcher?.x_fip != null ? toFiniteNumber(pitcher.x_fip) : null, weight: 0.35 },
        { value: pitcher?.x_era != null ? toFiniteNumber(pitcher.x_era) : null, weight: 0.25 },
      ].filter((part) => part.value !== null);
      if (parts.length === 0) return null;
      const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
      return parts.reduce(
        (sum, part) => sum + (part.value * part.weight),
        0,
      ) / totalWeight;
    }

    let homeSkillRa9 = resolvePitcherSkill(mlb.home_pitcher);
    let awaySkillRa9 = resolvePitcherSkill(mlb.away_pitcher);

    // WITHOUT_ODDS_MODE: raw_data is null — fall back to DB lookup by team abbreviation.
    // Guard: only call DB when the pitcher object itself is absent; if a pitcher object
    // exists but lacks siera/xfip/xera (resolvePitcherSkill returns null), we fall
    // through to PROJECTION_FLOOR_F5_FALLBACK rather than fetching stale DB data.
    if (homeSkillRa9 === null && oddsSnapshot?.home_team && mlb.home_pitcher == null) {
      homeSkillRa9 = getPitcherEraFromDb(oddsSnapshot.home_team);
    }
    if (awaySkillRa9 === null && oddsSnapshot?.away_team && mlb.away_pitcher == null) {
      awaySkillRa9 = getPitcherEraFromDb(oddsSnapshot.away_team);
    }

    if (homeSkillRa9 === null || awaySkillRa9 === null) return PROJECTION_FLOOR_F5_FALLBACK;
    const raw = (homeSkillRa9 / 9) * 5 + (awaySkillRa9 / 9) * 5;
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
  'season_k_pct',         // starter K% — primary stat for k_interaction
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
  if (
    pitcher?.last_three_pitch_counts == null &&
    pitcher?.recent_ip == null &&
    pitcher?.avg_ip == null
  ) {
    missing.push('starter_leash');
  }
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
    x_fip: row.x_fip ?? null,
    siera: row.siera ?? null,
    x_era: row.x_era ?? null,
    bb_pct: row.bb_pct ?? null,
    hr_per_9: row.hr_per_9 ?? null,
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
function enrichMlbPitcherData(
  oddsSnapshot,
  { forKEngine = false, useF5ProjectionFloor = false } = {},
) {
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
    mlb.f5_line =
      oddsSnapshot.total_f5 ??
      mlb.f5_line ??
      (useF5ProjectionFloor ? computeProjectionFloorF5(oddsSnapshot) : null);
    mlb.home_offense_profile =
      mlb.home_offense_profile ?? resolveMlbF5OffenseProfile(homeTeam);
    mlb.away_offense_profile =
      mlb.away_offense_profile ?? resolveMlbF5OffenseProfile(awayTeam);
    mlb.park_run_factor =
      mlb.park_run_factor ?? resolveMlbF5ParkRunFactor(homeTeam);

    // WI-0771: Hydrate per-pitcher strikeout market lines from player_prop_lines.
    // Reads from DB only (no live API calls). Attaches k_market_lines directly
    // to each pitcher object so computePitcherKDriverCards can use the correct
    // lines without cross-pitcher contamination.
    if (forKEngine) {
      try {
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        const kPropRows = db.prepare(`
          SELECT player_name, line, over_price, under_price, bookmaker, fetched_at
          FROM player_prop_lines
          WHERE sport = 'mlb' AND prop_type = 'strikeouts' AND fetched_at > ?
          ORDER BY fetched_at DESC
        `).all(threeHoursAgo);

        // Index: normalized_pitcher_name → bookmaker → line entry (most recent wins)
        const kLinesByPitcher = {};
        for (const row of kPropRows) {
          const pitcherKey = normalizePitcherLookupKey(row.player_name);
          if (!kLinesByPitcher[pitcherKey]) kLinesByPitcher[pitcherKey] = {};
          const bkKey = String(row.bookmaker || 'unknown').toLowerCase();
          if (!kLinesByPitcher[pitcherKey][bkKey]) {
            kLinesByPitcher[pitcherKey][bkKey] = {
              line: row.line,
              under_price: row.under_price,
              over_price: row.over_price,
              bookmaker: row.bookmaker,
              line_source: row.bookmaker,
              fetched_at: row.fetched_at,
            };
          }
        }

        // Resolve and attach per-pitcher lines (keyed by bookmaker)
        function resolvePitcherKMarketLines(pitcher) {
          if (!pitcher || typeof pitcher !== 'object') return {};
          const key = normalizePitcherLookupKey(pitcher.full_name);
          return kLinesByPitcher[key] ?? {};
        }

        // Pending pitcher build — attach after buildPitcherEntry runs (below).
        // Store the lookup map so post-build assignment can use it.
        mlb._kLinesByPitcher = kLinesByPitcher;
      } catch (_kLinesErr) {
        // Non-fatal — K engine will fall back to PROJECTION_ONLY per-pitcher
        console.warn(`[MLBModel] [pitcher-k] player_prop_lines query failed: ${_kLinesErr.message}`);
        mlb._kLinesByPitcher = {};
      }
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
        mlb.wind_dir = weatherRow.wind_dir ?? mlb.wind_dir ?? null;
      }
      if (weatherRow?.conditions) {
        mlb.roof = weatherRow.conditions;
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
          ? {
              era: row.era,
              whip: row.whip,
              k_per_9: row.k_per_9,
              recent_k_per_9: row.recent_k_per_9,
              avg_ip: row.recent_ip,
              handedness: row.handedness ?? null,
              x_fip: row.x_fip ?? null,
              siera: row.siera ?? null,
              x_era: row.x_era ?? null,
              bb_pct: row.bb_pct ?? null,
              hr_per_9: row.hr_per_9 ?? null,
              season_k_pct: row.season_k_pct ?? null,
            }
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

    // WI-0771: Attach per-pitcher market lines after pitcher objects are built.
    // k_market_lines is keyed by bookmaker → { line, under_price, over_price, ... }.
    if (forKEngine && mlb._kLinesByPitcher) {
      const kMap = mlb._kLinesByPitcher;
      if (mlb.home_pitcher && typeof mlb.home_pitcher === 'object') {
        const hKey = normalizePitcherLookupKey(mlb.home_pitcher.full_name);
        mlb.home_pitcher.k_market_lines = kMap[hKey] ?? {};
      }
      if (mlb.away_pitcher && typeof mlb.away_pitcher === 'object') {
        const aKey = normalizePitcherLookupKey(mlb.away_pitcher.full_name);
        mlb.away_pitcher.k_market_lines = kMap[aKey] ?? {};
      }
      delete mlb._kLinesByPitcher; // clean up temp storage
    }

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
  gameIds = null,
} = {}) {
  // When MLB odds are disabled in config (projection-only period), force without-odds
  // mode regardless of what the scheduler or caller passes. Self-heals when
  // ODDS_SPORTS_CONFIG.MLB.active is flipped back to true on May 1.
  if (!ODDS_SPORTS_CONFIG.MLB.active) {
    withoutOddsMode = true;
  }

  const jobRunId = `job-mlb-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[MLBModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[MLBModel] Job key: ${jobKey}`);
  }
  console.log(`[MLBModel] Time: ${new Date().toISOString()}`);
  if (withoutOddsMode) {
    console.log('[MLBModel] WITHOUT_ODDS_MODE: MLB odds disabled in config — running projection-only');
  }

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
      const requestedGameIds = Array.isArray(gameIds) && gameIds.length > 0
        ? new Set(gameIds.map((value) => String(value)))
        : null;

      // Group by game_id and get latest for each
      const gameOdds = {};
      oddsSnapshots.forEach((snap) => {
        if (requestedGameIds && !requestedGameIds.has(String(snap.game_id))) {
          return;
        }
        if (
          !gameOdds[snap.game_id] ||
          snap.captured_at > gameOdds[snap.game_id].captured_at
        ) {
          gameOdds[snap.game_id] = snap;
        }
      });

      const gameIdList = Object.keys(gameOdds);
      console.log(`[MLBModel] Running inference on ${gameIdList.length} games...`);

      // Get model instance
      const model = getModel('MLB');

      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];
      const gamePipelineStates = {};
      const pitcherPropSummary = {};
      const rolloutState = resolveMlbPitcherPropRolloutState();

      // Process each game — emit one card per qualifying driver market
      for (const gameId of gameIdList) {
        try {
          const baseOddsSnapshot = gameOdds[gameId];
          const gameOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
            forKEngine: false,
            useF5ProjectionFloor: withoutOddsMode,
          });
          const pitcherKOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
            forKEngine: true,
          });

          const gameDriverCards = computeMLBDriverCards(gameId, gameOddsSnapshot);
          // K props draw from player_prop_lines — independent of F5 total line.
          // Always pass the resolved mode; per-pitcher fallback to PROJECTION_ONLY
          // happens inside computePitcherKDriverCards when no strikeout line is found.
          const _kMode = resolvePitcherKsMode();
          const _kCallOptions =
            _kMode === 'ODDS_BACKED'
              ? { mode: _kMode, bookmakerPriority: MLB_PROP_BOOKMAKER_PRIORITY }
              : { mode: _kMode };
          const rawPitcherKDriverCards = computePitcherKDriverCards(gameId, pitcherKOddsSnapshot, _kCallOptions);
          const pitcherKDriverCards = rawPitcherKDriverCards.map((driver) => {
            if (!driver.market?.startsWith('pitcher_k_')) return driver;

            // ── WI-0747: MLB_K_AUDIT — quality classification before card write ──
            if (driver.prop_decision) {
              const pd = driver.prop_decision;
              const missingInputs = pd.missing_inputs ?? [];
              const degradedInputs = pd.degraded_inputs ?? [];
              // WI-0770: use real swstr_pct from DB via model output (starter_swstr_pct
              // is the raw DB value returned by calculateProjectionK — null when
              // season_swstr_pct not yet populated by pull_mlb_statcast).
              const _realSwstrPct = driver.projection?.starter_swstr_pct ?? null;
              const _statcastSwstrMissing = missingInputs.includes('statcast_swstr');
              // Map model-layer flags → classifier input signals
              const _starter = {
                k_pct:       missingInputs.includes('starter_k_pct') ? null : 0.25,
                swstr_pct:   _statcastSwstrMissing ? null : _realSwstrPct,
                csw_pct:     null,
                whiff_proxy: null, // WI-0770: no hardcoded proxy — absent means absent
              };
              const _leash = {
                pitch_count_avg: missingInputs.includes('leash_metric') ? null : 90,
                ip_proxy:        missingInputs.includes('leash_metric') ? 5.5 : null,
              };
              const _opponent = {
                k_pct_vs_hand:       (missingInputs.includes('opp_k_pct_vs_hand') ||
                                      missingInputs.includes('league_avg_k_fallback')) ? null : 0.22,
                contact_pct_vs_hand: missingInputs.includes('opponent_contact_profile') ? null : 0.76,
              };
              const _qr = classifyMlbPitcherKQuality({ starter: _starter, opponent: _opponent, leash: _leash });
              pd.model_quality        = _qr.model_quality;
              pd.proxy_fields         = _qr.proxies;
              pd.degradation_reasons  = [..._qr.hardMissing, ..._qr.proxies];
              // WI-0770: surface statcast_inputs in prop_decision for downstream inspection
              pd.statcast_inputs      = driver.pitcher_k_result?.statcast_inputs ?? null;
              // Dedup pre-existing missing_inputs and flags
              pd.missing_inputs = dedupeFlags(pd.missing_inputs ?? []);
              pd.flags          = dedupeFlags(pd.flags ?? []);
              const sideStr = driver.market?.endsWith('_home') ? 'home' : 'away';
              const _mlbRaw = (typeof pitcherKOddsSnapshot.raw_data === 'string'
                ? JSON.parse(pitcherKOddsSnapshot.raw_data)
                : pitcherKOddsSnapshot.raw_data) ?? {};
              const _pitcher = (_mlbRaw.mlb ?? {})[`${sideStr}_pitcher`];
              console.log(`[MLB_K_AUDIT] ${JSON.stringify({
                pitcher:                  _pitcher?.full_name ?? `${sideStr}_sp`,
                starter_skill_status:     (missingInputs.includes('statcast_swstr') ||
                                           missingInputs.includes('starter_k_pct')) ? 'PARTIAL' : 'COMPLETE',
                opponent_contact_status:  missingInputs.includes('opponent_contact_profile') ? 'PARTIAL' : 'COMPLETE',
                leash_status:             missingInputs.includes('leash_metric') ? 'PARTIAL' : 'COMPLETE',
                missing_fields:           _qr.hardMissing,
                proxy_fields:             _qr.proxies,
                quality_before_projection: _qr.model_quality,
              })}`);
            }
            // ────────────────────────────────────────────────────────────────────

            if (driver.emit_card !== true) {
              driver.execution_envelope = null;
              return driver;
            }
            const publishability = evaluatePitcherPropPublishability(pitcherKOddsSnapshot, driver);
            const executionEnvelope = deriveMlbExecutionEnvelope({
              driver,
              pricingStatus: publishability.status,
              pricingReason: publishability.reason,
              pricingCapturedAt: publishability.fetched_at,
              isPitcherK: true,
              rolloutState,
            });
            driver.odds_freshness = publishability.status;
            driver.line_fetched_at = publishability.fetched_at;
            driver.execution_envelope = executionEnvelope;
            if (driver.prop_decision) {
              driver.prop_decision.flags = uniqueReasonCodes([
                ...(driver.prop_decision.flags || []),
                ...(publishability.reason ? [publishability.reason] : []),
              ]);
            }
            driver.emit_card = executionEnvelope._publish_state.emit_allowed === true;
            driver.block_publish_reason =
              executionEnvelope._publish_state.block_reason;
            return driver;
          });
          const gamePitcherSummary = {
            executable_props_published: 0,
            leans_only_count: 0,
            pass_count: 0,
            execution_path_counts: {},
          };
          for (const driver of pitcherKDriverCards) {
            if (!driver.market?.startsWith('pitcher_k_')) continue;
            const executionEnvelope = driver.execution_envelope;
            if (executionEnvelope?.k_prop_execution_path) {
              gamePitcherSummary.execution_path_counts[executionEnvelope.k_prop_execution_path] =
                (gamePitcherSummary.execution_path_counts[executionEnvelope.k_prop_execution_path] || 0) + 1;
            }
            if (executionEnvelope?.execution_status === 'EXECUTABLE') {
              gamePitcherSummary.executable_props_published += 1;
            } else if (executionEnvelope?._publish_state?.emit_allowed === true) {
              gamePitcherSummary.leans_only_count += 1;
            } else {
              gamePitcherSummary.pass_count += 1;
            }
          }
          pitcherPropSummary[gameId] = gamePitcherSummary;
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
          const projectionFloorF5 = (f5TotalContextForFloor.line === null)
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

          // Synthesize a PROJECTION_ONLY F5 driver when the floor was applied (no market line available)
          const projectionFloorDriver = (marketAvailability.projection_floor && projectionFloorF5 !== null)
            ? {
                market: 'f5_total',
                prediction: 'OVER',
                confidence: 0.5,
                status: 'PASS',
                action: 'PASS',
                classification: 'PASS',
                ev_threshold_passed: false,
                projection_source: 'SYNTHETIC_FALLBACK',
                status_cap: 'PASS',
                reason_codes: ['PASS_SYNTHETIC_FALLBACK', 'PASS_NO_EDGE'],
                missing_inputs: ['market_line'],
                pass_reason_code: 'PASS_SYNTHETIC_FALLBACK',
                playability: {
                  over_playable_at_or_below: projectionFloorF5 - 0.5,
                  under_playable_at_or_above: projectionFloorF5 + 0.5,
                },
                projection: {
                  projected_total: projectionFloorF5,
                  projected_total_low: Math.max(0, projectionFloorF5 - 0.5),
                  projected_total_high: projectionFloorF5 + 0.5,
                  projected_home_f5_runs: Math.round((projectionFloorF5 / 2) * 10) / 10,
                  projected_away_f5_runs: Math.round((projectionFloorF5 / 2) * 10) / 10,
                },
                reasoning: `F5 SYNTHETIC_FALLBACK projection floor ${projectionFloorF5.toFixed(1)}; PASS only until a real F5 market line is available`,
                drivers: [{
                  type: 'mlb-f5-projection-floor',
                  projected: projectionFloorF5,
                  edge: 0,
                  projection_source: 'SYNTHETIC_FALLBACK',
                }],
                without_odds_mode: true,
                projection_floor: true,
                projection_floor_line: projectionFloorF5,
              }
            : null;
          const gamePricingStatus = gameOddsSnapshot?.captured_at ? 'FRESH' : 'MISSING';
          const gamePricingReason = gameOddsSnapshot?.captured_at
            ? null
            : 'ODDS_SNAPSHOT_MISSING';
          const candidateDrivers = [
            ...(selectedGameDriver
              ? [{
                  driver: selectedGameDriver,
                  executionEnvelope: deriveMlbExecutionEnvelope({
                    driver: selectedGameDriver,
                    pricingStatus: gamePricingStatus,
                    pricingReason: gamePricingReason,
                    pricingCapturedAt: gameOddsSnapshot?.captured_at ?? null,
                  }),
                }]
              : []),
            ...pitcherKDriverCards
              .filter((driver) => driver.execution_envelope)
              .map((driver) => ({
                driver,
                executionEnvelope: driver.execution_envelope,
              })),
            ...(f5MlDriverCard?.ev_threshold_passed
              ? [{
                  driver: f5MlDriverCard,
                  executionEnvelope: deriveMlbExecutionEnvelope({
                    driver: f5MlDriverCard,
                    pricingStatus: gamePricingStatus,
                    pricingReason: gamePricingReason,
                    pricingCapturedAt: gameOddsSnapshot?.captured_at ?? null,
                  }),
                }]
              : []),
            ...(projectionFloorDriver
              ? [{
                  driver: projectionFloorDriver,
                  executionEnvelope: deriveMlbExecutionEnvelope({
                    driver: projectionFloorDriver,
                    pricingStatus: 'NOT_REQUIRED',
                    pricingReason: 'PROJECTION_FLOOR',
                    pricingCapturedAt: null,
                  }),
                }]
              : []),
          ];
          const candidateExecutionEnvelopes = candidateDrivers.map(
            ({ executionEnvelope }) => executionEnvelope,
          );
          const qualified = candidateDrivers
            .filter(
              ({ executionEnvelope }) =>
                executionEnvelope?._publish_state?.emit_allowed === true,
            )
            .map(({ driver, executionEnvelope }) => {
              driver.execution_envelope = executionEnvelope;
              if (executionEnvelope.k_prop_execution_path) {
                driver.k_prop_execution_path =
                  executionEnvelope.k_prop_execution_path;
              }
              return driver;
            });

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
            executionEnvelopes: candidateExecutionEnvelopes,
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
            const { playerId: pitcherPlayerId, playerName: pitcherPlayerName } =
              resolvePitcherKPayloadIdentity(driver, pitcherTeam);

            const tier = isPitcherK
              ? (driver.card_verdict === 'PLAY'
                  ? 'BEST'
                  : driver.card_verdict === 'WATCH'
                    ? 'WATCH'
                    : null)
              : driver.ev_threshold_passed === false
                ? null
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
              status: driver.status ?? (driver.ev_threshold_passed ? 'FIRE' : 'PASS'),
              action: driver.action ?? (driver.ev_threshold_passed ? 'FIRE' : 'PASS'),
              classification: driver.classification ?? (driver.ev_threshold_passed ? 'BASE' : 'PASS'),
              prediction: driver.prediction,
              selection: {
                side: driver.prediction,
              },
              line,
              confidence: driver.confidence,
              tier,
              ev_passed:
                isPitcherK
                  ? driver.card_verdict === 'PLAY' ||
                    driver.card_verdict === 'WATCH'
                  : driver.ev_threshold_passed === true,
              reasoning: driver.reasoning,
              reason_codes: Array.isArray(driver.reason_codes) ? driver.reason_codes : [],
              pass_reason_code: driver.pass_reason_code ?? null,
              projection_source: driver.projection_source ?? null,
              status_cap: driver.status_cap ?? null,
              playability: driver.playability ?? null,
              missing_inputs: dedupeFlags(Array.isArray(driver.missing_inputs) ? driver.missing_inputs : []),
              disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
              // Note: driver.prop_decision already carries model_quality (set by WI-0747 classifier block above)
              generated_at: now,
              // When global withoutOddsMode is active (MLB odds disabled in config), mark all cards
              // as without_odds_mode so the DB lock bypasses the price requirement.
              // projection_floor is only set when the driver itself is a synthetic floor driver.
              ...((driver.without_odds_mode || withoutOddsMode) ? { without_odds_mode: true, tags: ['no_odds_mode'] } : {}),
              ...(driver.projection_floor ? { projection_floor: true } : {}),
              ...(isF5
                ? {
                    projection:
                      driver.projection && typeof driver.projection === 'object'
                        ? driver.projection
                        : { projected_total: projected },
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
                      player_id: pitcherPlayerId,
                      player_name: pitcherPlayerName,
                      canonical_market_key: 'pitcher_strikeouts',
                      basis: driver.basis || 'PROJECTION_ONLY',
                      tags: ['no_odds_mode'],
                      projection:
                        driver.projection && typeof driver.projection === 'object'
                          ? driver.projection
                          : (projected !== null ? { k_mean: projected } : null),
                      prop_display_state: computePitcherKPropDisplayState(
                        driver.prop_decision?.verdict ?? driver.card_verdict,
                      ),
                      prop_decision: driver.prop_decision ?? null,
                      pitcher_k_result: driver.pitcher_k_result ?? null,
                      // Odds-backed enrichment (null in PROJECTION_ONLY)
                      line_source: driver.line_source ?? null,
                      over_price: driver.over_price ?? null,
                      under_price: driver.under_price ?? null,
                      best_line_bookmaker: driver.best_line_bookmaker ?? null,
                      margin: driver.margin ?? null,
                      line_fetched_at: driver.line_fetched_at ?? null,
                      odds_freshness: driver.odds_freshness ?? null,
                      block_publish_reason: driver.block_publish_reason ?? null,
                    }
                  : {
                      player_name: pitcherTeam ? `${pitcherTeam} SP` : 'SP',
                      canonical_market_key: 'pitcher_strikeouts',
                    }),
            };
            const projectionOnlyMarket = isF5 || isF5ML || isPitcherK;
            const executionEnvelope = driver.execution_envelope || deriveMlbExecutionEnvelope({
              driver,
              pricingStatus:
                projectionOnlyMarket || driver.without_odds_mode || driver.projection_floor
                  ? 'NOT_REQUIRED'
                  : gamePricingStatus,
              pricingReason:
                projectionOnlyMarket || driver.without_odds_mode || driver.projection_floor
                  ? 'PROJECTION_ONLY_MARKET'
                  : gamePricingReason,
              pricingCapturedAt: gameOddsSnapshot?.captured_at ?? null,
              isPitcherK,
              rolloutState: isPitcherK ? rolloutState : null,
            });
            driver.execution_envelope = executionEnvelope;
            Object.assign(payloadData, executionEnvelope);
            if (isPitcherK && payloadData.basis === 'PROJECTION_ONLY') {
              payloadData.basis = 'PROJECTION_ONLY';
              payloadData.tags = ['no_odds_mode'];
              payloadData.line_source = null;
              payloadData.over_price = null;
              payloadData.under_price = null;
              payloadData.best_line_bookmaker = null;
              payloadData.margin = null;
              payloadData.line_fetched_at = null;
              payloadData.odds_freshness = null;
            }
            assertMlbExecutionInvariant(payloadData);

            const cardTitle = isF5
              ? `F5 ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
              : isF5ML
                ? `F5 ML ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
                : isPitcherK
                  ? `${pitcherTeam ?? '?'} SP Ks ${driver.prediction} [PROJECTION_ONLY]`
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
        pitcher_prop_summary: pitcherPropSummary,
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
  resolveMlbPitcherPropRolloutState,
  resolvePitcherKPayloadIdentity,
  isTimestampFresh,
  filterSnapshotsByGameIds,
  evaluatePitcherPropPublishability,
  deriveMlbExecutionEnvelope,
  assertMlbExecutionInvariant,
  // Exported for WI-0596 unit tests
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
  buildPitcherKLineContract,
  buildPitcherStrikeoutLookback,
  // Exported for WI-0637 unit tests
  computeProjectionFloorF5,
  // Exported for WI-0648 unit tests
  MIN_MLB_GAMES_FOR_RECAL,
};
