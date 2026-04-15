/**
 * NBA Model Runner Job
 *
 * Reads latest NBA odds from DB, runs per-driver inference, and stores
 * card_payloads (one per active driver: rest-advantage, travel, lineup,
 * matchup-style, blowout-risk). Drivers only emit when their signal is
 * actionable — neutral/missing data produces no card.
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_nba_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-nba-model)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  wasJobRecentlySuccessful,
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
  computeLineDelta,
  getTeamMetricsWithGames,
} = require('@cheddar-logic/data');

const { kellyStake } = require('@cheddar-logic/models/src/edge-calculator');

const {
  computeNBADriverCards,
  generateCard,
  computeNBAMarketDecisions,
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
  buildDecisionBasisMeta,
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  capturePublishedDecisionState,
  assertNoDecisionMutation,
} = require('../utils/decision-publisher');
const { evaluateExecution } = require('./execution-gate');
const {
  normalizeRawDataPayload,
} = require('../utils/normalize-raw-data-payload');
const {
  resolveThresholdProfile,
} = require('@cheddar-logic/models');
const {
  isPlayoffGame,
  PLAYOFF_SIGMA_MULTIPLIER,
  PLAYOFF_EDGE_MIN_INCREMENT,
} = require('../utils/playoff-detection');
const { computeRestDays } = require('../utils/rest-days');
const { sendDiscordMessages } = require('./post_discord_cards');
const { applyCalibration } = require('../utils/calibration');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';

// WI-0768: weight applied when blending pace-anchor total with market total
const TEAM_CONTEXT_WEIGHT = 0.25;
const ESPN_NULL_ALERT_WINDOW_MINUTES = 60;
const ESPN_NULL_ALERT_THRESHOLD_DEFAULT = 2;

function normalizeEspnNullReason(reason) {
  return (
    String(reason || 'UNKNOWN')
      .trim()
      .replace(/\s+/g, '_')
      .toUpperCase() || 'UNKNOWN'
  );
}

function getEspnNullAlertThreshold() {
  const parsed = Number.parseInt(
    process.env.ESPN_NULL_ALERT_THRESHOLD ?? `${ESPN_NULL_ALERT_THRESHOLD_DEFAULT}`,
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ESPN_NULL_ALERT_THRESHOLD_DEFAULT;
}

function buildEspnNullTeamKey(team, reason) {
  return `${String(team || '').trim().toUpperCase()}::${normalizeEspnNullReason(reason)}`;
}

function buildEspnNullAlertMessage(sport, nullMetricTeams) {
  const lines = [
    `⚠️ **${sport} ESPN Null Metrics Alert**`,
    '',
    `${nullMetricTeams.length} team(s) returned neutral ESPN metrics in the latest run:`,
  ];
  for (const entry of nullMetricTeams) {
    lines.push(`• \`${entry.team}\` — ${entry.reason}`);
  }
  return lines.join('\n');
}

function extractNbaEspnNullMetricTeams({ homeTeam, awayTeam, homeResult, awayResult }) {
  const entries = [];
  const candidates = [
    { team: homeTeam, result: homeResult },
    { team: awayTeam, result: awayResult },
  ];

  for (const candidate of candidates) {
    if (candidate.result?.metrics?.avgPoints !== null) continue;
    entries.push({
      team: candidate.team || 'UNKNOWN_TEAM',
      reason: normalizeEspnNullReason(candidate.result?.metrics?.espn_null_reason),
    });
  }

  return entries;
}

function recordEspnNullTeams({
  sport,
  registry,
  nullMetricTeams,
  logger = console,
}) {
  const recorded = [];
  for (const entry of nullMetricTeams) {
    const normalizedEntry = {
      team: entry?.team || 'UNKNOWN_TEAM',
      reason: normalizeEspnNullReason(entry?.reason),
    };
    const key = buildEspnNullTeamKey(normalizedEntry.team, normalizedEntry.reason);
    if (registry.has(key)) continue;
    registry.set(key, normalizedEntry);
    logger.warn(
      `[ESPN_NULL] sport=${sport} team=${normalizedEntry.team} reason=${normalizedEntry.reason}`,
    );
    recorded.push(normalizedEntry);
  }
  return recorded;
}

async function sendEspnNullDiscordAlert({
  sport,
  nullMetricTeams,
  logger = console,
  sendDiscordMessagesFn = sendDiscordMessages,
  wasJobRecentlySuccessfulFn = wasJobRecentlySuccessful,
  insertJobRunFn = insertJobRun,
  markJobRunSuccessFn = markJobRunSuccess,
  markJobRunFailureFn = markJobRunFailure,
}) {
  const dedupedTeams = [];
  const seen = new Set();
  for (const entry of nullMetricTeams) {
    const normalizedEntry = {
      team: entry?.team || 'UNKNOWN_TEAM',
      reason: normalizeEspnNullReason(entry?.reason),
    };
    const key = buildEspnNullTeamKey(normalizedEntry.team, normalizedEntry.reason);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedTeams.push(normalizedEntry);
  }

  if (dedupedTeams.length < getEspnNullAlertThreshold()) {
    return { sent: false, reason: 'below_threshold', count: dedupedTeams.length };
  }

  if (process.env.ENABLE_DISCORD_CARD_WEBHOOKS !== 'true') {
    return { sent: false, reason: 'discord_disabled', count: dedupedTeams.length };
  }

  const webhookUrl = String(process.env.DISCORD_ALERT_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    logger.warn(`[${sport}Model] DISCORD_ALERT_WEBHOOK_URL not set — skipping ESPN null alert`);
    return { sent: false, reason: 'missing_webhook_url', count: dedupedTeams.length };
  }

  const alertJobName = `espn_null_alert_${sport.toLowerCase()}`;
  if (wasJobRecentlySuccessfulFn(alertJobName, ESPN_NULL_ALERT_WINDOW_MINUTES)) {
    return { sent: false, reason: 'cooldown_active', count: dedupedTeams.length };
  }

  const alertRunId = uuidV4();
  insertJobRunFn(alertJobName, alertRunId);
  try {
    await sendDiscordMessagesFn({
      webhookUrl,
      messages: [buildEspnNullAlertMessage(sport, dedupedTeams)],
    });
    markJobRunSuccessFn(alertRunId);
    logger.log(
      `[${sport}Model] Sent ESPN null alert for ${dedupedTeams.length} team(s)`,
    );
    return { sent: true, reason: 'sent', count: dedupedTeams.length };
  } catch (error) {
    markJobRunFailureFn(alertRunId, error.message);
    logger.warn(
      `[${sport}Model] Failed to send ESPN null alert: ${error.message}`,
    );
    return { sent: false, reason: 'send_failed', count: dedupedTeams.length };
  }
}

/**
 * WI-0841: Build key-player availability gate for a game from live impact context.
 *
 * Fail-open design:
 * - No impact context or unavailable ESPN data → empty flags, no degradation
 * - Only emits flags when ESPN-derived impact context marks a player as impact-level
 *
 * @param {object|null} homeImpactContext
 * @param {object|null} awayImpactContext
 * @returns {{ missingFlags: string[], uncertainFlags: string[], availabilityFlags: Array<object> }}
 */
function buildNbaAvailabilityGate(homeImpactContext, awayImpactContext) {
  const EMPTY = { missingFlags: [], uncertainFlags: [], availabilityFlags: [] };
  try {
    const missingFlags = [];
    const uncertainFlags = [];
    const availabilityFlags = [];

    for (const context of [homeImpactContext, awayImpactContext]) {
      if (!context || context.available === false) continue;
      const players = Array.isArray(context.players) ? context.players : [];
      for (const player of players) {
        const rawStatus = String(player.rawStatus || '').trim().toUpperCase();
        const reasons = Array.isArray(player.impactReasons)
          ? player.impactReasons.filter(Boolean)
          : [];
        const flag = {
          player: player.playerName || null,
          player_id: player.playerId || null,
          team: player.teamAbbr || null,
          status: rawStatus || null,
          impact_reasons: reasons,
          is_impact_player: Boolean(player.isImpactPlayer),
          avg_points_last5: player.avgPointsLast5 ?? null,
          starts_last5: player.startsLast5 ?? null,
        };
        availabilityFlags.push(flag);
        if (player.isImpactPlayer) {
          if (!missingFlags.includes('key_player_out')) missingFlags.push('key_player_out');
        } else if (rawStatus === 'DOUBTFUL') {
          if (!uncertainFlags.includes('key_player_uncertain')) uncertainFlags.push('key_player_uncertain');
        }
      }
    }

    return { missingFlags, uncertainFlags, availabilityFlags };
  } catch (err) {
    // Fail-open: DB query errors must not block card generation
    console.log(`  [availability] buildNbaAvailabilityGate error (${err.message}) — skipping gate`);
    return EMPTY;
  }
}

function applyNbaImpactGateToCard(card, availabilityGate) {
  const hasMissingFlags = Array.isArray(availabilityGate?.missingFlags) && availabilityGate.missingFlags.length > 0;
  const hasUncertainFlags = Array.isArray(availabilityGate?.uncertainFlags) && availabilityGate.uncertainFlags.length > 0;
  const availabilityFlags = Array.isArray(availabilityGate?.availabilityFlags)
    ? availabilityGate.availabilityFlags
    : [];

  if (!hasMissingFlags && !hasUncertainFlags && availabilityFlags.length === 0) return;

  card.payloadData.missing_inputs = [
    ...(card.payloadData.missing_inputs || []),
    ...(availabilityGate?.missingFlags || []),
  ];

  if (availabilityFlags.length > 0) {
    if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
    card.payloadData.raw_data.availability_flags = availabilityFlags;
  }

  if (
    hasMissingFlags &&
    Array.isArray(availabilityGate?.missingFlags) &&
    availabilityGate.missingFlags.includes('key_player_out') &&
    card.payloadData.tier &&
    (card.payloadData.tier === 'FIRE' || card.payloadData.tier === 'WATCH')
  ) {
    card.payloadData.tier = 'LEAN';
  }
}

const NBA_DRIVER_WEIGHTS = {
  baseProjection: 0.35,
  restAdvantage: 0.15,
  welcomeHomeV2: 0.1,
  matchupStyle: 0.2,
  blowoutRisk: 0.07,
  totalProjection: 0.13,
};

const NBA_DRIVER_CARD_TYPES = [
  'nba-base-projection',
  'nba-rest-advantage',
  'welcome-home',
  'welcome-home-v2', // alias: backward compat with existing DB rows
  'nba-matchup-style',
  'nba-blowout-risk',
  'nba-total-projection',
];

/**
 * WI-0646: Apply PLAYOFF_SIGMA_MULTIPLIER to empirical sigma overrides.
 * Only multiplies finite numeric fields so null/undefined gracefully pass through.
 */
function applyPlayoffSigmaMultiplier(sigma, multiplier) {
  if (!sigma || !multiplier) return sigma;
  const scale = (value) =>
    typeof value === 'number' && !Number.isNaN(value)
      ? value * multiplier
      : value ?? null;

  return {
    sigma_source: sigma.sigma_source,
    games_sampled: sigma.games_sampled ?? null,
    margin: scale(sigma.margin),
    total: scale(sigma.total),
    spread: scale(sigma.spread),
    adjusted_for_playoffs: true,
    playoff_sigma_multiplier: multiplier,
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computePricedCallCardConfidence({ edgePct, conflictScore }) {
  const normalizedEdgePct = hasFiniteNumber(edgePct) ? edgePct : 0;
  const normalizedConflictScore = hasFiniteNumber(conflictScore)
    ? conflictScore
    : 0;
  const baseConfidence = clamp(0.5 + normalizedEdgePct * 3, 0.5, 0.9);

  return edgeCalculator.computeConfidence({
    baseConfidence,
    watchdogStatus: 'OK',
    missingFieldCount: 0,
    proxyUsed: false,
    conflictScore: normalizedConflictScore,
  });
}

function buildMarketLineContext({
  sport,
  gameId,
  marketType,
  selectionSide = null,
}) {
  try {
    return computeLineDelta({
      sport,
      gameId,
      marketType,
      selectionSide,
    });
  } catch (error) {
    console.warn(
      `[NBAModel] Failed to compute ${marketType} line delta for ${gameId}: ${error.message}`,
    );
    return null;
  }
}

function buildLineContextPayload(lineContext, selectionSide) {
  if (!lineContext || typeof lineContext !== 'object') return null;
  return {
    ...lineContext,
    selection_side: selectionSide || null,
  };
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

function resolveSnapshotAgeMs(oddsSnapshot, nowMs = Date.now()) {
  const capturedAt = oddsSnapshot?.captured_at ?? oddsSnapshot?.fetched_at ?? null;
  if (!capturedAt) return null;

  const capturedAtMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) return null;

  return Math.max(0, nowMs - capturedAtMs);
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

function applyExecutionGateToNbaCard(card, { oddsSnapshot, nowMs = Date.now() } = {}) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') {
    return { evaluated: false, blocked: false, strictDecisionSnapshot: null };
  }

  const payload = card.payloadData;
  const executionStatus = String(payload.execution_status || '').toUpperCase();
  const alreadyPass =
    String(payload.status || '').toUpperCase() === 'PASS' ||
    String(payload.action || '').toUpperCase() === 'PASS' ||
    String(payload.classification || '').toUpperCase() === 'PASS' ||
    String(payload.decision_v2?.official_status || '').toUpperCase() === 'PASS';
  const resolvedModelStatus = String(payload.model_status || 'MODEL_OK').toUpperCase();
  const snapshotAgeMs = resolveSnapshotAgeMs(oddsSnapshot, nowMs);

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
      evaluated_at: new Date(nowMs).toISOString(),
      drop_reason: {
        drop_reason_code: earlyExitDropReasonCode,
        drop_reason_layer: 'worker_gate',
      },
    };

    return {
      evaluated: false,
      blocked: false,
      strictDecisionSnapshot: capturePublishedDecisionState(payload),
    };
  }

  const gateResult = evaluateExecution({
    modelStatus: resolvedModelStatus,
    rawEdge: Number.isFinite(payload.edge) ? payload.edge : null,
    confidence: Number.isFinite(payload.confidence) ? payload.confidence : null,
    snapshotAgeMs,
    marketKey: payload.market_key ?? null,
    sport: payload.sport ?? card.sport ?? 'NBA',
    recommendedBetType: payload.recommended_bet_type ?? null,
    marketType: payload.market_type ?? null,
    period: payload.period ?? payload.market?.period ?? null,
    cardType: card.cardType ?? null,
  });

  payload.execution_gate = {
    evaluated: true,
    should_bet: gateResult.shouldBet,
    net_edge: gateResult.netEdge,
    blocked_by: gateResult.blocked_by,
    model_status: resolvedModelStatus,
    snapshot_age_ms: snapshotAgeMs,
    evaluated_at: new Date(nowMs).toISOString(),
    drop_reason: gateResult.drop_reason,
  };

  if (!gateResult.shouldBet) {
    const passReasonCode = toExecutionGatePassReasonCode(gateResult.reason);
    payload.classification = 'PASS';
    payload.action = 'PASS';
    payload.status = 'PASS';
    payload.ui_display_status = 'PASS';
    payload.execution_status = 'BLOCKED';
    payload.ev_passed = false;
    payload.actionable = false;
    payload.publish_ready = false;
    payload.pass_reason_code = passReasonCode;
    payload.reason_codes = Array.from(
      new Set([passReasonCode, ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : [])]),
    ).sort();
    // WI-0941 TD-01: Stamp decision_v2 at execution gate demotion so official_status remains consistent
    if (payload.decision_v2 && typeof payload.decision_v2 === 'object') {
      payload.decision_v2.official_status = 'PASS';
      payload.decision_v2.primary_reason_code = passReasonCode;
    }
    payload._publish_state = {
      ...(payload._publish_state && typeof payload._publish_state === 'object'
        ? payload._publish_state
        : {}),
      publish_ready: false,
      emit_allowed: true,
      execution_status: 'BLOCKED',
      block_reason: gateResult.reason,
    };
  } else {
    payload.publish_ready = true;
    payload.actionable = true;
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

  return {
    evaluated: true,
    blocked: !gateResult.shouldBet,
    strictDecisionSnapshot: capturePublishedDecisionState(payload),
  };
}

function deriveExecutionStatusForCard(
  card,
  { withoutOddsMode = false } = {},
) {
  const payload = card?.payloadData;
  const existingStatus = String(payload?.execution_status || '').toUpperCase();
  if (
    existingStatus === 'EXECUTABLE' ||
    existingStatus === 'PROJECTION_ONLY' ||
    existingStatus === 'BLOCKED'
  ) {
    return existingStatus;
  }

  if (
    withoutOddsMode ||
    Array.isArray(payload?.tags) && payload.tags.includes('no_odds_mode') ||
    payload?.line_source === 'projection_floor'
  ) {
    return 'PROJECTION_ONLY';
  }

  return Number.isFinite(payload?.price) ? 'EXECUTABLE' : 'BLOCKED';
}

function assignExecutionStatus(card, options = {}) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return null;
  const executionStatus = deriveExecutionStatusForCard(card, options);
  card.payloadData.execution_status = executionStatus;
  return executionStatus;
}

function assertExecutableCardsArePriced(card) {
  const executionStatus = String(
    card?.payloadData?.execution_status || '',
  ).toUpperCase();
  if (executionStatus !== 'EXECUTABLE') return;
  if (canPriceCard(card)) return;

  const error = new Error(
    `[INVARIANT_BREACH] pricing_ready=false cannot coexist with execution_status=EXECUTABLE for ${card?.cardType || 'unknown-card'}`,
  );
  error.code = 'INVARIANT_BREACH';

  if (process.env.NODE_ENV === 'test') {
    throw error;
  }

  console.warn(error.message);
}

function applyNbaSettlementMarketContext(card) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;
  const payload = card.payloadData;
  if (String(payload.market_type || '').toUpperCase() !== 'TOTAL') return;

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
 * WI-0768: Fetch team_metrics_cache entries for both teams and compute a pace-anchor
 * total. Blends the anchor with the market total using TEAM_CONTEXT_WEIGHT.
 * Mutates oddsSnapshot.raw_data to add pace_anchor_total and blended_total.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @returns {Promise<{available: boolean, paceAnchorTotal: number|null, blendedTotal: number|null, teamContextMissingInputs: string[]}>}
 */
async function applyNbaTeamContext(gameId, oddsSnapshot) {
  const homeTeam = oddsSnapshot?.home_team;
  const awayTeam = oddsSnapshot?.away_team;

  if (!homeTeam || !awayTeam) {
    return {
      available: false,
      paceAnchorTotal: null,
      blendedTotal: null,
      teamContextMissingInputs: ['nba_team_context'],
      availabilityGate: { missingFlags: [], uncertainFlags: [], availabilityFlags: [] },
      nullMetricTeams: [],
    };
  }

  try {
    const [homeResult, awayResult] = await Promise.all([
      getTeamMetricsWithGames(homeTeam, 'NBA', { includeImpactContext: true }),
      getTeamMetricsWithGames(awayTeam, 'NBA', { includeImpactContext: true }),
    ]);
    const availabilityGate = buildNbaAvailabilityGate(
      homeResult?.impactContext || null,
      awayResult?.impactContext || null,
    );
    const nullMetricTeams = extractNbaEspnNullMetricTeams({
      homeTeam,
      awayTeam,
      homeResult,
      awayResult,
    });

    const hAvgPts = homeResult?.metrics?.avgPoints;
    const hAvgPtsAllowed = homeResult?.metrics?.avgPointsAllowed;
    const aAvgPts = awayResult?.metrics?.avgPoints;
    const aAvgPtsAllowed = awayResult?.metrics?.avgPointsAllowed;

    const hasContext = [
      hAvgPts,
      hAvgPtsAllowed,
      aAvgPts,
      aAvgPtsAllowed,
    ].every((v) => Number.isFinite(v));

    if (!hasContext) {
      console.log(
        `  [NBA_TEAM_CTX] ${gameId}: team_metrics_cache absent — missing_inputs: nba_team_context`,
      );
      return {
        available: false,
        paceAnchorTotal: null,
        blendedTotal: null,
        teamContextMissingInputs: ['nba_team_context'],
        availabilityGate,
        nullMetricTeams,
      };
    }

    // pace-anchor: average of both teams' expected scoring contributions
    const paceAnchorTotal =
      (hAvgPts + hAvgPtsAllowed + aAvgPts + aAvgPtsAllowed) / 2;
    const marketTotal = oddsSnapshot?.total ?? null;
    const blendedTotal = Number.isFinite(marketTotal)
      ? marketTotal * (1 - TEAM_CONTEXT_WEIGHT) +
        paceAnchorTotal * TEAM_CONTEXT_WEIGHT
      : paceAnchorTotal;

    // Mutate raw_data so downstream models can read the anchor
    if (oddsSnapshot.raw_data && typeof oddsSnapshot.raw_data === 'object') {
      oddsSnapshot.raw_data.pace_anchor_total = Number(
        paceAnchorTotal.toFixed(2),
      );
      oddsSnapshot.raw_data.blended_total = Number(blendedTotal.toFixed(2));
    }

    console.log(
      `  [NBA_TEAM_CTX] ${gameId}: pace_anchor=${paceAnchorTotal.toFixed(2)}, blended=${blendedTotal.toFixed(2)} (market=${marketTotal ?? 'n/a'})`,
    );

    return {
      available: true,
      paceAnchorTotal: Number(paceAnchorTotal.toFixed(2)),
      blendedTotal: Number(blendedTotal.toFixed(2)),
      teamContextMissingInputs: [],
      availabilityGate,
      nullMetricTeams,
    };
  } catch (err) {
    console.warn(
      `  [NBA_TEAM_CTX] ${gameId}: failed to fetch team metrics — ${err.message}`,
    );
    return {
      available: false,
      paceAnchorTotal: null,
      blendedTotal: null,
      teamContextMissingInputs: ['nba_team_context'],
      availabilityGate: { missingFlags: [], uncertainFlags: [], availabilityFlags: [] },
      nullMetricTeams: [],
    };
  }
}

/**
 * Generate standalone market call cards (nba-totals-call, nba-spread-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNBAMarketCallCards(
  gameId,
  marketDecisions,
  oddsSnapshot,
  { withoutOddsMode = false, lineContexts = {}, spreadLeanMin = null } = {},
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
  const totalLineContext = lineContexts?.TOTAL || null;
  const spreadLineContext = lineContexts?.SPREAD || null;

  const cards = [];

  // TOTAL decision → nba-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  const totalBias = computeTotalBias(totalDecision);
  const _totalProjection = totalDecision?.projection?.projected_total ?? null;
  if (
    totalDecision &&
    (
      (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH') ||
      // Without Odds Mode: emit lean whenever projection is available regardless of edge-based status
      (withoutOddsMode && _totalProjection != null)
    )
  ) {
    const rawStatus = totalDecision.status || 'PASS';
    const status = withoutOddsMode && rawStatus === 'PASS' ? 'LEAN' : rawStatus;
    const confidence = withoutOddsMode
      ? 0.52
      : computePricedCallCardConfidence({
          edgePct: totalDecision.edge,
          conflictScore: totalDecision.conflict,
        });
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
        sport: 'NBA',
        model_version: 'nba-cross-market-v1',
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
        model_status: totalDecision.model_status ?? 'MODEL_OK',
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
        consistency: {
          total_bias: totalBias,
        },
        reasoning: `${pickText}: ${totalDecision.reasoning}`,
        execution_status: withoutOddsMode ? 'PROJECTION_ONLY' : 'EXECUTABLE',
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
        line_context: buildLineContextPayload(totalLineContext, side),
        line_delta: totalLineContext?.delta ?? null,
        line_delta_pct: totalLineContext?.delta_pct ?? null,
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
          sport: 'NBA',
          gameId,
          cardType: 'nba-totals-call',
          cardTitle: `NBA Totals: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  // SPREAD decision → nba-spread-call
  const spreadDecision = marketDecisions?.SPREAD;
  const nbaSpreadProfile = resolveThresholdProfile({ sport: 'NBA', marketType: 'SPREAD' });
  // WI-0646: use playoff-adjusted spreadLeanMin when provided (isPlayoff=true), else default profile value
  const SPREAD_LEAN_MIN = spreadLeanMin != null ? spreadLeanMin : nbaSpreadProfile.edge.lean_edge_min; // 0.035 via v2 profile
  if (
    spreadDecision &&
    (spreadDecision.status === 'FIRE' || spreadDecision.status === 'WATCH') &&
    (spreadDecision.edge == null || spreadDecision.edge > SPREAD_LEAN_MIN)
  ) {
    const confidence = computePricedCallCardConfidence({
      edgePct: spreadDecision.edge,
      conflictScore: spreadDecision.conflict,
    });
    const tier = determineTier(confidence);
    const { side, line } = spreadDecision.best_candidate;
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
        sport: 'NBA',
        model_version: 'nba-cross-market-v1',
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
        model_status: spreadDecision.model_status ?? 'MODEL_OK',
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
        execution_status: 'EXECUTABLE',
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
        line_context: buildLineContextPayload(spreadLineContext, side),
        line_delta: spreadLineContext?.delta ?? null,
        line_delta_pct: spreadLineContext?.delta_pct ?? null,
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
          sport: 'NBA',
          gameId,
          cardType: 'nba-spread-call',
          cardTitle: `NBA Spread: ${pickText}`,
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
 * @param {object} options
 * @param {string|null} options.jobKey - Deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNBAModel({ jobKey = null, dryRun = false, withoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true' } = {}) {
  const jobRunId = `job-nba-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NBAModel] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[NBAModel] Job key: ${jobKey}`);
  if (withoutOddsMode) {
    console.log('[NBAModel] WITHOUT_ODDS_MODE=true — projection-floor lines, PROJECTION_ONLY cards, no settlement');
  }
  console.log(`[NBAModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[NBAModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(
        `[NBAModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun('run_nba_model', jobRunId, jobKey);

      // WI-0552: Compute empirical sigma from settled game history at job start.
      // Falls back to hardcoded defaults when fewer than 20 settled games exist.
      const computedSigma = edgeCalculator.computeSigmaFromHistory({
        sport: 'NBA',
        db: getDatabase(),
      });
      console.log('[run_nba_model] sigma:', JSON.stringify(computedSigma));
      console.log(`[SIGMA_SOURCE] sport=NBA source=${computedSigma.sigma_source} games_sampled=${computedSigma.games_sampled ?? null}`);
      // WI-0814: warn when using uncalibrated sigma — all PLAY cards will be downgraded to LEAN
      if (computedSigma.sigma_source === 'fallback') {
        console.warn(
          '[run_nba_model] [SIGMA_FALLBACK] Fewer than 20 settled games — using uncalibrated sigma defaults. ' +
          'All PLAY cards will be downgraded to LEAN until empirical sigma is available.',
        );
      }

      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      console.log('[NBAModel] Fetching odds for upcoming NBA games...');
      const oddsSnapshots = getOddsWithUpcomingGames(
        'NBA',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        if (!withoutOddsMode) {
          console.log('[NBAModel] No upcoming NBA games found, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
        // Without-Odds-Mode: no odds_snapshots but games exist — synthesize from games table
        console.log('[NBAModel] WITHOUT_ODDS_MODE: no odds snapshots, building synthetic snapshots from games table');
        oddsSnapshots.push(...getUpcomingGamesAsSyntheticSnapshots('NBA', nowUtc.toISO(), horizonUtc));
        if (oddsSnapshots.length === 0) {
          console.log('[NBAModel] No upcoming NBA games found in games table, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
      }

      console.log(`[NBAModel] Found ${oddsSnapshots.length} odds snapshots`);
      if (!ENABLE_WELCOME_HOME) {
        console.log(
          '[NBAModel] Welcome Home driver disabled (ENABLE_WELCOME_HOME=false)',
        );
      }

      // Dedupe: latest snapshot per game
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
        `[NBAModel] Running NBA driver inference on ${gameIds.length} games...`,
      );

      let cardsGenerated = 0;
      let cardsFailed = 0;
      let gatedCount = 0;
      let blockedCount = 0;
      let projectionBlockedCount = 0;
      const gamePipelineStates = {};
      const errors = [];
      const espnNullRegistry = new Map();

      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          const normalizedRawData = normalizeRawDataPayload(
            oddsSnapshot.raw_data,
          );
          oddsSnapshot.raw_data = normalizedRawData;

          // Persist enrichment to database so models have access to ESPN metrics
          try {
            updateOddsSnapshotRawData(oddsSnapshot.id, normalizedRawData);
          } catch (persistError) {
            console.log(
              `  [warn] ${gameId}: Failed to persist enrichment payload (${persistError.message})`,
            );
          }

          // WI-0768: Fetch team_metrics_cache; compute and blend pace-anchor total
          const teamCtx = await applyNbaTeamContext(gameId, oddsSnapshot);
          recordEspnNullTeams({
            sport: 'NBA',
            registry: espnNullRegistry,
            nullMetricTeams: teamCtx.nullMetricTeams || [],
          });
          // Re-persist raw_data if context enriched it with pace_anchor_total
          if (teamCtx.available) {
            try {
              updateOddsSnapshotRawData(oddsSnapshot.id, oddsSnapshot.raw_data);
            } catch (persistError) {
              console.log(
                `  [warn] ${gameId}: Failed to persist team context enrichment (${persistError.message})`,
              );
            }
          }

          // WI-0646: Detect playoff game and apply threshold overrides
          const isPlayoff = isPlayoffGame(oddsSnapshot);
          if (isPlayoff) console.log(`[PLAYOFF_MODE] gameId: ${gameId}`);
          const effectiveSigma = isPlayoff
            ? applyPlayoffSigmaMultiplier(computedSigma, PLAYOFF_SIGMA_MULTIPLIER)
            : computedSigma;
          const effectiveSpreadLeanMin = isPlayoff
            ? (resolveThresholdProfile({ sport: 'NBA', marketType: 'SPREAD' }).edge.lean_edge_min + PLAYOFF_EDGE_MIN_INCREMENT)
            : null; // null = use default from generateNBAMarketCallCards

          const projectionGate = assessProjectionInputs('NBA', oddsSnapshot);
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
                'nba',
                oddsSnapshot.game_time_utc,
                10,
              )
            : [];

          const availabilityGate = teamCtx.availabilityGate || {
            missingFlags: [],
            uncertainFlags: [],
            availabilityFlags: [],
          };
          if (availabilityGate.missingFlags.length > 0) {
            const flaggedPlayers = availabilityGate.availabilityFlags.map((f) => f.player).join(', ');
            console.log(
              `  [availability] ${gameId}: ${availabilityGate.missingFlags.join(', ')}` +
              (flaggedPlayers ? ` (${flaggedPlayers})` : ''),
            );
          }

          const driverCards = computeNBADriverCards(gameId, oddsSnapshot, {
            recentRoadGames: homeTeamRoadTrip,
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
            console.log(`  [skip] ${gameId}: No actionable NBA driver signals`);
            continue;
          }

          // Only clear/write when we have actionable output; avoids wiping prior cards on transient data gaps.
          // WI-0817: collect types now; deletes are deferred into the per-game write transaction below.
          const driverCardTypesToClear = [
            ...new Set([
              ...NBA_DRIVER_CARD_TYPES,
              ...driverCards.map((card) => card.cardType),
            ]),
          ];

          // WI-0836: Enrich oddsSnapshot with computed rest days before market decisions
          const _homeRestResult = computeRestDays(oddsSnapshot.home_team, 'nba', oddsSnapshot.game_time_utc);
          const _awayRestResult = computeRestDays(oddsSnapshot.away_team, 'nba', oddsSnapshot.game_time_utc);
          const enrichedSnapshot = {
            ...oddsSnapshot,
            rest_days_home: _homeRestResult.restDays,
            rest_days_away: _awayRestResult.restDays,
          };
          const nbaMarketDecisions = computeNBAMarketDecisions(enrichedSnapshot);

          // WI-0571: log projection comparison per game
          const totalPC = nbaMarketDecisions?.TOTAL?.projection_comparison;
          const spreadPC = nbaMarketDecisions?.SPREAD?.projection_comparison;
          if (totalPC) {
            console.log(
              `  [proj] ${gameId} TOTAL: consensus edge=${totalPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${totalPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${totalPC.execution_alpha_pts ?? 'n/a'} pts, playable=${totalPC.playable_edge}`,
            );
          }
          if (spreadPC) {
            console.log(
              `  [proj] ${gameId} SPREAD: consensus edge=${spreadPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${spreadPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${spreadPC.execution_alpha_pts ?? 'n/a'} pts, playable=${spreadPC.playable_edge}`,
            );
          }

          const nbaLineContexts = {
            TOTAL: buildMarketLineContext({
              sport: 'NBA',
              gameId,
              marketType: 'TOTAL',
              selectionSide:
                nbaMarketDecisions?.TOTAL?.best_candidate?.side ?? null,
            }),
            SPREAD: buildMarketLineContext({
              sport: 'NBA',
              gameId,
              marketType: 'SPREAD',
              selectionSide:
                nbaMarketDecisions?.SPREAD?.best_candidate?.side ?? null,
            }),
          };
          const nbaExpressionChoice =
            selectExpressionChoice(nbaMarketDecisions);
          const nbaMarketPayload = buildMarketPayload({
            decisions: nbaMarketDecisions,
            expressionChoice: nbaExpressionChoice,
          });

          const cards = driverCards.map((descriptor) =>
            generateCard({
              sport: 'NBA',
              gameId,
              descriptor,
              oddsSnapshot,
              marketPayload: nbaMarketPayload,
              now: new Date().toISOString(),
              expiresAt: null,
              driverWeights: NBA_DRIVER_WEIGHTS,
            }),
          );

          const pendingCards = [];

          for (const card of cards) {
            applyProjectionInputMetadata(card, projectionGate);
            // WI-0768: merge nba_team_context into missing_inputs when cache absent
            if (teamCtx.teamContextMissingInputs.length > 0) {
              card.payloadData.missing_inputs = [
                ...(card.payloadData.missing_inputs || []),
                ...teamCtx.teamContextMissingInputs,
              ];
            }
            applyNbaSettlementMarketContext(card);
            assignExecutionStatus(card, { withoutOddsMode });
            // WI-0768: cap execution_status at PROJECTION_ONLY when nba_team_context absent
            if (
              teamCtx.teamContextMissingInputs.length > 0 &&
              card.payloadData.execution_status === 'EXECUTABLE'
            ) {
              card.payloadData.execution_status = 'PROJECTION_ONLY';
            }
            // WI-0841: merge ESPN-derived impact flags and cap tier at LEAN
            applyNbaImpactGateToCard(card, availabilityGate);
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
              // WI-0591: thread empirical sigma so decisioning uses computed
              // values instead of silently falling back to static defaults.
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
            assertExecutableCardsArePriced(card);
            attachRunId(card, jobRunId);
            // WI-0836: rest signal observability
            if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
            card.payloadData.raw_data.rest_days_home = _homeRestResult.restDays;
            card.payloadData.raw_data.rest_days_away = _awayRestResult.restDays;
            card.payloadData.raw_data.rest_source_home = _homeRestResult.restSource;
            card.payloadData.raw_data.rest_source_away = _awayRestResult.restSource;
            const tierLabel = card.payloadData.tier
              ? ` [${card.payloadData.tier}]`
              : '';
            pendingCards.push({
              card,
              strictDecisionSnapshot: decisionOutcome.strictDecisionSnapshot,
              logLine: `  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            });
          }

          // Generate and insert NBA market call cards (nba-totals-call, nba-spread-call)
          const nbaMarketCallCards = generateNBAMarketCallCards(
            gameId,
            nbaMarketDecisions,
            oddsSnapshot,
            { withoutOddsMode, lineContexts: nbaLineContexts, spreadLeanMin: effectiveSpreadLeanMin },
          );
          // WI-0817: call card deletes are deferred into the per-game write transaction below.
          for (const card of nbaMarketCallCards) {
            applyProjectionInputMetadata(card, projectionGate);
            // WI-0768: merge nba_team_context into missing_inputs when cache absent
            if (teamCtx.teamContextMissingInputs.length > 0) {
              card.payloadData.missing_inputs = [
                ...(card.payloadData.missing_inputs || []),
                ...teamCtx.teamContextMissingInputs,
              ];
            }
            // WI-0768: apply blended total to nba-totals-call projection fields
            if (
              card.cardType === 'nba-totals-call' &&
              teamCtx.available &&
              Number.isFinite(teamCtx.blendedTotal)
            ) {
              if (card.payloadData?.projection) {
                card.payloadData.projection.total = teamCtx.blendedTotal;
              }
              if (card.payloadData?.market_context?.projection) {
                card.payloadData.market_context.projection.total =
                  teamCtx.blendedTotal;
              }
            }
            applyNbaSettlementMarketContext(card);
            assignExecutionStatus(card, { withoutOddsMode });
            // WI-0768: cap execution_status at PROJECTION_ONLY when nba_team_context absent
            if (
              teamCtx.teamContextMissingInputs.length > 0 &&
              card.payloadData.execution_status === 'EXECUTABLE'
            ) {
              card.payloadData.execution_status = 'PROJECTION_ONLY';
            }
            // WI-0841: merge ESPN-derived impact flags and cap tier at LEAN
            applyNbaImpactGateToCard(card, availabilityGate);
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
              // WI-0591: thread empirical sigma so decisioning uses computed
              // values instead of silently falling back to static defaults.
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
            // WI-0941 TD-02: Post-publish TOTAL no-odds-mode LEAN reason-code stamping
            // Match NHL WI-0940 pattern: after publishDecisionForCard normalizes reason_codes,
            // detect TOTAL card with withoutOddsMode and status=LEAN, then stamp NBA_NO_ODDS_MODE_LEAN
            if (
              card.cardType === 'nba-totals-call' &&
              withoutOddsMode &&
              card.payloadData?.status === 'LEAN'
            ) {
              if (!Array.isArray(card.payloadData.reason_codes)) {
                card.payloadData.reason_codes = [];
              }
              if (!card.payloadData.reason_codes.includes('NBA_NO_ODDS_MODE_LEAN')) {
                card.payloadData.reason_codes.push('NBA_NO_ODDS_MODE_LEAN');
              }
              if (card.payloadData.decision_v2) {
                card.payloadData.decision_v2.official_status = 'LEAN';
                if (!card.payloadData.decision_v2.primary_reason_code) {
                  card.payloadData.decision_v2.primary_reason_code = 'NBA_NO_ODDS_MODE_LEAN';
                }
              }
            }
            const executionGateOutcome = applyExecutionGateToNbaCard(card, {
              oddsSnapshot,
            });
            if (executionGateOutcome.blocked) {
              console.log(
                `  [execution-gate] ${gameId} [${card.cardType}]: ${card.payloadData.pass_reason_code}`,
              );
              if (
                Array.isArray(card.payloadData?.execution_gate?.blocked_by) &&
                card.payloadData.execution_gate.blocked_by.includes('CALIBRATION_KILL_SWITCH')
              ) {
                console.log('[NBA_MODEL] %s blocked: CALIBRATION_KILL_SWITCH', jobKey || gameId);
              }
            }
            assertExecutableCardsArePriced(card);
            attachRunId(card, jobRunId);
            // WI-0836: rest signal observability
            if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
            card.payloadData.raw_data.rest_days_home = _homeRestResult.restDays;
            card.payloadData.raw_data.rest_days_away = _awayRestResult.restDays;
            card.payloadData.raw_data.rest_source_home = _homeRestResult.restSource;
            card.payloadData.raw_data.rest_source_away = _awayRestResult.restSource;
            const tierLabel = card.payloadData.tier
              ? ` [${card.payloadData.tier}]`
              : '';
            pendingCards.push({
              card,
              strictDecisionSnapshot: executionGateOutcome.strictDecisionSnapshot,
              logLine: `  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
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

          // WI-0835: annotate sigma provenance on all pending card payloads before write.
          for (const entry of pendingCards) {
            if (!entry.card.payloadData.raw_data) entry.card.payloadData.raw_data = {};
            entry.card.payloadData.raw_data.sigma_source = computedSigma.sigma_source;
            entry.card.payloadData.raw_data.sigma_games_sampled = computedSigma.games_sampled ?? null;
          }

          // WI-0831: apply isotonic calibration to fair_prob before Kelly and card write.
          const NBA_MARKET_CAL_KEY = Object.freeze({
            TOTAL: 'NBA_TOTAL',
            SPREAD: 'SPREAD',
          });
          let _calStmtNba = null;
          try {
            _calStmtNba = getDatabase().prepare(
              'SELECT breakpoints_json FROM calibration_models WHERE sport = ? AND market_type = ?',
            );
          } catch (_e) {
            console.log('[CAL_APPLY] NBA calibration_models table not ready — using raw');
          }
          for (const entry of pendingCards) {
            const pd = entry.card.payloadData;
            if (Number.isFinite(pd.p_fair)) {
              const mType = String(pd.market_type || '').toUpperCase();
              const calKey = NBA_MARKET_CAL_KEY[mType] ?? null;
              let breakpoints = null;
              if (_calStmtNba && calKey) {
                try {
                  const calRow = _calStmtNba.get('NBA', calKey);
                  breakpoints = calRow ? JSON.parse(calRow.breakpoints_json) : null;
                } catch (_e) { /* table missing or parse error — use raw */ }
              }
              const { calibratedProb, calibrationSource } = applyCalibration(pd.p_fair, breakpoints);
              pd.p_fair = calibratedProb;
              if (!pd.raw_data) pd.raw_data = {};
              pd.raw_data.calibration_source = calibrationSource;
            }
          }

          // WI-0819: attach advisory Kelly stake fraction to PLAY/LEAN cards.
          for (const entry of pendingCards) {
            const pd = entry.card.payloadData;
            const officialStatus = pd.decision_v2?.official_status;
            if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
              const { kelly_fraction, kelly_units } = kellyStake(pd.p_fair, pd.price);
              pd.kelly_fraction = kelly_fraction;
              pd.kelly_units = kelly_units;
            } else {
              pd.kelly_fraction = null;
              pd.kelly_units = null;
            }
          }

          // WI-0817: atomic write phase — all deletes + all inserts in one transaction.
          // A crash or throw inside this block rolls back automatically; old cards survive intact.
          runPerGameWriteTransaction(() => {
            for (const ct of driverCardTypesToClear) {
              prepareModelAndCardWrite(gameId, 'nba-drivers-v1', ct, { runId: jobRunId });
            }
            if (nbaMarketCallCards.length > 0) {
              for (const ct of ['nba-totals-call', 'nba-spread-call']) {
                prepareModelAndCardWrite(gameId, 'nba-cross-market-v1', ct, { runId: jobRunId });
              }
            }
            for (const entry of pendingCards) {
              entry.card.payloadData.pipeline_state = pipelineState;
              assertNoDecisionMutation(
                entry.card.payloadData,
                entry.strictDecisionSnapshot,
                { label: `${entry.card.cardType}:before_insert` },
              );
              insertCardPayload(entry.card);
            }
          });
          for (const entry of pendingCards) {
            cardsGenerated++;
            console.log(entry.logLine);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload'))
            throw gameError;
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

      const summary = {
        cardsGenerated,
        cardsFailed,
        errors,
        pipeline_states: gamePipelineStates,
      };

      markJobRunSuccess(jobRunId, summary);
      try {
        setCurrentRunId(jobRunId, 'nba');
      } catch (runStateError) {
        console.error(
          `[NBAModel] Failed to update run state: ${runStateError.message}`,
        );
      }
      await sendEspnNullDiscordAlert({
        sport: 'NBA',
        nullMetricTeams: [...espnNullRegistry.values()],
      });
      console.log(
        `[NBAModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`,
      );
      console.log(
        `[NBAModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`,
      );
      if (projectionBlockedCount > 0) {
        console.log(
          `[NBAModel] Projection input gate: ${projectionBlockedCount}/${gameIds.length} games blocked`,
        );
      }
      console.log(
        `[NBAModel] Pipeline states: ${JSON.stringify(gamePipelineStates)}`,
      );
      if (errors.length > 0)
        errors.forEach((err) => console.error(`  - ${err}`));

      return { success: true, jobRunId, ...summary };
    } catch (error) {
      console.error(`[NBAModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (_) {}
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNBAModel()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = {
  runNBAModel,
  buildNbaAvailabilityGate,
  applyNbaImpactGateToCard,
  extractNbaEspnNullMetricTeams,
  recordEspnNullTeams,
  sendEspnNullDiscordAlert,
  generateNBAMarketCallCards,
  deriveExecutionStatusForCard,
  applyExecutionGateToNbaCard,
  applyPlayoffSigmaMultiplier,
};
