/*
 * Runtime tests for game-card tag derivation.
 * Run: node --import tsx/esm web/src/__tests__/game-card-tags.test.js
 */

import assert from 'node:assert/strict';
import { deriveTags } from '../lib/game-card/tags.ts';
import { GAME_TAGS } from '../lib/types/game-card.ts';

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

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
    selection: { side: 'HOME' },
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    market: 'ML',
    pick: 'NO PLAY',
    lean: 'none',
    side: 'NEUTRAL',
    truthStatus: 'WEAK',
    truthStrength: 0,
    conflict: 0,
    valueStatus: 'NO_EDGE',
    betAction: 'NO_BET',
    priceFlags: [],
    updatedAt: minutesAgoIso(1),
    whyCode: 'NO_DECISION',
    whyText: 'No decision',
    ...overrides,
  };
}

function buildCard(updatedAt) {
  return {
    id: 'card-1',
    gameId: 'game-1',
    sport: 'NBA',
    homeTeam: 'Home',
    awayTeam: 'Away',
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    updatedAt,
    status: 'scheduled',
    markets: {},
    play: buildPlay(),
    drivers: [buildDriver()],
    tags: [],
  };
}

console.log('🧪 Game card tags runtime tests');

const tenMinuteCard = buildCard(minutesAgoIso(10));
const tenMinuteTags = deriveTags(tenMinuteCard);
assert.equal(
  tenMinuteTags.includes(GAME_TAGS.STALE_5M),
  false,
  '10-minute-old card should NOT be tagged stale with 60-minute warning threshold',
);
assert.equal(
  tenMinuteTags.includes(GAME_TAGS.STALE_30M),
  false,
  '10-minute-old card should NOT be tagged severe stale with 90-minute threshold',
);

const sixtyOneMinuteCard = buildCard(minutesAgoIso(61));
const sixtyOneMinuteTags = deriveTags(sixtyOneMinuteCard);
assert.equal(
  sixtyOneMinuteTags.includes(GAME_TAGS.STALE_5M),
  true,
  '61-minute-old card should be tagged stale warning',
);
assert.equal(
  sixtyOneMinuteTags.includes(GAME_TAGS.STALE_30M),
  false,
  '61-minute-old card should not yet be severe stale',
);

const ninetyOneMinuteCard = buildCard(minutesAgoIso(91));
const ninetyOneMinuteTags = deriveTags(ninetyOneMinuteCard);
assert.equal(
  ninetyOneMinuteTags.includes(GAME_TAGS.STALE_5M),
  true,
  '91-minute-old card should be tagged stale warning',
);
assert.equal(
  ninetyOneMinuteTags.includes(GAME_TAGS.STALE_30M),
  true,
  '91-minute-old card should be tagged severe stale',
);

console.log('✅ Game card tags runtime tests passed');
