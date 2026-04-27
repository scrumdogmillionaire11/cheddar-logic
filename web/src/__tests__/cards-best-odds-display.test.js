/*
 * WI-0895: Deterministic matrix for resolveOddsDisplayPayload and classifyPassReasonBucket.
 * Run: node --import tsx/esm src/__tests__/cards-best-odds-display.test.js
 */

import assert from 'node:assert/strict';
import { resolveOddsDisplayPayload } from '../components/cards/game-card-helpers.tsx';
import { classifyPassReasonBucket } from '../components/cards/shared.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOdds(overrides = {}) {
  return {
    h2hHome: null, h2hAway: null, h2hBook: null, h2hHomeBook: null, h2hAwayBook: null,
    total: null, totalBook: null,
    totalLineOver: null, totalLineOverBook: null,
    totalLineUnder: null, totalLineUnderBook: null,
    spreadHome: null, spreadAway: null, spreadHomeBook: null, spreadAwayBook: null,
    spreadPriceHome: null, spreadPriceHomeBook: null,
    spreadPriceAway: null, spreadPriceAwayBook: null,
    totalPriceOver: null, totalPriceOverBook: null,
    totalPriceUnder: null, totalPriceUnderBook: null,
    spreadIsMispriced: null, spreadMispriceType: null, spreadMispriceStrength: null,
    spreadOutlierBook: null, spreadOutlierDelta: null, spreadReviewFlag: null,
    spreadConsensusLine: null, spreadConsensusConfidence: null,
    spreadDispersionStddev: null, spreadSourceBookCount: null,
    totalIsMispriced: null, totalMispriceType: null, totalMispriceStrength: null,
    totalOutlierBook: null, totalOutlierDelta: null, totalReviewFlag: null,
    totalConsensusLine: null, totalConsensusConfidence: null,
    totalDispersionStddev: null, totalSourceBookCount: null,
    h2hConsensusHome: null, h2hConsensusAway: null, h2hConsensusConfidence: null,
    capturedAt: null,
    ...overrides,
  };
}

function buildCard(playOverrides = {}) {
  return {
    id: 'test-card',
    sport: 'NBA',
    homeTeam: 'HOME',
    awayTeam: 'AWAY',
    startTime: new Date().toISOString(),
    tags: [],
    drivers: [],
    play: playOverrides.play !== undefined ? playOverrides.play : {
      market_type: 'MONEYLINE',
      execution_status: null,
      reason_codes: [],
      decision_v2: null,
      transform_meta: null,
      ...playOverrides,
    },
    propPlays: [],
  };
}

// ---------------------------------------------------------------------------
// resolveOddsDisplayPayload — MONEYLINE
// ---------------------------------------------------------------------------

{
  const odds = buildOdds({ h2hHome: -120, h2hHomeBook: 'draftkings', h2hAway: +105, h2hAwayBook: 'fanduel' });

  const home = resolveOddsDisplayPayload('MONEYLINE', 'HOME', odds);
  assert.equal(home.market, 'MONEYLINE', 'MONEYLINE HOME: market');
  assert.equal(home.bestPrice, -120, 'MONEYLINE HOME: bestPrice');
  assert.equal(home.priceBook, 'draftkings', 'MONEYLINE HOME: priceBook');
  assert.equal(home.bestLine, null, 'MONEYLINE HOME: bestLine is null');
  assert.equal(home.lineBook, null, 'MONEYLINE HOME: lineBook is null');
  assert.equal(home.hasVerifiedBest, true, 'MONEYLINE HOME: hasVerifiedBest');
  assert.equal(home.isSplitSource, false, 'MONEYLINE HOME: not split source');

  const away = resolveOddsDisplayPayload('MONEYLINE', 'AWAY', odds);
  assert.equal(away.bestPrice, 105, 'MONEYLINE AWAY: bestPrice');
  assert.equal(away.priceBook, 'fanduel', 'MONEYLINE AWAY: priceBook');
  assert.equal(away.hasVerifiedBest, true, 'MONEYLINE AWAY: hasVerifiedBest');
}

// MONEYLINE — missing book → hasVerifiedBest: false
{
  const odds = buildOdds({ h2hHome: -120, h2hHomeBook: null });
  const result = resolveOddsDisplayPayload('MONEYLINE', 'HOME', odds);
  assert.equal(result.hasVerifiedBest, false, 'MONEYLINE HOME no book: hasVerifiedBest false');
  assert.equal(result.priceBook, null, 'MONEYLINE HOME no book: priceBook null');
}

// MONEYLINE — missing numeric → hasVerifiedBest: false
{
  const odds = buildOdds({ h2hHome: null, h2hHomeBook: 'draftkings' });
  const result = resolveOddsDisplayPayload('MONEYLINE', 'HOME', odds);
  assert.equal(result.hasVerifiedBest, false, 'MONEYLINE HOME no price: hasVerifiedBest false');
  assert.equal(result.bestPrice, null, 'MONEYLINE HOME no price: bestPrice null');
}

// ---------------------------------------------------------------------------
// resolveOddsDisplayPayload — SPREAD
// ---------------------------------------------------------------------------

{
  const odds = buildOdds({
    spreadHome: -1.5, spreadHomeBook: 'draftkings',
    spreadPriceHome: -110, spreadPriceHomeBook: 'draftkings',
  });
  const result = resolveOddsDisplayPayload('SPREAD', 'HOME', odds);
  assert.equal(result.market, 'SPREAD', 'SPREAD HOME: market');
  assert.equal(result.bestLine, -1.5, 'SPREAD HOME: bestLine');
  assert.equal(result.lineBook, 'draftkings', 'SPREAD HOME: lineBook');
  assert.equal(result.bestPrice, -110, 'SPREAD HOME: bestPrice');
  assert.equal(result.priceBook, 'draftkings', 'SPREAD HOME: priceBook');
  assert.equal(result.hasVerifiedBest, true, 'SPREAD HOME: hasVerifiedBest');
  assert.equal(result.isSplitSource, false, 'SPREAD HOME: not split source (same book)');
}

// SPREAD AWAY
{
  const odds = buildOdds({
    spreadAway: +1.5, spreadAwayBook: 'betmgm',
    spreadPriceAway: -105, spreadPriceAwayBook: 'betmgm',
  });
  const result = resolveOddsDisplayPayload('SPREAD', 'AWAY', odds);
  assert.equal(result.bestLine, 1.5, 'SPREAD AWAY: bestLine');
  assert.equal(result.lineBook, 'betmgm', 'SPREAD AWAY: lineBook');
  assert.equal(result.hasVerifiedBest, true, 'SPREAD AWAY: hasVerifiedBest');
}

// SPREAD split-source
{
  const odds = buildOdds({
    spreadHome: -1.5, spreadHomeBook: 'draftkings',
    spreadPriceHome: -108, spreadPriceHomeBook: 'fanduel',
  });
  const result = resolveOddsDisplayPayload('SPREAD', 'HOME', odds);
  assert.equal(result.isSplitSource, true, 'SPREAD split-source: isSplitSource true');
  assert.equal(result.lineBook, 'draftkings', 'SPREAD split-source: lineBook');
  assert.equal(result.priceBook, 'fanduel', 'SPREAD split-source: priceBook');
  assert.equal(result.hasVerifiedBest, true, 'SPREAD split-source: hasVerifiedBest');
}

// ---------------------------------------------------------------------------
// resolveOddsDisplayPayload — PUCKLINE
// ---------------------------------------------------------------------------

{
  const odds = buildOdds({
    spreadHome: -1.5, spreadHomeBook: 'betrivers',
    spreadPriceHome: +120, spreadPriceHomeBook: 'betrivers',
  });
  const result = resolveOddsDisplayPayload('PUCKLINE', 'HOME', odds);
  assert.equal(result.market, 'PUCKLINE', 'PUCKLINE HOME: market');
  assert.equal(result.bestLine, -1.5, 'PUCKLINE HOME: bestLine');
  assert.equal(result.hasVerifiedBest, true, 'PUCKLINE HOME: hasVerifiedBest');
}

// ---------------------------------------------------------------------------
// resolveOddsDisplayPayload — TOTAL
// ---------------------------------------------------------------------------

{
  const odds = buildOdds({
    totalLineOver: 7.5, totalLineOverBook: 'draftkings',
    totalPriceOver: -115, totalPriceOverBook: 'draftkings',
  });
  const result = resolveOddsDisplayPayload('TOTAL', 'OVER', odds);
  assert.equal(result.market, 'TOTAL', 'TOTAL OVER: market');
  assert.equal(result.bestLine, 7.5, 'TOTAL OVER: bestLine');
  assert.equal(result.lineBook, 'draftkings', 'TOTAL OVER: lineBook');
  assert.equal(result.bestPrice, -115, 'TOTAL OVER: bestPrice');
  assert.equal(result.priceBook, 'draftkings', 'TOTAL OVER: priceBook');
  assert.equal(result.hasVerifiedBest, true, 'TOTAL OVER: hasVerifiedBest');
  assert.equal(result.isSplitSource, false, 'TOTAL OVER: not split');
}

{
  const odds = buildOdds({
    totalLineUnder: 7.5, totalLineUnderBook: 'fanduel',
    totalPriceUnder: -105, totalPriceUnderBook: 'fanduel',
  });
  const result = resolveOddsDisplayPayload('TOTAL', 'UNDER', odds);
  assert.equal(result.bestLine, 7.5, 'TOTAL UNDER: bestLine');
  assert.equal(result.lineBook, 'fanduel', 'TOTAL UNDER: lineBook');
  assert.equal(result.bestPrice, -105, 'TOTAL UNDER: bestPrice');
  assert.equal(result.hasVerifiedBest, true, 'TOTAL UNDER: hasVerifiedBest');
}

// TOTAL split-source
{
  const odds = buildOdds({
    totalLineOver: 8.0, totalLineOverBook: 'betmgm',
    totalPriceOver: -110, totalPriceOverBook: 'fanduel',
  });
  const result = resolveOddsDisplayPayload('TOTAL', 'OVER', odds);
  assert.equal(result.isSplitSource, true, 'TOTAL split-source: isSplitSource true');
  assert.equal(result.lineBook, 'betmgm', 'TOTAL split-source: lineBook');
  assert.equal(result.priceBook, 'fanduel', 'TOTAL split-source: priceBook');
}

// ---------------------------------------------------------------------------
// resolveOddsDisplayPayload — null odds and unknown market
// ---------------------------------------------------------------------------

{
  const result = resolveOddsDisplayPayload('MONEYLINE', 'HOME', null);
  assert.equal(result.hasVerifiedBest, false, 'null odds: hasVerifiedBest false');
  assert.equal(result.market, null, 'null odds: market null');
}

{
  const result = resolveOddsDisplayPayload('PROP', 'HOME', buildOdds());
  assert.equal(result.hasVerifiedBest, false, 'unknown market: hasVerifiedBest false');
  assert.equal(result.market, null, 'unknown market: market null');
}

// ---------------------------------------------------------------------------
// classifyPassReasonBucket
// ---------------------------------------------------------------------------

// projection-only via execution_status
{
  const card = buildCard({ play: { execution_status: 'PROJECTION_ONLY', reason_codes: [], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'projection-only', 'execution_status PROJECTION_ONLY');
}

// projection-only via reason_codes
{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['PROJECTION_ONLY_EXCLUSION'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'projection-only', 'reason_codes PROJECTION_ONLY_EXCLUSION');
}

{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['MISSING_DATA_PROJECTION_INPUTS'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'projection-only', 'reason_codes MISSING_DATA_PROJECTION_INPUTS');
}

{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['MISSING_DATA_DRIVERS'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'projection-only', 'reason_codes MISSING_DATA_DRIVERS');
}

// odds-blocked via execution_status
{
  const card = buildCard({ play: { execution_status: 'BLOCKED', reason_codes: [], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'odds-blocked', 'execution_status BLOCKED');
}

// odds-blocked via decision_v2.price_reason_codes
{
  const card = buildCard({ play: { execution_status: null, reason_codes: [], decision_v2: { price_reason_codes: ['PROXY_EDGE_BLOCKED'] }, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'odds-blocked', 'price_reason_codes PROXY_EDGE_BLOCKED');
}

// odds-blocked via PASS_EXECUTION_GATE_ prefix
{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['PASS_EXECUTION_GATE_NO_PRICE'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'odds-blocked', 'PASS_EXECUTION_GATE_ prefix');
}

// data-error via transform_meta.quality
{
  const card = buildCard({ play: { execution_status: null, reason_codes: [], decision_v2: null, transform_meta: { quality: 'BROKEN' } } });
  assert.equal(classifyPassReasonBucket(card), 'data-error', 'transform_meta.quality BROKEN');
}

// data-error via reason_codes
{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['PASS_DATA_ERROR'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'data-error', 'PASS_DATA_ERROR');
}

// default fallback → data-error
{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['PASS_DRIVER_SUPPORT_WEAK'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'data-error', 'PASS_DRIVER_SUPPORT_WEAK default fallback');
}

{
  const card = buildCard({ play: { execution_status: null, reason_codes: ['PASS_NO_EDGE'], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), 'data-error', 'PASS_NO_EDGE default fallback');
}

// no reason codes → null
{
  const card = buildCard({ play: { execution_status: null, reason_codes: [], decision_v2: null, transform_meta: null } });
  assert.equal(classifyPassReasonBucket(card), null, 'no reason codes → null');
}

// null play → null
{
  const card = buildCard({ play: null });
  assert.equal(classifyPassReasonBucket(card), null, 'null play → null');
}

console.log('cards-best-odds-display: all assertions passed ✓');
