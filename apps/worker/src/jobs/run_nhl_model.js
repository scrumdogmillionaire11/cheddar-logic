/**
 * NHL Model Runner Job
 *
 * Reads latest NHL odds from DB, runs inference model, and stores:
 * - card_payloads (ready-to-render web cards)
 *
 * NOTE: This job does NOT write model_outputs. Only run_mlb_model.js and
 * run_nfl_model.js call insertModelOutput(). See packages/data/src/db/models.js.
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
  getUpcomingGamesAsSyntheticSnapshots,
  insertCardPayload,
  prepareModelAndCardWrite,
  runPerGameWriteTransaction,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  enrichOddsSnapshotWithEspnMetrics,
  updateOddsSnapshotRawData,
  getDatabase,
  getPlayerAvailabilityByTeam,
} = require('@cheddar-logic/data');
const {
  enrichOddsSnapshotWithMoneyPuck,
  fetchMoneyPuckSnapshot,
} = require('../moneypuck');

// Import pluggable inference layer
const {
  getModel,
  computeNHLDriverCards,
  generateCard,
  computeNHLMarketDecisions,
  selectExpressionChoice,
  buildMarketPayload,
  determineTier,
  buildMarketCallCard,
  extractNhlDriverDataQualityContext,
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
const { resolveGoalieState } = require('../models/nhl-goalie-state');
const {
  isPlayoffGame,
  PLAYOFF_SIGMA_MULTIPLIER,
} = require('../utils/playoff-detection');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';
const USE_ORCHESTRATED_MARKET =
  process.env.USE_ORCHESTRATED_MARKET === 'true';
// WI-0505: Phase-2 gate for NHL 1P fair probability math.
// Requires stable real 1P line supply in odds snapshot (total_1p must be a number).
// Rollback: set NHL_1P_FAIR_PROB_PHASE2=false and redeploy; no migration needed.
const NHL_1P_FAIR_PROB_PHASE2 =
  process.env.NHL_1P_FAIR_PROB_PHASE2 === 'true';
const NHL_1P_SIGMA = Number.isFinite(parseFloat(process.env.NHL_1P_SIGMA))
  ? parseFloat(process.env.NHL_1P_SIGMA)
  : 1.26;

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
  'welcome-home',
  'welcome-home-v2', // alias: backward compat with existing DB rows
  'nhl-goalie',
  'nhl-goalie-certainty',
  'nhl-model-output',
  'nhl-shot-environment',
  'nhl-pace-totals',
  'nhl-pace-1p',
];
const NHL_SNAPSHOT_CARD_TYPES = new Set([
  'nhl-pace-totals',
  'nhl-pace-1p',
  'nhl-totals-call',
]);

/**
 * WI-0646: Apply PLAYOFF_SIGMA_MULTIPLIER to sigma overrides.
 * Only multiplies finite numeric fields so null/undefined gracefully pass through.
 */
function applyPlayoffSigmaMultiplier(sigma, multiplier) {
  if (!sigma) return sigma;
  return {
    ...sigma,
    spread: Number.isFinite(sigma.spread) ? sigma.spread * multiplier : sigma.spread,
    total: Number.isFinite(sigma.total) ? sigma.total * multiplier : sigma.total,
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
  cards = [],
  blockingReasonCodes = [],
}) {
  const teamMappingOk = Boolean(
    oddsSnapshot?.home_team && oddsSnapshot?.away_team,
  );
  const marketLinesOk =
    hasMoneylineOdds(oddsSnapshot) ||
    hasSpreadOdds(oddsSnapshot) ||
    hasTotalOdds(oddsSnapshot);
  const derivedPricingReady =
    Array.isArray(cards) && cards.length > 0
      ? cards.some((card) => card?.payloadData?._pricing_state?.status === 'FRESH')
      : pricingReady === true;
  const derivedCardReady =
    Array.isArray(cards) && cards.length > 0
      ? cards.some((card) => card?.payloadData?._publish_state?.emit_allowed === true)
      : cardReady === true;

  return buildPipelineState({
    ingested: Boolean(oddsSnapshot),
    team_mapping_ok: teamMappingOk,
    odds_ok: Boolean(oddsSnapshot?.captured_at) && marketLinesOk,
    market_lines_ok: marketLinesOk,
    projection_ready: projectionReady === true,
    drivers_ready: driversReady === true,
    pricing_ready: derivedPricingReady,
    card_ready: derivedCardReady,
    blocking_reason_codes: blockingReasonCodes,
  });
}

function deriveGameBlockingReasonCodes({
  oddsSnapshot,
  projectionReady,
  pricingReady,
  cards = [],
  homeGoalieState,
  awayGoalieState,
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

  // WI-0383: Goalie state watchdog checks
  const homeStarterState = homeGoalieState?.starter_state;
  const awayStarterState = awayGoalieState?.starter_state;

  if (homeStarterState === 'CONFLICTING' || awayStarterState === 'CONFLICTING') {
    reasonCodes.push(WATCHDOG_REASONS.GOALIE_CONFLICTING);
  }

  if (homeStarterState === 'UNKNOWN' || awayStarterState === 'UNKNOWN') {
    reasonCodes.push(WATCHDOG_REASONS.GOALIE_UNCONFIRMED);
    // Does not force PASS alone; confidence-cap path handles demotion
  }

  return reasonCodes;
}

function canPriceCard(card) {
  const sharpPriceStatus = card?.payloadData?.decision_v2?.sharp_price_status;
  return Boolean(sharpPriceStatus && sharpPriceStatus !== 'UNPRICED');
}

function attachNhlExecutionEnvelope(card, { projectionReady = true } = {}) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;
  const payload = card.payloadData;
  const executionStatus = String(payload.execution_status || '').toUpperCase() || 'BLOCKED';
  const pricingStatus =
    payload?._pricing_state?.status ||
    (canPriceCard(card)
      ? 'FRESH'
      : executionStatus === 'PROJECTION_ONLY'
        ? 'NOT_REQUIRED'
        : 'MISSING');

  payload._prediction_state = {
    ...(payload._prediction_state && typeof payload._prediction_state === 'object'
      ? payload._prediction_state
      : {}),
    status: projectionReady === true ? 'QUALIFIED' : 'UNQUALIFIED',
    reason: projectionReady === true ? null : 'PROJECTION_INPUTS_INCOMPLETE',
  };
  payload._pricing_state = {
    status: pricingStatus,
    reason:
      payload?._pricing_state?.reason ??
      (pricingStatus === 'FRESH' ? null : `pricing_status=${pricingStatus}`),
    captured_at:
      payload?._pricing_state?.captured_at ??
      payload?.odds_context?.captured_at ??
      null,
  };
  payload._publish_state = {
    ...(payload._publish_state && typeof payload._publish_state === 'object'
      ? payload._publish_state
      : {}),
    publish_ready: executionStatus === 'EXECUTABLE',
    emit_allowed: true,
    execution_status: executionStatus,
    block_reason:
      executionStatus === 'EXECUTABLE'
        ? null
        : payload?._publish_state?.block_reason || `execution_status=${executionStatus}`,
  };
  payload.actionable = executionStatus === 'EXECUTABLE';
  payload.publish_ready = payload._publish_state.publish_ready === true;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneAuditValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneAuditValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneAuditValue(nested)]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  Object.values(value).forEach((nested) => {
    deepFreeze(nested);
  });
  return value;
}

function emitNhlSnapshotInvariant(level, message) {
  const error = new Error(`[INVARIANT_BREACH][LEVEL=${level}] ${message}`);
  error.code = 'INVARIANT_BREACH';
  error.level = level;

  if (process.env.NODE_ENV === 'test') {
    throw error;
  }

  console.warn(error.message);
}

function assertNhlSnapshotInvariant(condition, level, message) {
  if (condition) return;
  emitNhlSnapshotInvariant(level, message);
}

// WI-0789: NHL key-player availability gate
// Parallel to NBA_IMPACT_PLAYERS. Curated set of high-impact skaters and
// starting goalies whose absence materially affects model output.
const NHL_IMPACT_PLAYERS = new Set([
  // Top skaters — forwards & defensemen
  'Connor McDavid',
  'Leon Draisaitl',
  'Nathan MacKinnon',
  'Cale Makar',
  'David Pastrnak',
  'Auston Matthews',
  'Mitch Marner',
  'Sidney Crosby',
  'Evgeni Malkin',
  'Alex Ovechkin',
  'John Tavares',
  'William Nylander',
  'Matthew Tkachuk',
  'Sam Reinhart',
  'Aleksander Barkov',
  'Mikko Rantanen',
  'Brayden Point',
  'Steven Stamkos',
  'Nikita Kucherov',
  'Victor Hedman',
  'Roman Josi',
  'Dougie Hamilton',
  'Quinn Hughes',
  'Mark Scheifele',
  'Kyle Connor',
  'Bo Horvat',
  'Elias Pettersson',
  'Kirill Kaprizov',
  'Brady Tkachuk',
  'Tim Stutzle',
  'Joel Farabee',
  'Tage Thompson',
  'JJ Peterka',
  'Clayton Keller',
  // Top starting goalies
  'Connor Hellebuyck',
  'Igor Shesterkin',
  'Andrei Vasilevskiy',
  'Jake Oettinger',
  'Logan Thompson',
  'Linus Ullmark',
  'Jeremy Swayman',
  'Juuse Saros',
  'Thatcher Demko',
  'Frederik Andersen',
  'Sam Montembeault',
  'Stuart Skinner',
  'Calvin Pickard',
]);

// WI-0789: Full odds-snapshot team name → ESPN abbreviation map (32 teams)
const NHL_TEAM_ABBR_MAP = {
  'Anaheim Ducks': 'ANA',
  'Boston Bruins': 'BOS',
  'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY',
  'Carolina Hurricanes': 'CAR',
  'Chicago Blackhawks': 'CHI',
  'Colorado Avalanche': 'COL',
  'Columbus Blue Jackets': 'CBJ',
  'Dallas Stars': 'DAL',
  'Detroit Red Wings': 'DET',
  'Edmonton Oilers': 'EDM',
  'Florida Panthers': 'FLA',
  'Los Angeles Kings': 'LAK',
  'Minnesota Wild': 'MIN',
  'Montreal Canadiens': 'MTL',
  'Nashville Predators': 'NSH',
  'New Jersey Devils': 'NJD',
  'New York Islanders': 'NYI',
  'New York Rangers': 'NYR',
  'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI',
  'Pittsburgh Penguins': 'PIT',
  'Seattle Kraken': 'SEA',
  'San Jose Sharks': 'SJS',
  'St. Louis Blues': 'STL',
  'Tampa Bay Lightning': 'TBL',
  'Toronto Maple Leafs': 'TOR',
  'Utah Mammoth': 'UTA',
  'Utah Hockey Club': 'UTA',
  'Vancouver Canucks': 'VAN',
  'Vegas Golden Knights': 'VGK',
  'Washington Capitals': 'WSH',
  'Winnipeg Jets': 'WPG',
};

/**
 * WI-0789: Build key-player availability gate for an NHL game.
 *
 * Queries player_availability for both teams. Checks whether any impact player
 * (from NHL_IMPACT_PLAYERS) is INJURED/OUT or DTD.
 *
 * Fail-open design:
 * - No rows (sync hasn't run yet, or team unmappable) → empty flags, no degradation
 * - Only emits flags when there is positive evidence of a player being INJURED/OUT/DTD
 *
 * @param {string} homeTeam  Full team name from odds snapshot, e.g. 'Edmonton Oilers'
 * @param {string} awayTeam  Full team name from odds snapshot, e.g. 'Toronto Maple Leafs'
 * @returns {{ missingFlags: string[], uncertainFlags: string[], availabilityFlags: Array<{player:string,team:string,status:string}> }}
 */
function buildNhlAvailabilityGate(homeTeam, awayTeam) {
  const EMPTY = { missingFlags: [], uncertainFlags: [], availabilityFlags: [] };
  try {
    const homeAbbr = NHL_TEAM_ABBR_MAP[homeTeam] || null;
    const awayAbbr = NHL_TEAM_ABBR_MAP[awayTeam] || null;

    // No team mapping — can't query; proceed normally
    if (!homeAbbr && !awayAbbr) return EMPTY;

    const allRows = [];
    if (homeAbbr) allRows.push(...getPlayerAvailabilityByTeam(homeAbbr, 'NHL'));
    if (awayAbbr) allRows.push(...getPlayerAvailabilityByTeam(awayAbbr, 'NHL'));

    // Sync hasn't run yet — fail-open, don't degrade cards
    if (allRows.length === 0) {
      return { ...EMPTY, missingFlags: ['nhl_availability_unresolved'] };
    }

    const missingFlags = [];
    const uncertainFlags = [];
    const availabilityFlags = [];

    for (const row of allRows) {
      const playerName = row.player_name || '';
      if (!NHL_IMPACT_PLAYERS.has(playerName)) continue;

      if (row.status === 'INJURED' || row.status === 'OUT') {
        if (!missingFlags.includes('key_player_out')) missingFlags.push('key_player_out');
        availabilityFlags.push({ player: playerName, team: row.team_id, status: row.status });
      } else if (row.status === 'DTD' || row.status === 'GTD') {
        if (!uncertainFlags.includes('key_player_uncertain')) uncertainFlags.push('key_player_uncertain');
        availabilityFlags.push({ player: playerName, team: row.team_id, status: row.status });
      }
    }

    return { missingFlags, uncertainFlags, availabilityFlags };
  } catch (err) {
    // Fail-open: DB query errors must not block card generation
    console.log(`  [availability] buildNhlAvailabilityGate error (${err.message}) — skipping gate`);
    return EMPTY;
  }
}

function extractNhlPaceAuditContext(descriptors) {
  if (!Array.isArray(descriptors)) return null;
  for (const descriptor of descriptors) {
    const paceResult = descriptor?.auditContext?.paceResult;
    if (paceResult && typeof paceResult === 'object') {
      return {
        paceResult,
      };
    }
  }
  return null;
}

function isNhlSnapshotCard(card) {
  return NHL_SNAPSHOT_CARD_TYPES.has(card?.cardType);
}

function hasUnknownGoalie(paceResult) {
  return (
    paceResult?.homeGoalieCertainty === 'UNKNOWN' ||
    paceResult?.awayGoalieCertainty === 'UNKNOWN'
  );
}

function buildNhlGoalieCertaintyPair(paceResult) {
  const home = paceResult?.homeGoalieCertainty ?? 'UNKNOWN';
  const away = paceResult?.awayGoalieCertainty ?? 'UNKNOWN';
  return `${home}/${away}`;
}

function applyNhlGoalieExecutionStatusGuard(card, paceResult) {
  if (!isNhlSnapshotCard(card) || !card?.payloadData || !paceResult) return;
  if (!hasUnknownGoalie(paceResult)) return;
  card.payloadData.execution_status = 'PROJECTION_ONLY';
}

function buildNhlModelSnapshot({ paceResult, payload, sigmaTotal }) {
  const missingFields = [];
  const requiredFields = [
    'homeExpected',
    'awayExpected',
    'expectedTotal',
    'rawTotalModel',
    'regressedTotalModel',
    'modifierBreakdown',
    'homeGoalieCertainty',
    'awayGoalieCertainty',
    'homeAdjustmentTrust',
    'awayAdjustmentTrust',
    'official_eligible',
    'first_period_model',
  ];

  requiredFields.forEach((field) => {
    if (paceResult?.[field] === undefined) {
      missingFields.push(field);
    }
  });

  const consistency = {
    pace_tier: payload?.consistency?.pace_tier ?? null,
    event_env: payload?.consistency?.event_env ?? null,
    total_bias: payload?.consistency?.total_bias ?? null,
  };
  Object.entries(consistency).forEach(([field, value]) => {
    if (!isNonEmptyString(value)) {
      missingFields.push(`consistency.${field}`);
    }
  });

  const snapshot = {
    homeExpected: paceResult?.homeExpected ?? null,
    awayExpected: paceResult?.awayExpected ?? null,
    expectedTotal: paceResult?.expectedTotal ?? null,
    rawTotalModel: paceResult?.rawTotalModel ?? null,
    regressedTotalModel: paceResult?.regressedTotalModel ?? null,
    sigma_total: Number.isFinite(sigmaTotal) ? sigmaTotal : null,
    modifierBreakdown: cloneAuditValue(paceResult?.modifierBreakdown ?? {}),
    homeGoalieCertainty: paceResult?.homeGoalieCertainty ?? null,
    awayGoalieCertainty: paceResult?.awayGoalieCertainty ?? null,
    homeAdjustmentTrust: paceResult?.homeAdjustmentTrust ?? null,
    awayAdjustmentTrust: paceResult?.awayAdjustmentTrust ?? null,
    official_eligible: paceResult?.official_eligible ?? null,
    first_period_model: cloneAuditValue(paceResult?.first_period_model ?? {}),
    consistency,
  };

  if (missingFields.length > 0) {
    emitNhlSnapshotInvariant(
      'WARNING',
      `snapshot fields missing for ${payload?.game_id || 'unknown-game'}: ${missingFields.join(', ')}`,
    );
  }

  const modifierBreakdown = snapshot.modifierBreakdown || {};
  if (modifierBreakdown.modifier_cap_applied === true) {
    assertNhlSnapshotInvariant(
      Math.abs(
        (snapshot.rawTotalModel ?? 0) -
          ((modifierBreakdown.base_5v5_total ?? 0) +
            (modifierBreakdown.capped_modifier_total ?? 0)),
      ) <= 0.01,
      'CRITICAL',
      'modifier cap applied but rawTotalModel does not reflect capped_modifier_total',
    );
  }

  const executionStatus = String(payload?.execution_status || '').toUpperCase();
  if (hasUnknownGoalie(paceResult)) {
    assertNhlSnapshotInvariant(
      executionStatus !== 'EXECUTABLE',
      'CRITICAL',
      `${payload?.game_id || 'unknown-game'} ${payload?.market_type || 'unknown-market'} cannot remain EXECUTABLE when goalie certainty is UNKNOWN`,
    );
  }

  if (String(payload?.market_type || '').toUpperCase() === 'FIRST_PERIOD') {
    if (hasUnknownGoalie(paceResult)) {
      assertNhlSnapshotInvariant(
        executionStatus !== 'EXECUTABLE',
        'CRITICAL',
        'nhl-pace-1p cannot remain actionable when full-game execution is blocked by unknown goalie gating',
      );
    }
  }

  return deepFreeze(snapshot);
}

function attachNhlSnapshotAuditFields(card, { paceResult, sigmaTotal } = {}) {
  if (!isNhlSnapshotCard(card) || !card?.payloadData) return;
  if (!paceResult) {
    emitNhlSnapshotInvariant(
      'WARNING',
      `pace snapshot source missing for ${card.cardType} (${card.payloadData.game_id || 'unknown-game'})`,
    );
    return;
  }

  card.payloadData._model_snapshot = buildNhlModelSnapshot({
    paceResult,
    payload: card.payloadData,
    sigmaTotal,
  });
  card.payloadData.nhl_goalie_certainty_pair =
    buildNhlGoalieCertaintyPair(paceResult);
}

function buildScraperGoalieInput(rawData, side) {
  const sideKey = side === 'home' ? 'home' : 'away';
  const goalieName = isNonEmptyString(rawData?.goalie?.[sideKey]?.name)
    ? rawData.goalie[sideKey].name.trim()
    : null;
  const status =
    rawData?.goalie?.[sideKey]?.status ??
    (sideKey === 'home' ? rawData?.goalie_home_status : rawData?.goalie_away_status) ??
    null;
  const gsax = toFiniteNumber(
    sideKey === 'home'
      ? rawData?.goalie_home_gsax ?? rawData?.goalie?.home?.gsax
      : rawData?.goalie_away_gsax ?? rawData?.goalie?.away?.gsax,
  );
  const savePct = toFiniteNumber(
    sideKey === 'home'
      ? rawData?.goalie_home_save_pct ?? rawData?.goalie?.home?.save_pct
      : rawData?.goalie_away_save_pct ?? rawData?.goalie?.away?.save_pct,
  );

  return {
    goalie_name: goalieName,
    status,
    gsax,
    save_pct: savePct,
    source_type: goalieName ? 'SCRAPER_NAME_MATCH' : 'SEASON_TABLE_INFERENCE',
  };
}

function attachNhlDriverContextToRawData(rawData) {
  const normalized = normalizeRawDataPayload(rawData);
  const context = extractNhlDriverDataQualityContext(normalized);
  return {
    ...normalized,
    nhl_driver_context: context,
  };
}

function applyNhlDriverContextMetadata(card, oddsSnapshot) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;

  const rawData = normalizeRawDataPayload(oddsSnapshot?.raw_data);
  const context = rawData?.nhl_driver_context;
  if (!context || typeof context !== 'object') return;

  const specialTeams =
    context.special_teams && typeof context.special_teams === 'object'
      ? context.special_teams
      : {};
  const shotEnvironment =
    context.shot_environment && typeof context.shot_environment === 'object'
      ? context.shot_environment
      : {};
  const shotProxy =
    shotEnvironment.proxy && typeof shotEnvironment.proxy === 'object'
      ? shotEnvironment.proxy
      : {};

  card.payloadData.nhl_driver_context = {
    enrichment_version: context.enrichment_version || 'nhl-driver-context-v1',
    special_teams: {
      status: String(specialTeams.status || 'missing'),
      available: specialTeams.available === true,
      pp_pk_delta: toFiniteNumber(specialTeams.pp_pk_delta),
      missing_inputs: Array.isArray(specialTeams.missing_inputs)
        ? specialTeams.missing_inputs
        : [],
    },
    shot_environment: {
      status: String(shotEnvironment.status || 'missing'),
      available: shotEnvironment.available === true,
      delta: toFiniteNumber(shotEnvironment.delta),
      missing_inputs: Array.isArray(shotEnvironment.missing_inputs)
        ? shotEnvironment.missing_inputs
        : [],
      proxy_metric:
        typeof shotProxy.metric === 'string' ? shotProxy.metric : null,
      proxy_available: shotProxy.available === true,
      proxy_delta: toFiniteNumber(shotProxy.delta),
    },
  };
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
  // Read live 1P prices from odds snapshot when available (feat(nhl-1p): WI-0715).
  // Falls back to null when the live odds lane is not active (PROJECTION_ONLY mode).
  const overPrice1P = toFiniteNumber(oddsSnapshot?.total_1p_price_over);
  const underPrice1P = toFiniteNumber(oddsSnapshot?.total_1p_price_under);
  const sidePrice =
    selection === 'OVER'
      ? overPrice1P
      : selection === 'UNDER'
        ? underPrice1P
        : null;
  const lineSource =
    toFiniteNumber(oddsSnapshot?.total_1p) !== null ? 'odds_snapshot' : 'fixed_reference';
  const priceSource = sidePrice !== null ? 'odds_snapshot' : null;
  const statusToken = String(payload.status || '').toUpperCase();
  // Card is playable only when live 1P prices are present (live odds lane active).
  // When prices are null the card degrades to EVIDENCE / PROJECTION_ONLY.
  const isPlayable =
    (statusToken === 'FIRE' || statusToken === 'WATCH') &&
    (selection === 'OVER' || selection === 'UNDER') &&
    sidePrice !== null;

  payload.market_type = 'FIRST_PERIOD';
  payload.recommended_bet_type = 'total';
  payload.period = '1P';
  payload.kind = isPlayable ? 'PLAY' : 'EVIDENCE';
  if (!isPlayable) {
    payload.execution_status = 'PROJECTION_ONLY';
    payload.actionable = false;
    payload.publish_ready = false;
  }
  // When demoted to EVIDENCE, set an explicit no-edge pass_reason_code so the
  // transform layer classifies this as a healthy no-play (quality='OK') rather
  // than a fetch failure (quality='DEGRADED'). Without this, nhl-pace-1p EVIDENCE
  // cards produce 'fetch_failure:play_producer_no_output' → Degraded badge on board.
  if (!isPlayable && !payload.pass_reason_code) {
    payload.pass_reason_code =
      sidePrice === null
        ? 'FIRST_PERIOD_NO_PROJECTION' // 1P price unavailable in odds feed
        : 'SUPPORT_BELOW_LEAN_THRESHOLD'; // model PASS — no edge
    // Sync reason_codes so EVIDENCE cards don't carry stale accumulated codes (AUDIT-FIX-06)
    payload.reason_codes = [payload.pass_reason_code].filter(Boolean);
  }
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
  payload.price = sidePrice;
  payload.line_source = lineSource;
  payload.price_source = priceSource;
  payload.market_variant = 'NHL_1P_TOTAL';
  payload.odds_context = {
    ...(payload.odds_context && typeof payload.odds_context === 'object'
      ? payload.odds_context
      : {}),
    total_1p: line,
    total_price_over_1p: overPrice1P,
    total_price_under_1p: underPrice1P,
  };
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
    market_type: 'FIRST_PERIOD',
    selection_side: selection,
    period: '1P',
    wager: {
      ...(payload.market_context?.wager &&
      typeof payload.market_context.wager === 'object'
        ? payload.market_context.wager
        : {}),
      called_line: line,
      called_price: sidePrice,
      line_source: payload.line_source,
      price_source: payload.price_source,
      period: '1P',
    },
  };
  payload.pricing_trace = {
    ...(payload.pricing_trace && typeof payload.pricing_trace === 'object'
      ? payload.pricing_trace
      : {}),
    called_market_type: 'FIRST_PERIOD',
    called_side: selection,
    called_line: line,
    called_price: sidePrice,
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
    // Include games that have already started/completed by time, even if status
    // hasn't been updated yet. This prevents stale 'scheduled' home games from
    // being skipped, which would incorrectly merge non-consecutive road trips.
    const now = new Date().toISOString();
    const playedGames = results.filter(
      (g) =>
        g.status === 'final' ||
        g.status === 'STATUS_FINAL' ||
        g.game_time_utc < now,
    );

    // Deduplicate: ESPN and odds pipelines can create two records for the same
    // physical game (slightly different timestamps). Collapse by same matchup
    // within a 2-hour window, preferring 'final' status.
    const seen = new Map();
    for (const g of playedGames) {
      const key = `${g.home_team.toUpperCase()}|${g.away_team.toUpperCase()}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, g);
      } else {
        const deltaMs = Math.abs(
          new Date(g.game_time_utc).getTime() -
            new Date(existing.game_time_utc).getTime(),
        );
        if (deltaMs <= 2 * 60 * 60 * 1000) {
          // Same game — keep the final one, or the earlier timestamp if both equal
          if (
            g.status === 'final' ||
            g.status === 'STATUS_FINAL'
          ) {
            seen.set(key, g);
          }
        } else {
          // Different dates — different game, use a time-qualified key
          seen.set(`${key}|${g.game_time_utc}`, g);
        }
      }
    }
    const completedGames = Array.from(seen.values()).sort(
      (a, b) =>
        new Date(a.game_time_utc).getTime() -
        new Date(b.game_time_utc).getTime(),
    ); // Chronological order (oldest to newest)

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

function getCardTypeForChosenMarket(market) {
  switch (market) {
    case 'TOTAL':
      return 'nhl-totals-call';
    case 'SPREAD':
      return 'nhl-spread-call';
    case 'ML':
      return 'nhl-moneyline-call';
    default:
      return null;
  }
}

/**
 * Generate standalone market call cards
 * (nhl-totals-call, nhl-spread-call, nhl-moneyline-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNHLMarketCallCards(
  gameId,
  marketDecisions,
  oddsSnapshot,
  {
    expressionChoice = null,
    homeGoalieState = null,
    awayGoalieState = null,
    useOrchestratedMarket = USE_ORCHESTRATED_MARKET,
    withoutOddsMode = false,
  } = {},
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
  const resolvedExpressionChoice =
    expressionChoice || selectExpressionChoice(marketDecisions);
  const marketPayload = buildMarketPayload({
    decisions: marketDecisions,
    expressionChoice: resolvedExpressionChoice,
    homeGoalieState,
    awayGoalieState,
  });
  const chosenCardType =
    useOrchestratedMarket && resolvedExpressionChoice
      ? getCardTypeForChosenMarket(resolvedExpressionChoice.chosen_market)
      : null;

  const cards = [];
  const CONFIDENCE_MAP = { FIRE: 0.74, WATCH: 0.61 };

  // TOTAL decision → nhl-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  const _totalProjection = totalDecision?.projection?.projected_total ?? null;
  if (
    totalDecision &&
    (!chosenCardType || chosenCardType === 'nhl-totals-call') &&
    (
      (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH') ||
      // Without Odds Mode: emit lean whenever projection is available regardless of edge-based status
      (withoutOddsMode && _totalProjection != null)
    )
  ) {
    const rawStatus = totalDecision.status || 'PASS';
    // In Without Odds Mode a below-threshold status becomes LEAN, not PASS
    const status = withoutOddsMode && rawStatus === 'PASS' ? 'LEAN' : rawStatus;
    const confidence = CONFIDENCE_MAP[rawStatus] ?? (withoutOddsMode ? 0.52 : 0.5);
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
      if (marketPayload?.consistency?.total_bias !== 'OK') {
        reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
      }
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
        tags: withoutOddsMode ? ['no_odds_mode'] : [],
        consistency: marketPayload.consistency,
        expression_choice: marketPayload.expression_choice,
        market_narrative: marketPayload.market_narrative,
        all_markets: marketPayload.all_markets,
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
        splits_divergence: (() => {
          const h = oddsSnapshot?.public_bets_pct_home;
          const a = oddsSnapshot?.public_bets_pct_away;
          if (h == null || a == null) return null;
          if (h - a > 15) return 'PUBLIC_HEAVY_HOME';
          if (a - h > 15) return 'PUBLIC_HEAVY_AWAY';
          return 'BALANCED';
        })(),
        sharp_divergence: (() => {
          const circaH = oddsSnapshot?.circa_handle_pct_home;
          const dkH    = oddsSnapshot?.dk_bets_pct_home;
          // Either source absent → null
          if (circaH == null || dkH == null) return null;
          const diff = Math.abs(circaH - dkH);
          if (diff >= 20) return 'SHARP_VS_PUBLIC';
          if (diff < 10)  return 'SHARP_ALIGNED';
          return null; // 10–19 range: inconclusive, emit null
        })(),
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
    (!chosenCardType || chosenCardType === 'nhl-spread-call') &&
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
        consistency: marketPayload.consistency,
        expression_choice: marketPayload.expression_choice,
        market_narrative: marketPayload.market_narrative,
        all_markets: marketPayload.all_markets,
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
        splits_divergence: (() => {
          const h = oddsSnapshot?.public_bets_pct_home;
          const a = oddsSnapshot?.public_bets_pct_away;
          if (h == null || a == null) return null;
          if (h - a > 15) return 'PUBLIC_HEAVY_HOME';
          if (a - h > 15) return 'PUBLIC_HEAVY_AWAY';
          return 'BALANCED';
        })(),
        sharp_divergence: (() => {
          const circaH = oddsSnapshot?.circa_handle_pct_home;
          const dkH    = oddsSnapshot?.dk_bets_pct_home;
          // Either source absent → null
          if (circaH == null || dkH == null) return null;
          const diff = Math.abs(circaH - dkH);
          if (diff >= 20) return 'SHARP_VS_PUBLIC';
          if (diff < 10)  return 'SHARP_ALIGNED';
          return null; // 10–19 range: inconclusive, emit null
        })(),
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
    (!chosenCardType || chosenCardType === 'nhl-moneyline-call') &&
    (
      (moneylineDecision.status === 'FIRE' || moneylineDecision.status === 'WATCH') ||
      // Without Odds Mode: emit lean for any directional signal regardless of edge-based status
      (withoutOddsMode && (moneylineDecision.best_candidate?.side === 'HOME' || moneylineDecision.best_candidate?.side === 'AWAY'))
    )
  ) {
    const mlRawStatus = moneylineDecision.status || 'PASS';
    const mlStatus = withoutOddsMode && mlRawStatus === 'PASS' ? 'LEAN' : mlRawStatus;
    const confidence = CONFIDENCE_MAP[mlRawStatus] ?? (withoutOddsMode ? 0.52 : 0.5);
    const tier = determineTier(confidence);
    const side = moneylineDecision.best_candidate?.side;
    const moneylinePrice =
      side === 'HOME'
        ? (oddsSnapshot?.h2h_home ?? null)
        : side === 'AWAY'
          ? (oddsSnapshot?.h2h_away ?? null)
          : null;

    if ((side === 'HOME' || side === 'AWAY') && (moneylinePrice != null || withoutOddsMode)) {
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
        status: mlStatus,
        recommended_bet_type: 'moneyline',
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: {
          side,
          team: teamName,
        },
        price: moneylinePrice,
        reason_codes: [],
        tags: withoutOddsMode ? ['no_odds_mode'] : [],
        consistency: marketPayload.consistency,
        expression_choice: marketPayload.expression_choice,
        market_narrative: marketPayload.market_narrative,
        all_markets: marketPayload.all_markets,
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
        ev_passed: !withoutOddsMode && moneylineDecision.status === 'FIRE',
        decision_basis_meta: withoutOddsMode ? buildDecisionBasisMeta({
          usingRealLine: false,
          edgePct: null,
          marketLineSource: 'projection_floor',
          marketOrPropType: 'moneyline',
        }) : undefined,
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
        splits_divergence: (() => {
          const h = oddsSnapshot?.public_bets_pct_home;
          const a = oddsSnapshot?.public_bets_pct_away;
          if (h == null || a == null) return null;
          if (h - a > 15) return 'PUBLIC_HEAVY_HOME';
          if (a - h > 15) return 'PUBLIC_HEAVY_AWAY';
          return 'BALANCED';
        })(),
        sharp_divergence: (() => {
          const circaH = oddsSnapshot?.circa_handle_pct_home;
          const dkH    = oddsSnapshot?.dk_bets_pct_home;
          // Either source absent → null
          if (circaH == null || dkH == null) return null;
          const diff = Math.abs(circaH - dkH);
          if (diff >= 20) return 'SHARP_VS_PUBLIC';
          if (diff < 10)  return 'SHARP_ALIGNED';
          return null; // 10–19 range: inconclusive, emit null
        })(),
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
async function runNHLModel({ jobKey = null, dryRun = false, withoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true' } = {}) {
  const jobRunId = `job-nhl-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NHLModel] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[NHLModel] Job key: ${jobKey}`);
  }
  if (withoutOddsMode) {
    console.log('[NHLModel] WITHOUT_ODDS_MODE=true — projection-floor lines, PROJECTION_ONLY cards, no settlement');
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

      // WI-0773: Replace static sigma with computeSigmaFromHistory (same pattern as NBA).
      const _computedSigma = edgeCalculator.computeSigmaFromHistory({
        sport: 'NHL',
        db: getDatabase(),
      });
      const _sigmaSource = _computedSigma.sigma_source; // 'computed' | 'fallback'
      let nhlBaseSigma;
      if (_sigmaSource === 'computed') {
        console.log(`[NHL] sigma calibrated from ${_computedSigma.games_sampled} samples: ${JSON.stringify({ margin: _computedSigma.margin, total: _computedSigma.total })}`);
        nhlBaseSigma = { margin: _computedSigma.margin, total: _computedSigma.total };
      } else {
        console.log('[NHL] insufficient history for sigma calibration — using defaults');
        nhlBaseSigma = edgeCalculator.getSigmaDefaults('NHL');
      }

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
        if (!withoutOddsMode) {
          console.log('[NHLModel] No recent NHL odds found, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
        // Without-Odds-Mode: no odds_snapshots but games exist — synthesize from games table
        console.log('[NHLModel] WITHOUT_ODDS_MODE: no odds snapshots, building synthetic snapshots from games table');
        oddsSnapshots.push(...getUpcomingGamesAsSyntheticSnapshots('NHL', nowUtc.toISO(), horizonUtc));
        if (oddsSnapshots.length === 0) {
          console.log('[NHLModel] No upcoming NHL games found in games table, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
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
      const moneyPuckSnapshot = await fetchMoneyPuckSnapshot({ ttlMs: 0 });

      // Process each game
      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);
          oddsSnapshot = await enrichOddsSnapshotWithMoneyPuck(oddsSnapshot, {
            snapshot: moneyPuckSnapshot,
          });

          // Persist enrichment to database so models have access to ESPN metrics
          const rawData = attachNhlDriverContextToRawData(oddsSnapshot.raw_data);
          oddsSnapshot.raw_data = rawData;
          try {
            updateOddsSnapshotRawData(oddsSnapshot.id, rawData);
          } catch (persistError) {
            console.log(
              `  [warn] ${gameId}: Failed to persist enrichment payload (${persistError.message})`,
            );
          }

          // WI-0646: Detect playoff game and apply threshold overrides
          const isPlayoff = isPlayoffGame(oddsSnapshot);
          if (isPlayoff) console.log(`[PLAYOFF_MODE] gameId: ${gameId}`);
          const effectiveSigma = isPlayoff
            ? applyPlayoffSigmaMultiplier(nhlBaseSigma, PLAYOFF_SIGMA_MULTIPLIER)
            : nhlBaseSigma;

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

          // WI-0789: NHL key-player availability gate
          const availabilityGate = buildNhlAvailabilityGate(
            oddsSnapshot.home_team,
            oddsSnapshot.away_team,
          );
          if (availabilityGate.missingFlags.length > 0 && !availabilityGate.missingFlags.includes('nhl_availability_unresolved')) {
            const flaggedPlayers = availabilityGate.availabilityFlags.map((f) => f.player).join(', ');
            console.log(
              `  [availability] ${gameId}: ${availabilityGate.missingFlags.join(', ')}` +
              (flaggedPlayers ? ` (${flaggedPlayers})` : ''),
            );
          }

          // Goalie state degradation path:
          // UNKNOWN starter_state → adjustment_trust='NEUTRALIZED' → goalie driver weight
          // zeroed, NOT total confidence. This is the sound path for unconfirmed or injured
          // goalies — the model proceeds without goalie influence rather than crashing.
          // See nhl-goalie-state.js line 163 for the NEUTRALIZED assignment.
          const canonicalGoalieState = {
            home: resolveGoalieState(
              buildScraperGoalieInput(rawData, 'home'),
              null,
              gameId,
              'home',
              { gameTimeUtc: oddsSnapshot.game_time_utc },
            ),
            away: resolveGoalieState(
              buildScraperGoalieInput(rawData, 'away'),
              null,
              gameId,
              'away',
              { gameTimeUtc: oddsSnapshot.game_time_utc },
            ),
          };

          // Compute per-driver card descriptors
          // WI-0505: Phase-2 fair prob requires a confirmed real 1P market line
          const hasReal1pLine = typeof oddsSnapshot.total_1p === 'number';
          const driverCards = computeNHLDriverCards(gameId, oddsSnapshot, {
            recentRoadGames: homeTeamRoadTrip,
            canonicalGoalieState,
            phase2FairProbEnabled: NHL_1P_FAIR_PROB_PHASE2 && hasReal1pLine,
            sigma1p: NHL_1P_SIGMA,
          });
          const nhlPaceAuditContext = extractNhlPaceAuditContext(driverCards);

          const marketDecisions = computeNHLMarketDecisions(oddsSnapshot);

          // WI-0571: log projection comparison per game
          const nhlTotalPC = marketDecisions?.TOTAL?.projection_comparison;
          const nhlSpreadPC = marketDecisions?.SPREAD?.projection_comparison;
          if (nhlTotalPC) {
            console.log(
              `  [proj] ${gameId} TOTAL: consensus edge=${nhlTotalPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${nhlTotalPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${nhlTotalPC.execution_alpha_pts ?? 'n/a'} pts, playable=${nhlTotalPC.playable_edge}`,
            );
          }
          if (nhlSpreadPC) {
            console.log(
              `  [proj] ${gameId} SPREAD: consensus edge=${nhlSpreadPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${nhlSpreadPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${nhlSpreadPC.execution_alpha_pts ?? 'n/a'} pts, playable=${nhlSpreadPC.playable_edge}`,
            );
          }

          const expressionChoice = selectExpressionChoice(marketDecisions);

          // WI-0503: Dual-run observation log — records selector decisions per game
          // without changing served card output. Parse with:
          //   grep '\[DUAL_RUN\]' apps/worker/logs/scheduler.log | jq .
          const dualRunRecord = buildDualRunRecord(
            gameId,
            oddsSnapshot,
            marketDecisions,
            expressionChoice,
          );
          if (dualRunRecord) {
            console.log(`[DUAL_RUN] ${JSON.stringify(dualRunRecord)}`);
          }

          const marketPayload = buildMarketPayload({
            decisions: marketDecisions,
            expressionChoice,
            homeGoalieState: canonicalGoalieState?.home,
            awayGoalieState: canonicalGoalieState?.away,
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
          // WI-0817: collect types now; deletes are deferred into the per-game write transaction below.
          const driverCardTypesToClear = [
            ...new Set([
              ...NHL_DRIVER_CARD_TYPES,
              ...driverCards.map((card) => card.cardType),
            ]),
          ];

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
            applyNhlDriverContextMetadata(card, oddsSnapshot);
            applyNhlSettlementMarketContext(card, oddsSnapshot);
            // WI-0789: merge key-player availability flags and cap tier at LEAN
            if (availabilityGate.missingFlags.length > 0 || availabilityGate.uncertainFlags.length > 0) {
              card.payloadData.missing_inputs = [
                ...(card.payloadData.missing_inputs || []),
                ...availabilityGate.missingFlags,
              ];
              if (availabilityGate.uncertainFlags.length > 0) {
                card.payloadData.missing_inputs = [
                  ...card.payloadData.missing_inputs,
                  ...availabilityGate.uncertainFlags,
                ];
              }
              if (availabilityGate.availabilityFlags.length > 0) {
                if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
                card.payloadData.raw_data.availability_flags = availabilityGate.availabilityFlags;
              }
              // Cap tier at LEAN when a starred player is confirmed INJURED/OUT
              if (
                availabilityGate.missingFlags.includes('key_player_out') &&
                card.payloadData.tier &&
                (card.payloadData.tier === 'FIRE' || card.payloadData.tier === 'WATCH')
              ) {
                card.payloadData.tier = 'LEAN';
              }
            }
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
              // WI-0646: effectiveSigma applies PLAYOFF_SIGMA_MULTIPLIER when isPlayoff.
              options: { sigmaOverride: effectiveSigma },
            });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(
                `  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`,
              );
            }
            applyNhlGoalieExecutionStatusGuard(
              card,
              nhlPaceAuditContext?.paceResult,
            );
            applyUiActionFields(card.payloadData, { oddsSnapshot });
            attachNhlExecutionEnvelope(card, { projectionReady: true });
            attachNhlSnapshotAuditFields(card, {
              paceResult: nhlPaceAuditContext?.paceResult,
              sigmaTotal: effectiveSigma?.total,
            });
            attachRunId(card, jobRunId);
            // WI-0773: Annotate sigma_source on card payload raw_data
            if (card.payloadData && card.payloadData.raw_data !== undefined) {
              card.payloadData.raw_data = {
                ...card.payloadData.raw_data,
                sigma_source: _sigmaSource === 'computed' ? 'calibrated' : 'default',
              };
            } else if (card.payloadData) {
              card.payloadData.raw_data = {
                sigma_source: _sigmaSource === 'computed' ? 'calibrated' : 'default',
              };
            }
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
            {
              expressionChoice,
              homeGoalieState: canonicalGoalieState?.home,
              awayGoalieState: canonicalGoalieState?.away,
              withoutOddsMode,
            },
          );
          // WI-0817: call card deletes are deferred into the per-game write transaction below.
          for (const card of marketCallCards) {
            applyProjectionInputMetadata(card, projectionGate);
            applyNhlDriverContextMetadata(card, oddsSnapshot);
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
              // WI-0646: effectiveSigma applies PLAYOFF_SIGMA_MULTIPLIER when isPlayoff.
              options: { sigmaOverride: effectiveSigma },
            });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(
                `  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`,
              );
            }
            applyNhlGoalieExecutionStatusGuard(
              card,
              nhlPaceAuditContext?.paceResult,
            );
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
            attachNhlExecutionEnvelope(card, { projectionReady: true });
            attachNhlSnapshotAuditFields(card, {
              paceResult: nhlPaceAuditContext?.paceResult,
              sigmaTotal: effectiveSigma?.total,
            });
            attachRunId(card, jobRunId);
            // WI-0773: Annotate sigma_source on card payload raw_data
            if (card.payloadData && card.payloadData.raw_data !== undefined) {
              card.payloadData.raw_data = {
                ...card.payloadData.raw_data,
                sigma_source: _sigmaSource === 'computed' ? 'calibrated' : 'default',
              };
            } else if (card.payloadData) {
              card.payloadData.raw_data = {
                sigma_source: _sigmaSource === 'computed' ? 'calibrated' : 'default',
              };
            }
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
            cards: pendingCards.map((entry) => entry.card),
            blockingReasonCodes: deriveGameBlockingReasonCodes({
              oddsSnapshot,
              projectionReady: true,
              pricingReady,
              cards: pendingCards.map((entry) => entry.card),
              homeGoalieState: canonicalGoalieState?.home,
              awayGoalieState: canonicalGoalieState?.away,
            }),
          });
          gamePipelineStates[gameId] = pipelineState;

          // WI-0817: atomic write phase — all deletes + all inserts in one transaction.
          // A crash or throw inside this block rolls back automatically; old cards survive intact.
          runPerGameWriteTransaction(() => {
            for (const ct of driverCardTypesToClear) {
              prepareModelAndCardWrite(gameId, 'nhl-drivers-v1', ct, { runId: jobRunId });
            }
            if (marketCallCards.length > 0) {
              for (const ct of ['nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call']) {
                prepareModelAndCardWrite(gameId, 'nhl-cross-market-v1', ct, { runId: jobRunId });
              }
            }
            for (const entry of pendingCards) {
              entry.card.payloadData.pipeline_state = pipelineState;
              insertCardPayload(entry.card);
            }
          });
          for (const entry of pendingCards) {
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

/**
 * WI-0503: Builds a structured dual-run record for expression choice comparison.
 * Emitted as a [DUAL_RUN] tagged JSON log line per game run during dual-run mode.
 * Does NOT affect production card output — observation only.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {object} marketDecisions - { TOTAL, SPREAD, ML } MarketDecision objects
 * @param {object|null} expressionChoice - result of selectExpressionChoice()
 * @returns {object|null} record suitable for JSON.stringify, or null if no choice
 */
function buildDualRunRecord(gameId, oddsSnapshot, marketDecisions, expressionChoice) {
  if (!expressionChoice) return null;
  return {
    game_id: gameId,
    matchup: `${oddsSnapshot.away_team ?? 'unknown'} @ ${oddsSnapshot.home_team ?? 'unknown'}`,
    run_at: new Date().toISOString(),
    chosen_market: expressionChoice.chosen_market,
    why_this_market: expressionChoice.why_this_market,
    markets: ['TOTAL', 'SPREAD', 'ML']
      .map((m) => {
        const d = marketDecisions[m];
        if (!d) return null;
        return {
          market: m,
          status: d.status,
          score: typeof d.score === 'number' ? Math.round(d.score * 1000) / 1000 : null,
          net: typeof d.net === 'number' ? Math.round(d.net * 1000) / 1000 : null,
          conflict: typeof d.conflict === 'number' ? Math.round(d.conflict * 1000) / 1000 : null,
          edge: d.edge ?? null,
        };
      })
      .filter(Boolean),
    rejected: (expressionChoice.rejected ?? []).reduce((acc, r) => {
      acc[r.market] = r.rejection_reason;
      return acc;
    }, {}),
  };
}

module.exports = {
  runNHLModel,
  generateNHLMarketCallCards,
  buildNhlModelSnapshot,
  applyNhlSettlementMarketContext,
  applyNhlDriverContextMetadata,
  attachNhlDriverContextToRawData,
  buildDualRunRecord,
};
