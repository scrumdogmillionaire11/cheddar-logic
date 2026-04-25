/*
 * API admin model-health behavioral test.
 *
 * Run: node web/src/__tests__/api-admin-model-health.test.js
 */

import assert from 'node:assert/strict';
import db from '../../../packages/data/src/db.js';
import {
  setupIsolatedTestDb,
  startIsolatedNextServer,
} from './db-test-runtime.js';

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getEtDateKey(date = new Date()) {
  return ET_DATE_FORMATTER.format(date);
}

function insertSnapshot(client, row) {
  client
    .prepare(
      `INSERT INTO model_health_snapshots
       (sport, run_at, hit_rate, roi_units, roi_pct, total_unique, wins, losses,
        streak, last10_hit_rate, status, signals_json, lookback_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.sport,
      row.runAt,
      row.hitRate,
      row.roiUnits,
      row.roiPct,
      row.totalUnique,
      row.wins,
      row.losses,
      row.streak,
      row.last10HitRate,
      row.status,
      row.signalsJson,
      row.lookbackDays,
    );
}

function seedPotdHealth(client) {
  const today = getEtDateKey();
  const nowIso = new Date().toISOString();

  client
    .prepare(
      `INSERT INTO potd_daily_stats
       (play_date, potd_fired, candidate_count, viable_count, top_edge_pct,
        top_score, selected_edge_pct, selected_score, stake_pct_of_bankroll,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(today, 1, 6, 2, 7.5, 88, 6.1, 84, 0.02, nowIso);

  client
    .prepare(
      `INSERT INTO potd_shadow_results
       (play_date, candidate_identity_key, shadow_candidate_id, game_id, sport,
        market_type, selection, selection_label, line, price, game_time_utc,
        status, result, virtual_stake_units, pnl_units, settled_at,
        grading_metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      today,
      'MLB|potd-shadow-win|TOTAL|OVER|8.500',
      null,
      'potd-shadow-win',
      'MLB',
      'TOTAL',
      'OVER',
      'Over 8.5',
      8.5,
      -110,
      nowIso,
      'settled',
      'win',
      1,
      0.91,
      nowIso,
      '{}',
      nowIso,
      nowIso,
    );
  client
    .prepare(
      `INSERT INTO potd_shadow_results
       (play_date, candidate_identity_key, shadow_candidate_id, game_id, sport,
        market_type, selection, selection_label, line, price, game_time_utc,
        status, result, virtual_stake_units, pnl_units, settled_at,
        grading_metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      today,
      'MLB|potd-shadow-pending|TOTAL|UNDER|8.500',
      null,
      'potd-shadow-pending',
      'MLB',
      'TOTAL',
      'UNDER',
      'Under 8.5',
      8.5,
      -105,
      nowIso,
      'pending',
      null,
      1,
      null,
      null,
      '{}',
      nowIso,
      nowIso,
    );
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('api-admin-model-health');
  let server = null;

  try {
    const client = db.getDatabase();
    seedPotdHealth(client);
    insertSnapshot(client, {
      sport: 'NBA',
      runAt: '2026-04-20T12:00:00.000Z',
      hitRate: 0.51,
      roiUnits: -1.25,
      roiPct: -0.04,
      totalUnique: 48,
      wins: 24,
      losses: 24,
      streak: 'L1',
      last10HitRate: 0.5,
      status: 'WATCH',
      signalsJson: '["old_snapshot"]',
      lookbackDays: 30,
    });
    insertSnapshot(client, {
      sport: 'NBA',
      runAt: '2026-04-21T12:00:00.000Z',
      hitRate: 0.58,
      roiUnits: 3.75,
      roiPct: 0.12,
      totalUnique: 50,
      wins: 29,
      losses: 21,
      streak: 'W3',
      last10HitRate: 0.7,
      status: 'OK',
      signalsJson: '["positive_roi","volume_ok"]',
      lookbackDays: 30,
    });
    insertSnapshot(client, {
      sport: 'NBA',
      runAt: '2026-04-22T12:00:00.000Z',
      hitRate: 0.8,
      roiUnits: 9,
      roiPct: 0.3,
      totalUnique: 10,
      wins: 8,
      losses: 2,
      streak: 'W8',
      last10HitRate: 0.8,
      status: 'IGNORED',
      signalsJson: '["wrong_window"]',
      lookbackDays: 14,
    });
    insertSnapshot(client, {
      sport: 'NHL',
      runAt: '2026-04-21T11:00:00.000Z',
      hitRate: 0.44,
      roiUnits: -2.5,
      roiPct: -0.09,
      totalUnique: 25,
      wins: 11,
      losses: 14,
      streak: 'L2',
      last10HitRate: 0.4,
      status: 'CAUTION',
      signalsJson: '{"not":"an array"}',
      lookbackDays: 30,
    });

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'api-admin-model-health',
      readinessPath: '/api/admin/model-health',
    });

    const response = await fetch(`${server.baseUrl}/api/admin/model-health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, 'model-health route should return 200');
    assert.match(
      response.headers.get('content-type') || '',
      /application\/json/,
      'model-health response should be JSON',
    );
    assert.ok(
      response.headers.has('x-ratelimit-limit'),
      'model-health response should include rate-limit headers',
    );

    const payload = await response.json();
    assert.equal(payload.success, true, 'model-health success=false');
    assert.ok(Array.isArray(payload.data), 'model-health data must be an array');
    assert.deepEqual(
      payload.data.map((row) => row.sport),
      ['NBA', 'NHL'],
      'route should return the latest 30-day row per sport only',
    );

    const nba = payload.data.find((row) => row.sport === 'NBA');
    assert.equal(
      nba.run_at,
      '2026-04-21T12:00:00.000Z',
      'NBA row should be the latest 30-day snapshot',
    );
    assert.equal(nba.hit_rate, 0.58, 'NBA hit_rate should come from DB row');
    assert.equal(nba.roi_units, 3.75, 'NBA roi_units should come from DB row');
    assert.deepEqual(
      nba.signals,
      ['positive_roi', 'volume_ok'],
      'signals_json should parse into response signals',
    );

    const nhl = payload.data.find((row) => row.sport === 'NHL');
    assert.deepEqual(
      nhl.signals,
      [],
      'non-array signals_json should be sanitized to an empty signal list',
    );
    assert.ok(payload.potd_health, 'model-health should include top-level potd_health');
    assert.equal(
      payload.potd_health.today_state,
      'fired',
      'potd_health should expose today fired/no-pick state',
    );
    assert.equal(
      payload.potd_health.candidate_count,
      6,
      'potd_health should expose candidate volume from daily stats',
    );
    assert.equal(
      payload.potd_health.near_miss.counts.settled,
      1,
      'potd_health should expose settled near-miss count',
    );
    assert.equal(
      payload.potd_health.near_miss.counts.pending,
      1,
      'potd_health should expose pending near-miss count',
    );

    console.log('✅ API admin model-health behavioral test passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ API admin model-health behavioral test failed');
  console.error(error);
  process.exit(1);
});
