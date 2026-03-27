'use strict';

const { FLAGS } = require('./flags');

const DEFAULT_EDGE_THRESHOLDS = Object.freeze({
  play_edge_min: 0.06,
  lean_edge_min: 0.03,
});
const DEFAULT_PLAY_CLEANLINESS_PROFILE = Object.freeze({
  enabled: false,
  require_watchdog_ok: false,
  play_conflict_max: null,
});
const TARGETED_PLAY_CLEANLINESS_PROFILE = Object.freeze({
  enabled: true,
  require_watchdog_ok: true,
  play_conflict_max: 0.3,
});
const PLAY_CLEANLINESS_SPORTS = new Set(['NBA', 'NHL']);
const PLAY_CLEANLINESS_MARKETS = new Set([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
]);

function defaultSupportThresholds(marketType) {
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    return { play: 0.65, lean: 0.5 };
  }
  if (
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
  ) {
    return { play: 0.55, lean: 0.45 };
  }
  return { play: 0.6, lean: 0.45 };
}

const SPORT_MARKET_THRESHOLDS_V2 = Object.freeze({
  'NBA:SPREAD': Object.freeze({
    support: Object.freeze({ play: 0.68, lean: 0.56 }),
    edge: Object.freeze({ play_edge_min: 0.07, lean_edge_min: 0.035 }),
  }),
  'NBA:TOTAL': Object.freeze({
    support: Object.freeze({ play: 0.58, lean: 0.47 }),
    edge: Object.freeze({ play_edge_min: 0.062, lean_edge_min: 0.031 }),
  }),
  'NBA:MONEYLINE': Object.freeze({
    support: Object.freeze({ play: 0.62, lean: 0.49 }),
    edge: Object.freeze({ play_edge_min: 0.06, lean_edge_min: 0.03 }),
  }),
  'NHL:TOTAL': Object.freeze({
    support: Object.freeze({ play: 0.52, lean: 0.42 }),
    edge: Object.freeze({ play_edge_min: 0.05, lean_edge_min: 0.025 }),
  }),
  'NHL:FIRST_PERIOD': Object.freeze({
    support: Object.freeze({ play: 0.52, lean: 0.42 }),
    edge: Object.freeze({ play_edge_min: 0.05, lean_edge_min: 0.025 }),
  }),
  'NHL:MONEYLINE': Object.freeze({
    support: Object.freeze({ play: 0.57, lean: 0.45 }),
    edge: Object.freeze({ play_edge_min: 0.058, lean_edge_min: 0.029 }),
  }),
  'NCAAM:SPREAD': Object.freeze({
    support: Object.freeze({ play: 0.58, lean: 0.45 }),
    edge: Object.freeze({ play_edge_min: 0.055, lean_edge_min: 0.028 }),
  }),
  'NCAAM:TOTAL': Object.freeze({
    support: Object.freeze({ play: 0.56, lean: 0.44 }),
    edge: Object.freeze({ play_edge_min: 0.054, lean_edge_min: 0.027 }),
  }),
  'NCAAM:MONEYLINE': Object.freeze({
    support: Object.freeze({ play: 0.57, lean: 0.45 }),
    edge: Object.freeze({ play_edge_min: 0.055, lean_edge_min: 0.028 }),
  }),
});

function resolveThresholdProfile({ sport, marketType }) {
  const normalizedSport = typeof sport === 'string' ? sport.toUpperCase() : '';
  const normalizedMarket =
    typeof marketType === 'string' ? marketType.toUpperCase() : '';

  const support = defaultSupportThresholds(normalizedMarket);
  const edge = {
    play_edge_min: DEFAULT_EDGE_THRESHOLDS.play_edge_min,
    lean_edge_min: DEFAULT_EDGE_THRESHOLDS.lean_edge_min,
  };

  const profile = {
    sport: normalizedSport || null,
    market_type: normalizedMarket || null,
    source: 'default',
    support,
    edge,
  };

  if (!FLAGS.ENABLE_MARKET_THRESHOLDS_V2) {
    return profile;
  }

  const key = `${normalizedSport}:${normalizedMarket}`;
  const mapped = SPORT_MARKET_THRESHOLDS_V2[key];
  if (!mapped) {
    return profile;
  }

  return {
    ...profile,
    source: 'sport_market_v2',
    support: { ...support, ...mapped.support },
    edge: { ...edge, ...mapped.edge },
  };
}

function resolvePlayCleanlinessProfile({ sport, marketType }) {
  const normalizedSport = typeof sport === 'string' ? sport.toUpperCase() : '';
  const normalizedMarket =
    typeof marketType === 'string' ? marketType.toUpperCase() : '';

  if (
    PLAY_CLEANLINESS_SPORTS.has(normalizedSport) &&
    PLAY_CLEANLINESS_MARKETS.has(normalizedMarket)
  ) {
    return TARGETED_PLAY_CLEANLINESS_PROFILE;
  }

  return DEFAULT_PLAY_CLEANLINESS_PROFILE;
}

// WI-0588: NBA totals quarantine — demote actionable tiers one level.
const QUARANTINE_REASON = 'NBA_TOTAL_QUARANTINE_DEMOTE';

function applyNbaTotalQuarantine({ sport, marketType, officialStatus, priceReasonCodes }) {
  if (!FLAGS.QUARANTINE_NBA_TOTAL) return { officialStatus, priceReasonCodes };
  const s = typeof sport === 'string' ? sport.toUpperCase() : '';
  const m = typeof marketType === 'string' ? marketType.toUpperCase() : '';
  if (s !== 'NBA' || m !== 'TOTAL') return { officialStatus, priceReasonCodes };
  if (officialStatus === 'PASS') return { officialStatus, priceReasonCodes };

  const demoted = officialStatus === 'PLAY' ? 'LEAN' : 'PASS';
  const codes = Array.isArray(priceReasonCodes) ? [...priceReasonCodes] : [];
  if (!codes.includes(QUARANTINE_REASON)) codes.push(QUARANTINE_REASON);
  return { officialStatus: demoted, priceReasonCodes: codes };
}

module.exports = {
  DEFAULT_EDGE_THRESHOLDS,
  SPORT_MARKET_THRESHOLDS_V2,
  defaultSupportThresholds,
  resolveThresholdProfile,
  resolvePlayCleanlinessProfile,
  applyNbaTotalQuarantine,
};
