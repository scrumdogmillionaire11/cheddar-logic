/*
 * FPL dashboard fixture planner contract test
 * Verifies DGW/BGW planner section and additive API types are wired.
 * Run: node web/src/__tests__/fpl-dashboard-fixture-planner.test.js
 */

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const fs = await import('node:fs/promises');

  const dashboardSource = await fs.readFile(
    new URL('../components/fpl-dashboard.tsx', import.meta.url),
    'utf8',
  );

  [
    'DGW/BGW Planner (Next 8 GWs)',
    'Your Squad',
    'Potential Targets',
    'Key Planning Notes',
    'DGW',
    'BGW',
  ].forEach((requiredText) => {
    assert.ok(
      dashboardSource.includes(requiredText),
      `Dashboard planner rendering missing text: ${requiredText}`,
    );
  });

  assert.ok(
    dashboardSource.includes('const fixturePlanner = data.fixture_planner;'),
    'Dashboard should read fixture_planner from payload',
  );
  assert.ok(
    dashboardSource.includes('{fixturePlanner ? ('),
    'Planner section should render only when fixture_planner is present',
  );

  const apiSource = await fs.readFile(
    new URL('../lib/fpl-api.ts', import.meta.url),
    'utf8',
  );

  [
    'export interface FixturePlannerData',
    'export interface FixturePlannerPlayerWindow',
    'export interface FixturePlannerUpcomingRow',
    'fixture_planner?: FixturePlannerData | null;',
  ].forEach((contractLine) => {
    assert.ok(
      apiSource.includes(contractLine),
      `DetailedAnalysisResponse/API type missing planner contract: ${contractLine}`,
    );
  });

  console.log('✅ FPL dashboard fixture planner contract test passed');
}

run().catch((error) => {
  console.error('❌ FPL dashboard fixture planner contract test failed');
  console.error(error.message || error);
  process.exit(1);
});
