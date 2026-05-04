/*
 * Contract tests for Game Props sport filtering.
 * Ensures props cards respect sport chips even when upstream sport metadata is degraded.
 */

import assert from 'node:assert';

import { DEFAULT_PROPS_FILTERS } from '../lib/game-card/filters';
import { filterPropCards } from '../components/cards/shared';

function makePropRow(overrides = {}) {
  return {
    playerId: '1',
    playerName: 'Test Player',
    propType: 'Strikeouts',
    line: 6.5,
    projection: 7.1,
    confidence: 0.72,
    price: -110,
    status: 'WATCH',
    edge: 0.6,
    sourceCardType: 'mlb-player-k',
    sourceCardTitle: 'Pitcher Strikeouts',
    updatedAtUtc: '2026-05-04T17:00:00.000Z',
    ...overrides,
  };
}

function makePropGameCard(overrides = {}) {
  return {
    gameId: 'game-1',
    sport: 'UNKNOWN',
    gameTimeUtc: '2026-05-04T23:46:00.000Z',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    status: 'scheduled',
    propPlays: [makePropRow()],
    maxConfidence: 0.72,
    tags: [],
    ...overrides,
  };
}

console.log('props sport filter contract tests');

{
  const cards = [
    makePropGameCard({
      gameId: 'mlb-game',
      propPlays: [makePropRow({ sourceCardType: 'mlb-player-k', propType: 'Strikeouts' })],
    }),
    makePropGameCard({
      gameId: 'nhl-game',
      propPlays: [makePropRow({ sourceCardType: 'nhl-player-sog', propType: 'Shots on Goal' })],
    }),
  ];

  const filters = {
    ...DEFAULT_PROPS_FILTERS,
    sports: ['MLB'],
  };

  const filtered = filterPropCards(cards, filters);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].gameId, 'mlb-game');
}

{
  const cards = [
    makePropGameCard({
      gameId: 'nhl-props-lane',
      sport: 'NHL_PROPS',
      propPlays: [makePropRow({ sourceCardType: 'nhl-player-sog', propType: 'Shots on Goal' })],
    }),
  ];

  const filters = {
    ...DEFAULT_PROPS_FILTERS,
    sports: ['NHL'],
  };

  const filtered = filterPropCards(cards, filters);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].gameId, 'nhl-props-lane');
}

{
  const cards = [
    makePropGameCard({
      gameId: 'mixed-card',
      sport: 'MLB',
      propPlays: [
        makePropRow({ sourceCardType: 'mlb-player-k', propType: 'Strikeouts', playerName: 'MLB Pitcher' }),
        makePropRow({ sourceCardType: 'nhl-player-sog', propType: 'Shots on Goal', playerName: 'NHL Skater' }),
      ],
    }),
  ];

  const filters = {
    ...DEFAULT_PROPS_FILTERS,
    sports: ['MLB'],
  };

  const filtered = filterPropCards(cards, filters);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].propPlays.length, 1);
  assert.equal(filtered[0].propPlays[0].playerName, 'MLB Pitcher');
}

console.log('props sport filter contract tests passed');
