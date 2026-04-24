import assert from 'node:assert/strict';

import {
  buildProjectionSummaries,
  deriveCardFamily,
  deriveResultCardMode,
  shouldTrackInResults,
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

function buildCanonicalMlbPitcherKProjectionRow() {
  return {
    sport: 'MLB',
    cardType: 'mlb-pitcher-k',
    payload: {
      basis: 'PROJECTION_ONLY',
      numeric_projection: 5.9,
      recommended_direction: 'UNDER',
    },
    directionToken: 'OVER',
    officialStatus: 'PLAY',
    canonicalMarketKey: 'pitcher_strikeouts',
    canonicalProjectionRaw: 6.8,
    canonicalProjectionValue: 6.5,
    gameResultMetadata: {},
    actualResult: JSON.stringify({
      pitcher_ks: 7,
    }),
  };
}

function buildNhl1pFallbackRow() {
  return {
    sport: 'NHL',
    cardType: 'nhl-pace-1p',
    payload: {
      basis: 'PROJECTION_ONLY',
      numeric_projection: 2.2,
      recommended_direction: 'OVER',
      period: '1P',
    },
    canonicalProjectionRaw: 9.9,
    directionToken: 'UNDER',
    gameResultMetadata: {
      firstPeriodScores: {
        home: 1,
        away: 2,
      },
    },
  };
}

function buildNhlShotsPassRow() {
  return {
    sport: 'NHL',
    cardType: 'nhl-player-shots',
    payload: {
      basis: 'PROJECTION_ONLY',
      numeric_projection: 3.4,
      recommended_direction: 'UNDER',
      play: {
        player_id: '8478402',
        prop_type: 'shots_on_goal',
        decision_v2: {
          official_status: 'PASS',
        },
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
  assert.strictEqual(
    deriveCardFamily('NHL', 'nhl-moneyline-call'),
    'NHL_ML',
    'nhl-moneyline-call must resolve to NHL_ML',
  );
  assert.strictEqual(
    deriveCardFamily('MLB', 'mlb-full-game'),
    'MLB_TOTAL',
    'mlb-full-game must resolve to MLB_TOTAL',
  );
  assert.strictEqual(
    deriveCardFamily('MLB', 'mlb-full-game-ml'),
    'MLB_ML',
    'mlb-full-game-ml must resolve to MLB_ML',
  );
  assert.strictEqual(
    deriveCardFamily('MLB', 'mlb-totals-call'),
    'MLB_TOTAL',
    'legacy mlb-totals-call alias must remain mapped',
  );
  assert.strictEqual(
    deriveCardFamily('NHL', 'nhl-ml-call'),
    'NHL_ML',
    'legacy nhl-ml-call alias must remain mapped',
  );
  assert.strictEqual(
    deriveCardFamily('MLB', 'mlb-ml-call'),
    'MLB_ML',
    'legacy mlb-ml-call alias must remain mapped',
  );
  assert.strictEqual(
    shouldTrackInResults('potd-call'),
    false,
    'potd-call must be excluded from /results tracking',
  );
  assert.strictEqual(
    shouldTrackInResults('nhl-moneyline-call'),
    true,
    'non-POTD odds-backed cards must remain tracked in /results',
  );

  const summaries = buildProjectionSummaries([
    buildOddsBackedRow(),
    buildNhlShotsProjectionRow(),
    buildNhlShotsPassRow(),
    buildCanonicalMlbPitcherKProjectionRow(),
    buildNhl1pFallbackRow(),
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
  assert.strictEqual(nhlShots.sampleSize, 2);
  assert.strictEqual(nhlShots.rowsSeen, 2);
  assert.strictEqual(nhlShots.mae, 0.6);
  assert.strictEqual(nhlShots.bias, -0.6);
  assert.strictEqual(nhlShots.directionalAccuracy, 1);
  assert.strictEqual(
    nhlShots.directionalWins,
    1,
    'PASS projections must not contribute to directional wins/losses',
  );
  assert.strictEqual(
    nhlShots.directionalLosses,
    0,
    'PASS projections must be excluded from directional tallying',
  );

  const pitcherK = summaries.find((row) => row.cardFamily === 'MLB_PITCHER_K');
  assert.ok(pitcherK, 'MLB_PITCHER_K projection summary missing');
  assert.strictEqual(pitcherK.actualsAvailable, true);
  assert.strictEqual(pitcherK.sampleSize, 1);
  assert.strictEqual(pitcherK.rowsSeen, 1);
  assert.strictEqual(
    pitcherK.mae,
    0.2,
    'covered families must prefer canonical projection_raw over payload numeric_projection',
  );
  assert.strictEqual(pitcherK.bias, -0.2);
  assert.strictEqual(pitcherK.directionalAccuracy, 1);

  const nhl1p = summaries.find((row) => row.cardFamily === 'NHL_1P_TOTAL');
  assert.ok(nhl1p, 'NHL_1P_TOTAL projection summary missing');
  assert.strictEqual(nhl1p.actualsAvailable, true);
  assert.strictEqual(nhl1p.sampleSize, 1);
  assert.strictEqual(
    nhl1p.mae,
    0.8,
    'unsupported NHL_1P_TOTAL must stay on explicit payload projection fallback',
  );
  assert.strictEqual(nhl1p.bias, -0.8);

  console.log('✅ Results projection split helper test passed');
}

run();
