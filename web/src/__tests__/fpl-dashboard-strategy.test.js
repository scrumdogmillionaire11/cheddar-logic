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
  assert.ok(
    dashboardSource.includes('const nearThresholdEmptyText ='),
    'Dashboard should define section-specific near-threshold empty copy',
  );
  assert.ok(
    dashboardSource.includes('data.near_threshold_reason?.trim()'),
    'Near-threshold empty state should prioritize backend near_threshold_reason',
  );
  assert.ok(
    dashboardSource.includes('const strategyPathsEmptyText ='),
    'Dashboard should define section-specific strategy-path empty copy',
  );
  assert.ok(
    dashboardSource.includes('data.strategy_paths_reason?.trim()'),
    'Strategy-path empty state should prioritize backend strategy_paths_reason',
  );
  assert.ok(
    dashboardSource.includes('const normalizeReasoningText ='),
    'Dashboard should normalize contradictory reasoning text',
  );
  assert.ok(
    dashboardSource.includes("normalizedCode === 'NO_CHIP_ACTION'"),
    'Dashboard should normalize raw NO_CHIP_ACTION decision codes',
  );
  assert.ok(
    dashboardSource.includes("raw.toLowerCase().includes('no free transfers')"),
    'Dashboard should guard against contradictory no-free-transfer reasoning copy',
  );
  assert.ok(
    dashboardSource.includes(
      'normalizeDecisionText(\n    data.primary_decision,\n    normalizedFreeTransferCount,\n  )',
    ),
    'Dashboard should normalize decision text with effective free-transfer context',
  );
  assert.ok(
    dashboardSource.includes('{parseNumeric(plan.delta_pts_4gw) !== null && ('),
    'Transfer plan delta display should guard against null numeric values',
  );
  assert.ok(
    !dashboardSource.includes('{plan.delta_pts_4gw !== undefined && ('),
    'Transfer plan delta display should not use undefined-only guards',
  );
  assert.ok(
    !dashboardSource.includes('{transferDiagnostic}'),
    'Near-threshold/strategy empty states should not reuse transfer diagnostic text',
  );
  assert.ok(
    dashboardSource.includes(
      'No near-threshold moves this gameweek. Candidate swaps were either clearly above threshold or well below required gain.',
    ),
    'Near-threshold empty state should use section-specific copy',
  );
  assert.ok(
    dashboardSource.includes('No distinct strategy-path alternatives this gameweek.'),
    'Strategy-path empty state should use section-specific copy',
  );
  assert.ok(
    !dashboardSource.includes('No near-threshold alternatives available this gameweek.'),
    'Near-threshold empty state should use diagnostic reasoning instead of static generic copy',
  );
  assert.ok(
    !dashboardSource.includes('No path generated'),
    'Strategy path empty state should not use repeated generic placeholder copy',
  );

  const apiSource = await fs.readFile(
    new URL('../lib/fpl-api.ts', import.meta.url),
    'utf8',
  );

  [
    'manager_state?: ManagerState | null;',
    'strategy_mode?: string | null;',
    'near_threshold_moves?: NearThresholdMove[] | null;',
    'out_player_id?: number;',
    'in_player_id?: number;',
    'near_threshold_reason?: string | null;',
    'strategy_paths?: StrategyPaths | null;',
    'strategy_paths_reason?: string | null;',
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
