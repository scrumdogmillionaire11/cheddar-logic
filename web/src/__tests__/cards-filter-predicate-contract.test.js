/*
 * Contract checks for the canonical cards filter predicate.
 * Run: node --import tsx/esm web/src/__tests__/cards-filter-predicate-contract.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyFilters,
  DEFAULT_GAME_FILTERS,
  DEFAULT_PROJECTIONS_FILTERS,
  evaluateCardFilter,
  getFilterDebugFlags,
} from '../lib/game-card/filters.ts';

function buildCard(id, overrides = {}) {
  const base = {
    id,
    gameId: `${id}-game`,
    sport: 'NHL',
    homeTeam: 'Home',
    awayTeam: 'Away',
    startTime: '2026-04-17T23:00:00Z',
    updatedAt: '2026-04-17T18:00:00Z',
    status: 'scheduled',
    markets: {},
    play: {
      cardType: 'nhl-pace-1p',
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      status: 'WATCH',
      action: 'HOLD',
      classification: 'LEAN',
      market: 'TOTAL',
      pick: 'Over 1.5',
      lean: 'over',
      side: 'OVER',
      prediction: 'OVER',
      truthStatus: 'STRONG',
      truthStrength: 0.71,
      conflict: 0.12,
      valueStatus: 'OK',
      betAction: 'BET',
      priceFlags: [],
      line: 1.5,
      updatedAt: '2026-04-17T18:00:00Z',
      whyCode: 'EDGE_FOUND',
      whyText: 'Edge found',
      decision_v2: {
        official_status: 'LEAN',
      },
    },
    drivers: [],
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

console.log('🧪 Cards filter predicate contract tests');

const projectionCard = buildCard('projection-card');
const projectionPredicate = evaluateCardFilter(
  projectionCard,
  DEFAULT_PROJECTIONS_FILTERS,
  'projections',
);
assert.equal(
  projectionPredicate.passes,
  true,
  'projection card should pass through the canonical predicate',
);
assert.deepEqual(
  applyFilters([projectionCard], DEFAULT_PROJECTIONS_FILTERS, 'projections').map(
    (card) => card.id,
  ),
  ['projection-card'],
  'applyFilters must use the same predicate result exposed for diagnostics',
);

const wrongCardType = buildCard('wrong-card-type', {
  play: { cardType: 'nba-total-projection' },
});
const wrongCardTypePredicate = evaluateCardFilter(
  wrongCardType,
  DEFAULT_PROJECTIONS_FILTERS,
  'projections',
);
assert.equal(wrongCardTypePredicate.passes, false);
assert.equal(
  getFilterDebugFlags(wrongCardType, DEFAULT_PROJECTIONS_FILTERS, 'projections')
    .cardType,
  false,
  'diagnostic flags must expose the same card-type predicate used by filtering',
);

const passCard = buildCard('pass-card', {
  play: {
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: { official_status: 'PASS' },
  },
  tags: ['has_fire', 'has_watch'],
});
assert.equal(
  evaluateCardFilter(passCard, DEFAULT_GAME_FILTERS, 'game').passes,
  false,
  'default game-mode FIRE/WATCH predicate should continue to suppress PASS cards',
);

const cardsDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../components/cards',
);
const contextSource = fs.readFileSync(
  path.join(cardsDir, 'CardsPageContext.tsx'),
  'utf8',
);
const listSource = fs.readFileSync(path.join(cardsDir, 'CardsList.tsx'), 'utf8');

assert.ok(
  contextSource.includes("evaluateCardFilter(filterCard, f, 'projections')"),
  'projection provider state should use the canonical predicate contract',
);
assert.ok(
  contextSource.includes('createProjectionFilterCard(game, play1p)'),
  'projection raw plays should be adapted once before predicate evaluation',
);
assert.ok(
  !listSource.includes('.filter(({ play }) => isActionableProjectionPlay(play))'),
  'CardsList must not re-apply a second divergent projection actionability filter',
);

console.log('✅ Cards filter predicate contract tests passed');
