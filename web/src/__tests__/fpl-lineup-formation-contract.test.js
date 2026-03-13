/*
 * FPL lineup formation contract test
 * Verifies recommended lineup renders by position rows using lineup_decision.
 * Run: node web/src/__tests__/fpl-lineup-formation-contract.test.js
 */

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const fs = await import('node:fs/promises');

  const lineupSource = await fs.readFile(
    new URL('../components/fpl-lineup-view.tsx', import.meta.url),
    'utf8',
  );

  [
    'lineupDecision?: LineupDecisionPayload | null;',
    'const POSITION_ORDER = [\'GK\', \'DEF\', \'MID\', \'FWD\'] as const;',
    'Recommended formation: {lineupDecision.formation}',
    'POSITION_ORDER.map((position) => {',
    'rowPlayers.length',
    'bench_order',
    'const ownership = parseNumeric(player.ownership);',
    'ownership !== null',
  ].forEach((requiredText) => {
    assert.ok(
      lineupSource.includes(requiredText),
      `Lineup view missing formation behavior contract: ${requiredText}`,
    );
  });

  const dashboardSource = await fs.readFile(
    new URL('../components/fpl-dashboard.tsx', import.meta.url),
    'utf8',
  );

  assert.ok(
    dashboardSource.includes('lineupDecision={data.lineup_decision}'),
    'Dashboard must pass lineup_decision to lineup view',
  );

  const apiSource = await fs.readFile(
    new URL('../lib/fpl-api.ts', import.meta.url),
    'utf8',
  );

  [
    'export interface LineupDecisionPayload',
    'export interface LineupDecisionStarter',
    'export interface LineupDecisionBench',
    'lineup_decision?: LineupDecisionPayload | null;',
  ].forEach((contractLine) => {
    assert.ok(
      apiSource.includes(contractLine),
      `FPL API contract missing lineup decision type support: ${contractLine}`,
    );
  });

  console.log('✅ FPL lineup formation contract test passed');
}

run().catch((error) => {
  console.error('❌ FPL lineup formation contract test failed');
  console.error(error.message || error);
  process.exit(1);
});
