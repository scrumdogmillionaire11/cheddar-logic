const {
  buildDecisionKey,
  buildDecisionV2,
  computeCandidateHash,
  computeInputsHash,
  getSideFamily,
  isWave1EligiblePayload,
  isRecommendationPayload,
  normalizeMarketType,
  normalizePeriod,
  shouldFlip,
} = require('@cheddar-logic/models');

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

function deriveVolEnv(payload) {
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
    vol_env: asNonEmptyString(existing.vol_env) || deriveVolEnv(payload),
    total_bias: totalBias,
  };
}

/**
 * Apply UI action fields to payload
 * Ensures every PLAY payload has `action` and `status` fields
 * so getPlayDisplayAction() in UI can properly recognize plays
 */
function applyUiActionFields(payload, context = {}) {
  if (!payload || payload.kind !== 'PLAY') {
    return payload; // Only apply to PLAY payloads
  }

  if (isWave1EligiblePayload(payload)) {
    ensureDecisionConsistencyEnvelope(payload);

    // Strip odds snapshot timestamp before calling buildDecisionV2.
    // The watchdog's STALE_SNAPSHOT check compares captured_at against
    // the current clock. When this decision is stored to the DB and later
    // read back (potentially hours later), the stored watchdog_status would
    // permanently reflect the staleness at write-time, which is incorrect.
    // On the Pi's hourly odds cadence, odds are routinely 30-60 min old at
    // model-run time — well within the system's own ODDS_GAP_ALERT_MINUTES=90
    // tolerance — so the 30-min threshold fires spuriously on every run.
    // Staleness should be enforced at the scheduler/ingest level (before
    // the model runs), not baked into a stored decision record.
    if (payload.odds_context && typeof payload.odds_context === 'object') {
      const { captured_at: _capturedAt, ...oddsContextWithoutTs } =
        payload.odds_context;
      payload.odds_context = oddsContextWithoutTs;
    }
    const contextWithoutTs = context.oddsSnapshot
      ? {
          ...context,
          oddsSnapshot: (({ captured_at: _ca, capturedAt: _cA, ...rest }) =>
            rest)(context.oddsSnapshot),
        }
      : context;

    const decisionV2 = buildDecisionV2(payload, contextWithoutTs);
    if (decisionV2) {
      payload.decision_v2 = decisionV2;
      const official = decisionV2.official_status;
      payload.classification =
        official === 'PLAY' ? 'BASE' : official === 'LEAN' ? 'LEAN' : 'PASS';
      payload.action =
        official === 'PLAY' ? 'FIRE' : official === 'LEAN' ? 'HOLD' : 'PASS';
      payload.status =
        official === 'PLAY' ? 'FIRE' : official === 'LEAN' ? 'WATCH' : 'PASS';
      payload.pass_reason_code =
        official === 'PASS' ? decisionV2.primary_reason_code : null;
      payload.reason_codes = Array.from(
        new Set([
          ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
          decisionV2.primary_reason_code,
        ]),
      );
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

  payload.selection = { ...(payload.selection || {}), side, team };
  payload.prediction = side;
  payload.line = line;
  payload.price = price;
  payload.edge = decision.edge ?? payload.edge ?? null;
  payload.confidence = decision.confidence ?? payload.confidence ?? null;
  payload.published_from_gate = true;
  payload.gate_reason = gateReason || null;
  payload.published_decision_key = decisionKey || null;
  payload.reason_codes = Array.from(
    new Set([...(payload.reason_codes || []), 'DECISION_HELD']),
  );
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
    return { card, gated: false };
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
  const edge = Number.isFinite(payload.edge) ? payload.edge : 0;
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
    current ? { ...current, locked_status: lockStatus } : null,
    { side, line, price, edge },
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
  applyUiActionFields(card.payloadData, { oddsSnapshot });

  return {
    card,
    gated: true,
    allow: gateResult.allow,
    decisionKey,
    reasonCode: gateResult.reason_code,
  };
}

module.exports = {
  publishDecisionForCard,
  applyUiActionFields,
  deriveAction,
};
