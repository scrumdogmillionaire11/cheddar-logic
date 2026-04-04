/**
 * Unit tests for deriveMarketSignals()
 *
 * All inputs/outputs are pure — no network, no DB.
 * Covers the canonical cases from WI-0775 + WI-0667 acceptance criteria.
 *
 * Run: node --import tsx/esm src/__tests__/market-signals.test.js
 */

import assert from 'node:assert';
import { deriveMarketSignals } from '../lib/game-card/market-signals.ts';

// ---------------------------------------------------------------------------
// Helper: build a minimal GameCard stub
// ---------------------------------------------------------------------------
function makeCard({
  splitsSource = 'actionnetwork',
  publicBetsPctHome = null,
  publicBetsPctAway = null,
  publicHandlePctHome = null,
  publicHandlePctAway = null,
  spreadConsensusConfidence = null,
  officialStatus = 'PLAY',
  direction = 'HOME',
  tags = [],
  primaryReasonCode = null,
} = {}) {
  return {
    id: 'test-card',
    gameId: 'test-game',
    sport: 'NHL',
    homeTeam: 'Home',
    awayTeam: 'Away',
    startTime: '2026-04-03T00:00:00Z',
    updatedAt: '2026-04-03T00:00:00Z',
    status: 'scheduled',
    markets: {},
    drivers: [],
    tags: [],
    play: {
      status: officialStatus === 'PLAY' ? 'FIRE' : officialStatus === 'LEAN' ? 'WATCH' : 'PASS',
      market: 'TOTAL',
      pick: '',
      lean: '',
      side: direction,
      truthStatus: 'STRONG',
      truthStrength: 0.7,
      conflict: 0,
      valueStatus: 'OK',
      betAction: 'BET',
      priceFlags: [],
      updatedAt: '2026-04-03T00:00:00Z',
      whyCode: primaryReasonCode ?? 'EDGE_FOUND',
      whyText: '',
      pass_reason_code: null,
      tags,
      decision_v2: primaryReasonCode
        ? {
            official_status: officialStatus,
            primary_reason_code: primaryReasonCode,
            direction,
            pipeline_version: 'v2',
            decided_at: '2026-04-03T00:00:00Z',
          }
        : null,
    },
    marketSignals: {
      publicBetsPctHome,
      publicBetsPctAway,
      publicHandlePctHome,
      publicHandlePctAway,
      splitsSource,
      spreadConsensusConfidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (err) { console.error(`  ✗  ${name}\n       ${err.message}`); fail++; }
}

// 1. No splits data → no pills
test('returns [] when splitsSource is null', () => {
  assert.deepStrictEqual(deriveMarketSignals(makeCard({ splitsSource: null })), []);
});

test('returns [] when marketSignals is absent', () => {
  const card = { ...makeCard(), marketSignals: undefined };
  assert.deepStrictEqual(deriveMarketSignals(card), []);
});

// 2. PASS_SHARP_MONEY_OPPOSITE → Sharp Divergence (blue)
test('emits Sharp Divergence for PASS_SHARP_MONEY_OPPOSITE reason code', () => {
  const pills = deriveMarketSignals(makeCard({ primaryReasonCode: 'PASS_SHARP_MONEY_OPPOSITE', officialStatus: 'LEAN', publicBetsPctHome: 74 }));
  assert.ok(pills.some((p) => p.label === 'Sharp Divergence' && p.color === 'blue'), JSON.stringify(pills));
});

// 3. FADE_PUBLIC_POSITIVE tag → Sharp Divergence
test('emits Sharp Divergence for FADE_PUBLIC_POSITIVE tag', () => {
  const pills = deriveMarketSignals(makeCard({ tags: ['FADE_PUBLIC_POSITIVE'], publicBetsPctHome: 50 }));
  assert.ok(pills.some((p) => p.label === 'Sharp Divergence'), JSON.stringify(pills));
});

// 4. Low public % + FADE_PUBLIC_POSITIVE → Contrarian Edge
test('emits Contrarian Edge when FADE_PUBLIC_POSITIVE + publicBetsPct < 40', () => {
  const pills = deriveMarketSignals(makeCard({ tags: ['FADE_PUBLIC_POSITIVE'], direction: 'HOME', publicBetsPctHome: 28 }));
  assert.ok(pills.some((p) => p.label === 'Contrarian Edge' && p.color === 'green'), JSON.stringify(pills));
});

// 5. Public Heavy (amber)
test('emits Public Heavy (amber) when publicBetsPct > 65', () => {
  const pills = deriveMarketSignals(makeCard({ direction: 'HOME', publicBetsPctHome: 74 }));
  const pill = pills.find((p) => p.label === 'Public Heavy (74%)');
  assert.ok(pill && pill.color === 'amber', JSON.stringify(pills));
});

test('no Public Heavy pill at exactly 65%', () => {
  const pills = deriveMarketSignals(makeCard({ direction: 'HOME', publicBetsPctHome: 65 }));
  assert.ok(!pills.some((p) => p.label.startsWith('Public Heavy')), JSON.stringify(pills));
});

// 6. Consensus (slate)
test('emits Consensus when spreadConsensusConfidence=HIGH and no divergence', () => {
  const pills = deriveMarketSignals(makeCard({ spreadConsensusConfidence: 'HIGH', publicBetsPctHome: 50 }));
  assert.ok(pills.some((p) => p.label === 'Consensus' && p.color === 'slate'), JSON.stringify(pills));
});

test('Consensus suppressed when Sharp Divergence present', () => {
  const pills = deriveMarketSignals(makeCard({ spreadConsensusConfidence: 'HIGH', primaryReasonCode: 'PASS_SHARP_MONEY_OPPOSITE' }));
  assert.ok(!pills.some((p) => p.label === 'Consensus'), JSON.stringify(pills));
});

// 7. AWAY direction uses publicBetsPctAway
test('uses publicBetsPctAway when direction is AWAY', () => {
  const pills = deriveMarketSignals(makeCard({ direction: 'AWAY', publicBetsPctAway: 72, publicBetsPctHome: 28 }));
  assert.ok(pills.some((p) => p.label === 'Public Heavy (72%)'), JSON.stringify(pills));
  assert.ok(!pills.some((p) => p.label === 'Public Heavy (28%)'), JSON.stringify(pills));
});

const total = pass + fail;
console.log(`\n${pass}/${total} tests passed`);
if (fail > 0) process.exit(1);
