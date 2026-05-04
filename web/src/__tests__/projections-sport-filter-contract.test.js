/*
 * Contract tests for Game Props (projections mode) sport filtering.
 */

import assert from 'node:assert';

import { DEFAULT_PROJECTIONS_FILTERS } from '../lib/game-card/filters';
import { matchesProjectionSportFilter } from '../components/cards/shared';

function makeGame(overrides = {}) {
  return {
    id: 'g-1',
    gameId: 'g-1',
    sport: 'MLB',
    homeTeam: 'Home',
    awayTeam: 'Away',
    gameTimeUtc: '2026-05-04T23:46:00.000Z',
    status: 'scheduled',
    createdAt: '2026-05-04T17:00:00.000Z',
    plays: [],
    ...overrides,
  };
}

console.log('projections sport filter contract tests');

{
  const filters = { ...DEFAULT_PROJECTIONS_FILTERS, sports: ['NHL', 'NBA'] };
  const mlbGame = makeGame({ sport: 'MLB' });
  assert.equal(matchesProjectionSportFilter(mlbGame, filters), false);
}

{
  const filters = { ...DEFAULT_PROJECTIONS_FILTERS, sports: ['NHL', 'NBA'] };
  const nhlGame = makeGame({ sport: 'nhl' });
  assert.equal(matchesProjectionSportFilter(nhlGame, filters), true);
}

console.log('projections sport filter contract tests passed');
