/*
 * API admin pipeline-health behavioral test.
 *
 * Run: node web/src/__tests__/api-admin-pipeline-health.test.js
 */

import assert from 'node:assert/strict';
import db from '../../../packages/data/src/db.js';
import {
  setupIsolatedTestDb,
  startIsolatedNextServer,
} from './db-test-runtime.js';

function countRows(client, tableName) {
  return client.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('api-admin-pipeline-health');
  let server = null;

  try {
    const client = db.getDatabase();
    client
      .prepare(
        `INSERT INTO pipeline_health
         (phase, check_name, status, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'cards',
        'freshness',
        'ok',
        'fresh cards available',
        '2026-04-21T12:00:00.000Z',
      );

    const beforeCounts = {
      pipelineHealth: countRows(client, 'pipeline_health'),
      potdDailyStats: countRows(client, 'potd_daily_stats'),
      potdShadowResults: countRows(client, 'potd_shadow_results'),
    };

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'api-admin-pipeline-health',
      readinessPath: '/api/admin/pipeline-health',
    });

    const response = await fetch(`${server.baseUrl}/api/admin/pipeline-health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, 'pipeline-health route should return 200');
    assert.match(
      response.headers.get('content-type') || '',
      /application\/json/,
      'pipeline-health response should be JSON',
    );
    assert.ok(
      response.headers.has('x-ratelimit-limit'),
      'pipeline-health response should include rate-limit headers',
    );

    const payload = await response.json();
    assert.equal(payload.success, true, 'pipeline-health success=false');
    assert.ok(Array.isArray(payload.data), 'pipeline-health data must remain an array');
    assert.equal(payload.data.length, 1, 'existing pipeline_health rows should still be returned');
    assert.equal(payload.data[0].phase, 'cards');
    assert.equal(payload.data[0].check_name, 'freshness');

    assert.ok(
      Array.isArray(payload.potd_lanes),
      'pipeline-health should include additive potd_lanes array',
    );
    assert.deepEqual(
      payload.potd_lanes.map((lane) => lane.check_name),
      ['run_recency', 'today_state', 'candidate_volume', 'near_miss_settlement'],
      'POTD lanes should be attributable by phase/check',
    );
    assert.ok(
      payload.potd_lanes.every((lane) => lane.phase === 'potd' && lane.virtual === true),
      'POTD lanes should be marked as virtual read-only checks',
    );

    const runRecency = payload.potd_lanes.find((lane) => lane.check_name === 'run_recency');
    const todayState = payload.potd_lanes.find((lane) => lane.check_name === 'today_state');
    const candidateVolume = payload.potd_lanes.find((lane) => lane.check_name === 'candidate_volume');
    const nearMissSettlement = payload.potd_lanes.find((lane) => lane.check_name === 'near_miss_settlement');
    assert.equal(runRecency.status, 'failed', 'sparse POTD history should fail run recency');
    assert.equal(todayState.status, 'failed', 'sparse POTD history should fail today state');
    assert.equal(candidateVolume.status, 'warning', 'zero candidates should degrade candidate volume');
    assert.equal(
      nearMissSettlement.status,
      'warning',
      'missing near-miss history should degrade but not crash',
    );
    assert.match(
      nearMissSettlement.reason,
      /0 settled, 0 pending/,
      'near-miss lane should expose status counts',
    );

    const afterCounts = {
      pipelineHealth: countRows(client, 'pipeline_health'),
      potdDailyStats: countRows(client, 'potd_daily_stats'),
      potdShadowResults: countRows(client, 'potd_shadow_results'),
    };
    assert.deepEqual(
      afterCounts,
      beforeCounts,
      'pipeline-health route must not write to pipeline or POTD tables',
    );

    console.log('✅ API admin pipeline-health behavioral test passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ API admin pipeline-health behavioral test failed');
  console.error(error);
  process.exit(1);
});
