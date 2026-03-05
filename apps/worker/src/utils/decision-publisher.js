const {
  buildDecisionKey,
  computeCandidateHash,
  computeInputsHash,
  getSideFamily,
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

/**
 * Apply UI action fields to payload
 * Ensures every PLAY payload has `action` and `status` fields
 * so getPlayDisplayAction() in UI can properly recognize plays
 */
function applyUiActionFields(payload) {
  if (!payload || payload.kind !== 'PLAY') {
    return payload; // Only apply to PLAY payloads
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

  // Apply UI action fields so getPlayDisplayAction() recognizes plays
  applyUiActionFields(card.payloadData);

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
