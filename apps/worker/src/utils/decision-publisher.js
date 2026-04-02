const {
  buildDecisionKey,
  buildDecisionV2,
  CANONICAL_EDGE_CONTRACT,
  computeCandidateHash,
  computeInputsHash,
  getSideFamily,
  isWave1EligiblePayload,
  isRecommendationPayload,
  normalizeMarketType,
  normalizePeriod,
  shouldFlip,
} = require('@cheddar-logic/models');

const { goalieUncertaintyBlocks } = require('../models/cross-market');

const {
  getDecisionRecord,
  insertDecisionEvent,
  updateDecisionCandidateTracking,
  upsertDecisionRecord,
} = require('@cheddar-logic/data');

/**
 * Derive UI action from tier
 * Maps model tier to display action for UI filtering
 */
function deriveAction({ tier }) {
  const t = String(tier || '').toUpperCase();

  // Simple tier-based mapping ensures UI sees plays immediately
  if (t === 'SUPER') return 'FIRE';
  if (t === 'BEST') return 'HOLD';
  if (t === 'WATCH') return 'HOLD';
  return 'PASS';
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStrictReasonCodes(reasonCodes) {
  if (!Array.isArray(reasonCodes)) return [];
  return Array.from(new Set(reasonCodes.filter(Boolean))).sort();
}

function syncSelectionCompatibilityFields(payload, updates = {}) {
  if (!payload || typeof payload !== 'object') return;
  const nextSide = updates.side || payload?.selection?.side || payload?.prediction || null;
  const nextTeam =
    updates.team !== undefined
      ? updates.team
      : payload?.selection?.team;
  if (!payload.selection || typeof payload.selection !== 'object') {
    payload.selection = {};
  }
  if (nextSide) {
    payload.selection.side = nextSide;
    payload.prediction = nextSide;
  }
  if (nextTeam !== undefined) {
    payload.selection.team = nextTeam;
  }
}

function mapOfficialStatusToLegacyDecision(officialStatus) {
  if (officialStatus === 'PLAY') {
    return {
      classification: 'BASE',
      action: 'FIRE',
      status: 'FIRE',
      passReasonCode: null,
    };
  }
  if (officialStatus === 'LEAN') {
    return {
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
      passReasonCode: null,
    };
  }
  return {
    classification: 'PASS',
    action: 'PASS',
    status: 'PASS',
    passReasonCode: null,
  };
}

function mapActionToClassification(action) {
  const normalizedAction = String(action || '').toUpperCase();
  if (normalizedAction === 'FIRE') return 'BASE';
  if (normalizedAction === 'HOLD') return 'LEAN';
  return 'PASS';
}

function resolveExecutionStatus(payload) {
  const explicitStatus = String(payload?.execution_status || '').toUpperCase();
  const sharpPriceStatus = String(
    payload?.decision_v2?.sharp_price_status || '',
  ).toUpperCase();
  const hasExecutablePricing =
    sharpPriceStatus.length > 0 && sharpPriceStatus !== 'UNPRICED';

  if (explicitStatus === 'PROJECTION_ONLY' || explicitStatus === 'BLOCKED') {
    return explicitStatus;
  }

  if (explicitStatus === 'EXECUTABLE') {
    return hasExecutablePricing ? 'EXECUTABLE' : 'BLOCKED';
  }

  return hasExecutablePricing ? 'EXECUTABLE' : 'BLOCKED';
}

function capturePublishedDecisionState(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    classification: payload.classification ?? null,
    action: payload.action ?? null,
    status: payload.status ?? null,
    execution_status: payload.execution_status ?? null,
    pass_reason_code: payload.pass_reason_code ?? null,
    reason_codes: normalizeStrictReasonCodes(payload.reason_codes),
    decision_v2_official_status: payload.decision_v2?.official_status ?? null,
  };
}

function buildDecisionMutationDiffs(payload, expectedSnapshot) {
  const currentSnapshot = capturePublishedDecisionState(payload);
  if (!expectedSnapshot || !currentSnapshot) return [];

  const diffs = [];
  const fieldPathMap = {
    classification: 'classification',
    action: 'action',
    status: 'status',
    execution_status: 'execution_status',
    pass_reason_code: 'pass_reason_code',
    reason_codes: 'reason_codes',
    decision_v2_official_status: 'decision_v2.official_status',
  };

  for (const [key, fieldPath] of Object.entries(fieldPathMap)) {
    const expected = expectedSnapshot[key];
    const actual = currentSnapshot[key];
    if (JSON.stringify(expected) === JSON.stringify(actual)) continue;
    diffs.push({
      field_path: fieldPath,
      expected,
      actual,
    });
  }

  return diffs;
}

function assertNoDecisionMutation(payload, expectedSnapshot, context = {}) {
  const diffs = buildDecisionMutationDiffs(payload, expectedSnapshot);
  if (diffs.length === 0) return [];

  const label = context.label || 'post_publish';
  const details = diffs
    .map(
      (diff) =>
        `${diff.field_path}: expected=${JSON.stringify(diff.expected)} actual=${JSON.stringify(diff.actual)}`,
    )
    .join('; ');
  const error = new Error(
    `[INVARIANT_BREACH] ${label}: strict decision fields mutated after publish (${details})`,
  );
  error.code = 'INVARIANT_BREACH';
  error.diffs = diffs;

  if (context.throwOnViolation ?? process.env.NODE_ENV === 'test') {
    throw error;
  }

  console.warn(error.message);
  return diffs;
}

function derivePaceTier(payload) {
  const total =
    typeof payload?.odds_context?.total === 'number'
      ? payload.odds_context.total
      : typeof payload?.projection?.total === 'number'
        ? payload.projection.total
        : null;
  const sport = String(payload?.sport || '').toUpperCase();
  if (total === null || !Number.isFinite(total)) return 'UNKNOWN';
  if (sport === 'NBA' || sport === 'NCAAM') {
    if (total >= 230) return 'HIGH';
    if (total <= 215) return 'LOW';
    return 'MID';
  }
  if (sport === 'NHL') {
    if (total >= 6.5) return 'HIGH';
    if (total <= 5.5) return 'LOW';
    return 'MID';
  }
  return 'UNKNOWN';
}

function deriveEventEnv(payload) {
  const sport = String(payload?.sport || '').toUpperCase();
  if (sport === 'NBA' || sport === 'NCAAM' || sport === 'NHL') return 'INDOOR';
  return 'UNKNOWN';
}

function deriveEventDirectionTag(payload) {
  const side = String(
    payload?.selection?.side || payload?.prediction || '',
  ).toUpperCase();
  if (side === 'OVER') return 'FAVOR_OVER';
  if (side === 'UNDER') return 'FAVOR_UNDER';
  if (side === 'HOME') return 'FAVOR_HOME';
  if (side === 'AWAY') return 'FAVOR_AWAY';
  return 'UNKNOWN';
}

function deriveVolEnv(payload, homeGoalieState, awayGoalieState) {
  // WI-0382: Force VOLATILE when goalie identity is UNKNOWN or CONFLICTING
  if (goalieUncertaintyBlocks(homeGoalieState, awayGoalieState)) return 'VOLATILE';

  const conflict =
    typeof payload?.driver?.inputs?.conflict === 'number'
      ? payload.driver.inputs.conflict
      : typeof payload?.expression_choice?.chosen?.conflict === 'number'
        ? payload.expression_choice.chosen.conflict
        : null;
  if (conflict === null || !Number.isFinite(conflict)) return 'UNKNOWN';
  return conflict >= 0.4 ? 'VOLATILE' : 'STABLE';
}

function ensureDecisionConsistencyEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return;
  const existing =
    payload.consistency && typeof payload.consistency === 'object'
      ? payload.consistency
      : {};

  const totalBias =
    asNonEmptyString(existing.total_bias) ||
    asNonEmptyString(payload?.driver?.inputs?.total_bias) ||
    'UNKNOWN';

  payload.consistency = {
    ...existing,
    pace_tier: asNonEmptyString(existing.pace_tier) || derivePaceTier(payload),
    event_env: asNonEmptyString(existing.event_env) || deriveEventEnv(payload),
    event_direction_tag:
      asNonEmptyString(existing.event_direction_tag) ||
      deriveEventDirectionTag(payload),
    vol_env:
      asNonEmptyString(existing.vol_env) ||
      deriveVolEnv(payload, payload.homeGoalieState, payload.awayGoalieState),
    total_bias: totalBias,
  };
}

/**
 * Finalize decision-authoritative fields on the payload.
 * This must only run inside the publish boundary.
 */
function finalizeDecisionFields(payload, context = {}) {
  if (!payload || payload.kind !== 'PLAY') {
    return payload;
  }

  syncSelectionCompatibilityFields(payload);

  if (payload.official_eligible === false) {
    payload.decision_v2 = {
      ...(payload.decision_v2 && typeof payload.decision_v2 === 'object'
        ? payload.decision_v2
        : {}),
      official_status: 'PASS',
      primary_reason_code:
        payload.pass_reason_code || payload.decision_v2?.primary_reason_code || 'OFFICIAL_INELIGIBLE',
      pipeline_version: payload.decision_v2?.pipeline_version || 'v2',
    };
    payload.classification = 'PASS';
    payload.action = 'PASS';
    payload.status = 'PASS';
    payload.pass_reason_code = payload.decision_v2.primary_reason_code;
    payload.reason_codes = normalizeStrictReasonCodes([
      payload.decision_v2.primary_reason_code,
    ]);
    payload.execution_status = resolveExecutionStatus(payload);
    return payload;
  }

  if (isWave1EligiblePayload(payload)) {
    ensureDecisionConsistencyEnvelope(payload);
    const decisionV2 = buildDecisionV2(payload, context);
    if (decisionV2) {
      payload.decision_v2 = decisionV2;
      const legacyDecision = mapOfficialStatusToLegacyDecision(
        decisionV2.official_status,
      );
      payload.classification = legacyDecision.classification;
      payload.action = legacyDecision.action;
      payload.status = legacyDecision.status;
      payload.pass_reason_code =
        decisionV2.official_status === 'PASS'
          ? decisionV2.primary_reason_code
          : null;
      payload.reason_codes = normalizeStrictReasonCodes([
        decisionV2.primary_reason_code,
      ]);
      payload.execution_status = resolveExecutionStatus(payload);
      syncSelectionCompatibilityFields(payload);
      return payload;
    }
  }

  const action = deriveAction({
    tier: payload.tier,
    edge: payload.edge,
    confidence: payload.confidence,
  });

  payload.action = action;
  // Legacy fallback for getPlayDisplayAction() backward compatibility
  payload.status =
    action === 'FIRE' ? 'FIRE' : action === 'HOLD' ? 'WATCH' : 'PASS';
  payload.classification = mapActionToClassification(action);
  payload.execution_status = resolveExecutionStatus(payload);
  syncSelectionCompatibilityFields(payload);

  return payload;
}

function deriveUiDisplayStatus(payload) {
  const executionStatus = String(payload?.execution_status || '').toUpperCase();
  const officialStatus = String(
    payload?.decision_v2?.official_status || '',
  ).toUpperCase();
  const legacyStatus = String(payload?.status || '').toUpperCase();

  if (executionStatus === 'PROJECTION_ONLY') return 'WATCH';
  if (executionStatus === 'BLOCKED') return 'PASS';
  if (executionStatus === 'EXECUTABLE' && officialStatus === 'PLAY') {
    return 'PLAY';
  }
  if (executionStatus === 'EXECUTABLE' && officialStatus === 'LEAN') {
    return 'WATCH';
  }
  if (legacyStatus === 'FIRE') return 'PLAY';
  if (legacyStatus === 'WATCH') return 'WATCH';
  if (officialStatus === 'LEAN') return 'WATCH';
  return 'PASS';
}

/**
 * Backward-compatible wrapper:
 * - Pre-publish payloads: finalize semantic decision fields, then decorate UI
 * - Post-publish payloads: decorate UI only
 */
function applyUiActionFields(payload, context = {}) {
  if (!payload || payload.kind !== 'PLAY') {
    return payload;
  }

  const hasPublishedDecision =
    Boolean(payload.decision_v2) &&
    typeof payload.classification === 'string' &&
    typeof payload.action === 'string' &&
    typeof payload.status === 'string';
  const strictDecisionSnapshot = hasPublishedDecision
    ? capturePublishedDecisionState(payload)
    : null;

  if (!hasPublishedDecision) {
    finalizeDecisionFields(payload, context);
  }

  payload.ui_display_status = deriveUiDisplayStatus(payload);

  if (strictDecisionSnapshot) {
    assertNoDecisionMutation(payload, strictDecisionSnapshot, {
      label: 'applyUiActionFields',
    });
  }

  return payload;
}

function buildPickText(market, side, line) {
  if (market === 'total' || market === 'team_total') {
    const lineText = line != null ? ` ${line}` : '';
    return `${side === 'OVER' ? 'OVER' : 'UNDER'}${lineText}`;
  }

  if (market === 'spread' || market === 'puckline') {
    const lineText = line != null ? ` ${line > 0 ? `+${line}` : line}` : '';
    return `${side === 'HOME' ? 'Home' : 'Away'}${lineText}`;
  }

  if (market === 'moneyline') {
    return `${side === 'HOME' ? 'Home' : 'Away'} ML`;
  }

  return side;
}

function toCanonicalMarketForContext(market) {
  if (market === 'moneyline') return 'MONEYLINE';
  if (market === 'spread' || market === 'puckline') return 'SPREAD';
  if (market === 'total' || market === 'team_total') return 'TOTAL';
  return null;
}

function applyPublishedDecisionToPayload(
  card,
  decision,
  market,
  decisionKey,
  gateReason,
) {
  if (!decision) return;

  const payload = card.payloadData || {};
  const side = decision.recommended_side;
  const line = decision.recommended_line ?? null;
  const price = decision.recommended_price ?? null;
  const homeTeam = payload.home_team || null;
  const awayTeam = payload.away_team || null;

  let team = payload.selection?.team;
  if (side === 'HOME') team = homeTeam || team;
  if (side === 'AWAY') team = awayTeam || team;

  syncSelectionCompatibilityFields(payload, { side, team });
  payload.line = line;
  payload.price = price;
  payload.edge = decision.edge ?? payload.edge ?? null;
  payload.edge_available = Number.isFinite(payload.edge);
  payload.confidence = decision.confidence ?? payload.confidence ?? null;
  payload.published_from_gate = true;
  payload.gate_reason = gateReason || null;
  payload.published_decision_key = decisionKey || null;
  payload.gate_reason_codes = normalizeStrictReasonCodes([
    'DECISION_HELD',
    gateReason || null,
  ]);
  payload.tags = Array.from(
    new Set([...(payload.tags || []), 'PUBLISHED_FROM_GATE']),
  );

  const pickText = buildPickText(market, side, line);
  const sportLabel = payload.sport
    ? String(payload.sport).toUpperCase()
    : 'SPORT';
  if (market === 'total' || market === 'team_total') {
    card.cardTitle = `${sportLabel} Totals: ${pickText}`;
  } else if (market === 'spread' || market === 'puckline') {
    card.cardTitle = `${sportLabel} Spread: ${pickText}`;
  } else if (market === 'moneyline') {
    card.cardTitle = `${sportLabel} Moneyline: ${pickText}`;
  }

  payload.reasoning = `${pickText}: published decision held`;

  // Keep pricing_trace consistent with the held decision so validateExactWager
  // does not flag EXACT_WAGER_MISMATCH when the gate overwrites prediction/price.
  if (payload.pricing_trace && typeof payload.pricing_trace === 'object') {
    if (side)
      payload.pricing_trace = { ...payload.pricing_trace, called_side: side };
    if (line !== null)
      payload.pricing_trace = { ...payload.pricing_trace, called_line: line };
    if (price !== null)
      payload.pricing_trace = { ...payload.pricing_trace, called_price: price };
  }

  // Keep canonical market_context aligned with held decision rewrites.
  const existingMarketContext =
    payload.market_context && typeof payload.market_context === 'object'
      ? payload.market_context
      : {};
  const existingWager =
    existingMarketContext.wager &&
    typeof existingMarketContext.wager === 'object'
      ? existingMarketContext.wager
      : {};
  const traceForSources =
    payload.pricing_trace && typeof payload.pricing_trace === 'object'
      ? payload.pricing_trace
      : {};

  payload.market_context = {
    ...existingMarketContext,
    version: existingMarketContext.version || 'v1',
    market_type:
      toCanonicalMarketForContext(market) ||
      existingMarketContext.market_type ||
      null,
    selection_side: side || existingMarketContext.selection_side || null,
    selection_team: team || existingMarketContext.selection_team || null,
    wager: {
      ...existingWager,
      called_line: line,
      called_price: price,
      line_source:
        payload.line_source ||
        existingWager.line_source ||
        traceForSources.line_source ||
        'odds_snapshot',
      price_source:
        payload.price_source ||
        existingWager.price_source ||
        traceForSources.price_source ||
        'odds_snapshot',
    },
  };

  card.payloadData = payload;
}

function publishDecisionForCard({ card, oddsSnapshot, options = {} }) {
  const payload = card?.payloadData;
  if (!isRecommendationPayload(payload)) {
    applyUiActionFields(card?.payloadData, {
      oddsSnapshot,
      sigmaOverride: options.sigmaOverride ?? null,
    });
    if (card?.payloadData && typeof card.payloadData === 'object') {
      card.payloadData._audit_stage = 'PUBLISH_OUTPUT';
    }
    return {
      card,
      gated: false,
      strictDecisionSnapshot: capturePublishedDecisionState(card?.payloadData),
    };
  }

  const market = normalizeMarketType(
    payload.market_type,
    payload.recommended_bet_type,
  );
  const period = normalizePeriod(payload);
  const sideFamily = getSideFamily(market);
  const decisionKey = buildDecisionKey({
    sport: payload.sport,
    gameId: card.gameId,
    market,
    period,
    sideFamily,
  });

  const side = payload.selection?.side || payload.prediction;
  const line = Number.isFinite(payload.line) ? payload.line : null;
  const price = Number.isFinite(payload.price) ? payload.price : null;
  const edge = Number.isFinite(payload.edge) ? payload.edge : null;
  const edgeAvailable =
    payload.edge_available === true || Number.isFinite(payload.edge);
  const inputsHash = computeInputsHash(payload);
  const candidateHash = computeCandidateHash({
    side,
    line,
    price,
    inputsHash,
    market,
    period,
    sideFamily,
  });

  const current = getDecisionRecord(decisionKey);
  const candidateSeenCount =
    current && current.last_candidate_hash === candidateHash
      ? (current.candidate_seen_count || 0) + 1
      : 1;

  const nowIso = new Date().toISOString();
  const gameTime = oddsSnapshot?.game_time_utc
    ? new Date(oddsSnapshot.game_time_utc)
    : null;
  const minutesToStart = gameTime
    ? (gameTime.getTime() - Date.now()) / 60000
    : 9999;
  const lineDelta =
    current && current.recommended_line != null && line != null
      ? Math.abs(line - current.recommended_line)
      : 0;
  const lineMoved = lineDelta > 0;

  const hardLockMinutes = options.hardLockMinutes ?? 120;
  const lockStatus =
    current?.locked_status === 'HARD' || minutesToStart <= hardLockMinutes
      ? 'HARD'
      : 'SOFT';
  const lockAt =
    lockStatus === 'HARD' && current?.locked_status !== 'HARD'
      ? nowIso
      : current?.locked_at || null;

  const gateResult = shouldFlip(
    current
      ? {
          ...current,
          locked_status: lockStatus,
          edge_available: Number.isFinite(current.edge),
        }
      : null,
    { side, line, price, edge, edge_available: edgeAvailable },
    {
      candidateSeenCount,
      lineMoved,
      lineDelta,
      criticalOverride: options.criticalOverride === true,
    },
  );

  const action = gateResult.allow
    ? current
      ? current.recommended_side === side
        ? 'KEEP'
        : 'FLIP_ALLOWED'
      : 'INIT'
    : 'FLIP_BLOCKED';

  insertDecisionEvent({
    ts: nowIso,
    decisionKey,
    action,
    reasonCode: gateResult.reason_code,
    reasonDetail: gateResult.reason_detail,
    prevSide: current?.recommended_side ?? null,
    prevLine: current?.recommended_line ?? null,
    prevPrice: current?.recommended_price ?? null,
    prevEdge: current?.edge ?? null,
    candSide: side,
    candLine: line,
    candPrice: price,
    candEdge: edge,
    edgeUnits: CANONICAL_EDGE_CONTRACT.unit,
    edgeDelta: gateResult.edge_delta ?? null,
    lineDelta,
    priceDelta:
      current?.recommended_price != null && price != null
        ? price - current.recommended_price
        : null,
    inputsHash,
    resultVersion: payload.model_version || null,
  });

  if (gateResult.allow) {
    upsertDecisionRecord({
      decisionKey,
      sport: payload.sport,
      gameId: card.gameId,
      market,
      period,
      sideFamily,
      recommendedSide: side,
      recommendedLine: line,
      recommendedPrice: price,
      book: payload.book || null,
      edge,
      confidence: payload.confidence ?? null,
      lockedStatus: lockStatus,
      lockedAt: lockAt,
      lastSeenAt: nowIso,
      resultVersion: payload.model_version || null,
      inputsHash,
      oddsSnapshotId: null,
      lastReasonCode: gateResult.reason_code,
      lastReasonDetail: gateResult.reason_detail,
      lastCandidateHash: candidateHash,
      candidateSeenCount,
    });
    payload.published_decision_key = decisionKey;
  } else if (current) {
    updateDecisionCandidateTracking({
      decisionKey,
      lastSeenAt: nowIso,
      lastCandidateHash: candidateHash,
      candidateSeenCount,
      lastReasonCode: gateResult.reason_code,
      lastReasonDetail: gateResult.reason_detail,
      lockedStatus: lockStatus,
      lockedAt: lockAt,
    });

    applyPublishedDecisionToPayload(
      card,
      current,
      market,
      decisionKey,
      gateResult.reason_code,
    );
  }

  // Attach canonical decision fields before insert.
  // WI-0591: pass sigmaOverride from options into buildDecisionV2 context.
  finalizeDecisionFields(card.payloadData, {
    oddsSnapshot,
    sigmaOverride: options.sigmaOverride ?? null,
  });
  applyUiActionFields(card.payloadData);
  card.payloadData._audit_stage = 'PUBLISH_OUTPUT';
  const strictDecisionSnapshot = capturePublishedDecisionState(card.payloadData);

  return {
    card,
    gated: true,
    allow: gateResult.allow,
    decisionKey,
    reasonCode: gateResult.reason_code,
    strictDecisionSnapshot,
  };
}

module.exports = {
  publishDecisionForCard,
  applyUiActionFields,
  finalizeDecisionFields,
  capturePublishedDecisionState,
  assertNoDecisionMutation,
  deriveAction,
  deriveVolEnv,
};
