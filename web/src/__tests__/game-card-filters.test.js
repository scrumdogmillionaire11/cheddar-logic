/*
 * Runtime behavior checks for game-card filters.
 * Run: npm --prefix web run test:filters
 */

import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters.ts';

function buildDriver(overrides = {}) {
  return {
    key: 'driver-1',
    market: 'ML',
    tier: 'WATCH',
    direction: 'HOME',
    confidence: 0.61,
    note: 'Baseline driver',
    cardType: 'nba-projection',
    cardTitle: 'NBA Projection',
    ...overrides,
  };
}

function buildPlay(overrides = {}) {
  return {
    market_type: 'MONEYLINE',
    selection: {
      side: 'HOME',
    },
    status: 'FIRE',
    market: 'ML',
    pick: 'Home ML -110',
    lean: 'home',
    side: 'HOME',
    truthStatus: 'STRONG',
    truthStrength: 0.82,
    conflict: 0.08,
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

function ids(cards) {
  return cards.map((card) => card.id).sort();
}

console.log('🧪 Game card filter runtime tests');

assert.deepStrictEqual(
  DEFAULT_GAME_FILTERS.statuses,
  ['FIRE', 'WATCH'],
  'default main-view statuses should stay FIRE/WATCH',
);

const fireCard = buildCard('fire-card', {
  play: {
    action: 'FIRE',
    classification: 'BASE',
    status: 'FIRE',
    pick: 'Home ML -112',
  },
});

const passCard = buildCard('pass-card', {
  play: {
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    pick: 'Home ML -112 (Verification Required)',
  },
  tags: ['has_fire', 'has_watch'],
  drivers: [
    buildDriver({ tier: 'BEST', confidence: 0.9 }),
    buildDriver({ key: 'driver-2', tier: 'SUPER', confidence: 0.78 }),
  ],
});

const defaultResult = applyFilters(
  [fireCard, passCard],
  DEFAULT_GAME_FILTERS,
  'game',
);
assert.deepStrictEqual(
  ids(defaultResult),
  ['fire-card'],
  'default FIRE/WATCH filters should exclude PASS cards even with strong tags/drivers',
);

const fullSlateFilters = {
  ...DEFAULT_GAME_FILTERS,
  statuses: ['FIRE', 'WATCH', 'PASS'],
};
const fullSlateResult = applyFilters(
  [fireCard, passCard],
  fullSlateFilters,
  'game',
);
assert.deepStrictEqual(
  ids(fullSlateResult),
  ['fire-card', 'pass-card'],
  'including PASS status should include PASS cards',
);

const passWithExpressionChoice = buildCard('pass-with-expression-choice', {
  play: {
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: { official_status: 'PASS' },
  },
  expressionChoice: {
    status: 'WATCH',
    chosenMarket: 'ML',
    pick: 'Away ML +120',
    score: 0.61,
  },
});

const defaultWithExpressionChoiceResult = applyFilters(
  [passWithExpressionChoice],
  DEFAULT_GAME_FILTERS,
  'game',
);
assert.deepStrictEqual(
  ids(defaultWithExpressionChoiceResult),
  [],
  'explicit PASS play should not be promoted into FIRE/WATCH visibility by expressionChoice status',
);

console.log('✅ Game card filter runtime tests passed');
