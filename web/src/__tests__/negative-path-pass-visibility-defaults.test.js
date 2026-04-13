/*
 * Negative-path filter checks: PASS stays hidden by default and appears only when requested.
 * Run: node --import tsx/esm web/src/__tests__/negative-path-pass-visibility-defaults.test.js
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

function buildCard(id, playOverrides = {}) {
  return {
    id,
    gameId: `${id}-game`,
    sport: 'NBA',
    homeTeam: 'Home',
    awayTeam: 'Away',
    startTime: '2026-03-23T00:00:00Z',
    updatedAt: '2026-03-22T10:00:00Z',
    status: 'scheduled',
    markets: {},
    drivers: [buildDriver()],
    tags: [],
    play: {
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      market: 'ML',
      pick: 'NO PLAY',
      side: 'HOME',
      betAction: 'NO_PLAY',
      reason_codes: ['PASS_NO_EDGE'],
      pass_reason_code: 'PASS_NO_EDGE',
      decision_v2: { official_status: 'PASS' },
      ...playOverrides,
    },
  };
}

function ids(cards) {
  return cards.map((card) => card.id).sort();
}

console.log('🧪 Negative-path PASS visibility defaults');

const passCard = buildCard('pass-default-hidden', {
  pick: 'Home ML -112 (Verification Required)',
  reason_codes: ['PASS_EXECUTION_GATE_BLOCKED'],
  pass_reason_code: 'PASS_EXECUTION_GATE_BLOCKED',
});

const fireCard = buildCard('fire-control', {
  status: 'FIRE',
  action: 'FIRE',
  classification: 'BASE',
  pick: 'Home ML -110',
  betAction: 'BET',
  reason_codes: ['EDGE_CLEAR'],
  pass_reason_code: null,
  decision_v2: { official_status: 'PLAY' },
});

const defaultView = applyFilters([passCard, fireCard], DEFAULT_GAME_FILTERS, 'game');
assert.deepStrictEqual(
  ids(defaultView),
  ['fire-control'],
  'default FIRE/WATCH view must hide valid PASS cards',
);

const includePass = {
  ...DEFAULT_GAME_FILTERS,
  statuses: ['FIRE', 'WATCH', 'PASS'],
};
const fullSlate = applyFilters([passCard, fireCard], includePass, 'game');
assert.deepStrictEqual(
  ids(fullSlate),
  ['fire-control', 'pass-default-hidden'],
  'including PASS must reveal PASS cards without mutating reason/status fields',
);

const shownPass = fullSlate.find((card) => card.id === 'pass-default-hidden');
assert.equal(shownPass?.play?.status, 'PASS');
assert.equal(shownPass?.play?.pass_reason_code, 'PASS_EXECUTION_GATE_BLOCKED');

console.log('✅ Negative-path PASS visibility defaults passed');
