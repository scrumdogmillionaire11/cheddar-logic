/*
 * Runtime checks for play-first market filtering behavior.
 * Run: npm --prefix web run test:filters:play-first
 */

import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters.ts';

function buildDriver(overrides = {}) {
  return {
    key: 'driver-1',
    market: 'TOTAL',
    tier: 'WATCH',
    direction: 'OVER',
    confidence: 0.55,
    note: 'Baseline',
    cardType: 'nba-total',
    cardTitle: 'NBA Total',
    ...overrides,
  };
}

function buildPlay(overrides = {}) {
  return {
    market_type: 'SPREAD',
    selection: {
      side: 'HOME',
    },
    status: 'FIRE',
    action: 'FIRE',
    classification: 'BASE',
    market: 'SPREAD',
    pick: 'Home -3.5',
    lean: 'home',
    side: 'HOME',
    truthStatus: 'STRONG',
    truthStrength: 0.78,
    conflict: 0.12,
    valueStatus: 'GOOD',
    betAction: 'BET',
    priceFlags: [],
    updatedAt: '2026-03-22T10:00:00Z',
    whyCode: 'EDGE_FOUND',
    whyText: 'Edge found',
    ...overrides,
  };
}

function buildCard(id, overrides = {}) {
  const base = {
    id,
    gameId: `${id}-game`,
    sport: 'NBA',
    homeTeam: 'Home',
    awayTeam: 'Away',
    startTime: '2026-03-23T00:00:00Z',
    updatedAt: '2026-03-22T10:00:00Z',
    status: 'scheduled',
    markets: {},
    play: buildPlay(),
    drivers: [buildDriver()],
    tags: [],
  };

  return {
    ...base,
    ...overrides,
    play:
      overrides.play === undefined
        ? base.play
        : { ...base.play, ...overrides.play },
    drivers: overrides.drivers ?? base.drivers,
    tags: overrides.tags ?? base.tags,
  };
}

const spreadOnlyFilters = {
  ...DEFAULT_GAME_FILTERS,
  markets: ['SPREAD'],
  statuses: ['FIRE', 'WATCH'],
};

console.log('🧪 Play-first filter runtime tests');

const playMarketMatch = buildCard('play-market-match', {
  play: {
    market: 'SPREAD',
    market_type: 'SPREAD',
    pick: 'Home -4.5',
  },
  drivers: [buildDriver({ market: 'TOTAL', direction: 'OVER' })],
});

const playMarketMatchResult = applyFilters(
  [playMarketMatch],
  spreadOnlyFilters,
  'game',
);
assert.deepStrictEqual(
  playMarketMatchResult.map((card) => card.id),
  ['play-market-match'],
  'play.market_type match should include card even when drivers do not match market',
);

const fallbackNonMatch = buildCard('fallback-non-match', {
  play: {
    market: 'TOTAL',
    market_type: 'TOTAL',
    pick: 'Over 226.5',
  },
  drivers: [buildDriver({ market: 'SPREAD', direction: 'HOME', note: 'Spread edge' })],
});

const fallbackMissing = buildCard('fallback-missing', {
  play: {
    market: undefined,
    market_type: undefined,
    pick: 'Home -2.5',
  },
  drivers: [buildDriver({ market: 'SPREAD', direction: 'HOME', note: 'Spread edge' })],
});

const fallbackResult = applyFilters(
  [fallbackNonMatch, fallbackMissing],
  spreadOnlyFilters,
  'game',
);
assert.deepStrictEqual(
  fallbackResult.map((card) => card.id).sort(),
  [],
  'cards without canonical matching market_type should be excluded even if legacy fields/drivers suggest a match',
);

console.log('✅ Play-first filter runtime tests passed');
