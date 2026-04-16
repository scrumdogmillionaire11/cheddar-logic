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
const { DateTime } = require('luxon');

// Import cheddar-logic data layer
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  getOddsWithUpcomingGames,
  getUpcomingGamesAsSyntheticSnapshots,
  insertModelOutput,
  insertCardPayload,
  prepareModelAndCardWrite,
  runPerGameWriteTransaction,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  // WI-0840: dynamic league constants query
  computeMLBLeagueAverages,
  resolveSnapshotAge,
} = require('@cheddar-logic/data');

// Import pluggable inference layer
const { computeMLBDriverCards, computePitcherKDriverCards } = require('../models');
const { evaluateMlbGameMarkets, projectF5ML, projectTeamF5RunsAgainstStarter, setLeagueConstants } = require('../models/mlb-model');
const { assertNoSilentMarketDrop, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');

// WI-0648: Empirical sigma recalibration gate
// Threshold: once a team has accumulated >= MIN_MLB_GAMES_FOR_RECAL settled games
// in the 2026 season, computeSigmaFromHistory replaces MLB_SIGMA_DEFAULT constants.
const edgeCalculator = require('@cheddar-logic/models/src/edge-calculator');

const MIN_MLB_GAMES_FOR_RECAL = parseInt(process.env.MIN_MLB_GAMES_FOR_RECAL || '20', 10);

// Pitcher K runtime mode: ODDS_BACKED when player_prop_lines has a recent
// strikeout line for the pitcher; PROJECTION_ONLY per-pitcher when absent.
const MLB_K_PROP_FRESHNESS_MINUTES = Number(
  process.env.MLB_K_PROP_FRESHNESS_MINUTES || 75,
);
const {
  buildMatchup,
  buildPipelineState,
  WATCHDOG_REASONS,
  PRICE_REASONS,
} = require('@cheddar-logic/models');

// WI-0747: MLB K explicit input contract — deterministic quality classifier
const {
  classifyMlbPitcherKQuality,
  dedupeFlags,
} = require('./mlb-k-input-classifier');
const { evaluateExecution } = require('./execution-gate');
const { applyCalibration } = require('../utils/calibration');
const { assertFeatureTimeliness } = require('../models/feature-time-guard');
const { pullMlbStatcast } = require('./pull_mlb_statcast');
const {
  MLB_TEAM_ABBREVIATIONS,
  MLB_PROP_BOOKMAKER_PRIORITY,
  MLB_F5_TEAM_OFFENSE_SPLITS,
  MLB_F5_PARK_RUN_FACTORS,
  MLB_TEAM_VARIANT_ALIASES,
} = require('./mlb-runner-constants');

// MLB-specific watchdog vocabulary stays local to this runner so WI-0604 can
// document the new codes without widening shared registries.
const MLB_PIPELINE_REASON_CODES = Object.freeze({
  F5_TOTAL_UNAVAILABLE: 'F5_TOTAL_UNAVAILABLE',
  F5_ML_UNAVAILABLE: 'F5_ML_UNAVAILABLE',
});

const MLB_MARKET_TRUST_CLASS = Object.freeze({
  ODDS_BACKED: 'ODDS_BACKED',
  PROJECTION_ONLY: 'PROJECTION_ONLY',
});

const MLB_MARKET_GROUP = Object.freeze({
  FULL_GAME_TOTAL: 'FULL_GAME_TOTAL',
  FULL_GAME_ML: 'FULL_GAME_ML',
  F5_TOTAL: 'F5_TOTAL',
  F5_ML: 'F5_ML',
  PITCHER_K: 'PITCHER_K',
  OTHER_PROP: 'OTHER_PROP',
});

const MLB_SEED_CONTEXT_MAX_AGE_MINUTES = Number(
  process.env.MODEL_ODDS_MAX_AGE_MINUTES ||
    process.env.ODDS_GAP_ALERT_MINUTES ||
    210,
);
const MLB_PROJECTION_ONLY_MARKET_FLAGS = Object.freeze([
  'PROJECTION_ONLY_NO_MARKET_TRUST',
  'PROJECTION_ONLY_NOT_ACTIONABLE',
  'NO_ANCHOR_PRICE_VALIDATION',
]);

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
  const mlb = rawData?.mlb && typeof rawData.mlb === 'object' ? rawData.mlb : {};

  const line = pickFirstFinite(
    oddsSnapshot?.total,
    mlb?.full_game_line,
    rawEntry?.line,
    rawEntry?.total,
  );
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

function hydrateCanonicalMlbMarketLines(
  oddsSnapshot,
  existingMlb = {},
  { useF5ProjectionFloor = false } = {},
) {
  const mlb = existingMlb && typeof existingMlb === 'object' ? { ...existingMlb } : {};
  const canonicalFullGameLine = pickFirstFinite(
    oddsSnapshot?.total,
    mlb.full_game_line,
    mlb.total_line,
  );

  mlb.full_game_line = canonicalFullGameLine;
  delete mlb.total_line;
  mlb.f5_line =
    oddsSnapshot?.total_f5 ??
    mlb.f5_line ??
    (useF5ProjectionFloor ? computeProjectionFloorF5(oddsSnapshot) : null);

  return mlb;
}

function buildMlbMarketAvailability(oddsSnapshot, { expectF5Ml = false, withoutOddsMode = false, projectionFloorF5 = null } = {}) {
  const f5TotalContext = resolveMlbF5TotalContext(oddsSnapshot);
  const f5MoneylineContext = resolveMlbF5MoneylineContext(oddsSnapshot);
  const fullGameTotalContext = resolveMlbFullGameTotalContext(oddsSnapshot);
  const blockingReasonCodes = [];

  // F5 availability: F5 total line required for F5 markets
  const f5LineOk = f5TotalContext.line !== null;
  const useFloor = projectionFloorF5 !== null && !f5LineOk;
  const effectiveF5LineOk = f5LineOk || useFloor;

  // F5 ML availability: F5 ML prices or fallback to full-game ML prices
  const f5MlOk =
    f5MoneylineContext.home !== null && f5MoneylineContext.away !== null;

  // Full-game total availability: Full-game total line only (independent of F5)
  const fullGameTotalOk = withoutOddsMode
    ? false
    : fullGameTotalContext.line !== null;

  // Full-game ML availability: h2h_home and h2h_away prices (independent of F5)
  const fullGameMlOk =
    toFiniteNumber(oddsSnapshot?.h2h_home) !== null &&
    toFiniteNumber(oddsSnapshot?.h2h_away) !== null;

  // F5 diagnostic codes (not hard blockers for full-game markets)
  if (!effectiveF5LineOk) {
    blockingReasonCodes.push(MLB_PIPELINE_REASON_CODES.F5_TOTAL_UNAVAILABLE);
  }
  if (useFloor) {
    blockingReasonCodes.push(PRICE_REASONS.MARKET_PRICE_MISSING);
  }
  if (expectF5Ml && !f5MlOk) {
    blockingReasonCodes.push(MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE);
  }

  // Only block entire game if NO suitable market lines available at all
  // Full-game markets can proceed with their own prices even if F5 is unavailable
  if (!effectiveF5LineOk && !fullGameTotalOk && !fullGameMlOk) {
    blockingReasonCodes.push(WATCHDOG_REASONS.MARKET_UNAVAILABLE);
  }

  if (withoutOddsMode) {
    blockingReasonCodes.push('PROJECTION_ONLY_NO_TOTALS');
  }

  return {
    f5_line_ok: effectiveF5LineOk,
    f5_ml_ok: f5MlOk,
    full_game_total_ok: fullGameTotalOk,
    full_game_ml_ok: fullGameMlOk,
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
  // Market readiness: F5 total, full-game total, full-game ML, or F5 ML if expected
  const marketLinesOk =
    availability.f5_line_ok ||
    availability.full_game_total_ok ||
    availability.full_game_ml_ok ||
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

function formatMlbProjectionOnlyContextLog(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    return 'disabled';
  }

  return [
    `run_mode=${runtimeContext.run_mode ?? 'UNKNOWN'}`,
    `seed_data_status=${runtimeContext.seed_data_status ?? 'UNKNOWN'}`,
    `seed_last_success_at=${runtimeContext.seed_last_success_at ?? 'null'}`,
    `games_seeded_count=${runtimeContext.games_seeded_count ?? 0}`,
    `market_expression_enabled=${runtimeContext.market_expression_enabled === true}`,
  ].join(' ');
}

function formatMlbDualRunLog(record = {}) {
  return JSON.stringify({
    gameId: record.gameId ?? 'unknown',
    marketType: record.marketType ?? 'unknown',
    pickedPath: record.pickedPath ?? 'unknown',
    shadowPath: record.shadowPath ?? 'none',
    deltaEdge: Number.isFinite(record.deltaEdge) ? record.deltaEdge : null,
    deltaConfidence: Number.isFinite(record.deltaConfidence)
      ? record.deltaConfidence
      : null,
    winner: record.winner ?? 'unknown',
  });
}

function computeLineAgeMinutes(timestamp, now = Date.now()) {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const ageMs = now - parsed;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return Math.round((ageMs / (60 * 1000)) * 10) / 10;
}

function buildMlbPitcherKAuditLog({
  gameId,
  driver,
  starterQuality,
  reasonCodes,
  pitcher,
  marketType = 'PITCHER_K',
}) {
  return {
    gameId: gameId ?? 'unknown',
    pitcherId: driver?.player_id ?? pitcher?.id ?? null,
    starterQuality: starterQuality ?? 'UNKNOWN',
    bookmaker: driver?.best_line_bookmaker ?? null,
    lineAgeMinutes: computeLineAgeMinutes(driver?.line_fetched_at),
    marketType,
    decisionState: driver?.status ?? driver?.prop_decision?.verdict ?? 'UNKNOWN',
    reasonCodes: Array.isArray(reasonCodes) ? reasonCodes : [],
  };
}

function formatMlbPitcherKAuditLog(payload = {}) {
  return JSON.stringify(payload);
}

function formatMlbPipelineStateLog(gameId, pipelineState = {}) {
  const blockingReasons = Array.isArray(pipelineState.blocking_reason_codes) && pipelineState.blocking_reason_codes.length > 0
    ? pipelineState.blocking_reason_codes.join('|')
    : 'none';

  return [
    `game_id=${gameId}`,
    `ingested=${pipelineState.ingested === true}`,
    `market_lines_ok=${pipelineState.market_lines_ok === true}`,
    `projection_ready=${pipelineState.projection_ready === true}`,
    `drivers_ready=${pipelineState.drivers_ready === true}`,
    `pricing_ready=${pipelineState.pricing_ready === true}`,
    `card_ready=${pipelineState.card_ready === true}`,
    `f5_line_ok=${pipelineState.f5_line_ok === true}`,
    `f5_ml_ok=${pipelineState.f5_ml_ok === true}`,
    `full_game_total_ok=${pipelineState.full_game_total_ok === true}`,
    `blocking_reason_codes=${blockingReasons}`,
  ].join(' ');
}

function summarizeMlbPipelineStates(gamePipelineStates = {}) {
  const states = Object.values(gamePipelineStates).filter(
    (state) => state && typeof state === 'object',
  );
  const topBlockers = {};

  for (const state of states) {
    for (const reason of state.blocking_reason_codes || []) {
      topBlockers[reason] = (topBlockers[reason] || 0) + 1;
    }
  }

  const topBlockerSummary = Object.entries(topBlockers)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}:${count}`)
    .join('|') || 'none';

  return [
    `games=${states.length}`,
    `projection_ready=${states.filter((state) => state.projection_ready === true).length}`,
    `pricing_ready=${states.filter((state) => state.pricing_ready === true).length}`,
    `card_ready=${states.filter((state) => state.card_ready === true).length}`,
    `top_blockers=${topBlockerSummary}`,
  ].join(' ');
}

const MLB_FULL_GAME_FUNNEL_WINDOW = 50;
const MLB_FULL_GAME_DIRECTIONAL_FUNNEL_WINDOW = 200;

function roundPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function computeStageDropPct(previousCount, currentCount) {
  const prev = Number(previousCount);
  const curr = Number(currentCount);
  if (!Number.isFinite(prev) || prev <= 0) return 0;
  if (!Number.isFinite(curr)) return 0;
  const dropped = Math.max(0, prev - curr);
  return roundPct((dropped / prev) * 100);
}

function getMlbFullGameMarketKey(driver = {}) {
  const market = String(driver?.market || '').toLowerCase();
  if (market === 'full_game_total') return 'FULL_GAME_TOTAL';
  if (market === 'full_game_ml') return 'FULL_GAME_ML';
  return null;
}

function resolveDirectionalTotalSide(driver = {}) {
  const prediction = String(driver?.prediction || '').toUpperCase();
  if (prediction === 'OVER' || prediction === 'UNDER') return prediction;
  const edge = Number(driver?.drivers?.[0]?.edge);
  if (Number.isFinite(edge)) return edge >= 0 ? 'OVER' : 'UNDER';
  return null;
}

function resolveDirectionalModelTotal(driver = {}) {
  const projectedTotal = Number(
    driver?.projection?.projected_total ?? driver?.drivers?.[0]?.projected,
  );
  return Number.isFinite(projectedTotal) ? projectedTotal : null;
}

function resolveDirectionalEdge(driver = {}) {
  const edge = Number(driver?.drivers?.[0]?.edge);
  return Number.isFinite(edge) ? edge : null;
}

function resolveDirectionalConfidence(driver = {}) {
  const confidence = Number(driver?.confidence);
  return Number.isFinite(confidence) ? confidence : null;
}

function resolveDirectionalSegmentRuns(driver = {}) {
  const homeF5 = Number(driver?.projection?.home_f5_runs);
  const awayF5 = Number(driver?.projection?.away_f5_runs);
  const homeLate = Number(driver?.projection?.home_late_runs);
  const awayLate = Number(driver?.projection?.away_late_runs);
  return {
    f5Runs: Number.isFinite(homeF5) && Number.isFinite(awayF5)
      ? homeF5 + awayF5
      : null,
    lateRuns: Number.isFinite(homeLate) && Number.isFinite(awayLate)
      ? homeLate + awayLate
      : null,
  };
}

function resolveDirectionalMarketTotal(driver = {}, modelTotal = null) {
  const explicitLine = Number(driver?.line);
  if (Number.isFinite(explicitLine)) return explicitLine;

  const edge = Number(driver?.drivers?.[0]?.edge);
  if (Number.isFinite(modelTotal) && Number.isFinite(edge)) {
    return modelTotal - edge;
  }
  return null;
}

function normalizeReasonCodeSet(driver = {}) {
  const reasonCodes = Array.isArray(driver?.reason_codes)
    ? driver.reason_codes
    : [];
  return new Set(reasonCodes.map((code) => String(code || '').toUpperCase()));
}

function evaluateMlbFullGameFunnelCandidate(driver = {}, isOfficialPlay = false) {
  const marketKey = getMlbFullGameMarketKey(driver);
  const directionalSide = marketKey === 'FULL_GAME_TOTAL'
    ? resolveDirectionalTotalSide(driver)
    : null;
  const directionalModelTotal = marketKey === 'FULL_GAME_TOTAL'
    ? resolveDirectionalModelTotal(driver)
    : null;
  const directionalMarketTotal = marketKey === 'FULL_GAME_TOTAL'
    ? resolveDirectionalMarketTotal(driver, directionalModelTotal)
    : null;
  const directionalEdge = marketKey === 'FULL_GAME_TOTAL'
    ? resolveDirectionalEdge(driver)
    : null;
  const directionalConfidence = marketKey === 'FULL_GAME_TOTAL'
    ? resolveDirectionalConfidence(driver)
    : null;
  const directionalSegments = marketKey === 'FULL_GAME_TOTAL'
    ? resolveDirectionalSegmentRuns(driver)
    : { f5Runs: null, lateRuns: null };
  const reasonCodes = normalizeReasonCodeSet(driver);
  const confidence = Number(driver?.confidence ?? 0);

  const passedProjection =
    String(driver?.projection_source || '').toUpperCase() !== 'NO_BET';
  const passedEdgeThreshold = !(
    reasonCodes.has('PASS_NO_EDGE') || reasonCodes.has('PASS_RUN_DIFF_TOO_SMALL')
  );
  const passedVolatilityThreshold = !(
    reasonCodes.has('PASS_PROBABILITY_EDGE_WEAK') || reasonCodes.has('PASS_MATH_ONLY_EDGE')
  );
  const passedDriverSupport = !(
    reasonCodes.has('PASS_NO_SUPPORTING_DRIVERS') || reasonCodes.has('PASS_WEAK_DRIVER_SUPPORT')
  );
  const passedF5Contradiction = !(
    reasonCodes.has('PASS_BULLPEN_CONTRADICTS_F5') || reasonCodes.has('PASS_EXPRESSION_MISMATCH_F5_PREF')
  );
  const passedConfidence = confidence >= 0.6;
  const finalOfficialPlay = isOfficialPlay === true;

  let suppressor = null;
  if (!passedProjection) suppressor = 'PROJECTION_SOURCE_NO_BET';
  else if (!passedEdgeThreshold) suppressor = 'PASS_NO_EDGE_OR_RUN_DIFF';
  else if (!passedVolatilityThreshold) suppressor = 'PASS_PROBABILITY_EDGE_WEAK_OR_MATH_ONLY';
  else if (!passedDriverSupport) suppressor = 'PASS_DRIVER_SUPPORT';
  else if (!passedF5Contradiction) suppressor = 'PASS_F5_CONTRADICTION';
  else if (!passedConfidence) suppressor = 'PASS_CONFIDENCE_GATE';
  else if (!finalOfficialPlay) suppressor = 'NOT_IN_OFFICIAL_PLAYS';

  return {
    directionalSide,
    directionalModelTotal,
    directionalMarketTotal,
    directionalEdge,
    directionalConfidence,
    directionalF5Runs: directionalSegments.f5Runs,
    directionalLateRuns: directionalSegments.lateRuns,
    passedProjection,
    passedEdgeThreshold,
    passedVolatilityThreshold,
    passedDriverSupport,
    passedF5Contradiction,
    passedConfidence,
    finalOfficialPlay,
    suppressor,
  };
}

/**
 * Killshot audit: measures what % of pre-gate overs survive each gate.
 * This shows explicitly: "If we turn off gate X, how many overs pass?"
 */
function buildMlbKillshotGateAudit(samples = []) {
  const ordered = Array.isArray(samples)
    ? samples.slice(-1000) // Use larger window for audit
    : [];
  
  const directional = ordered.filter(
    (sample) => sample?.directionalSide === 'OVER' || sample?.directionalSide === 'UNDER',
  );
  
  if (directional.length === 0) {
    return {
      audit_type: 'KILLSHOT_GATE_ANALYSIS',
      sample_size: 0,
      pre_gate: { OVER: 0, UNDER: 0 },
      post_gate: { OVER: 0, UNDER: 0 },
      gate_analysis: {},
      insights: [],
    };
  }

  const gateChain = [
    { name: 'passed_projection', fieldName: 'passedProjection' },
    { name: 'passed_edge_threshold', fieldName: 'passedEdgeThreshold' },
    { name: 'passed_volatility_threshold', fieldName: 'passedVolatilityThreshold' },
    { name: 'passed_driver_support', fieldName: 'passedDriverSupport' },
    { name: 'passed_f5_contradiction', fieldName: 'passedF5Contradiction' },
    { name: 'passed_confidence', fieldName: 'passedConfidence' },
    { name: 'final_official_play', fieldName: 'finalOfficialPlay' },
  ];

  // Pre-gate: all candidates by side
  const preGate = {
    OVER: directional.filter((s) => s.directionalSide === 'OVER').length,
    UNDER: directional.filter((s) => s.directionalSide === 'UNDER').length,
  };

  // Post-gate: candidates that pass ALL gates
  const postGate = {
    OVER: directional.filter(
      (s) =>
        s.directionalSide === 'OVER' &&
        s.passedProjection &&
        s.passedEdgeThreshold &&
        s.passedVolatilityThreshold &&
        s.passedDriverSupport &&
        s.passedF5Contradiction &&
        s.passedConfidence &&
        s.finalOfficialPlay,
    ).length,
    UNDER: directional.filter(
      (s) =>
        s.directionalSide === 'UNDER' &&
        s.passedProjection &&
        s.passedEdgeThreshold &&
        s.passedVolatilityThreshold &&
        s.passedDriverSupport &&
        s.passedF5Contradiction &&
        s.passedConfidence &&
        s.finalOfficialPlay,
    ).length,
  };

  // For each gate: how many overs would exist if we removed JUST this gate?
  const gateAnalysis = {};
  for (const gate of gateChain) {
    const withoutThisGate = {
      OVER: directional.filter((s) => {
        if (s.directionalSide !== 'OVER') return false;
        // Check all gates EXCEPT this one
        for (const g of gateChain) {
          if (g.name === gate.name) continue; // Skip the gate we're removing
          if (!s[g.fieldName]) return false;
        }
        return true;
      }).length,
      UNDER: directional.filter((s) => {
        if (s.directionalSide !== 'UNDER') return false;
        // Check all gates EXCEPT this one
        for (const g of gateChain) {
          if (g.name === gate.name) continue; // Skip the gate we're removing
          if (!s[g.fieldName]) return false;
        }
        return true;
      }).length,
    };

    const currentlyBlocking = {
      OVER: preGate.OVER - withoutThisGate.OVER,
      UNDER: preGate.UNDER - withoutThisGate.UNDER,
    };

    gateAnalysis[gate.name] = {
      would_pass_without_this_gate: withoutThisGate,
      currently_blocking: currentlyBlocking,
      blocking_pct: {
        OVER: preGate.OVER > 0 ? ((currentlyBlocking.OVER / preGate.OVER) * 100).toFixed(1) : '0',
        UNDER: preGate.UNDER > 0 ? ((currentlyBlocking.UNDER / preGate.UNDER) * 100).toFixed(1) : '0',
      },
    };
  }

  // Identify the biggest over-killers
  const overKillers = Object.entries(gateAnalysis)
    .map(([gateName, analysis]) => ({
      gate: gateName,
      blocking: analysis.currently_blocking.OVER,
      pct: parseFloat(analysis.blocking_pct.OVER),
    }))
    .sort((a, b) => b.blocking - a.blocking)
    .slice(0, 3);

  const insights = [];
  if (preGate.OVER === 0 && preGate.UNDER > 0) {
    insights.push('CRITICAL: Zero OVER candidates pre-gate. Model is entirely biased toward UNDER.');
  } else if (preGate.OVER < preGate.UNDER * 0.1) {
    insights.push(`WARNING: OVER is only ${((preGate.OVER / (preGate.OVER + preGate.UNDER)) * 100).toFixed(1)}% of candidates. Heavy directional bias.`);
  }

  if (postGate.OVER === 0 && postGate.UNDER > 0) {
    insights.push(`All ${preGate.OVER} OVER candidates killed by pipeline. See top killers below.`);
    for (const killer of overKillers) {
      insights.push(`  - ${killer.gate}: blocks ${killer.blocking} overs (${killer.pct}%)`);
    }
  }

  const overToUnderRatio = preGate.OVER > 0 ? (preGate.UNDER / preGate.OVER).toFixed(2) : 'Inf';

  return {
    audit_type: 'KILLSHOT_GATE_ANALYSIS',
    sample_size: directional.length,
    directional_bias: {
      pre_gate_over_to_under_ratio: overToUnderRatio,
      over_pct_pre_gate: preGate.OVER > 0 || preGate.UNDER > 0
        ? ((preGate.OVER / (preGate.OVER + preGate.UNDER)) * 100).toFixed(1)
        : '0',
      over_pct_post_gate: postGate.OVER > 0 || postGate.UNDER > 0
        ? ((postGate.OVER / (postGate.OVER + postGate.UNDER)) * 100).toFixed(1)
        : '0',
    },
    pre_gate: preGate,
    post_gate: postGate,
    gate_analysis: gateAnalysis,
    top_over_killers: overKillers,
    insights,
  };
}

function buildMlbFullGameDirectionalFunnelReport(samples = []) {
  const ordered = Array.isArray(samples)
    ? samples.slice(-MLB_FULL_GAME_DIRECTIONAL_FUNNEL_WINDOW)
    : [];
  const directional = ordered.filter(
    (sample) => sample?.directionalSide === 'OVER' || sample?.directionalSide === 'UNDER',
  );

  const stageOrder = [
    ['total_candidates_created', null],
    ['passed_projection', 'passedProjection'],
    ['passed_edge_threshold', 'passedEdgeThreshold'],
    ['passed_volatility_threshold', 'passedVolatilityThreshold'],
    ['passed_driver_support', 'passedDriverSupport'],
    ['passed_f5_contradiction', 'passedF5Contradiction'],
    ['passed_confidence', 'passedConfidence'],
    ['final_official_plays', 'finalOfficialPlay'],
  ];

  const stageSideCounts = Object.fromEntries(
    stageOrder.map(([stageName]) => [stageName, { OVER: 0, UNDER: 0 }]),
  );

  let modelTotalSum = 0;
  let modelTotalCount = 0;
  let marketTotalSum = 0;
  let marketTotalCount = 0;

  const sideComponents = {
    OVER: {
      edgeSum: 0,
      edgeCount: 0,
      absEdgeSum: 0,
      confidenceSum: 0,
      confidenceCount: 0,
      f5ShareSum: 0,
      lateShareSum: 0,
      shareCount: 0,
    },
    UNDER: {
      edgeSum: 0,
      edgeCount: 0,
      absEdgeSum: 0,
      confidenceSum: 0,
      confidenceCount: 0,
      f5ShareSum: 0,
      lateShareSum: 0,
      shareCount: 0,
    },
  };

  for (const sample of directional) {
    const side = sample.directionalSide;
    stageOrder.forEach(([stageName, sampleKey]) => {
      const include = sampleKey === null ? true : sample[sampleKey] === true;
      if (include) stageSideCounts[stageName][side] += 1;
    });

    if (Number.isFinite(sample.directionalModelTotal)) {
      modelTotalSum += sample.directionalModelTotal;
      modelTotalCount += 1;
    }
    if (Number.isFinite(sample.directionalMarketTotal)) {
      marketTotalSum += sample.directionalMarketTotal;
      marketTotalCount += 1;
    }

    if (Number.isFinite(sample.directionalEdge)) {
      sideComponents[side].edgeSum += sample.directionalEdge;
      sideComponents[side].absEdgeSum += Math.abs(sample.directionalEdge);
      sideComponents[side].edgeCount += 1;
    }

    if (Number.isFinite(sample.directionalConfidence)) {
      sideComponents[side].confidenceSum += sample.directionalConfidence;
      sideComponents[side].confidenceCount += 1;
    }

    if (Number.isFinite(sample.directionalF5Runs) && Number.isFinite(sample.directionalLateRuns)) {
      const totalRuns = sample.directionalF5Runs + sample.directionalLateRuns;
      if (totalRuns > 0) {
        sideComponents[side].f5ShareSum += (sample.directionalF5Runs / totalRuns) * 100;
        sideComponents[side].lateShareSum += (sample.directionalLateRuns / totalRuns) * 100;
        sideComponents[side].shareCount += 1;
      }
    }
  }

  const preGateTotal = stageSideCounts.total_candidates_created.OVER + stageSideCounts.total_candidates_created.UNDER;
  const postGateTotal = stageSideCounts.final_official_plays.OVER + stageSideCounts.final_official_plays.UNDER;

  const dropBySide = {};
  for (let idx = 1; idx < stageOrder.length; idx += 1) {
    const prevStage = stageOrder[idx - 1][0];
    const currStage = stageOrder[idx][0];
    const prevOver = stageSideCounts[prevStage].OVER;
    const prevUnder = stageSideCounts[prevStage].UNDER;
    const currOver = stageSideCounts[currStage].OVER;
    const currUnder = stageSideCounts[currStage].UNDER;

    dropBySide[currStage] = {
      OVER: computeStageDropPct(prevOver, currOver),
      UNDER: computeStageDropPct(prevUnder, currUnder),
    };
  }

  const avgModelTotal = modelTotalCount > 0 ? roundPct(modelTotalSum / modelTotalCount) : null;
  const avgMarketTotal = marketTotalCount > 0 ? roundPct(marketTotalSum / marketTotalCount) : null;
  const componentAverages = {
    OVER: {
      average_edge: sideComponents.OVER.edgeCount > 0
        ? roundPct(sideComponents.OVER.edgeSum / sideComponents.OVER.edgeCount)
        : null,
      average_abs_edge: sideComponents.OVER.edgeCount > 0
        ? roundPct(sideComponents.OVER.absEdgeSum / sideComponents.OVER.edgeCount)
        : null,
      average_confidence: sideComponents.OVER.confidenceCount > 0
        ? roundPct(sideComponents.OVER.confidenceSum / sideComponents.OVER.confidenceCount)
        : null,
      average_f5_share_pct: sideComponents.OVER.shareCount > 0
        ? roundPct(sideComponents.OVER.f5ShareSum / sideComponents.OVER.shareCount)
        : null,
      average_late_share_pct: sideComponents.OVER.shareCount > 0
        ? roundPct(sideComponents.OVER.lateShareSum / sideComponents.OVER.shareCount)
        : null,
    },
    UNDER: {
      average_edge: sideComponents.UNDER.edgeCount > 0
        ? roundPct(sideComponents.UNDER.edgeSum / sideComponents.UNDER.edgeCount)
        : null,
      average_abs_edge: sideComponents.UNDER.edgeCount > 0
        ? roundPct(sideComponents.UNDER.absEdgeSum / sideComponents.UNDER.edgeCount)
        : null,
      average_confidence: sideComponents.UNDER.confidenceCount > 0
        ? roundPct(sideComponents.UNDER.confidenceSum / sideComponents.UNDER.confidenceCount)
        : null,
      average_f5_share_pct: sideComponents.UNDER.shareCount > 0
        ? roundPct(sideComponents.UNDER.f5ShareSum / sideComponents.UNDER.shareCount)
        : null,
      average_late_share_pct: sideComponents.UNDER.shareCount > 0
        ? roundPct(sideComponents.UNDER.lateShareSum / sideComponents.UNDER.shareCount)
        : null,
    },
  };

  return {
    sample_size: directional.length,
    window_size: MLB_FULL_GAME_DIRECTIONAL_FUNNEL_WINDOW,
    averages: {
      average_model_total: avgModelTotal,
      average_market_total: avgMarketTotal,
    },
    pre_gate: {
      over_count: stageSideCounts.total_candidates_created.OVER,
      under_count: stageSideCounts.total_candidates_created.UNDER,
      over_pct: preGateTotal > 0
        ? roundPct((stageSideCounts.total_candidates_created.OVER / preGateTotal) * 100)
        : 0,
      under_pct: preGateTotal > 0
        ? roundPct((stageSideCounts.total_candidates_created.UNDER / preGateTotal) * 100)
        : 0,
    },
    post_gate: {
      over_count: stageSideCounts.final_official_plays.OVER,
      under_count: stageSideCounts.final_official_plays.UNDER,
      over_pct: postGateTotal > 0
        ? roundPct((stageSideCounts.final_official_plays.OVER / postGateTotal) * 100)
        : 0,
      under_pct: postGateTotal > 0
        ? roundPct((stageSideCounts.final_official_plays.UNDER / postGateTotal) * 100)
        : 0,
    },
    stage_side_counts: stageSideCounts,
    stage_drop_pct_by_side: dropBySide,
    side_component_averages: componentAverages,
  };
}

/**
 * WI-0944: Build MLB Full-Game Suppression Funnel Report (Operator Contract)
 *
 * Generates a deterministic, operator-facing report that shows how MLB full-game
 * candidates flow through each suppression gate over the most recent N=50 samples.
 *
 * OUTPUT SHAPE (locked for WI-0944 and later):
 *
 * {
 *   "sample_size": number,        // N (max 50), total candidates processed
 *   "counts": {                   // Raw counts (not ratios) at each stage
 *     "total_candidates_created": number,
 *     "passed_projection": number,
 *     "passed_edge_threshold": number,
 *     "passed_volatility_threshold": number,
 *     "passed_driver_support": number,
 *     "passed_f5_contradiction": number,
 *     "passed_confidence": number,
 *     "final_official_plays": number
 *   },
 *   "drop_pct": {                // Percentage drop from previous stage (not cascading)
 *     "passed_projection": number,           // % of total_candidates that didn't pass
 *     "passed_edge_threshold": number,       // % of total_candidates that didn't pass
 *     ... (same pattern for each stage)
 *     "final_official_plays": number
 *   },
 *   "top_suppressors": [          // Top 2 suppressors ordered by impact
 *     {
 *       "condition": string,      // e.g., "PASS_NO_EDGE_OR_RUN_DIFF", "PASS_CONFIDENCE_GATE"
 *       "count": number,          // How many candidates were suppressed by this condition
 *       "impact_pct": number      // (count / sample_size) * 100
 *     },
 *     ...
 *   ]
 * }
 *
 * OPERATOR USE:
 * - High drop_pct at a stage → investigate that gate (e.g., edge_threshold at 40% → many low-edge candidates)
 * - top_suppressors → names the most common suppressors without parsing candidate payloads
 * - Reproducible output across runs with same sample → enables before/after threshold testing
 *
 * @param {Array} samples - Array of evaluation results from evaluateMlbFullGameFunnelCandidate
 * @returns {Object} Operator-facing report with sample_size, counts, drop_pct, top_suppressors
 */
function buildMlbFullGameSuppressionFunnelReport(samples = []) {
  const ordered = Array.isArray(samples) ? samples.slice(-MLB_FULL_GAME_FUNNEL_WINDOW) : [];
  const total = ordered.length;
  const counts = {
    total_candidates_created: total,
    passed_projection: 0,
    passed_edge_threshold: 0,
    passed_volatility_threshold: 0,
    passed_driver_support: 0,
    passed_f5_contradiction: 0,
    passed_confidence: 0,
    final_official_plays: 0,
  };

  const suppressorCounts = {};
  for (const sample of ordered) {
    if (sample.passedProjection) counts.passed_projection += 1;
    if (sample.passedEdgeThreshold) counts.passed_edge_threshold += 1;
    if (sample.passedVolatilityThreshold) counts.passed_volatility_threshold += 1;
    if (sample.passedDriverSupport) counts.passed_driver_support += 1;
    if (sample.passedF5Contradiction) counts.passed_f5_contradiction += 1;
    if (sample.passedConfidence) counts.passed_confidence += 1;
    if (sample.finalOfficialPlay) counts.final_official_plays += 1;
    if (sample.suppressor) {
      suppressorCounts[sample.suppressor] = (suppressorCounts[sample.suppressor] || 0) + 1;
    }
  }

  const stageOrder = [
    'total_candidates_created',
    'passed_projection',
    'passed_edge_threshold',
    'passed_volatility_threshold',
    'passed_driver_support',
    'passed_f5_contradiction',
    'passed_confidence',
    'final_official_plays',
  ];
  const dropPct = {};
  for (let idx = 1; idx < stageOrder.length; idx += 1) {
    const prev = counts[stageOrder[idx - 1]];
    const curr = counts[stageOrder[idx]];
    dropPct[stageOrder[idx]] = computeStageDropPct(prev, curr);
  }

  const topSuppressors = Object.entries(suppressorCounts)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 2)
    .map(([condition, count]) => ({
      condition,
      count,
      impact_pct: total > 0 ? roundPct((count / total) * 100) : 0,
    }));

  return {
    sample_size: total,
    counts,
    drop_pct: dropPct,
    top_suppressors: topSuppressors,
  };
}

function getLatestSuccessfulJobStartedAt(jobName) {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT started_at
       FROM job_runs
       WHERE job_name = ?
         AND status = 'success'
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(jobName);
  return row?.started_at ?? null;
}

function buildMlbProjectionOnlyRuntimeContext({
  nowUtc = DateTime.utc(),
  maxAgeMinutes = MLB_SEED_CONTEXT_MAX_AGE_MINUTES,
} = {}) {
  const seedLastSuccessAt = getLatestSuccessfulJobStartedAt(
    'pull_espn_games_direct',
  );
  let seedDataStatus = 'MISSING';

  if (seedLastSuccessAt) {
    const lastSuccess = DateTime.fromISO(seedLastSuccessAt, { zone: 'utc' });
    const ageMinutes = nowUtc.diff(lastSuccess, 'minutes').minutes;
    seedDataStatus = ageMinutes <= maxAgeMinutes ? 'FRESH' : 'STALE';
  }

  return {
    run_mode: 'PROJECTION_ONLY',
    seed_data_status: seedDataStatus,
    seed_last_success_at: seedLastSuccessAt,
    games_seeded_count: 0,
    market_expression_enabled: false,
  };
}

function applyMlbProjectionOnlyGuards(target, runtimeContext) {
  if (!target || typeof target !== 'object' || !runtimeContext) return target;

  const flags = [...MLB_PROJECTION_ONLY_MARKET_FLAGS];
  if (runtimeContext.seed_data_status === 'STALE') {
    flags.push('STALE_SEED_DATA');
  }

  target.run_mode = runtimeContext.run_mode;
  target.market_expression_enabled = false;
  target.market_trust_flags = flags;
  target.reason_codes = uniqueReasonCodes([
    ...(Array.isArray(target.reason_codes) ? target.reason_codes : []),
    ...flags,
  ]);
  if (!target.raw_data || typeof target.raw_data !== 'object') {
    target.raw_data = {};
  }
  target.raw_data.mlb_runtime_context = { ...runtimeContext };
  return target;
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

function resolveSnapshotTimestampMeta(oddsSnapshot, payload, nowMs = Date.now()) {
  const resolution = resolveSnapshotAge(
    {
      captured_at: oddsSnapshot?.captured_at ?? oddsSnapshot?.fetched_at ?? null,
      pulled_at: oddsSnapshot?.pulled_at ?? null,
      updated_at: oddsSnapshot?.updated_at ?? null,
    },
    {
      snapshotId: oddsSnapshot?.id ?? null,
      sport: payload?.sport ?? 'MLB',
      gameId: oddsSnapshot?.game_id ?? payload?.game_id ?? null,
      nowMs,
    },
  );

  const snapshotTimestamp = {
    captured_at: oddsSnapshot?.captured_at ?? null,
    pulled_at: oddsSnapshot?.pulled_at ?? null,
    updated_at: oddsSnapshot?.updated_at ?? null,
    resolved_timestamp: resolution.resolved_timestamp,
    resolved_source: resolution.source_field,
    resolved_age_ms: resolution.resolved_age_ms,
  };

  return { resolution, snapshotTimestamp };
}

function toExecutionGatePassReasonCode(reason) {
  const normalized = String(reason || '')
    .toUpperCase()
    .split(':')[0]
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized
    ? `PASS_EXECUTION_GATE_${normalized}`
    : 'PASS_EXECUTION_GATE_BLOCKED';
}

function americanOddsToImpliedProbability(price) {
  if (!Number.isFinite(price) || price === 0) return null;
  if (price > 0) {
    return 100 / (price + 100);
  }
  return Math.abs(price) / (Math.abs(price) + 100);
}

function resolveMlbMoneylineExecutionInputs({
  prediction,
  winProbHome,
  homePrice,
  awayPrice,
  rawEdge,
}) {

  const side = String(prediction || '').toUpperCase();
  const selectedPrice =
    side === 'HOME'
      ? toFiniteNumber(homePrice)
      : side === 'AWAY'
        ? toFiniteNumber(awayPrice)
        : null;
  const pFairHome = toFiniteNumber(winProbHome);
  const pFair =
    pFairHome !== null
      ? side === 'HOME'
        ? pFairHome
        : side === 'AWAY'
          ? 1 - pFairHome
          : null
      : null;

  return {
    edge: Number.isFinite(rawEdge) ? rawEdge : null,
    price: selectedPrice,
    p_fair: pFair,
    p_implied:
      selectedPrice !== null
        ? americanOddsToImpliedProbability(selectedPrice)
        : null,
  };
}

function resolveMlbTotalExecutionInputs({
  prediction,
  projectedTotal,
  marketLine,
  overPrice,
  underPrice,
  pOver,
  pUnder,
}) {
  const side = String(prediction || '').toUpperCase();
  const selectedPrice =
    side === 'OVER'
      ? toFiniteNumber(overPrice)
      : side === 'UNDER'
        ? toFiniteNumber(underPrice)
        : null;
  const pFair =
    side === 'OVER'
      ? toFiniteNumber(pOver)
      : side === 'UNDER'
        ? toFiniteNumber(pUnder)
        : null;
  const pImplied =
    selectedPrice !== null
      ? americanOddsToImpliedProbability(selectedPrice)
      : null;
  const edge =
    pFair !== null && pImplied !== null
      ? pFair - pImplied
      : null;
  const edgePoints =
    Number.isFinite(projectedTotal) && Number.isFinite(marketLine)
      ? projectedTotal - marketLine
      : null;

  return {
    edge,
    edge_pct: edge,
    edge_points: edgePoints,
    price: selectedPrice,
    p_fair: pFair,
    p_implied: pImplied,
    model_prob: pFair,
  };
}

function isMlbMoneylineSelection(selection) {
  const side = String(selection || '').toUpperCase();
  return side === 'HOME' || side === 'AWAY';
}

function resolveMlbMarketGroup(driver = {}) {
  const market = String(driver.market || '').toLowerCase();
  if (market === 'full_game_total') return MLB_MARKET_GROUP.FULL_GAME_TOTAL;
  if (market === 'full_game_ml') return MLB_MARKET_GROUP.FULL_GAME_ML;
  if (market === 'f5_total') return MLB_MARKET_GROUP.F5_TOTAL;
  if (market === 'f5_ml') return MLB_MARKET_GROUP.F5_ML;
  if (market.startsWith('pitcher_k_')) return MLB_MARKET_GROUP.PITCHER_K;
  return MLB_MARKET_GROUP.OTHER_PROP;
}

function resolveMlbTrustClass(marketGroup) {
  if (
    marketGroup === MLB_MARKET_GROUP.FULL_GAME_TOTAL ||
    marketGroup === MLB_MARKET_GROUP.FULL_GAME_ML
  ) {
    return MLB_MARKET_TRUST_CLASS.ODDS_BACKED;
  }
  return MLB_MARKET_TRUST_CLASS.PROJECTION_ONLY;
}

function buildMlbMarketContract({ driver, oddsSnapshot, line, price }) {
  const marketGroup = resolveMlbMarketGroup(driver);
  const trustClass = resolveMlbTrustClass(marketGroup);
  return {
    market_group: marketGroup,
    trust_class: trustClass,
    line: toFiniteNumber(line),
    price: toFiniteNumber(price),
    source:
      typeof driver?.line_source === 'string' && driver.line_source.length > 0
        ? driver.line_source
        : typeof driver?.price_source === 'string' && driver.price_source.length > 0
          ? driver.price_source
          : null,
    captured_at: oddsSnapshot?.captured_at ?? null,
  };
}

function isProjectionOnlyMlbMarket(driver = {}) {
  return resolveMlbTrustClass(resolveMlbMarketGroup(driver)) === MLB_MARKET_TRUST_CLASS.PROJECTION_ONLY;
}

function applyExecutionGateToMlbPayload(payload, { oddsSnapshot, nowMs = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') {
    return { evaluated: false, blocked: false };
  }

  const executionStatus = String(payload.execution_status || '').toUpperCase();
  const alreadyPass =
    String(payload.status || '').toUpperCase() === 'PASS' ||
    String(payload.action || '').toUpperCase() === 'PASS' ||
    String(payload.classification || '').toUpperCase() === 'PASS';
  const resolvedModelStatus = String(payload.model_status || 'MODEL_OK').toUpperCase();
  const { resolution: snapshotResolution, snapshotTimestamp } = resolveSnapshotTimestampMeta(
    oddsSnapshot,
    payload,
    nowMs,
  );
  const snapshotAgeMs = snapshotResolution?.resolved_age_ms ?? null;
  payload.snapshot_timestamp = snapshotTimestamp;
  if (executionStatus !== 'EXECUTABLE' || alreadyPass) {
    const earlyExitDropReasonCode = alreadyPass
      ? 'NOT_BET_ELIGIBLE'
      : executionStatus === 'PROJECTION_ONLY'
        ? 'PROJECTION_ONLY_EXCLUSION'
        : 'NOT_EXECUTABLE_PATH';
    payload.execution_gate = {
      evaluated: false,
      should_bet: null,
      net_edge: null,
      blocked_by: [earlyExitDropReasonCode],
      model_status: resolvedModelStatus,
      snapshot_age_ms: snapshotAgeMs,
      freshness_decision: null,
      evaluated_at: new Date(nowMs).toISOString(),
      drop_reason: {
        drop_reason_code: earlyExitDropReasonCode,
        drop_reason_layer: 'worker_gate',
      },
    };
    payload.execution_envelope = {
      snapshot_id: oddsSnapshot?.id ?? null,
      snapshot_timestamp: snapshotTimestamp,
      freshness_decision: null,
    };
    return { evaluated: false, blocked: false };
  }

  // WI-0944: MLB full-game ML uses relaxed execution thresholds.
  // The model's confidence is structurally capped at 5-6/10 and raw edges of
  // 6-11pp are meaningful signal. A positive ML edge must be the primary
  // decision driver; support/confidence can downgrade tier but must not hard-veto.
  // Large edge (rawEdge >= 0.06): near-bypass thresholds so conf=5/10 cannot
  // nullify a +9-11pp model call.
  // Standard relaxed (rawEdge < 0.06): lower but still meaningful floors.
  const _rawEdgeForGate = Number.isFinite(payload.edge) ? payload.edge : 0;
  const _sportToken = String(payload.sport || 'MLB').toUpperCase();
  const _cardTypeToken = String(payload.card_type || '').toLowerCase();
  const _marketTypeToken = String(payload.market_type || '').toUpperCase();
  const _recommendedBetTypeToken = String(payload.recommended_bet_type || '').toUpperCase();
  const _periodToken = String(payload.period ?? payload.market?.period ?? '').toUpperCase();
  const _cardTitleToken = String(payload.card_title || payload.title || '').toUpperCase();
  const _isFullGamePeriod =
    _periodToken === '' ||
    _periodToken === 'NA' ||
    _periodToken === 'FULL_GAME' ||
    _periodToken === 'GAME';
  const _isMlbMoneylineLike =
    _marketTypeToken === 'MONEYLINE' &&
    (_recommendedBetTypeToken === 'MONEYLINE' || _cardTitleToken.includes('FULL GAME ML'));
  const _isMlbFullGameMl =
    _sportToken === 'MLB' &&
    (
      _cardTypeToken === 'mlb-full-game-ml' ||
      _cardTypeToken === 'mlb-full-game' ||
      (_isMlbMoneylineLike && _isFullGamePeriod)
    );
  const _mlbGateOverrides = _isMlbFullGameMl
    ? {
        minNetEdge: _rawEdgeForGate >= 0.06 ? 0.01 : 0.02,
        minConfidence: _rawEdgeForGate >= 0.06 ? 0.45 : 0.50,
      }
    : {};

  const gateResult = evaluateExecution({
    modelStatus: resolvedModelStatus,
    rawEdge: Number.isFinite(payload.edge) ? payload.edge : null,
    confidence: Number.isFinite(payload.confidence) ? payload.confidence : null,
    snapshotAgeMs,
    marketKey: payload.market_key ?? null,
    sport: payload.sport ?? 'MLB',
    recommendedBetType: payload.recommended_bet_type ?? null,
    marketType: payload.market_type ?? null,
    period: payload.period ?? payload.market?.period ?? null,
    cardType: payload.card_type ?? null,
    ..._mlbGateOverrides,
  });

  const edgeOverrideEligible =
    _isMlbFullGameMl &&
    _rawEdgeForGate >= 0.06 &&
    resolvedModelStatus === 'MODEL_OK';
  const edgeOverrideBlockers = new Set([
    'CONFIDENCE_BELOW_THRESHOLD',
    'NET_EDGE_INSUFFICIENT',
  ]);
  const blockedByOnlySoftEdgeOrConfidence =
    Array.isArray(gateResult.blocked_by) &&
    gateResult.blocked_by.length > 0 &&
    gateResult.blocked_by.every((reason) =>
      edgeOverrideBlockers.has(String(reason || '').split(':')[0]),
    );
  const applyHighEdgeOverride =
    !gateResult.shouldBet && edgeOverrideEligible && blockedByOnlySoftEdgeOrConfidence;

  const gateShouldBet = applyHighEdgeOverride ? true : gateResult.shouldBet;
  const gateBlockedBy = applyHighEdgeOverride ? [] : gateResult.blocked_by;
  const gateDropReason = applyHighEdgeOverride ? null : gateResult.drop_reason;
  const reasonCodes = Array.isArray(payload.reason_codes) ? payload.reason_codes : [];
  const hasWeakSupportSignal = reasonCodes.some((code) => {
    const token = String(code || '').toUpperCase();
    return token === 'SOFT_WEAK_DRIVER_SUPPORT' || token === 'PASS_DRIVER_SUPPORT_WEAK';
  });
  const hasLowConfidenceSignal = Number.isFinite(payload.confidence) && payload.confidence < 0.55;
  const downgradeHighEdgeToLean =
    _isMlbFullGameMl &&
    _rawEdgeForGate >= 0.06 &&
    resolvedModelStatus === 'MODEL_OK' &&
    gateShouldBet &&
    (hasWeakSupportSignal || hasLowConfidenceSignal);

  payload.execution_gate = {
    evaluated: true,
    should_bet: gateShouldBet,
    net_edge: gateResult.netEdge,
    blocked_by: gateBlockedBy,
    model_status: resolvedModelStatus,
    snapshot_age_ms: snapshotAgeMs,
    freshness_decision: gateResult.freshness_decision || null,
    evaluated_at: new Date(nowMs).toISOString(),
    drop_reason: gateDropReason,
    overridden_by_edge: applyHighEdgeOverride || downgradeHighEdgeToLean,
    override_context: applyHighEdgeOverride || downgradeHighEdgeToLean
      ? {
          raw_edge: _rawEdgeForGate,
          threshold: 0.06,
          original_blocked_by: gateResult.blocked_by,
          resolution: 'DOWNGRADED_TO_LEAN',
        }
      : null,
  };
  payload.execution_envelope = {
    snapshot_id: oddsSnapshot?.id ?? null,
    snapshot_timestamp: snapshotTimestamp,
    freshness_decision: gateResult.freshness_decision || null,
  };

  if (applyHighEdgeOverride || downgradeHighEdgeToLean) {
    payload.status = 'LEAN';
    payload.action = 'LEAN';
    payload.classification = 'LEAN';
    payload.ev_passed = true;
    payload.execution_status = 'EXECUTABLE';
    payload.actionable = true;
    payload.publish_ready = true;
    payload.pass_reason_code = null;
    payload.reason_codes = Array.from(
      new Set(
        (Array.isArray(payload.reason_codes) ? payload.reason_codes : []).filter(
          (code) => !String(code || '').startsWith('PASS_EXECUTION_GATE_'),
        ),
      ),
    ).sort();
    payload._publish_state = {
      ...(payload._publish_state && typeof payload._publish_state === 'object'
        ? payload._publish_state
        : {}),
      publish_ready: true,
      emit_allowed: true,
      execution_status: 'EXECUTABLE',
      block_reason: null,
    };
  }

  if (!gateShouldBet) {
    const passReasonCode = toExecutionGatePassReasonCode(gateResult.reason);
    payload.status = 'PASS';
    payload.action = 'PASS';
    payload.classification = 'PASS';
    payload.ev_passed = false;
    payload.execution_status = 'BLOCKED';
    payload.actionable = false;
    payload.publish_ready = false;
    payload.pass_reason_code = passReasonCode;
    payload.reason_codes = Array.from(
      new Set([passReasonCode, ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : [])]),
    ).sort();
    payload._publish_state = {
      ...(payload._publish_state && typeof payload._publish_state === 'object'
        ? payload._publish_state
        : {}),
      publish_ready: false,
      emit_allowed: true,
      execution_status: 'BLOCKED',
      block_reason: gateResult.reason,
    };
  }

  return {
    evaluated: true,
    blocked: !gateShouldBet,
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

function resolvePitcherKSelectionSide(driver = {}) {
  const candidate = String(
    driver.direction ??
      driver.prop_decision?.lean_side ??
      driver.prediction ??
      '',
  )
    .trim()
    .toUpperCase();

  if (candidate === 'OVER' || candidate === 'UNDER') return candidate;
  return String(driver.prediction || '').trim().toUpperCase();
}

function resolvePitcherKSelectedPrice(driver = {}, selectionSide = null) {
  if (selectionSide === 'OVER') return toFiniteNumber(driver.over_price);
  if (selectionSide === 'UNDER') return toFiniteNumber(driver.under_price);
  return null;
}

function buildMlbPitcherKPayloadFields({
  driver = {},
  pitcherPlayerId = null,
  pitcherPlayerName = 'SP',
  projected = null,
} = {}) {
  const basis = driver.basis === 'ODDS_BACKED' ? 'ODDS_BACKED' : 'PROJECTION_ONLY';
  const selectionSide = resolvePitcherKSelectionSide(driver);
  const lineContract =
    basis === 'ODDS_BACKED'
      ? buildPitcherKLineContract(
          driver.pitcher_k_result?.selected_market ??
            driver.prop_decision?.selected_market ??
            null,
        )
      : null;
  const line =
    basis === 'ODDS_BACKED'
      ? pickFirstFinite(driver.line, lineContract?.line)
      : null;
  const price =
    basis === 'ODDS_BACKED'
      ? resolvePitcherKSelectedPrice(driver, selectionSide)
      : null;

  return {
    selectionSide,
    line,
    titleSuffix: basis === 'PROJECTION_ONLY' ? ' [PROJECTION_ONLY]' : '',
    payloadFields: {
      player_id: pitcherPlayerId,
      player_name: pitcherPlayerName,
      prop_type: 'strikeouts',
      canonical_market_key: 'pitcher_strikeouts',
      basis,
      ...(basis === 'PROJECTION_ONLY' ? { tags: ['no_odds_mode'] } : {}),
      projection:
        driver.projection && typeof driver.projection === 'object'
          ? driver.projection
          : projected !== null
            ? { k_mean: projected }
            : null,
      prop_display_state: computePitcherKPropDisplayState(
        driver.prop_decision?.verdict ?? driver.card_verdict,
      ),
      prop_decision: driver.prop_decision ?? null,
      pitcher_k_result: driver.pitcher_k_result ?? null,
      line_source: basis === 'ODDS_BACKED' ? driver.line_source ?? null : null,
      over_price: basis === 'ODDS_BACKED' ? driver.over_price ?? null : null,
      under_price: basis === 'ODDS_BACKED' ? driver.under_price ?? null : null,
      best_line_bookmaker:
        basis === 'ODDS_BACKED' ? driver.best_line_bookmaker ?? null : null,
      margin: basis === 'ODDS_BACKED' ? driver.margin ?? null : null,
      line_fetched_at:
        basis === 'ODDS_BACKED' ? driver.line_fetched_at ?? null : null,
      odds_freshness:
        basis === 'ODDS_BACKED' ? driver.odds_freshness ?? null : null,
      block_publish_reason: driver.block_publish_reason ?? null,
      pitcher_k_line_contract: lineContract,
      line,
      price,
    },
  };
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
  // Pitcher-K cards currently run without odds/line integration.
  // Keep mode projection-only unless explicitly overridden for local testing.
  const envMode = process.env.PITCHER_KS_MODEL_MODE;
  if (envMode === 'PROJECTION_ONLY' || envMode === 'ODDS_BACKED') return envMode;
  return 'PROJECTION_ONLY';
}

function hasMissingStatcastInputsInPitcherCards(cards = []) {
  for (const card of cards) {
    if (!card?.market?.startsWith('pitcher_k_')) continue;
    const missingInputs = Array.isArray(card?.prop_decision?.missing_inputs)
      ? card.prop_decision.missing_inputs
      : [];
    if (
      missingInputs.includes('statcast_swstr') ||
      missingInputs.includes('statcast_velo')
    ) {
      return true;
    }
  }
  return false;
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

const MLB_F5_SYNTHETIC_EDGE_THRESHOLD = 0.5;

/**
 * WI-0877: Synthetic-line F5 total edge driver for withoutOddsMode.
 *
 * @param {Object} mlb - Parsed mlb object from raw_data
 * @param {Object} context - { park_run_factor, temp_f, wind_mph, wind_dir, roof }
 * @param {string} gameId - Game identifier (for logging)
 * @returns {Object|null}
 */
function computeSyntheticLineF5Driver(mlb, context, gameId) {
  if (mlb.home_offense_profile == null || mlb.away_offense_profile == null) {
    return null;
  }

  // homeResult: away offense sees home starter (away team projected runs)
  // awayResult: home offense sees away starter (home team projected runs)
  const homeResult = projectTeamF5RunsAgainstStarter(
    mlb.home_pitcher ?? null,
    mlb.away_offense_profile,
    context,
  );
  const awayResult = projectTeamF5RunsAgainstStarter(
    mlb.away_pitcher ?? null,
    mlb.home_offense_profile,
    context,
  );

  if (homeResult.f5_runs === null || awayResult.f5_runs === null) {
    return null;
  }

  const projectedBase = homeResult.f5_runs + awayResult.f5_runs;
  const syntheticLine = projectedBase < 4.0 ? 3.5 : 4.5;
  const edge = projectedBase - syntheticLine;

  // Confidence: 6 baseline (synthetic line carries more risk than a real market line).
  // Subtract 1 per degraded side; floor at 4.
  const homeDegraded = (homeResult.degraded_inputs || []).length > 0;
  const awayDegraded = (awayResult.degraded_inputs || []).length > 0;
  const rawConf = Math.max(4, 6 - (homeDegraded ? 1 : 0) - (awayDegraded ? 1 : 0));

  const reasonCodes = ['SYNTHETIC_LINE_ASSUMPTION'];
  if (homeDegraded) reasonCodes.push('DEGRADED_INPUT_HOME');
  if (awayDegraded) reasonCodes.push('DEGRADED_INPUT_AWAY');

  let prediction;
  let status;
  let action;
  let classification;
  let evThresholdPassed;

  // FIRE only when projection clears the dead zone (>=5.0 OVER, <=3.0 UNDER)
  // and confidence is at maximum (rawConf 6 = no degraded inputs on either side).
  if (projectedBase >= 5.0 && rawConf >= 6) {
    prediction = 'OVER';
    status = action = classification = 'FIRE';
    evThresholdPassed = true;
  } else if (projectedBase <= 3.0 && rawConf >= 6) {
    prediction = 'UNDER';
    status = action = classification = 'FIRE';
    evThresholdPassed = true;
  } else if (edge >= MLB_F5_SYNTHETIC_EDGE_THRESHOLD && rawConf === 5) {
    prediction = 'OVER';
    status = action = classification = 'WATCH';
    evThresholdPassed = false;
  } else if (edge <= -MLB_F5_SYNTHETIC_EDGE_THRESHOLD && rawConf === 5) {
    prediction = 'UNDER';
    status = action = classification = 'WATCH';
    evThresholdPassed = false;
  } else {
    prediction = edge >= 0 ? 'OVER' : 'UNDER';
    status = action = classification = 'PASS';
    evThresholdPassed = false;
  }

  const projectedHomeFiveRuns = Math.round(awayResult.f5_runs * 10) / 10;
  const projectedAwayFiveRuns = Math.round(homeResult.f5_runs * 10) / 10;
  const projectedTotal = Math.round(projectedBase * 10) / 10;

  console.log(
    `[MLBModel] SYNTHETIC_EDGE_F5: ${gameId} — projectedBase=${projectedTotal} syntheticLine=${syntheticLine} edge=${edge.toFixed(2)} status=${status} rawConf=${rawConf}`,
  );

  return {
    market: 'f5_total',
    prediction,
    confidence: rawConf / 10,
    status,
    action,
    classification,
    ev_threshold_passed: evThresholdPassed,
    projection_source: 'FULL_MODEL',
    reason_codes: reasonCodes,
    missing_inputs: [],
    ...(status === 'PASS' ? { pass_reason_code: 'PASS_NO_EDGE' } : {}),
    playability: {
      over_playable_at_or_below: syntheticLine,
      under_playable_at_or_above: syntheticLine,
    },
    projection: {
      projected_total: projectedTotal,
      projected_total_low: Math.max(0, Math.round((projectedBase - MLB_F5_SYNTHETIC_EDGE_THRESHOLD) * 10) / 10),
      projected_total_high: Math.round((projectedBase + MLB_F5_SYNTHETIC_EDGE_THRESHOLD) * 10) / 10,
      projected_home_f5_runs: projectedHomeFiveRuns,
      projected_away_f5_runs: projectedAwayFiveRuns,
    },
    reasoning: `F5 SYNTHETIC_LINE edge=${edge.toFixed(2)} projectedBase=${projectedTotal} syntheticLine=${syntheticLine}; projection_source=FULL_MODEL`,
    drivers: [{
      type: 'mlb-f5-synthetic-line',
      projected: projectedTotal,
      projected_home_f5_runs: projectedHomeFiveRuns,
      projected_away_f5_runs: projectedAwayFiveRuns,
      edge,
      synthetic_line: syntheticLine,
      projection_source: 'FULL_MODEL',
    }],
    without_odds_mode: true,
    projection_floor: false,
  };
}

function buildMlbDualRunRecord(gameId, oddsSnapshot, selection) {
  const markets = Array.isArray(selection?.markets) ? selection.markets : [];
  const selectedMarket = markets[0]?.market ?? null;
  const selectedStatus = markets[0]?.status ?? null;

  return {
    gameId: gameId,
    marketType: selectedMarket ?? 'unknown',
    pickedPath: selection?.chosen_market ?? selectedStatus ?? 'unknown',
    shadowPath: selection?.shadow_path ?? 'none',
    deltaEdge: Number.isFinite(selection?.delta_edge) ? selection.delta_edge : null,
    deltaConfidence: Number.isFinite(selection?.delta_confidence)
      ? selection.delta_confidence
      : null,
    winner: selection?.winner ?? 'unknown',
    // Keep original fields for compatibility with any downstream debug tooling.
    matchup:
      selection?.matchup ??
      `${oddsSnapshot?.away_team ?? 'unknown'} @ ${oddsSnapshot?.home_team ?? 'unknown'}`,
    run_at: new Date().toISOString(),
    chosen_market: selection?.chosen_market ?? 'F5_TOTAL',
    why_this_market:
      selection?.why_this_market ?? 'Rule 1: only configured MLB game market',
    markets,
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
    // Statcast — populated by pull_mlb_statcast (09:00 ET daily via player-props scheduler)
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

    // Get existing pitcher data (if already populated in raw_data.mlb)
    const existingRaw =
      typeof oddsSnapshot.raw_data === 'string'
        ? JSON.parse(oddsSnapshot.raw_data)
        : (oddsSnapshot.raw_data ?? {});
    const mlb = existingRaw.mlb ?? {};
    const existingHomePitcher = mlb.home_pitcher ?? null;
    const existingAwayPitcher = mlb.away_pitcher ?? null;

    // Query by specific pitcher ID first, then by name, finally fallback to team
    function getPitcherRow(team, existingPitcher) {
      // Priority 1: match by mlb_id if available
      if (existingPitcher?.mlb_id != null) {
        const byId = forKEngine
          ? db.prepare('SELECT * FROM mlb_pitcher_stats WHERE mlb_id = ?')
          : db.prepare("SELECT * FROM mlb_pitcher_stats WHERE mlb_id = ? AND date(updated_at) = date('now')");
        const row = byId.get(existingPitcher.mlb_id);
        if (row) return row;
      }

      // Priority 2: match by full_name if available
      if (existingPitcher?.full_name != null) {
        const byName = forKEngine
          ? db.prepare('SELECT * FROM mlb_pitcher_stats WHERE full_name = ? COLLATE NOCASE')
          : db.prepare("SELECT * FROM mlb_pitcher_stats WHERE full_name = ? COLLATE NOCASE AND date(updated_at) = date('now')");
        const row = byName.get(existingPitcher.full_name);
        if (row) return row;
      }

      // Priority 3: fallback to team lookup (last resort)
      const byTeam = forKEngine
        ? db.prepare('SELECT * FROM mlb_pitcher_stats WHERE team = ? ORDER BY updated_at DESC LIMIT 1')
        : db.prepare("SELECT * FROM mlb_pitcher_stats WHERE team = ? AND date(updated_at) = date('now') LIMIT 1");
      
      for (const key of resolveMlbTeamLookupKeys(team)) {
        const row = byTeam.get(key);
        if (row) return row;
      }
      return null;
    }

    const homeRow = getPitcherRow(homeTeam, existingHomePitcher);
    const awayRow = getPitcherRow(awayTeam, existingAwayPitcher);

    // Canonical contract: hydrate full-game totals as mlb.full_game_line.
    const hydratedMlb = hydrateCanonicalMlbMarketLines(
      oddsSnapshot,
      mlb,
      { useF5ProjectionFloor },
    );
    Object.assign(mlb, hydratedMlb);
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
        // wind_dir IS wired into the model: resolveWeatherRunFactor() in mlb-model.js
        // applies a multiplicative coefficient to the run factor when wind_mph >= 10.
        //   OUT (or OUT_*): factor *= (1 + windStep)  — higher run expectation
        //   IN  (or IN_*):  factor *= (1 - windStep)  — lower run expectation
        // windStep = min(0.08, (mph - 8) * 0.005), clamped total factor to [0.88, 1.12].
        // This is NOT payload metadata — it affects F5 total projections.
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
  const jobRunId = `job-mlb-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[MLBModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[MLBModel] Job key: ${jobKey}`);
  }
  console.log(`[MLBModel] Time: ${new Date().toISOString()}`);
  if (withoutOddsMode) {
    console.log('[MLBModel] WITHOUT_ODDS_MODE=true — projection-floor lines, PROJECTION_ONLY cards, no settlement');
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
      const nowUtc = DateTime.utc();
      const projectionOnlyRuntimeContext = withoutOddsMode
        ? buildMlbProjectionOnlyRuntimeContext({ nowUtc })
        : null;
      if (projectionOnlyRuntimeContext) {
        console.log(
          `[MLBModel] PROJECTION_ONLY_CONTEXT_START ${formatMlbProjectionOnlyContextLog(projectionOnlyRuntimeContext)}`,
        );
      }

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
      console.log(`[SIGMA_SOURCE] sport=MLB source=${mlbSigma.sigma_source} games_sampled=${mlbSigma.games_sampled ?? null}`);
      // WI-0814: warn when using uncalibrated sigma — MLB F5/moneyline cards will be downgraded to LEAN
      if (mlbSigma.sigma_source === 'fallback') {
        console.warn(
          '[run_mlb_model] [SIGMA_FALLBACK] Fewer than 20 settled games — using uncalibrated sigma defaults. ' +
          'All PLAY cards will be downgraded to LEAN until empirical sigma is available.',
        );
      }
      console.log('[MLBModel] Fetching odds for upcoming MLB games...');
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
          return {
            success: true,
            jobRunId,
            cardsGenerated: 0,
            projection_only_context: projectionOnlyRuntimeContext,
          };
        }
        // Without-Odds-Mode: no odds_snapshots but games exist — synthesize from games table
        console.log('[MLBModel] WITHOUT_ODDS_MODE: no odds snapshots, building synthetic snapshots from games table');
        oddsSnapshots.push(...getUpcomingGamesAsSyntheticSnapshots('MLB', nowUtc.toISO(), horizonUtc));
        if (oddsSnapshots.length === 0) {
          console.log('[MLBModel] No upcoming MLB games found in games table, exiting.');
          markJobRunSuccess(jobRunId);
          return {
            success: true,
            jobRunId,
            cardsGenerated: 0,
            projection_only_context: projectionOnlyRuntimeContext,
          };
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
      if (projectionOnlyRuntimeContext) {
        projectionOnlyRuntimeContext.games_seeded_count = gameIdList.length;
        console.log(
          `[MLBModel] PROJECTION_ONLY_CONTEXT_RESOLVED ${formatMlbProjectionOnlyContextLog(projectionOnlyRuntimeContext)}`,
        );
      }
      console.log(`[MLBModel] Running inference on ${gameIdList.length} games...`);

      // WI-0840: compute dynamic league constants once per job run
      const leagueConstants = computeMLBLeagueAverages(getDatabase());
      setLeagueConstants(leagueConstants);
      console.log(
        `[MLB_LEAGUE_AVG] source=${leagueConstants.source} n=${leagueConstants.n}`,
      );

      let cardsGenerated = 0;
      let cardsFailed = 0;
      const errors = [];
      const gamePipelineStates = {};
      const pitcherPropSummary = {};
      const mlbFullGameFunnelSamples = [];
      const rolloutState = resolveMlbPitcherPropRolloutState();
      let attemptedStatcastRefresh = false;

      // Process each game — emit one card per qualifying driver market
      for (const gameId of gameIdList) {
        try {
          const baseOddsSnapshot = gameOdds[gameId];
          const gameOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
            forKEngine: false,
            useF5ProjectionFloor: withoutOddsMode,
          });
          let pitcherKOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
            forKEngine: true,
          });

          const gameDriverCards = computeMLBDriverCards(gameId, gameOddsSnapshot);
          
          // Projection-only markets are explicitly flagged so they bypass odds-backed
          // execution assumptions without muting official full-game markets.
          gameDriverCards.forEach((card) => {
            if (isProjectionOnlyMlbMarket(card)) {
              card.without_odds_mode = true;
            }
          });
          // K props draw from player_prop_lines — independent of F5 total line.
          // Always pass the resolved mode; per-pitcher fallback to PROJECTION_ONLY
          // happens inside computePitcherKDriverCards when no strikeout line is found.
          const _kMode = resolvePitcherKsMode();
          const _kCallOptions =
            _kMode === 'ODDS_BACKED'
              ? { mode: _kMode, bookmakerPriority: MLB_PROP_BOOKMAKER_PRIORITY }
              : { mode: _kMode };
          let rawPitcherKDriverCards = computePitcherKDriverCards(gameId, pitcherKOddsSnapshot, _kCallOptions);
          if (
            !attemptedStatcastRefresh &&
            hasMissingStatcastInputsInPitcherCards(rawPitcherKDriverCards)
          ) {
            attemptedStatcastRefresh = true;
            const statcastRefreshKey = `pull_mlb_statcast:auto-refresh:${new Date().toISOString().slice(0, 10)}`;
            try {
              const refreshResult = await pullMlbStatcast({
                jobKey: statcastRefreshKey,
                dryRun: false,
              });
              if (refreshResult?.success) {
                pitcherKOddsSnapshot = enrichMlbPitcherData(baseOddsSnapshot, {
                  forKEngine: true,
                });
                rawPitcherKDriverCards = computePitcherKDriverCards(
                  gameId,
                  pitcherKOddsSnapshot,
                  _kCallOptions,
                );
                console.log(
                  `[MLBModel] [pitcher-k] Statcast refresh completed (rowsUpdated=${refreshResult.rowsUpdated ?? 0}, skipped=${Boolean(refreshResult.skipped)})`,
                );
              } else {
                console.warn(
                  `[MLBModel] [pitcher-k] Statcast refresh failed: ${refreshResult?.error || 'unknown error'}`,
                );
              }
            } catch (refreshErr) {
              console.warn(`[MLBModel] [pitcher-k] Statcast refresh error: ${refreshErr.message}`);
            }
          }
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
              const _hasHardOrProxy = _qr.hardMissing.length > 0 || _qr.proxies.length > 0;
              pd.model_quality        = _hasHardOrProxy ? _qr.model_quality : 'FULL_MODEL';
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
              const auditSummary = buildMlbPitcherKAuditLog({
                gameId,
                driver,
                starterQuality: _qr.model_quality,
                reasonCodes: [..._qr.hardMissing, ..._qr.proxies],
                pitcher: _pitcher,
              });
              console.log(
                `[MLB_K_AUDIT] ${formatMlbPitcherKAuditLog(auditSummary)}`,
              );
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
          const gameEval = evaluateMlbGameMarkets(gameDriverCards, { game_id: gameId });
          assertNoSilentMarketDrop(gameEval);
          logRejectedMarkets(gameEval.rejected);

          const officialFullGameMarkets = new Set(
            (Array.isArray(gameEval.official_plays) ? gameEval.official_plays : [])
              .map((play) => String(play?.market_type || '').toUpperCase()),
          );
          for (const driver of gameDriverCards) {
            const marketKey = getMlbFullGameMarketKey(driver);
            if (!marketKey) continue;
            mlbFullGameFunnelSamples.push(
              evaluateMlbFullGameFunnelCandidate(
                driver,
                officialFullGameMarkets.has(marketKey),
              ),
            );
          }

          const dualRunRecord = buildMlbDualRunRecord(
            gameId,
            gameOddsSnapshot,
            {
              chosen_market: gameEval.status,
              why_this_market: `evaluateMlbGameMarkets: ${gameEval.status}`,
              markets: gameEval.market_results.map((r) => ({ market: r.market_type, status: r.status })),
              rejected: gameEval.rejected.reduce((acc, r) => {
                acc[r.market_type] = (r.reason_codes || []).join(',');
                return acc;
              }, {}),
            },
          );
          console.log(`[MLB_DUAL_RUN] ${formatMlbDualRunLog(dualRunRecord)}`);
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

          // Parse mlb raw data once for both F5 ML and synthetic-line F5 edge paths.
          const gameRawData = parseMlbRawData(gameOddsSnapshot);
          const mlb = gameRawData?.mlb && typeof gameRawData.mlb === 'object' ? gameRawData.mlb : {};
          const syntheticContext = {
            park_run_factor: mlb.park_run_factor ?? null,
            temp_f: mlb.temp_f ?? null,
            wind_mph: mlb.wind_mph ?? null,
            wind_dir: mlb.wind_dir ?? null,
            roof: mlb.roof ?? null,
          };

          // F5 ML side-projection card. Prefer dedicated F5 ML prices, but fall back
          // to full-game ML prices as a projection-only context so we do not silence
          // the model when first-5 lines are absent.
          const f5MlContext = resolveMlbF5MoneylineContext(gameOddsSnapshot);
          const hasDedicatedF5Ml = f5MlContext.home !== null && f5MlContext.away !== null;
          const f5MlHomePrice = hasDedicatedF5Ml
            ? f5MlContext.home
            : toFiniteNumber(gameOddsSnapshot?.h2h_home);
          const f5MlAwayPrice = hasDedicatedF5Ml
            ? f5MlContext.away
            : toFiniteNumber(gameOddsSnapshot?.h2h_away);
          let f5MlDriverCard = null;
          if (f5MlHomePrice !== null && f5MlAwayPrice !== null) {
            const f5MlResult = projectF5ML(
              mlb.home_pitcher ?? null,
              mlb.away_pitcher ?? null,
              f5MlHomePrice,
              f5MlAwayPrice,
              mlb.home_offense_profile ?? null,
              mlb.away_offense_profile ?? null,
              {
                park_run_factor: mlb.park_run_factor ?? null,
                temp_f: mlb.temp_f ?? null,
                wind_mph: mlb.wind_mph ?? null,
                wind_dir: mlb.wind_dir ?? null,
                roof: mlb.roof ?? null,
              },
            );
            if (f5MlResult) {
              const normalizedSelection = String(
                f5MlResult.prediction ?? '',
              ).toUpperCase();
              if (!isMlbMoneylineSelection(normalizedSelection)) {
                console.log(
                  '[MLBModel] F5 ML projection skipped (invalid selection prediction=' +
                    normalizedSelection +
                    ')',
                );
              } else {
              const confidence = f5MlResult.confidence / 10;
              const isStrongProjection = f5MlResult.ev_threshold_passed === true;
              f5MlDriverCard = {
                market: 'f5_ml',
                prediction: normalizedSelection,
                confidence,
                ev_threshold_passed: isStrongProjection,
                status: isStrongProjection ? 'FIRE' : 'WATCH',
                action: isStrongProjection ? 'FIRE' : 'HOLD',
                classification: isStrongProjection ? 'BASE' : 'LEAN',
                reason_codes: uniqueReasonCodes([
                  ...(isStrongProjection ? [] : ['PROJECTION_ONLY_INSIGHT']),
                  ...(hasDedicatedF5Ml ? [] : ['PROJECTION_PROXY_FULL_GAME_ML']),
                ]),
                reasoning: f5MlResult.reasoning,
                projection_source: 'FULL_MODEL',
                without_odds_mode: true,
                drivers: [{
                  type: 'mlb-f5-ml',
                  edge: f5MlResult.edge,
                  projected_win_prob_home: f5MlResult.projected_win_prob_home,
                }],
                ml_f5_home: f5MlHomePrice,
                ml_f5_away: f5MlAwayPrice,
              };
              }
            }
          } else {
            console.log('[MLBModel] NO_F5_ML_PRICE_CONTEXT: ' + gameId + ' — F5 ML projection skipped (no dedicated F5 or full-game ML prices)');
          }

          // Recover qualified driver cards from evaluateMlbGameMarkets results
          const qualifiedDrivers = [
            ...gameEval.official_plays,
            ...gameEval.leans,
          ].map((evalResult) => {
            return gameDriverCards.find(
              (c) => `${gameId}::${c.market ?? 'unknown'}` === evalResult.candidate_id,
            );
          }).filter(Boolean);

          // WI-0877: Try full-model synthetic-line edge driver first.
          // Falls back to SYNTHETIC_FALLBACK PASS when offense profiles are absent or
          // either side has missing projection inputs.
          const syntheticEdgeDriver = (marketAvailability.projection_floor && projectionFloorF5 !== null)
            ? computeSyntheticLineF5Driver(mlb, syntheticContext, gameId)
            : null;
          const projectionFloorDriver = syntheticEdgeDriver !== null
            ? syntheticEdgeDriver
            : (marketAvailability.projection_floor && projectionFloorF5 !== null)
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
          const hasProjectionOnlyFallbackCandidates =
            pitcherKDriverCards.some(
              (driver) => driver.execution_envelope?._publish_state?.emit_allowed === true,
            ) ||
            projectionFloorDriver !== null;

          // Short-circuit only when nothing can be emitted. Projection-only
          // pitcher props and projection-floor F5 cards should still write.
          if (
            (gameEval.status === 'SKIP_MARKET_NO_EDGE' ||
              gameEval.status === 'SKIP_GAME_INPUT_FAILURE') &&
            !hasProjectionOnlyFallbackCandidates
          ) {
            console.log(
              `  ⏭️  ${gameId}: ${gameEval.status} — ${gameEval.rejected
                .flatMap((r) => r.reason_codes)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(', ') || 'no reason codes'}`,
            );
            gamePipelineStates[gameId] = buildMlbPipelineState({
              oddsSnapshot: gameOddsSnapshot,
              marketAvailability,
              projectionReady: gameEval.status !== 'SKIP_GAME_INPUT_FAILURE',
              driversReady: false,
              pricingReady: false,
              cardReady: false,
              executionEnvelopes: [],
            });
            continue;
          }
          const gamePricingStatus = gameOddsSnapshot?.captured_at ? 'FRESH' : 'MISSING';
          const gamePricingReason = gameOddsSnapshot?.captured_at
            ? null
            : 'ODDS_SNAPSHOT_MISSING';
          const projectionOnlyInsights = gameDriverCards.filter((driver) => {
            if (String(driver?.market || '').toLowerCase() !== 'f5_total') return false;
            if (!isProjectionOnlyMlbMarket(driver)) return false;
            const status = String(driver?.status || '').toUpperCase();
            return (status === 'FIRE' || status === 'WATCH') && !qualifiedDrivers.includes(driver);
          });
          const candidateDrivers = [
            ...qualifiedDrivers.map((driver) => ({
              driver,
              executionEnvelope: deriveMlbExecutionEnvelope({
                driver,
                pricingStatus: isProjectionOnlyMlbMarket(driver) ? 'NOT_REQUIRED' : gamePricingStatus,
                pricingReason: isProjectionOnlyMlbMarket(driver) ? 'PROJECTION_ONLY_MARKET' : gamePricingReason,
                pricingCapturedAt: gameOddsSnapshot?.captured_at ?? null,
              }),
            })),
            ...projectionOnlyInsights.map((driver) => ({
              driver: {
                ...driver,
                without_odds_mode: true,
                reason_codes: uniqueReasonCodes([
                  ...(Array.isArray(driver.reason_codes) ? driver.reason_codes : []),
                  'PROJECTION_ONLY_INSIGHT',
                ]),
              },
              executionEnvelope: deriveMlbExecutionEnvelope({
                driver,
                pricingStatus: 'NOT_REQUIRED',
                pricingReason: 'PROJECTION_ONLY_MARKET',
                pricingCapturedAt: null,
              }),
            })),
            ...pitcherKDriverCards
              .filter((driver) => driver.execution_envelope)
              .map((driver) => ({
                driver,
                executionEnvelope: driver.execution_envelope,
              })),
            ...(f5MlDriverCard
              ? [{
                  driver: f5MlDriverCard,
                  executionEnvelope: deriveMlbExecutionEnvelope({
                    driver: f5MlDriverCard,
                    pricingStatus: 'NOT_REQUIRED',
                    pricingReason: 'PROJECTION_ONLY_MARKET',
                    pricingCapturedAt: null,
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

          // WI-0817: deletes are deferred to the per-game write transaction below (after qualified check).
          // pricing_ready = true only when odds-backed qualified cards exist (not floor-only)
          const oddsBackedQualified = qualified.filter((d) =>
            resolveMlbTrustClass(resolveMlbMarketGroup(d)) === MLB_MARKET_TRUST_CLASS.ODDS_BACKED
          );
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
            `[MLB_PIPELINE_STATE] ${formatMlbPipelineStateLog(gameId, pipelineState)}`,
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

          // WI-0817: atomic write phase — all deletes + all inserts in one transaction.
          // A crash or throw inside this block rolls back automatically; old cards survive intact.
          const _cardLogs = [];
          runPerGameWriteTransaction(() => {
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-model-output', { runId: jobRunId });
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-strikeout', { runId: jobRunId });
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-f5', { runId: jobRunId });
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-f5-ml', { runId: jobRunId });
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-pitcher-k', { runId: jobRunId });
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-full-game', { runId: jobRunId });
            prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-full-game-ml', { runId: jobRunId });

          for (const driver of qualified) {
            const isF5 = driver.market === 'f5_total';
            const isF5ML = driver.market === 'f5_ml';
            const isFullGameTotal = driver.market === 'full_game_total';
            const isFullGameML = driver.market === 'full_game_ml';
            const isPitcherK = driver.market?.startsWith('pitcher_k_');
            const cardType = isF5 ? 'mlb-f5'
              : isF5ML ? 'mlb-f5-ml'
              : isFullGameTotal ? 'mlb-full-game'
              : isFullGameML ? 'mlb-full-game-ml'
              : isPitcherK ? 'mlb-pitcher-k'
              : 'mlb-strikeout';
            const marketGroup = resolveMlbMarketGroup(driver);
            const trustClass = resolveMlbTrustClass(marketGroup);

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
            const pitcherKPayloadConfig = isPitcherK
              ? buildMlbPitcherKPayloadFields({
                  driver,
                  pitcherPlayerId,
                  pitcherPlayerName,
                  projected,
                })
              : null;

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
              market_type: (isF5 || isF5ML) ? 'FIRST_5_INNINGS' : (isFullGameTotal || isFullGameML) ? 'FULL_GAME' : 'PROP',
              market_group: marketGroup,
              trust_class: trustClass,
              status: driver.status ?? (driver.ev_threshold_passed ? 'FIRE' : 'PASS'),
              action: driver.action ?? (driver.ev_threshold_passed ? 'FIRE' : 'PASS'),
              classification: driver.classification ?? (driver.ev_threshold_passed ? 'BASE' : 'PASS'),
              prediction: driver.prediction,
              selection: {
                side: pitcherKPayloadConfig?.selectionSide ?? driver.prediction,
              },
              line: pitcherKPayloadConfig?.line ?? line,
              model_status: driver.model_status ?? 'MODEL_OK',
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
              ...(isF5ML || isFullGameML
                ? resolveMlbMoneylineExecutionInputs({
                    prediction: driver.prediction,
                    winProbHome:
                      driver.drivers?.[0]?.projected_win_prob_home ??
                      driver.drivers?.[0]?.win_prob_home ??
                      null,
                    homePrice: isF5ML
                      ? driver.ml_f5_home
                      : gameOddsSnapshot?.h2h_home,
                    awayPrice: isF5ML
                      ? driver.ml_f5_away
                      : gameOddsSnapshot?.h2h_away,
                    rawEdge: driverDetail.edge,
                  })
                : isFullGameTotal
                  ? (() => {
                      const fgCtx = resolveMlbFullGameTotalContext(gameOddsSnapshot);
                      return resolveMlbTotalExecutionInputs({
                        prediction: driver.prediction,
                        projectedTotal:
                          driver.projection?.projected_total ??
                          driverDetail.projected ??
                          null,
                        marketLine: fgCtx.line,
                        overPrice: fgCtx.over_price,
                        underPrice: fgCtx.under_price,
                        pOver: driver.projection?.p_over ?? null,
                        pUnder: driver.projection?.p_under ?? null,
                      });
                    })()
                : {}),
              // Projection-only cards are explicitly tagged for downstream separation.
              // projection_floor is only set when the driver itself is a synthetic floor driver.
              ...(driver.without_odds_mode ? { without_odds_mode: true, tags: ['no_odds_mode'] } : {}),
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
                    chosen_market: gameEval.status,
                    why_this_market: `evaluateMlbGameMarkets: ${gameEval.status}`,
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
                : isFullGameTotal
                  ? (() => {
                      const fgCtx = resolveMlbFullGameTotalContext(gameOddsSnapshot);
                      return {
                        recommended_bet_type: 'total',
                        odds_context: {
                          total: fgCtx.line ?? null,
                          total_price_over: fgCtx.over_price ?? null,
                          total_price_under: fgCtx.under_price ?? null,
                          captured_at: gameOddsSnapshot?.captured_at ?? null,
                        },
                        projection: driver.projection ?? null,
                        primary_game_market: true,
                      };
                    })()
                : isFullGameML
                  ? {
                      recommended_bet_type: 'moneyline',
                      odds_context: {
                        h2h_home: gameOddsSnapshot?.h2h_home ?? null,
                        h2h_away: gameOddsSnapshot?.h2h_away ?? null,
                        captured_at: gameOddsSnapshot?.captured_at ?? null,
                      },
                      projection: {
                        projected_win_prob_home: driver.drivers?.[0]?.win_prob_home ?? null,
                      },
                      primary_game_market: false,
                    }
                : isPitcherK
                  ? pitcherKPayloadConfig.payloadFields
                  : {
                      player_name: pitcherTeam ? `${pitcherTeam} SP` : 'SP',
                      canonical_market_key: 'pitcher_strikeouts',
                    }),
            };
            const projectionOnlyMarket = trustClass === MLB_MARKET_TRUST_CLASS.PROJECTION_ONLY;
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
            payloadData.card_type = cardType;
            payloadData.market_contract = buildMlbMarketContract({
              driver,
              oddsSnapshot: gameOddsSnapshot,
              line: payloadData.line,
              price: payloadData.price,
            });
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
            const effectiveProjectionOnlyContext =
              driver.without_odds_mode ||
              payloadData.execution_status === 'PROJECTION_ONLY'
                ? projectionOnlyRuntimeContext
                : null;
            if (effectiveProjectionOnlyContext) {
              applyMlbProjectionOnlyGuards(
                payloadData,
                effectiveProjectionOnlyContext,
              );
            }
            if (trustClass === MLB_MARKET_TRUST_CLASS.ODDS_BACKED) {
              applyExecutionGateToMlbPayload(payloadData, {
                oddsSnapshot: {
                  captured_at: gameOddsSnapshot?.captured_at ?? null,
                  fetched_at: payloadData.line_fetched_at ?? null,
                },
              });
            } else {
              const projectionOnlySnapshotMeta = resolveSnapshotTimestampMeta(
                gameOddsSnapshot,
                payloadData,
                Date.now(),
              );
              payloadData.snapshot_timestamp = projectionOnlySnapshotMeta.snapshotTimestamp;
              payloadData.execution_gate = {
                evaluated: false,
                should_bet: null,
                net_edge: null,
                blocked_by: ['PROJECTION_ONLY_MARKET'],
                model_status: String(payloadData.model_status || 'MODEL_OK').toUpperCase(),
                snapshot_age_ms: projectionOnlySnapshotMeta.resolution?.resolved_age_ms ?? null,
                freshness_decision: null,
                evaluated_at: new Date().toISOString(),
                drop_reason: {
                  drop_reason_code: 'PROJECTION_ONLY_MARKET',
                  drop_reason_layer: 'worker_gate',
                },
              };
              payloadData.execution_envelope = {
                snapshot_id: gameOddsSnapshot?.id ?? null,
                snapshot_timestamp: projectionOnlySnapshotMeta.snapshotTimestamp,
                freshness_decision: null,
              };
            }
            assertMlbExecutionInvariant(payloadData);

            const cardTitle = isF5
              ? `F5 ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
              : isF5ML
                ? `F5 ML ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
                : isFullGameTotal
                  ? `Full Game Total ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
                : isFullGameML
                  ? `Full Game ML ${driver.prediction}: ${gameOddsSnapshot?.away_team ?? '?'} @ ${gameOddsSnapshot?.home_team ?? '?'}`
                : isPitcherK
                  ? `${pitcherTeam ?? '?'} SP Ks ${pitcherKPayloadConfig?.selectionSide ?? driver.prediction}${pitcherKPayloadConfig?.titleSuffix ?? ''}`
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
            const modelOutputData = effectiveProjectionOnlyContext
              ? applyMlbProjectionOnlyGuards(
                  {
                    ...driver,
                    runtime_context: { ...effectiveProjectionOnlyContext },
                    projection_only_flags: payloadData.market_trust_flags,
                  },
                  effectiveProjectionOnlyContext,
                )
              : driver;
            insertModelOutput({
              id: modelOutputId,
              gameId,
              sport: 'MLB',
              modelName: 'mlb-model-v1',
              modelVersion: '1.0.0',
              predictionType: cardType,
              predictedAt: now,
              confidence: driver.confidence,
              outputData: modelOutputData,
              // WITHOUT_ODDS_MODE: synthetic snapshots are not persisted to odds_snapshots,
              // so passing their id would break the FK constraint. Pass null instead.
              oddsSnapshotId: baseOddsSnapshot.id?.startsWith('synthetic-') ? null : baseOddsSnapshot.id,
              jobRunId,
            });

            card.modelOutputIds = modelOutputId;
            attachRunId(card, jobRunId);
            // WI-0835: annotate sigma provenance on card payload raw_data
            if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
            card.payloadData.raw_data.sigma_source = mlbSigma.sigma_source;
            card.payloadData.raw_data.sigma_games_sampled = mlbSigma.games_sampled ?? null;
            // WI-0831: apply isotonic calibration to fair_prob before Kelly and card write.
            {
              const pd = card.payloadData;
              if (Number.isFinite(pd.p_fair)) {
                let breakpoints = null;
                try {
                  const calRow = getDatabase().prepare(
                    'SELECT breakpoints_json FROM calibration_models WHERE sport = ? AND market_type = ?',
                  ).get('MLB', 'MLB_F5_TOTAL');
                  breakpoints = calRow ? JSON.parse(calRow.breakpoints_json) : null;
                } catch (_e) {
                  console.log('[CAL_APPLY] MLB calibration_models table not ready — using raw');
                }
                const { calibratedProb, calibrationSource } = applyCalibration(pd.p_fair, breakpoints);
                pd.p_fair = calibratedProb;
                pd.raw_data.calibration_source = calibrationSource;
              }
            }
            // WI-0819: attach advisory Kelly stake fraction to actionable cards.
            {
              const pd = card.payloadData;
              const isPass =
                String(pd.status || '').toUpperCase() === 'PASS' ||
                String(pd.action || '').toUpperCase() === 'PASS' ||
                String(pd.classification || '').toUpperCase() === 'PASS';
              if (!isPass && Number.isFinite(pd.p_fair) && Number.isFinite(pd.price)) {
                const { kelly_fraction, kelly_units } = edgeCalculator.kellyStake(pd.p_fair, pd.price);
                pd.kelly_fraction = kelly_fraction;
                pd.kelly_units = kelly_units;
              } else {
                pd.kelly_fraction = null;
                pd.kelly_units = null;
              }
            }
            card.payloadData.pipeline_state = pipelineState;
            // WI-0827: feature timeliness audit — warn on future-leakage violations (Phase 1).
            {
              const _betPlacedAt = baseOddsSnapshot?.captured_at ?? null;
              if (_betPlacedAt) {
                const _timeliness = assertFeatureTimeliness(
                  (typeof baseOddsSnapshot?.raw_data === 'object' ? baseOddsSnapshot.raw_data : {}) ?? {},
                  _betPlacedAt,
                );
                if (!_timeliness.ok) {
                  console.warn(
                    `[FeatureGuard] ${gameId}: ${_timeliness.violations.length} violation(s): ` +
                      _timeliness.violations.map((v) => v.field).join(', '),
                  );
                }
                card.payloadData.feature_timeliness = _timeliness;
              }
            }
            insertCardPayload(card);

            if (isFullGameTotal && payloadData?.projection?.component_breakdown) {
              const modelTotal = Number(payloadData?.projection?.projected_total);
              const marketTotal = Number(payloadData?.odds_context?.total ?? payloadData?.line);
              const edge = Number.isFinite(modelTotal) && Number.isFinite(marketTotal)
                ? modelTotal - marketTotal
                : null;
              console.log(
                `[MLB_PROJECTION_COMPONENTS] ${JSON.stringify({
                  gameId,
                  prediction: driver.prediction,
                  model_total: Number.isFinite(modelTotal) ? modelTotal : null,
                  market_total: Number.isFinite(marketTotal) ? marketTotal : null,
                  edge,
                  components: payloadData.projection.component_breakdown,
                })}`,
              );
            }

                        _cardLogs.push(`  ✅ ${gameId} [${cardType}]: ${driver.prediction} (${(driver.confidence * 100).toFixed(0)}%)`);
          }
          });
          for (const _logLine of _cardLogs) {
            cardsGenerated++;
            console.log(_logLine);
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
        `[MLBModel] Pipeline states: ${summarizeMlbPipelineStates(gamePipelineStates)}`,
      );
      const suppressionFunnel = buildMlbFullGameSuppressionFunnelReport(
        mlbFullGameFunnelSamples,
      );
      const directionalFunnel = buildMlbFullGameDirectionalFunnelReport(
        mlbFullGameFunnelSamples,
      );
      console.log(
        `[MLB_SUPPRESSION_FUNNEL] ${JSON.stringify(suppressionFunnel)}`,
      );
      console.log(
        `[MLB_DIRECTIONAL_FUNNEL] ${JSON.stringify(directionalFunnel)}`,
      );
      
      // Killshot audit: show exactly where overs die
      const killshotAudit = buildMlbKillshotGateAudit(mlbFullGameFunnelSamples);
      console.log(
        `[MLB_KILLSHOT_GATE_AUDIT] ${JSON.stringify(killshotAudit)}`,
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
        projection_only_context: projectionOnlyRuntimeContext,
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
  buildMlbProjectionOnlyRuntimeContext,
  applyMlbProjectionOnlyGuards,
  hydrateCanonicalMlbMarketLines,
  buildMlbDualRunRecord,
  formatMlbDualRunLog,
  buildMlbPitcherKAuditLog,
  formatMlbPitcherKAuditLog,
  buildMlbF5OddsContext,
  buildMlbMarketAvailability,
  buildMlbPipelineState,
  MLB_PIPELINE_REASON_CODES,
  resolveMlbTeamLookupKeys,
  resolvePitcherKsMode,
  resolveMlbPitcherPropRolloutState,
  resolvePitcherKPayloadIdentity,
  buildMlbPitcherKPayloadFields,
  isTimestampFresh,
  filterSnapshotsByGameIds,
  evaluatePitcherPropPublishability,
  deriveMlbExecutionEnvelope,
  resolveMlbTotalExecutionInputs,
  resolveMlbMoneylineExecutionInputs,
  assertMlbExecutionInvariant,
  applyExecutionGateToMlbPayload,
  // Exported for WI-0596 unit tests
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
  buildPitcherKLineContract,
  buildPitcherStrikeoutLookback,
  // Exported for WI-0637 unit tests
  computeProjectionFloorF5,
  // Exported for WI-0877 unit tests
  computeSyntheticLineF5Driver,
  // Exported for WI-0648 unit tests
  MIN_MLB_GAMES_FOR_RECAL,
  // Exported for WI-0944 funnel instrumentation
  buildMlbFullGameSuppressionFunnelReport,
  buildMlbFullGameDirectionalFunnelReport,
  buildMlbKillshotGateAudit,
  evaluateMlbFullGameFunnelCandidate,
  getMlbFullGameMarketKey,
  normalizeReasonCodeSet,
  MLB_FULL_GAME_FUNNEL_WINDOW,
  MLB_FULL_GAME_DIRECTIONAL_FUNNEL_WINDOW,
};
