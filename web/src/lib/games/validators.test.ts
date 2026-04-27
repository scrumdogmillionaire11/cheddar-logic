import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessProjectionInputsFromRawData,
  deriveSourceMappingHealth,
  getActiveRunIds,
  getFallbackRunIdsFromCards,
  getRunStatus,
  hasMinimumViability,
} from './validators';

test('validators smoke', () => {
  const projection = assessProjectionInputsFromRawData(
    'NBA',
    JSON.stringify({
      home: { avg_points: 110, avg_points_allowed: 102 },
      away: { avg_points: 108, avg_points_allowed: 104 },
    }),
  );
  assert.equal(projection.projection_inputs_complete, true);

  const mapping = deriveSourceMappingHealth({
    espn_metrics: {
      source_contract: {
        mapping_ok: false,
        mapping_failures: ['team_alias_miss'],
      },
    },
  });
  assert.equal(mapping.source_mapping_ok, false);
  assert.deepEqual(mapping.source_mapping_failures, ['team_alias_miss']);

  const objectMapping = deriveSourceMappingHealth({
    espn_metrics: {
      source_contract: {
        mapping_ok: false,
        mapping_failures: [
          { code: 'TEAM_ALIAS_MISS', team: 'Tampa Bay Rays' },
          { reason: 'home_team_missing' },
        ],
      },
    },
  });
  assert.deepEqual(objectMapping.source_mapping_failures, [
    'TEAM_ALIAS_MISS:Tampa Bay Rays',
    'home_team_missing',
  ]);

  assert.equal(
    hasMinimumViability(
      { selection: { side: 'OVER' }, line: 5.5, price: null },
      'TOTAL',
    ),
    true,
  );
});

test.skip('validators db helpers require a real database', () => {
  void getActiveRunIds;
  void getFallbackRunIdsFromCards;
  void getRunStatus;
});
