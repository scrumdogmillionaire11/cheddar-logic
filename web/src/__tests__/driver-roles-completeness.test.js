/*
 * DRIVER_ROLES completeness guard
 * Run: npm --prefix web run test:driver-roles
 */

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const { DRIVER_ROLES } = await import('../lib/game-card/driver-scoring.ts');

  const workerCardTypes = [
    'fpl-model-output',
    'mlb-model-output',
    'nba-base-projection',
    'nba-blowout-risk',
    'nba-matchup-style',
    'nba-rest-advantage',
    'nba-spread-call',
    'nba-total-projection',
    'nba-totals-call',
    'ncaam-base-projection',
    'ncaam-ft-trend',
    'ncaam-matchup-style',
    'ncaam-rest-advantage',
    'nfl-model-output',
    'nhl-base-projection',
    'nhl-goalie',
    'nhl-goalie-certainty',
    'nhl-lineup',
    'nhl-model-output',
    'nhl-moneyline-call',
    'nhl-pace-1p',
    'nhl-pace-totals',
    'nhl-player-shots',
    'nhl-player-shots-1p',
    'nhl-rest-advantage',
    'nhl-shot-environment',
    'nhl-spread-call',
    'nhl-totals-call',
    'soccer-model-output',
    'soccer-ohio-scope',
    'welcome-home-v2',
  ];

  const excludedFromGuard = new Set([
    'fpl-model-output',
    'mlb-model-output',
    'nfl-model-output',
    'soccer-model-output',
    'soccer-ohio-scope',
  ]);

  const requiredCardTypes = workerCardTypes.filter(
    cardType => !excludedFromGuard.has(cardType),
  );

  const missing = requiredCardTypes.filter(
    cardType => !Object.hasOwn(DRIVER_ROLES, cardType),
  );

  assert.strictEqual(
    missing.length,
    0,
    [
      'DRIVER_ROLES is missing explicit registration for worker cardType(s):',
      ...missing.map(cardType => `- ${cardType}`),
      '',
      'Add explicit entries in web/src/lib/game-card/driver-scoring.ts.',
    ].join('\n'),
  );

  console.log(
    `✅ DRIVER_ROLES completeness passed (${requiredCardTypes.length} required / ${workerCardTypes.length} worker card types, ${excludedFromGuard.size} excluded)`,
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
