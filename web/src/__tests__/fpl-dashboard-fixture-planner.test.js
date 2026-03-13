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
    dashboardSource.includes('const fixturePlanner = data.fixture_planner ?? {'),
    'Dashboard should normalize fixture_planner to a deterministic object',
  );
  assert.ok(
    dashboardSource.includes('No DGW/BGW events flagged in the current 8-GW horizon.'),
    'Planner should show deterministic horizon-empty copy instead of unavailable fallback',
  );
  assert.ok(
    dashboardSource.includes('plannerStructurallyEmpty') &&
      dashboardSource.includes('data.fixture_planner_reason?.trim()'),
    'Planner empty state should prefer backend fixture_planner_reason when structurally empty',
  );
  assert.ok(
    !dashboardSource.includes('Planner data unavailable for this run. Re-run analysis to refresh'),
    'Planner unavailable fallback should not be the default rendering path',
  );
  assert.ok(
    !dashboardSource.includes('Planner Status'),
    'Planner status fallback header should be retired',
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
    'fixture_planner_reason?: string | null;',
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
