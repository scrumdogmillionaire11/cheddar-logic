import assert from 'node:assert/strict';

import {
  buildProjectionSummaries,
  deriveResultCardMode,
} from '../app/api/results/projection-metrics.ts';

function buildNhlShotsProjectionRow() {
  return {
    sport: 'NHL',
    cardType: 'nhl-player-shots',
    payload: {
      basis: 'PROJECTION_ONLY',
      numeric_projection: 3.4,
      recommended_direction: 'OVER',
      play: {
        player_id: '8478402',
        prop_type: 'shots_on_goal',
      },
    },
    gameResultMetadata: {
      playerShots: {
        fullGameByPlayerId: {
          '8478402': 4,
        },
      },
    },
  };
}

function buildMlbPitcherKProjectionRow() {
  return {
    sport: 'MLB',
    cardType: 'mlb-pitcher-k',
    payload: {
      basis: 'PROJECTION_ONLY',
      numeric_projection: 6.8,
      recommended_direction: 'OVER',
    },
    gameResultMetadata: {},
  };
}

function buildOddsBackedRow() {
  return {
    sport: 'NHL',
    cardType: 'nhl-pace-totals',
    payload: {
      decision_basis_meta: {
        decision_basis: 'ODDS_BACKED',
      },
      model: {
        expectedTotal: 6.4,
      },
      prediction: 'OVER',
    },
    gameResultMetadata: {
      firstPeriodScores: {
        home: 2,
        away: 1,
      },
    },
  };
}

function run() {
  assert.strictEqual(
    deriveResultCardMode({
      decision_basis_meta: { decision_basis: 'ODDS_BACKED' },
    }),
    'ODDS_BACKED',
    'explicit ODDS_BACKED basis must remain ODDS_BACKED',
  );
  assert.strictEqual(
    deriveResultCardMode({ basis: 'PROJECTION_ONLY' }),
    'PROJECTION_ONLY',
    'explicit PROJECTION_ONLY basis must remain PROJECTION_ONLY',
  );
  assert.strictEqual(
    deriveResultCardMode({
      market_context: { wager: { line_source: 'projection_floor' } },
    }),
    'PROJECTION_ONLY',
    'projection-floor line source must infer PROJECTION_ONLY',
  );

  const summaries = buildProjectionSummaries([
    buildOddsBackedRow(),
    buildNhlShotsProjectionRow(),
    buildMlbPitcherKProjectionRow(),
  ]);

  assert.strictEqual(
    summaries.some((row) => row.cardFamily === 'NHL_TOTAL'),
    false,
    'ODDS_BACKED rows must not produce projection summaries',
  );

  const nhlShots = summaries.find(
    (row) => row.cardFamily === 'NHL_PLAYER_SHOTS',
  );
  assert.ok(nhlShots, 'NHL_PLAYER_SHOTS projection summary missing');
  assert.strictEqual(nhlShots.actualsAvailable, true);
  assert.strictEqual(nhlShots.sampleSize, 1);
  assert.strictEqual(nhlShots.rowsSeen, 1);
  assert.strictEqual(nhlShots.mae, 0.6);
  assert.strictEqual(nhlShots.bias, -0.6);
  assert.strictEqual(nhlShots.directionalAccuracy, 1);

  const pitcherK = summaries.find((row) => row.cardFamily === 'MLB_PITCHER_K');
  assert.ok(pitcherK, 'MLB_PITCHER_K projection summary missing');
  assert.strictEqual(pitcherK.actualsAvailable, false);
  assert.strictEqual(pitcherK.sampleSize, 0);
  assert.strictEqual(pitcherK.rowsSeen, 1);
  assert.strictEqual(pitcherK.mae, null);
  assert.strictEqual(pitcherK.bias, null);
  assert.strictEqual(pitcherK.directionalAccuracy, null);

  console.log('✅ Results projection split helper test passed');
}

run();
