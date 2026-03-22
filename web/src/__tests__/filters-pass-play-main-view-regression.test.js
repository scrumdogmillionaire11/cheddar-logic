/*
 * Runtime regression guard: PASS cards must not surface in default FIRE/WATCH view.
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
    confidence: 0.62,
    note: 'Baseline',
    cardType: 'nba-projection',
    cardTitle: 'NBA Projection',
    ...overrides,
  };
}

function buildPlay(overrides = {}) {
  return {
    status: 'PASS',
    action: 'PASS',
    classification: 'PASS',
    market: 'ML',
    pick: 'NO PLAY',
    lean: 'none',
    side: 'HOME',
    truthStatus: 'WEAK',
    truthStrength: 0.2,
    conflict: 0.8,
    valueStatus: 'BAD',
    betAction: 'NO_PLAY',
    priceFlags: [],
    updatedAt: '2026-03-22T10:00:00Z',
    whyCode: 'PASS_NO_EDGE',
    whyText: 'No edge',
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

console.log('🧪 PASS main-view runtime regression tests');

const passTagHeavy = buildCard('pass-tag-heavy', {
  play: {
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    pick: 'Home ML -112 (Verification Required)',
  },
  tags: ['has_fire', 'has_watch'],
  drivers: [
    buildDriver({ key: 'best-1', tier: 'BEST', confidence: 0.93 }),
    buildDriver({ key: 'super-1', tier: 'SUPER', confidence: 0.81 }),
  ],
});

const passPickText = buildCard('pass-pick-text', {
  play: {
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    pick: 'Away ML -104 (Verification Required)',
  },
});

const passOfficialStatus = buildCard('pass-official-status', {
  play: {
    action: 'FIRE',
    classification: 'BASE',
    status: 'FIRE',
    pick: 'Away ML -108',
    decision_v2: {
      official_status: 'PASS',
    },
  },
  tags: ['has_fire'],
  drivers: [buildDriver({ key: 'watch-1', tier: 'WATCH', confidence: 0.67 })],
});

const fireControl = buildCard('fire-control', {
  play: {
    action: 'FIRE',
    classification: 'BASE',
    status: 'FIRE',
    pick: 'Home ML -110',
    decision_v2: {
      official_status: 'PLAY',
    },
  },
});

const defaultResult = applyFilters(
  [passTagHeavy, passPickText, passOfficialStatus, fireControl],
  DEFAULT_GAME_FILTERS,
  'game',
);
assert.deepStrictEqual(
  ids(defaultResult),
  ['fire-control'],
  'default FIRE/WATCH filters must exclude PASS cards from strong tags, non-NO-PLAY text, and decision_v2 official_status PASS',
);

const includePassFilters = {
  ...DEFAULT_GAME_FILTERS,
  statuses: ['FIRE', 'WATCH', 'PASS'],
};
const includePassResult = applyFilters(
  [passTagHeavy, passPickText, passOfficialStatus, fireControl],
  includePassFilters,
  'game',
);
assert.deepStrictEqual(
  ids(includePassResult),
  ['fire-control', 'pass-official-status', 'pass-pick-text', 'pass-tag-heavy'],
  'including PASS status should include PASS cards in full-slate mode',
);

console.log('✅ PASS main-view runtime regression tests passed');
