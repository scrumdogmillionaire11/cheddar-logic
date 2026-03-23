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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
