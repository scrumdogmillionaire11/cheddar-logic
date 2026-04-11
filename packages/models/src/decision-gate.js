const nodeCrypto = require('crypto');

/**
 * Canonical edge contract for all gate and pipeline consumers.
 *
 * unit: 'decimal_fraction'
 *   edge = p_fair - p_implied
 *   Example: 0.06 = 6% edge above market implied probability
 *
 * Sources of truth (in precedence order):
 *   1. decision_v2.edge_pct  (wave-1 probability edge from buildDecisionV2)
 *      decision_v2.edge_delta_pct may also appear on NHL prop payloads and
 *      represents projection delta vs. line, not price edge.
 *   2. payload.edge          (set explicitly by model runners that compute CDF edge)
 *   3. null                  (edge unavailable — do not coerce to 0)
 *
 * EDGE_UPGRADE_MIN: minimum edge improvement (in decimal_fraction units)
 * required to permit a side-flip. 0.04 = 4 percentage points.
 */
const CANONICAL_EDGE_CONTRACT = Object.freeze({
  unit: 'decimal_fraction',
  description: 'edge = p_fair - p_implied; 0.06 = 6% edge',
  upgrade_min: 0.04,
  sources: ['decision_v2.edge_pct (wave-1)', 'decision_v2.edge_delta_pct (nhl props)', 'payload.edge', 'null'],
});

const DEFAULTS = {
  EDGE_UPGRADE_MIN: 0.04, // unit: decimal_fraction — 0.04 = 4 percentage points improvement required
  REQUIRE_STABILITY_RUNS: 2,
  HARD_LOCK_MINUTES: 120,
  LINE_MOVE_MIN: 0.5,
};

/** Returns true only if value is a finite decimal-fraction edge. Never treat null/undefined as 0. */
function hasFiniteEdge(value) {
  return Number.isFinite(value);
}

function normalizeMarketType(marketType, recommendedBetType) {
  const raw = String(marketType || recommendedBetType || '').toLowerCase();
  if (raw.includes('first_period') || raw.includes('1p')) return 'first_period';
  if (raw.includes('total')) return 'total';
  if (raw.includes('team_total') || raw.includes('team total'))
    return 'team_total';
  if (raw.includes('spread')) return 'spread';
  if (raw.includes('puck_line') || raw.includes('puckline')) return 'puckline';
  if (raw.includes('moneyline') || raw === 'ml') return 'moneyline';
  if (raw.includes('prop')) return 'prop';
  return 'unknown';
}

function normalizePeriod(payload) {
  const raw =
    payload?.period ||
    payload?.time_period ||
    payload?.market?.period ||
    'full_game';
  const value = String(raw).toLowerCase().replace(/\s+/g, '_');
  if (
    value === 'fullgame' ||
    value === 'full_game' ||
    value === 'game' ||
    value === 'full'
  )
    return 'full_game';
  if (value === '1h' || value === '1st_half' || value === 'first_half')
    return '1h';
  if (value === '2h' || value === '2nd_half' || value === 'second_half')
    return '2h';
  if (
    value === '1q' ||
    value === '1st_q' ||
    value === 'first_q' ||
    value === 'first_quarter'
  )
    return '1q';
  if (
    value === '2q' ||
    value === '2nd_q' ||
    value === 'second_q' ||
    value === 'second_quarter'
  )
    return '2q';
  if (
    value === '3q' ||
    value === '3rd_q' ||
    value === 'third_q' ||
    value === 'third_quarter'
  )
    return '3q';
  if (
    value === '4q' ||
    value === '4th_q' ||
    value === 'fourth_q' ||
    value === 'fourth_quarter'
  )
    return '4q';
  if (
    value === '1p' ||
    value === '1st_p' ||
    value === 'first_p' ||
    value === 'first_period'
  )
    return '1p';
  if (
    value === '2p' ||
    value === '2nd_p' ||
    value === 'second_p' ||
    value === 'second_period'
  )
    return '2p';
  if (
    value === '3p' ||
    value === '3rd_p' ||
    value === 'third_p' ||
    value === 'third_period'
  )
    return '3p';
  if (value === 'f5' || value === 'first5' || value === 'first_5') return 'f5';
  return value;
}

function getSideFamily(market) {
  if (
    market === 'total' ||
    market === 'team_total' ||
    market === 'first_period' ||
    market === 'prop'
  ) {
    return 'over_under';
  }
  if (market === 'spread' || market === 'moneyline' || market === 'puckline') {
    return 'home_away';
  }
  return 'unknown';
}

function buildDecisionKey({ sport, gameId, market, period, sideFamily }) {
  return `${String(sport).toLowerCase()}|${String(gameId)}|${market}|${period}|${sideFamily}`;
}

function isRecommendationPayload(payload) {
  if (!payload) return false;
  if (payload.kind !== 'PLAY') return false;
  if (payload.market_type === 'INFO') return false;

  const market = normalizeMarketType(
    payload.market_type,
    payload.recommended_bet_type,
  );
  if (market === 'unknown' || market === 'prop') return false;

  const side = payload.selection?.side || payload.prediction;
  const hasValidSide =
    side === 'HOME' || side === 'AWAY' || side === 'OVER' || side === 'UNDER';
  if (!hasValidSide) return false;

  const hasPrice = Number.isFinite(payload.price);
  if (!hasPrice) return false;

  if (
    market === 'total' ||
    market === 'team_total' ||
    market === 'spread' ||
    market === 'puckline'
  ) {
    return Number.isFinite(payload.line);
  }

  return true;
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
  );
  return `{${entries.join(',')}}`;
}

function computeInputsHash(payload) {
  const modelInputs = payload?.driver?.inputs || null;
  const base = {
    market_type: payload?.market_type || null,
    recommended_bet_type: payload?.recommended_bet_type || null,
    selection: payload?.selection || null,
    line: payload?.line ?? null,
    price: payload?.price ?? null,
    edge: payload?.edge ?? null,
    model_version: payload?.model_version || null,
    odds_context: payload?.odds_context || null,
    driver_inputs: modelInputs,
  };
  const raw = stableStringify(base);
  return nodeCrypto.createHash('sha256').update(raw).digest('hex');
}

function computeCandidateHash({
  side,
  line,
  price,
  inputsHash,
  market,
  period,
  sideFamily,
}) {
  const raw = stableStringify({
    side,
    line,
    price,
    inputs_hash: inputsHash,
    market,
    period,
    side_family: sideFamily,
  });
  return nodeCrypto.createHash('sha256').update(raw).digest('hex');
}

function resolveLineMoveContext(ctx = {}) {
  const nestedLineDelta = Number.isFinite(ctx?.lineContext?.delta)
    ? ctx.lineContext.delta
    : Number.isFinite(ctx?.lineContext?.lineDelta)
      ? ctx.lineContext.lineDelta
      : null;
  const lineDelta = Number.isFinite(ctx?.lineDelta)
    ? ctx.lineDelta
    : nestedLineDelta;
  const lineMoved =
    ctx?.lineMoved === true ||
    ctx?.lineContext?.lineMoved === true ||
    (Number.isFinite(lineDelta) && Math.abs(lineDelta) > 0);

  return {
    lineMoved,
    lineDelta: Number.isFinite(lineDelta) ? lineDelta : 0,
  };
}

/**
 * Determines whether a new candidate decision should replace the current one.
 *
 * Edge contract: candidate.edge and current.edge MUST be decimal fractions
 * (unit: 'decimal_fraction' per CANONICAL_EDGE_CONTRACT). Missing edge must be
 * passed as null — never as 0 or undefined.
 *
 * @param {object|null} current - stored decision record
 * @param {object} candidate - { side, line, price, edge, edge_available }
 * @param {object} ctx - { candidateSeenCount, lineMoved, lineDelta, criticalOverride }
 */
function shouldFlip(current, candidate, ctx = {}) {
  const config = { ...DEFAULTS, ...(ctx || {}) };
  const { lineMoved, lineDelta } = resolveLineMoveContext(ctx);
  const candidateEdgeAvailable =
    candidate?.edge_available === true || hasFiniteEdge(candidate?.edge);
  const currentEdgeAvailable =
    current?.edge_available === true || hasFiniteEdge(current?.edge);
  const edgeComparable = candidateEdgeAvailable && currentEdgeAvailable;

  if (!current) {
    return {
      allow: true,
      reason_code: 'INIT',
      reason_detail: 'First published decision for this market',
      edge_delta: candidateEdgeAvailable ? (candidate.edge ?? null) : null,
    };
  }

  if (current.locked_status === 'HARD') {
    if (ctx.criticalOverride) {
      return {
        allow: true,
        reason_code: 'CRITICAL_OVERRIDE',
        reason_detail: 'Hard lock overridden by critical event',
        edge_delta: (hasFiniteEdge(candidate?.edge) && hasFiniteEdge(current?.edge))
          ? candidate.edge - current.edge
          : null,
      };
    }
    return {
      allow: false,
      reason_code: 'HARD_LOCKED',
      reason_detail: 'Hard lock active; decision held',
      edge_delta: 0,
    };
  }

  const sideChanged = candidate.side !== current.recommended_side;
  const edgeDelta = (hasFiniteEdge(candidate?.edge) && hasFiniteEdge(current?.edge))
    ? candidate.edge - current.edge
    : null;

  if (!sideChanged) {
    return {
      allow: true,
      reason_code: 'REFRESH_SAME_SIDE',
      reason_detail: 'Same side; refresh price/line',
      edge_delta: edgeDelta,
    };
  }

  if ((ctx.candidateSeenCount ?? 0) < config.REQUIRE_STABILITY_RUNS) {
    return {
      allow: false,
      reason_code: 'NOT_STABLE',
      reason_detail: `Candidate seen ${ctx.candidateSeenCount ?? 0} runs; need ${config.REQUIRE_STABILITY_RUNS}`,
      edge_delta: edgeDelta,
    };
  }

  if (!candidateEdgeAvailable || !currentEdgeAvailable) {
    if (lineMoved && Math.abs(lineDelta || 0) >= config.LINE_MOVE_MIN) {
      return {
        allow: true,
        reason_code: 'LINE_MOVE_NO_EDGE',
        reason_detail: `Line moved ${lineDelta}; accepted without edge comparison`,
        edge_delta: null,
      };
    }

    return {
      allow: false,
      reason_code: 'EDGE_UNAVAILABLE',
      reason_detail:
        'Edge unavailable for candidate or current decision; side flip requires edge comparison or qualifying line move',
      edge_delta: null,
    };
  }

  if (
    lineMoved &&
    Math.abs(lineDelta || 0) >= config.LINE_MOVE_MIN &&
    edgeDelta !== null &&
    edgeDelta >= 0
  ) {
    return {
      allow: true,
      reason_code: 'LINE_MOVE',
      reason_detail: `Line moved ${lineDelta}; edge improved/held`,
      edge_delta: edgeDelta,
    };
  }

  if (
    edgeDelta !== null &&
    edgeDelta + Number.EPSILON >= config.EDGE_UPGRADE_MIN
  ) {
    return {
      allow: true,
      reason_code: 'EDGE_UPGRADE',
      reason_detail: `Edge improved +${edgeDelta.toFixed(2)} (>= ${config.EDGE_UPGRADE_MIN})`,
      edge_delta: edgeDelta,
    };
  }

  return {
    allow: false,
    reason_code: 'EDGE_TOO_SMALL',
    reason_detail: `Edge delta +${edgeDelta.toFixed(2)} < ${config.EDGE_UPGRADE_MIN}`,
    edge_delta: edgeDelta,
  };
}

module.exports = {
  CANONICAL_EDGE_CONTRACT,
  buildDecisionKey,
  computeCandidateHash,
  computeInputsHash,
  getSideFamily,
  isRecommendationPayload,
  normalizeMarketType,
  normalizePeriod,
  shouldFlip,
};
