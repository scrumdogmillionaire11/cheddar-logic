'use strict';

/**
 * Tests for edge-calculator.js
 *
 * Run: node packages/models/src/__tests__/edge-calculator.test.js
 */

const {
  impliedProbFromAmerican,
  noVigImplied,
  computeMoneylineEdge,
  computeSpreadEdge,
  computeTotalEdge,
} = require('../edge-calculator');

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
