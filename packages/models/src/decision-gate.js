/* eslint-disable @typescript-eslint/no-require-imports */
const nodeCrypto = require('crypto');

const DEFAULTS = {
  EDGE_UPGRADE_MIN: 0.5,
  REQUIRE_STABILITY_RUNS: 2,
  HARD_LOCK_MINUTES: 120,
  LINE_MOVE_MIN: 0.5
};

function normalizeMarketType(marketType, recommendedBetType) {
  const raw = String(marketType || recommendedBetType || '').toLowerCase();
  if (raw.includes('total')) return 'total';
  if (raw.includes('team_total') || raw.includes('team total')) return 'team_total';
  if (raw.includes('spread')) return 'spread';
  if (raw.includes('puck_line') || raw.includes('puckline')) return 'puckline';
  if (raw.includes('moneyline') || raw === 'ml') return 'moneyline';
  if (raw.includes('prop')) return 'prop';
  return 'unknown';
}

function normalizePeriod(payload) {
  const raw = payload?.period || payload?.time_period || payload?.market?.period || 'full_game';
  const value = String(raw).toLowerCase().replace(/\s+/g, '_');
  if (value === 'fullgame' || value === 'full_game' || value === 'game' || value === 'full') return 'full_game';
  if (value === '1h' || value === '1st_half' || value === 'first_half') return '1h';
  if (value === '2h' || value === '2nd_half' || value === 'second_half') return '2h';
  if (value === '1q' || value === '1st_q' || value === 'first_q' || value === 'first_quarter') return '1q';
  if (value === '2q' || value === '2nd_q' || value === 'second_q' || value === 'second_quarter') return '2q';
  if (value === '3q' || value === '3rd_q' || value === 'third_q' || value === 'third_quarter') return '3q';
  if (value === '4q' || value === '4th_q' || value === 'fourth_q' || value === 'fourth_quarter') return '4q';
  if (value === '1p' || value === '1st_p' || value === 'first_p' || value === 'first_period') return '1p';
  if (value === '2p' || value === '2nd_p' || value === 'second_p' || value === 'second_period') return '2p';
  if (value === '3p' || value === '3rd_p' || value === 'third_p' || value === 'third_period') return '3p';
  if (value === 'f5' || value === 'first5' || value === 'first_5') return 'f5';
  return value;
}

function getSideFamily(market) {
  if (market === 'total' || market === 'team_total' || market === 'prop') {
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
  const driverKey = typeof payload.driver?.key === 'string' ? payload.driver.key : '';
  if (!driverKey.startsWith('cross_market')) return false;
  const side = payload.selection?.side || payload.prediction;
  return side === 'HOME' || side === 'AWAY' || side === 'OVER' || side === 'UNDER';
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
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
    driver_inputs: modelInputs
  };
  const raw = stableStringify(base);
  return nodeCrypto.createHash('sha256').update(raw).digest('hex');
}

function computeCandidateHash({ side, line, price, inputsHash, market, period, sideFamily }) {
  const raw = stableStringify({ side, line, price, inputs_hash: inputsHash, market, period, side_family: sideFamily });
  return nodeCrypto.createHash('sha256').update(raw).digest('hex');
}

function shouldFlip(current, candidate, ctx = {}) {
  const config = { ...DEFAULTS, ...(ctx || {}) };

  if (!current) {
    return {
      allow: true,
      reason_code: 'INIT',
      reason_detail: 'First published decision for this market',
      edge_delta: candidate.edge ?? 0
    };
  }

  if (current.locked_status === 'HARD') {
    if (ctx.criticalOverride) {
      return {
        allow: true,
        reason_code: 'CRITICAL_OVERRIDE',
        reason_detail: 'Hard lock overridden by critical event',
        edge_delta: (candidate.edge ?? 0) - (current.edge ?? 0)
      };
    }
    return {
      allow: false,
      reason_code: 'HARD_LOCKED',
      reason_detail: 'Hard lock active; decision held',
      edge_delta: 0
    };
  }

  if ((ctx.candidateSeenCount ?? 0) < config.REQUIRE_STABILITY_RUNS) {
    return {
      allow: false,
      reason_code: 'NOT_STABLE',
      reason_detail: `Candidate seen ${ctx.candidateSeenCount ?? 0} runs; need ${config.REQUIRE_STABILITY_RUNS}`,
      edge_delta: (candidate.edge ?? 0) - (current.edge ?? 0)
    };
  }

  const sideChanged = candidate.side !== current.recommended_side;
  const edgeDelta = (candidate.edge ?? 0) - (current.edge ?? 0);

  if (!sideChanged) {
    return {
      allow: true,
      reason_code: 'REFRESH_SAME_SIDE',
      reason_detail: 'Same side; refresh price/line',
      edge_delta: edgeDelta
    };
  }

  if (ctx.lineMoved && Math.abs(ctx.lineDelta || 0) >= config.LINE_MOVE_MIN && edgeDelta >= 0) {
    return {
      allow: true,
      reason_code: 'LINE_MOVE',
      reason_detail: `Line moved ${ctx.lineDelta}; edge improved/held`,
      edge_delta: edgeDelta
    };
  }

  if (edgeDelta >= config.EDGE_UPGRADE_MIN) {
    return {
      allow: true,
      reason_code: 'EDGE_UPGRADE',
      reason_detail: `Edge improved +${edgeDelta.toFixed(2)} (>= ${config.EDGE_UPGRADE_MIN})`,
      edge_delta: edgeDelta
    };
  }

  return {
    allow: false,
    reason_code: 'EDGE_TOO_SMALL',
    reason_detail: `Edge delta +${edgeDelta.toFixed(2)} < ${config.EDGE_UPGRADE_MIN}`,
    edge_delta: edgeDelta
  };
}

module.exports = {
  buildDecisionKey,
  computeCandidateHash,
  computeInputsHash,
  getSideFamily,
  isRecommendationPayload,
  normalizeMarketType,
  normalizePeriod,
  shouldFlip
};
