'use strict';

const assertStrict = require('node:assert/strict');

const {
  scanForMispricing,
  scanLineDiscrepancies,
  scanOddsDiscrepancies,
} = require('../mispricing-scanner');

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
    return;
  }

  console.error(`  FAIL: ${label}${detail ? ' -- ' + detail : ''}`);
  failed++;
}

function approx(received, expected, tolerance = 0.0005) {
  return Math.abs(received - expected) <= tolerance;
}

function recentIso(offsetMs = 60000) {
  return new Date(Date.now() - offsetMs).toISOString();
}

function makeSnapshot({
  gameId = 'game-001',
  sport = 'NBA',
  homeTeam = 'Boston Celtics',
  awayTeam = 'New York Knicks',
  commenceTime = '2026-04-10T23:00:00Z',
  capturedAt = recentIso(),
  spreads = [],
  totals = [],
  h2h = [],
  rawData = null,
} = {}) {
  return {
    game_id: gameId,
    sport,
    captured_at: capturedAt,
    raw_data: rawData || JSON.stringify({
      homeTeam,
      awayTeam,
      commenceTime,
      markets: { spreads, totals, h2h },
    }),
  };
}

function assertNoForbiddenOutputTerms(label, rows) {
  const forbidden = ['bet', 'play', 'recommend'];
  const fields = ['market', 'direction', 'side', 'tier', 'market_type', 'selection', 'edge_type', 'threshold_class'];

  let clean = true;
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field];
      if (typeof value !== 'string') continue;
      if (forbidden.some(word => value.toLowerCase().includes(word))) clean = false;
    }

    for (const code of row.reason_codes || []) {
      if (forbidden.some(word => String(code).toLowerCase().includes(word))) clean = false;
    }
  }

  assert(label, clean, `rows=${JSON.stringify(rows)}`);
}

console.log('\n=== Export surface ===');

assert('scanForMispricing export is a function', typeof scanForMispricing === 'function');
assert('scanLineDiscrepancies export is a function', typeof scanLineDiscrepancies === 'function');
assert('scanOddsDiscrepancies export is a function', typeof scanOddsDiscrepancies === 'function');

console.log('\n=== Legacy scanForMispricing compatibility ===');

{
  const result = scanForMispricing([]);
  assert('scanForMispricing([]) returns []', Array.isArray(result) && result.length === 0, `result=${JSON.stringify(result)}`);
}

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'Caesars', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  const candidates = scanForMispricing([snapshot]);
  const homeCandidate = candidates.find(candidate =>
    candidate.market_type === 'SPREAD' &&
    candidate.selection === 'HOME' &&
    candidate.source_book === 'DraftKings'
  );

  assert('Legacy spread candidate still emitted', Boolean(homeCandidate), `candidates=${JSON.stringify(candidates)}`);
  assert('Legacy spread line gap tiers still work', homeCandidate?.threshold_class === 'TRIGGER', `candidate=${JSON.stringify(homeCandidate)}`);
  assert('Legacy spread edge_type stays LINE', homeCandidate?.edge_type === 'LINE', `candidate=${JSON.stringify(homeCandidate)}`);
}

{
  const snapshot = makeSnapshot({
    totals: [
      { book: 'DraftKings', line: 221.5, over: -110, under: -110 },
      { book: 'FanDuel', line: 220.5, over: -110, under: -110 },
      { book: 'BetMGM', line: 220.5, over: -110, under: -110 },
      { book: 'Caesars', line: 220.5, over: -110, under: -110 },
    ],
  });

  const candidates = scanForMispricing([snapshot]);
  const totalCandidate = candidates.find(candidate =>
    candidate.market_type === 'TOTAL' &&
    candidate.source_book === 'DraftKings'
  );

  assert('Legacy total candidate still emitted', Boolean(totalCandidate), `candidates=${JSON.stringify(candidates)}`);
  assert('Legacy total delta still maps to TRIGGER', totalCandidate?.threshold_class === 'TRIGGER', `candidate=${JSON.stringify(totalCandidate)}`);
}

{
  const snapshot = makeSnapshot({
    h2h: [
      { book: 'DraftKings', home: -105, away: 100 },
      { book: 'FanDuel', home: -115, away: 100 },
      { book: 'BetMGM', home: -115, away: 100 },
    ],
  });

  const candidates = scanForMispricing([snapshot]);
  const mlCandidate = candidates.find(candidate =>
    candidate.market_type === 'ML' &&
    candidate.selection === 'HOME' &&
    candidate.source_book === 'DraftKings'
  );

  assert('Legacy ML price candidate still emitted after threshold recalibration', Boolean(mlCandidate), `candidates=${JSON.stringify(candidates)}`);
  assert('Legacy ML price candidate is now TRIGGER for -105 vs -115', mlCandidate?.threshold_class === 'TRIGGER', `candidate=${JSON.stringify(mlCandidate)}`);
  assert('Legacy ML implied edge pct is near 2.27%', approx(mlCandidate?.implied_edge_pct || 0, 0.022689), `candidate=${JSON.stringify(mlCandidate)}`);
}

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  const candidates = scanForMispricing([snapshot]);
  assert('Legacy line scan still rejects 2-book spread market at default minBooks=3', candidates.length === 0, `candidates=${JSON.stringify(candidates)}`);
}

{
  const staleSnapshot = makeSnapshot({
    capturedAt: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  const candidates = scanForMispricing([staleSnapshot]);
  assert('Legacy scanner still excludes stale snapshots', candidates.length === 0, `candidates=${JSON.stringify(candidates)}`);
}

{
  const malformed = makeSnapshot({ rawData: '{not valid json}' });

  let threw = false;
  let candidates = [];
  try {
    candidates = scanForMispricing([malformed]);
  } catch (error) {
    threw = true;
  }

  assert('Legacy scanner skips malformed raw_data without throwing', !threw);
  assert('Legacy scanner returns [] for malformed raw_data', candidates.length === 0, `candidates=${JSON.stringify(candidates)}`);
}

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'Caesars', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  assertNoForbiddenOutputTerms('Legacy outputs avoid forbidden recommendation terms', scanForMispricing([snapshot]));
}

console.log('\n=== scanLineDiscrepancies ===');

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  const gaps = scanLineDiscrepancies([snapshot]);
  const gap = gaps[0];

  assert('3-book spread line gap emits one LineGap', gaps.length === 1, `gaps=${JSON.stringify(gaps)}`);
  assert('LineGap tier is TRIGGER at 1.5 points', gap?.tier === 'TRIGGER', `gap=${JSON.stringify(gap)}`);
  assert('LineGap delta is 1.5', approx(gap?.delta || 0, 1.5, 0.0001), `gap=${JSON.stringify(gap)}`);
  assert('LineGap outlierBook is DraftKings', gap?.outlierBook === 'DraftKings', `gap=${JSON.stringify(gap)}`);
  assert('LineGap consensusLine is -3.5', approx(gap?.consensusLine || 0, -3.5, 0.0001), `gap=${JSON.stringify(gap)}`);
  assert('LineGap direction is home for better home number', gap?.direction === 'home', `gap=${JSON.stringify(gap)}`);
  assert('LineGap carries snapshot metadata', gap?.homeTeam === 'Boston Celtics' && gap?.awayTeam === 'New York Knicks' && gap?.commenceTime === '2026-04-10T23:00:00Z', `gap=${JSON.stringify(gap)}`);
}

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  const gaps = scanLineDiscrepancies([snapshot]);
  assert('2-book market returns no line gaps at default minBooks=3', gaps.length === 0, `gaps=${JSON.stringify(gaps)}`);
}

{
  const snapshot = makeSnapshot({
    totals: [
      { book: 'DraftKings', line: 220.0, over: -110, under: -110 },
      { book: 'FanDuel', line: 221.0, over: -110, under: -110 },
      { book: 'BetMGM', line: 221.0, over: -110, under: -110 },
    ],
  });

  const gaps = scanLineDiscrepancies([snapshot]);
  const totalGap = gaps[0];

  assert('Total line gap emits one gap', gaps.length === 1, `gaps=${JSON.stringify(gaps)}`);
  assert('Lower total line maps to over direction', totalGap?.direction === 'over', `gap=${JSON.stringify(totalGap)}`);
}

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -2.0, away: 2.0, price_home: -110, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
      { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -110, price_away: -110 },
    ],
  });

  assertNoForbiddenOutputTerms('LineGap outputs avoid forbidden recommendation terms', scanLineDiscrepancies([snapshot]));
}

console.log('\n=== scanOddsDiscrepancies ===');

{
  const snapshot = makeSnapshot({
    spreads: [
      { book: 'DraftKings', home: -3.5, away: 3.5, price_home: -105, price_away: -110 },
      { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -113, price_away: -110 },
      { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -115, price_away: -110 },
    ],
  });

  const gaps = scanOddsDiscrepancies([snapshot]);
  const homeGap = gaps.find(gap => gap.market === 'spread' && gap.side === 'home');

  assert('Same-line spread juice difference emits one home OddsGap', gaps.length === 1 && Boolean(homeGap), `gaps=${JSON.stringify(gaps)}`);
  assert('Home odds gap bestBook is DraftKings', homeGap?.bestBook === 'DraftKings', `gap=${JSON.stringify(homeGap)}`);
  assert('Home odds gap bestPrice is -105', homeGap?.bestPrice === -105, `gap=${JSON.stringify(homeGap)}`);
  assert('Home odds gap worstBook is BetMGM', homeGap?.worstBook === 'BetMGM', `gap=${JSON.stringify(homeGap)}`);
  assert('Home odds gap worstPrice is -115', homeGap?.worstPrice === -115, `gap=${JSON.stringify(homeGap)}`);
  assert('Home odds gap impliedEdgePct is at least 0.02', (homeGap?.impliedEdgePct || 0) >= 0.02, `gap=${JSON.stringify(homeGap)}`);
  assert('Home odds gap tier is TRIGGER', homeGap?.tier === 'TRIGGER', `gap=${JSON.stringify(homeGap)}`);
}

{
  const snapshot = makeSnapshot({
    h2h: [
      { book: 'DraftKings', home: -108, away: 100 },
      { book: 'FanDuel', home: -108, away: 100 },
      { book: 'BetMGM', home: -110, away: 100 },
    ],
  });

  const gaps = scanOddsDiscrepancies([snapshot]);
  assert('Near-even ML prices -108/-108/-110 stay below watch threshold', gaps.length === 0, `gaps=${JSON.stringify(gaps)}`);
}

{
  const snapshot = makeSnapshot({
    h2h: [
      { book: 'DraftKings', home: -105, away: 100 },
      { book: 'FanDuel', home: -115, away: 100 },
      { book: 'BetMGM', home: -115, away: 100 },
    ],
  });

  const gaps = scanOddsDiscrepancies([snapshot]);
  const gap = gaps.find(candidate => candidate.market === 'moneyline' && candidate.side === 'home');

  assert('Near-even ML -105 vs -115 emits one home odds gap', gaps.length === 1 && Boolean(gap), `gaps=${JSON.stringify(gaps)}`);
  assert('Near-even ML impliedEdgePct is about 2.27%', approx(gap?.impliedEdgePct || 0, 0.022689), `gap=${JSON.stringify(gap)}`);
  assert('Near-even ML tier is TRIGGER after recalibration', gap?.tier === 'TRIGGER', `gap=${JSON.stringify(gap)}`);
}

{
  const snapshot = makeSnapshot({
    totals: [
      { book: 'DraftKings', line: 220.5, over: -105, under: -115 },
      { book: 'FanDuel', line: 220.5, over: -112, under: -115 },
      { book: 'BetMGM', line: 220.5, over: -115, under: -115 },
    ],
  });

  const gaps = scanOddsDiscrepancies([snapshot]);
  const overGap = gaps.find(gap => gap.market === 'total' && gap.side === 'over');

  assert('Total same-line juice differences are scanned', Boolean(overGap), `gaps=${JSON.stringify(gaps)}`);
  assert('Total odds gap preserves agreed line', overGap?.line === 220.5, `gap=${JSON.stringify(overGap)}`);
}

{
  const snapshot = makeSnapshot({
    h2h: [
      { book: 'DraftKings', home: -105, away: 100 },
      { book: 'FanDuel', home: -115, away: 100 },
      { book: 'BetMGM', home: -115, away: 100 },
    ],
  });

  assertNoForbiddenOutputTerms('OddsGap outputs avoid forbidden recommendation terms', scanOddsDiscrepancies([snapshot]));
}

console.log(`\n============================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`============================\n`);

if (failed > 0 && require.main === module) {
  process.exit(1);
}

if (typeof test === 'function') {
  test('mispricing-scanner assertions pass', () => {
    assertStrict.strictEqual(failed, 0, `${failed} mispricing-scanner assertion(s) failed`);
  });
}
