/*
 * FPL dashboard strategy contract test
 * Verifies strategy/transparency sections are wired and captain delta rendering is guarded.
 * Run: node web/src/__tests__/fpl-dashboard-strategy.test.js
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
    'Manager State',
    'Near Threshold Moves',
    'Strategy Paths',
    'Structural Issues',
    'Chip Timing Outlook',
  ].forEach((section) => {
    assert.ok(
      dashboardSource.includes(section),
      `Dashboard missing section heading: ${section}`,
    );
  });

  assert.ok(
    dashboardSource.includes('captainDelta !== null'),
    'Captain delta should render only when numeric value exists',
  );
  assert.ok(
    !dashboardSource.includes('data.captain_delta?.delta_pts !== undefined'),
    'Legacy captain delta guard should not be used',
  );
  assert.ok(
    dashboardSource.includes('Captain delta vs vice:'),
    'Captain delta label missing from dashboard',
  );

  const apiSource = await fs.readFile(
    new URL('../lib/fpl-api.ts', import.meta.url),
    'utf8',
  );

  [
    'manager_state?: ManagerState | null;',
    'strategy_mode?: string | null;',
    'near_threshold_moves?: NearThresholdMove[] | null;',
    'strategy_paths?: StrategyPaths | null;',
    'squad_issues?: SquadIssue[] | null;',
    'chip_timing_outlook?: ChipTimingOutlook | null;',
  ].forEach((contractLine) => {
    assert.ok(
      apiSource.includes(contractLine),
      `DetailedAnalysisResponse missing additive field: ${contractLine}`,
    );
  });

  console.log('✅ FPL dashboard strategy contract test passed');
}

run().catch((error) => {
  console.error('❌ FPL dashboard strategy contract test failed');
  console.error(error.message || error);
  process.exit(1);
});
