'use strict';

const assertStrict = require('node:assert/strict');
// eslint-disable-next-line no-redeclare
const { describe, test } = require('node:test');

/**
 * Tests for edge-calculator.js
 *
 * Run: node packages/models/src/__tests__/edge-calculator.test.js
 */

const {
  impliedProbFromAmerican,
  noVigImplied,
  computeConfidence,
  computeMoneylineEdge,
  computeSpreadEdge,
  computeTotalEdge,
} = require('../edge-calculator');

// eslint-disable-next-line no-redeclare
function expect(received) {
  return {
    toBe(expected) {
      assertStrict.strictEqual(received, expected);
    },
    toBeNull() {
      assertStrict.strictEqual(received, null);
    },
    toBeGreaterThan(expected) {
      assertStrict.ok(received > expected);
    },
    toBeLessThan(expected) {
      assertStrict.ok(received < expected);
    },
    toBeCloseTo(expected, precision = 2) {
      const tolerance = 10 ** -precision;
      assertStrict.ok(Math.abs(received - expected) <= tolerance);
    },
    not: {
      toBeNull() {
        assertStrict.notStrictEqual(received, null);
      },
    },
  };
}

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function approx(a, b, tol = 0.0001) {
  return Math.abs(a - b) <= tol;
}

// ── noVigImplied ─────────────────────────────────────────────────────────────

console.log('\n=== noVigImplied ===');

assert(
  'noVigImplied is exported',
  typeof noVigImplied === 'function',
  'expected function'
);

const even = noVigImplied(-110, -110);
assert(
  'noVigImplied(-110, -110) returns object',
  even != null && typeof even === 'object',
  JSON.stringify(even)
);
assert(
  'noVigImplied(-110, -110).home ≈ 0.5',
  even && approx(even.home, 0.5),
  `got ${even && even.home}`
);
assert(
  'noVigImplied(-110, -110).away ≈ 0.5',
  even && approx(even.away, 0.5),
  `got ${even && even.away}`
);

// At -150/+130:
// p_home_raw = 150/(150+100) = 0.6
// p_away_raw = 100/(130+100) = 100/230 ≈ 0.43478
// total = 0.6 + 0.43478 = 1.03478
// home_nv = 0.6 / 1.03478 ≈ 0.57980
// away_nv = 0.43478 / 1.03478 ≈ 0.42020
const asymm = noVigImplied(-150, 130);
assert(
  'noVigImplied(-150, +130) returns object',
  asymm != null && typeof asymm === 'object',
  JSON.stringify(asymm)
);
assert(
  'noVigImplied(-150, +130).home ≈ 0.5798',
  asymm && approx(asymm.home, 0.5798, 0.001),
  `got ${asymm && asymm.home}`
);
assert(
  'noVigImplied(-150, +130).away ≈ 0.4202',
  asymm && approx(asymm.away, 0.4202, 0.001),
  `got ${asymm && asymm.away}`
);
assert(
  'noVigImplied(-150, +130) home + away ≈ 1.0',
  asymm && approx(asymm.home + asymm.away, 1.0, 0.0001),
  `sum=${asymm && (asymm.home + asymm.away)}`
);

// Returns null when one price is invalid
const nullResult = noVigImplied(null, -110);
assert(
  'noVigImplied(null, -110) returns null',
  nullResult === null,
  `got ${nullResult}`
);

// ── computeSpreadEdge with noVig ──────────────────────────────────────────────

console.log('\n=== computeSpreadEdge vig removal ===');

// With both prices present, p_implied should use no-vig probability (~0.5 for -110/-110)
// rather than raw implied (~0.524)
const spreadBoth = computeSpreadEdge({
  projectionMarginHome: 7, // favors home cover
  spreadLine: -6.5,
  spreadPriceHome: -110,
  spreadPriceAway: -110,
  sigmaMargin: 12,
  isPredictionHome: true,
});
assert(
  'computeSpreadEdge with both prices returns edge',
  spreadBoth && typeof spreadBoth.edge === 'number',
  JSON.stringify(spreadBoth)
);
// With vig removal, p_implied for -110 should be 0.5 not 0.524
// So edge should be higher than with raw implied
const spreadOneSide = computeSpreadEdge({
  projectionMarginHome: 7,
  spreadLine: -6.5,
  spreadPriceHome: -110,
  spreadPriceAway: undefined,
  sigmaMargin: 12,
  isPredictionHome: true,
});
assert(
  'computeSpreadEdge with only one price returns VIG_REMOVAL_SKIPPED:true',
  spreadOneSide && spreadOneSide.VIG_REMOVAL_SKIPPED === true,
  JSON.stringify(spreadOneSide)
);
assert(
  'computeSpreadEdge with both prices has higher edge than one-side (vig removed)',
  spreadBoth && spreadOneSide && spreadBoth.edge > spreadOneSide.edge,
  `both=${spreadBoth && spreadBoth.edge}, oneSide=${spreadOneSide && spreadOneSide.edge}`
);

// ── computeMoneylineEdge with noVig ──────────────────────────────────────────

console.log('\n=== computeMoneylineEdge vig removal ===');

const mlBoth = computeMoneylineEdge({
  projectionWinProbHome: 0.6,
  americanOdds: -120,
  priceOpposite: 100,
  isPredictionHome: true,
});
assert(
  'computeMoneylineEdge with priceOpposite returns edge',
  mlBoth && typeof mlBoth.edge === 'number',
  JSON.stringify(mlBoth)
);

const mlOneSide = computeMoneylineEdge({
  projectionWinProbHome: 0.6,
  americanOdds: -120,
  isPredictionHome: true,
});
assert(
  'computeMoneylineEdge without priceOpposite returns VIG_REMOVAL_SKIPPED:true',
  mlOneSide && mlOneSide.VIG_REMOVAL_SKIPPED === true,
  JSON.stringify(mlOneSide)
);

// ── computeTotalEdge with noVig ───────────────────────────────────────────────

console.log('\n=== computeTotalEdge vig removal ===');

const totalBoth = computeTotalEdge({
  projectionTotal: 240,
  totalLine: 238.5,
  totalPriceOver: -110,
  totalPriceUnder: -110,
  sigmaTotal: 14,
  isPredictionOver: true,
});
assert(
  'computeTotalEdge with both prices returns edge',
  totalBoth && typeof totalBoth.edge === 'number',
  JSON.stringify(totalBoth)
);

const totalOneSide = computeTotalEdge({
  projectionTotal: 240,
  totalLine: 238.5,
  totalPriceOver: -110,
  totalPriceUnder: undefined,
  sigmaTotal: 14,
  isPredictionOver: true,
});
assert(
  'computeTotalEdge with only one price returns VIG_REMOVAL_SKIPPED:true',
  totalOneSide && totalOneSide.VIG_REMOVAL_SKIPPED === true,
  JSON.stringify(totalOneSide)
);

// ── WI-0554: computed confidence ────────────────────────────────────────────

console.log('\n=== WI-0554: computed confidence ===');

assert(
  'computeConfidence is exported',
  typeof computeConfidence === 'function',
  'expected function'
);

const baseConfidence = computeConfidence({ baseConfidence: 0.88 });
assert(
  'computeConfidence with no penalties preserves base confidence',
  approx(baseConfidence, 0.88),
  `got ${baseConfidence}`
);

const degradedConfidence = computeConfidence({
  baseConfidence: 0.88,
  watchdogStatus: 'CAUTION',
  missingFieldCount: 2,
  proxyUsed: true,
  conflictScore: 0.4,
});
assert(
  'computeConfidence applies CAUTION, proxy, missing-field, and conflict penalties',
  approx(degradedConfidence, 0.43),
  `got ${degradedConfidence}`
);

const flooredConfidence = computeConfidence({
  baseConfidence: 0.35,
  watchdogStatus: 'CAUTION',
  missingFieldCount: 10,
  proxyUsed: true,
  conflictScore: 0.8,
});
assert(
  'computeConfidence floors at 0.30',
  approx(flooredConfidence, 0.3),
  `got ${flooredConfidence}`
);

assert(
  'computeMoneylineEdge without confidenceContext preserves 0.95 base confidence',
  mlBoth && approx(mlBoth.confidence, 0.95),
  JSON.stringify(mlBoth)
);

assert(
  'computeSpreadEdge without confidenceContext preserves 0.85 base confidence',
  spreadBoth && approx(spreadBoth.confidence, 0.85),
  JSON.stringify(spreadBoth)
);

assert(
  'computeTotalEdge without confidenceContext preserves 0.88 base confidence',
  totalBoth && approx(totalBoth.confidence, 0.88),
  JSON.stringify(totalBoth)
);

const totalDegraded = computeTotalEdge({
  projectionTotal: 240,
  totalLine: 238.5,
  totalPriceOver: -110,
  totalPriceUnder: -110,
  sigmaTotal: 14,
  isPredictionOver: true,
  confidenceContext: {
    watchdogStatus: 'CAUTION',
    missingFieldCount: 2,
    proxyUsed: true,
    conflictScore: 0.4,
  },
});
assert(
  'computeTotalEdge lowers confidence for degraded inputs',
  totalDegraded &&
    totalBoth &&
    totalDegraded.confidence < totalBoth.confidence &&
    approx(totalDegraded.confidence, 0.43),
  JSON.stringify(totalDegraded)
);

// ── WI-0555: NBA spread gate via resolveThresholdProfile ─────────────────────

console.log('\n=== WI-0555: generateNBAMarketCallCards spread gate ===');

// We test the gating logic in isolation — a spread decision at edge=0.025 (below
// NBA:SPREAD lean_edge_min=0.035) must NOT produce a call card when the canonical
// resolveThresholdProfile is used as the gate, and MUST produce one at edge=0.04.
const {
  generateNBAMarketCallCards,
} = require('../../../../apps/worker/src/jobs/run_nba_model');

function makeSpreadDecision(edge) {
  return {
    SPREAD: {
      status: 'FIRE',
      edge,
      reasoning: 'test reasoning',
      best_candidate: { side: 'HOME', line: -6.5 },
      drivers: [{ eligible: true, driverKey: 'rest-advantage', weight: 1, signal: 0.6 }],
    },
  };
}

const oddsSnap = {
  home_team: 'Lakers',
  away_team: 'Celtics',
  game_time_utc: new Date(Date.now() + 3600 * 1000).toISOString(),
  total: 238.5,
  total_price_over: -110,
  total_price_under: -110,
  spread_price_home: -110,
  spread_price_away: -110,
};

const cardsBelowGate = generateNBAMarketCallCards('game-001', makeSpreadDecision(0.025), oddsSnap);
const spreadCardsBelowGate = cardsBelowGate.filter((c) => c && c.cardType === 'nba-spread-call');
assert(
  'No spread call card generated for edge=0.025 (below lean_edge_min=0.035)',
  spreadCardsBelowGate.length === 0,
  `got ${spreadCardsBelowGate.length} card(s) — edge gate must use 0.035, not 0.02`
);

const cardsAboveGate = generateNBAMarketCallCards('game-002', makeSpreadDecision(0.04), oddsSnap);
const spreadCardsAboveGate = cardsAboveGate.filter((c) => c && c.cardType === 'nba-spread-call');
assert(
  'Spread call card IS generated for edge=0.04 (above lean_edge_min=0.035)',
  spreadCardsAboveGate.length === 1,
  `got ${spreadCardsAboveGate.length} card(s)`
);

function makeTotalDecision(edge, conflict = 0) {
  return {
    TOTAL: {
      status: 'FIRE',
      edge,
      conflict,
      reasoning: 'total test reasoning',
      best_candidate: { side: 'OVER', line: 238.5 },
      projection: { projected_total: 240.5 },
      drivers: [{ eligible: true, driverKey: 'totalProjection', weight: 1, signal: 0.7 }],
    },
  };
}

const totalCardsLowEdge = generateNBAMarketCallCards(
  'game-003',
  makeTotalDecision(0.02),
  oddsSnap,
);
const totalCardsHighEdge = generateNBAMarketCallCards(
  'game-004',
  makeTotalDecision(0.12),
  oddsSnap,
);
const totalCardsNoOdds = generateNBAMarketCallCards(
  'game-005',
  makeTotalDecision(0.12),
  oddsSnap,
  { withoutOddsMode: true },
);

const totalLowConfidence =
  totalCardsLowEdge.find((card) => card.cardType === 'nba-totals-call')?.payloadData
    ?.confidence;
const totalHighConfidence =
  totalCardsHighEdge.find((card) => card.cardType === 'nba-totals-call')?.payloadData
    ?.confidence;
const totalNoOddsConfidence =
  totalCardsNoOdds.find((card) => card.cardType === 'nba-totals-call')?.payloadData
    ?.confidence;

assert(
  'NBA totals call-card confidence increases with larger edge_pct',
  typeof totalLowConfidence === 'number' &&
    typeof totalHighConfidence === 'number' &&
    totalHighConfidence > totalLowConfidence,
  `low=${totalLowConfidence}, high=${totalHighConfidence}`
);

assert(
  'NBA totals call-card confidence never exceeds 0.90',
  typeof totalHighConfidence === 'number' && totalHighConfidence <= 0.9,
  `got ${totalHighConfidence}`
);

assert(
  'NBA totals no-odds mode keeps the 0.52 bounded low-confidence fallback',
  approx(totalNoOddsConfidence, 0.52),
  `got ${totalNoOddsConfidence}`
);

// ── WI-0552: computeSigmaFromHistory ─────────────────────────────────────────

console.log('\n=== WI-0552: computeSigmaFromHistory ===');

const {
  computeSigmaFromHistory,
  getSigmaDefaults,
} = require('../edge-calculator');

assert(
  'computeSigmaFromHistory is exported',
  typeof computeSigmaFromHistory === 'function',
  'expected function'
);

assert(
  'getSigmaDefaults is exported',
  typeof getSigmaDefaults === 'function',
  'expected function'
);

// Helper to build a mock db with prepare().all() returning canned rows
function makeMockDb(rows) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  };
}

// Test: empty db → fallback
const sigmaEmpty = computeSigmaFromHistory({ sport: 'NBA', db: makeMockDb([]) });
assert(
  'computeSigmaFromHistory with 0 games returns sigma_source: fallback',
  sigmaEmpty && sigmaEmpty.sigma_source === 'fallback',
  JSON.stringify(sigmaEmpty)
);
assert(
  'computeSigmaFromHistory with 0 games returns NBA margin default',
  sigmaEmpty && sigmaEmpty.margin === 12,
  `got margin=${sigmaEmpty && sigmaEmpty.margin}`
);
assert(
  'computeSigmaFromHistory with 0 games returns NBA total default',
  sigmaEmpty && sigmaEmpty.total === 14,
  `got total=${sigmaEmpty && sigmaEmpty.total}`
);

// Test: 15 games → below threshold → fallback
function makeRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    final_score_home: 110 + (i % 5),
    final_score_away: 100 + (i % 7),
  }));
}
const sigma15 = computeSigmaFromHistory({ sport: 'NBA', db: makeMockDb(makeRows(15)) });
assert(
  'computeSigmaFromHistory with 15 games returns sigma_source: fallback',
  sigma15 && sigma15.sigma_source === 'fallback',
  JSON.stringify(sigma15)
);

// Test: 25 games with known deltas → computed
// Build 25 rows with realistic NBA-style scores so std-dev lands in plausible range
const nbaRows = Array.from({ length: 25 }, (_, i) => ({
  final_score_home: 108 + (i % 12) - 6, // varies ±6
  final_score_away: 105 + (i % 10) - 5, // varies ±5
}));
const sigma25 = computeSigmaFromHistory({ sport: 'NBA', db: makeMockDb(nbaRows) });
assert(
  'computeSigmaFromHistory with 25 games returns sigma_source: computed',
  sigma25 && sigma25.sigma_source === 'computed',
  JSON.stringify(sigma25)
);
assert(
  'computeSigmaFromHistory with 25 games returns games_sampled',
  sigma25 && typeof sigma25.games_sampled === 'number' && sigma25.games_sampled === 25,
  `got games_sampled=${sigma25 && sigma25.games_sampled}`
);
assert(
  'computeSigmaFromHistory with 25 NBA games: margin in plausible range [1, 20]',
  sigma25 && sigma25.margin >= 1 && sigma25.margin <= 20,
  `got margin=${sigma25 && sigma25.margin}`
);
assert(
  'computeSigmaFromHistory with 25 NBA games: total in plausible range [1, 25]',
  sigma25 && sigma25.total >= 1 && sigma25.total <= 25,
  `got total=${sigma25 && sigma25.total}`
);

// Test: accepts windowGames param
const sigmaWindow = computeSigmaFromHistory({ sport: 'NBA', db: makeMockDb(makeRows(25)), windowGames: 60 });
assert(
  'computeSigmaFromHistory accepts windowGames param without error',
  sigmaWindow && sigmaWindow.sigma_source !== undefined,
  JSON.stringify(sigmaWindow)
);

// Test: DB error → fallback
const errorDb = {
  prepare: () => { throw new Error('DB unavailable'); },
};
const sigmaErr = computeSigmaFromHistory({ sport: 'NBA', db: errorDb });
assert(
  'computeSigmaFromHistory returns fallback on DB error',
  sigmaErr && sigmaErr.sigma_source === 'fallback',
  JSON.stringify(sigmaErr)
);

// Test: getSigmaDefaults JSDoc annotated (we check the function still works correctly)
const defaults = getSigmaDefaults('NBA');
assert(
  'getSigmaDefaults(NBA) still returns { margin: 12, total: 14 }',
  defaults && defaults.margin === 12 && defaults.total === 14,
  JSON.stringify(defaults)
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}

// ── AUDIT-FIX-01: NHL half-integer continuity correction (Jest test block) ────

const { shouldFlip } = require('../decision-gate');

describe('AUDIT-FIX-01: computeTotalEdge NHL half-integer continuity correction', () => {
  test('half-integer NHL total (5.5, sigmaTotal=1.8) — adjustedLine must NOT add +0.5', () => {
    // With old bug: adjustedLine = 5.5 + 0.5 = 6.0
    // With fix: adjustedLine = 5.5 (half-integer, no correction)
    // p_over_old = 1 - normCdf((6.0 - 5.8) / 1.8) = 1 - normCdf(0.111) ≈ 0.4558
    // p_over_fix = 1 - normCdf((5.5 - 5.8) / 1.8) = 1 - normCdf(-0.167) ≈ 0.5663
    // So p_fair (isPredictionOver=true) with fix is significantly higher than with bug
    const result = computeTotalEdge({
      projectionTotal: 5.8,
      totalLine: 5.5,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      sigmaTotal: 1.8,
      isPredictionOver: true,
    });
    // With fix: p_fair ≈ 0.5663 (unadjusted 5.5 line)
    // With bug: p_fair ≈ 0.4558 (adjusted to 6.0)
    // The fix should produce p_fair > 0.5 (above break-even) for a 5.8 projection vs 5.5 line
    expect(result).not.toBeNull();
    expect(result.p_fair).toBeGreaterThan(0.5);
  });

  test('integer NHL total (6, sigmaTotal=1.8) — adjustedLine must be 6.5 (old behaviour preserved)', () => {
    // With integer line: adjustedLine = 6 + 0.5 = 6.5 (continuity correction applied)
    // p_over = 1 - normCdf((6.5 - 6.2) / 1.8) = 1 - normCdf(0.167) ≈ 0.4338
    const result = computeTotalEdge({
      projectionTotal: 6.2,
      totalLine: 6,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      sigmaTotal: 1.8,
      isPredictionOver: true,
    });
    // With integer line, correction applied: adjustedLine = 6.5
    // p_over for projection 6.2 vs adjusted 6.5 should be < 0.5 (projection < adjusted line)
    expect(result).not.toBeNull();
    expect(result.p_fair).toBeLessThan(0.5);
  });
});

// ── AUDIT-FIX-04: decision-gate null-safe edgeDelta (Jest test block) ─────────

describe('AUDIT-FIX-04: shouldFlip null-safe edgeDelta', () => {
  const currentRecord = {
    recommended_side: 'OVER',
    edge: 0.02,
    edge_available: true,
    locked_status: null,
  };

  test('candidate.edge=null + edge_available=true — edgeDelta must be null, not EDGE_UPGRADE', () => {
    const result = shouldFlip(
      currentRecord,
      { side: 'OVER', edge: null, edge_available: true },
      { candidateSeenCount: 3 },
    );
    expect(result.edge_delta).toBeNull();
  });

  test('candidate.edge=0.04 + current.edge=0.01 — edgeDelta must be 0.03', () => {
    const result = shouldFlip(
      { ...currentRecord, edge: 0.01 },
      { side: 'OVER', edge: 0.04, edge_available: true },
      { candidateSeenCount: 3 },
    );
    expect(result.edge_delta).toBeCloseTo(0.03, 5);
  });
});

// ── WI-0591: buildDecisionV2 consumes sigmaOverride from context ───────────

describe('WI-0591: buildDecisionV2 sigma override', () => {
  const { buildDecisionV2 } = require('../decision-pipeline-v2');

  const basePayload = {
    sport: 'NBA',
    kind: 'PLAY',
    market_type: 'SPREAD',
    recommended_bet_type: 'spread',
    prediction: 'HOME',
    selection: { side: 'HOME', team: 'Home Team' },
    line: -3.5,
    price: -110,
    confidence: 0.74,
    tier: 'T1',
    model_version: 'nba-cross-market-v1',
    game_id: 'test-game',
    home_team: 'Home Team',
    away_team: 'Away Team',
    start_time_utc: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    projection: { margin_home: 9.8, total: null, win_prob_home: null },
    odds_context: {
      spread_home: -3.5,
      spread_away: 3.5,
      spread_price_home: -110,
      spread_price_away: -110,
      total: 224,
      captured_at: new Date().toISOString(),
    },
    consistency: { total_bias: 'OK', pace_tier: 'MID', event_env: 'INDOOR', event_direction_tag: 'FAVOR_HOME', vol_env: 'STABLE' },
    reasoning: 'test',
    driver: { key: 'powerRating', inputs: {} },
    drivers_active: ['powerRating'],
    reason_codes: [],
    tags: [],
  };

  test('without sigmaOverride uses getSigmaDefaults (fallback)', () => {
    const result = buildDecisionV2(basePayload, {});
    expect(result).not.toBeNull();
    expect(result.sigma_source).toBe('fallback');
  });

  test('with computed sigmaOverride returns sigma_source=computed', () => {
    const result = buildDecisionV2(basePayload, {
      sigmaOverride: { margin: 10.5, total: 13.2, sigma_source: 'computed', games_sampled: 60 },
    });
    expect(result).not.toBeNull();
    expect(result.sigma_source).toBe('computed');
  });

  test('tighter sigma produces larger edge_pct than wider sigma for same projection delta', () => {
    const wideResult = buildDecisionV2(basePayload, {
      sigmaOverride: { margin: 20, total: 25, sigma_source: 'computed', games_sampled: 60 },
    });
    const tightResult = buildDecisionV2(basePayload, {
      sigmaOverride: { margin: 6, total: 8, sigma_source: 'computed', games_sampled: 60 },
    });
    expect(wideResult).not.toBeNull();
    expect(tightResult).not.toBeNull();
    // Tighter sigma → higher p_fair for same projection advantage → larger edge_pct
    expect(tightResult.edge_pct).toBeGreaterThan(wideResult.edge_pct);
  });

  test('sigmaOverride with null margin falls back to getSigmaDefaults', () => {
    const result = buildDecisionV2(basePayload, {
      sigmaOverride: { margin: null, total: null, sigma_source: 'fallback' },
    });
    expect(result).not.toBeNull();
    expect(result.sigma_source).toBe('fallback');
  });

  test('NCAAM payload with sigmaOverride forwards sigma_source=computed', () => {
    const ncaamPayload = { ...basePayload, sport: 'NCAAM' };
    const result = buildDecisionV2(ncaamPayload, {
      sigmaOverride: { margin: 9.1, total: 12.4, sigma_source: 'computed', games_sampled: 45 },
    });
    expect(result).not.toBeNull();
    expect(result.sigma_source).toBe('computed');
  });
});
