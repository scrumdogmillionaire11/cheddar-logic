/*
 * Behavior-level regression tests for NCAAM FT advantage callout.
 * Run: node web/src/__tests__/cards-ft-advantage-behavior.test.js
 *
 * Tests inline-implement the pure logic from extractFtTrendInsight and
 * formatFtTrendInsight (post-regex-removal version) for stable, framework-free
 * verification that FT advantage follows FT% correctly.
 */

import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Inlined pure logic from cards-page-client.tsx (post-cleanup version)
// ---------------------------------------------------------------------------

function extractFtTrendInsight(card) {
  const ftDriver = card.drivers.find(
    (d) => d.cardType === 'ncaam-ft-trend',
  );
  if (!ftDriver) return null;

  const context = ftDriver.ftTrendContext;

  const safeHomePct =
    typeof context?.homeFtPct === 'number' ? context.homeFtPct : null;
  const safeAwayPct =
    typeof context?.awayFtPct === 'number' ? context.awayFtPct : null;
  const safeTotalLine =
    typeof context?.totalLine === 'number' ? context.totalLine : null;

  const sideFromPct =
    safeHomePct !== null && safeAwayPct !== null
      ? safeHomePct > safeAwayPct
        ? 'HOME'
        : safeAwayPct > safeHomePct
          ? 'AWAY'
          : null
      : null;

  const resolvedSide =
    sideFromPct ??
    context?.advantagedSide ??
    (ftDriver.direction === 'HOME' || ftDriver.direction === 'AWAY'
      ? ftDriver.direction
      : null);

  if (!resolvedSide) return null;

  const homeSide = resolvedSide === 'HOME';
  return {
    advantagedTeam: homeSide ? card.homeTeam : card.awayTeam,
    disadvantagedTeam: homeSide ? card.awayTeam : card.homeTeam,
    advantagedPct: homeSide ? safeHomePct : safeAwayPct,
    disadvantagedPct: homeSide ? safeAwayPct : safeHomePct,
    totalLine: safeTotalLine,
  };
}

function formatFtTrendInsight(insight) {
  const ftPart =
    insight.advantagedPct !== null && insight.disadvantagedPct !== null
      ? `${insight.advantagedTeam} ${insight.advantagedPct.toFixed(1)}% vs ${insight.disadvantagedTeam} ${insight.disadvantagedPct.toFixed(1)}%`
      : `${insight.advantagedTeam} over ${insight.disadvantagedTeam}`;
  const totalPart =
    insight.totalLine !== null ? ` (total ${insight.totalLine.toFixed(1)})` : '';
  return `${ftPart}${totalPart}`;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCard({ homeTeam, awayTeam, ftTrendContext, direction = 'HOME' }) {
  return {
    homeTeam,
    awayTeam,
    drivers: [
      {
        cardType: 'ncaam-ft-trend',
        note: 'FT trend driver',
        direction,
        ftTrendContext: ftTrendContext ?? null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('NCAAM FT advantage behavior tests');

// Test A: home FT% > away FT% → advantagedTeam is home team
{
  const card = makeCard({
    homeTeam: 'Duke',
    awayTeam: 'UNC',
    ftTrendContext: { homeFtPct: 74, awayFtPct: 68, totalLine: 140.5, advantagedSide: null },
  });
  const insight = extractFtTrendInsight(card);
  assert(insight !== null, 'Test A: insight should not be null');
  assert.strictEqual(insight.advantagedTeam, 'Duke', 'Test A: advantagedTeam should be home team');
  assert.strictEqual(insight.disadvantagedTeam, 'UNC', 'Test A: disadvantagedTeam should be away team');
  assert.strictEqual(insight.advantagedPct, 74, 'Test A: advantagedPct should be home FT%');
  assert.strictEqual(insight.disadvantagedPct, 68, 'Test A: disadvantagedPct should be away FT%');
  console.log('  Test A passed: home FT% > away FT% → home team advantaged');
}

// Test B: away FT% > home FT% → advantagedTeam is away team
{
  const card = makeCard({
    homeTeam: 'Duke',
    awayTeam: 'UNC',
    ftTrendContext: { homeFtPct: 71, awayFtPct: 79, totalLine: 138.0, advantagedSide: null },
  });
  const insight = extractFtTrendInsight(card);
  assert(insight !== null, 'Test B: insight should not be null');
  assert.strictEqual(insight.advantagedTeam, 'UNC', 'Test B: advantagedTeam should be away team');
  assert.strictEqual(insight.disadvantagedTeam, 'Duke', 'Test B: disadvantagedTeam should be home team');
  assert.strictEqual(insight.advantagedPct, 79, 'Test B: advantagedPct should be away FT%');
  assert.strictEqual(insight.disadvantagedPct, 71, 'Test B: disadvantagedPct should be home FT%');
  console.log('  Test B passed: away FT% > home FT% → away team advantaged');
}

// Test C: equal FT% → sideFromPct is null, falls back to context.advantagedSide
{
  const card = makeCard({
    homeTeam: 'Duke',
    awayTeam: 'UNC',
    ftTrendContext: { homeFtPct: 73, awayFtPct: 73, totalLine: 142.0, advantagedSide: 'AWAY' },
  });
  const insight = extractFtTrendInsight(card);
  assert(insight !== null, 'Test C: insight should not be null when context.advantagedSide present');
  assert.strictEqual(insight.advantagedTeam, 'UNC', 'Test C: when FT% tied, should use context.advantagedSide (AWAY)');
  console.log('  Test C passed: tied FT% falls back to context.advantagedSide');
}

// Test D: null context → extractFtTrendInsight returns null (no crash)
{
  const card = makeCard({
    homeTeam: 'Duke',
    awayTeam: 'UNC',
    ftTrendContext: null,
    direction: 'NEUTRAL',
  });
  // Override driver to have no direction so resolvedSide is also null
  card.drivers[0].direction = 'NEUTRAL';
  const insight = extractFtTrendInsight(card);
  assert.strictEqual(insight, null, 'Test D: null context with NEUTRAL direction should return null');
  console.log('  Test D passed: null context returns null safely (no crash)');
}

// Test E: formatFtTrendInsight produces correct string with both pcts and totalLine
{
  const insight = {
    advantagedTeam: 'Duke',
    disadvantagedTeam: 'UNC',
    advantagedPct: 74.2,
    disadvantagedPct: 68.5,
    totalLine: 140.5,
  };
  const result = formatFtTrendInsight(insight);
  assert.strictEqual(
    result,
    'Duke 74.2% vs UNC 68.5% (total 140.5)',
    'Test E: formatFtTrendInsight should produce correct string',
  );
  console.log('  Test E passed: formatFtTrendInsight correct output');
}

console.log('All NCAAM FT advantage behavior tests passed');
