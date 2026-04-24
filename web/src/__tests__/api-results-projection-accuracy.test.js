import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function resetDbEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.RECORD_DATABASE_PATH;
}

async function seedProjectionAccuracyDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cheddar-web-projection-accuracy-'));
  const dbPath = path.join(dir, 'test.db');
  resetDbEnv();
  process.env.CHEDDAR_DB_PATH = dbPath;

  const dataModule = await import('@cheddar-logic/data');
  const data = dataModule.default || dataModule;
  await data.runMigrations();
  const db = data.getDatabase();

  db.prepare(`
    INSERT INTO projection_accuracy_evals (
      card_id, game_id, sport, card_type, market_family, market_type,
      projection_raw, projection_value, synthetic_line, synthetic_rule,
      synthetic_direction, direction_strength, nearest_half_line,
      selected_direction, weak_direction_flag, projection_confidence,
      confidence_score, confidence_band, market_trust, market_trust_status,
      failure_flags, captured_at, actual, actual_value, grade_status,
      graded_result, abs_error, signed_error, absolute_error,
      expected_over_prob, expected_direction_prob, calibration_bucket
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'api-pa-card-1',
    'api-pa-game-1',
    'mlb',
    'mlb-pitcher-k',
    'MLB_PITCHER_K',
    'MLB_PITCHER_K',
    6.8,
    6.8,
    6.5,
    'nearest_half',
    'OVER',
    'STRONG',
    6.5,
    'OVER',
    0,
    60,
    60,
    'TRUST',
    'PROJECTION_ONLY',
    'TRUSTED',
    '[]',
    new Date().toISOString(),
    7,
    7,
    'GRADED',
    'WIN',
    0.2,
    -0.2,
    0.2,
    1,
    1,
    '6.0-6.9',
  );
  db.prepare(`
    INSERT INTO projection_accuracy_line_evals (
      card_id, line_role, line, eval_line, projection_value,
      direction, weak_direction_flag, edge_vs_line, confidence_score,
      confidence_band, market_trust, expected_over_prob,
      expected_direction_prob, actual_value, grade_status,
      graded_result, hit_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'api-pa-card-1',
    'SYNTHETIC',
    6.5,
    6.5,
    6.8,
    'OVER',
    0,
    0.3,
    60,
    'TRUST',
    'PROJECTION_ONLY',
    1,
    1,
    7,
    'GRADED',
    'WIN',
    1,
  );
  data.materializeProjectionAccuracyMarketHealth(db, {
    marketFamilies: ['MLB_PITCHER_K'],
    generatedAt: '2026-04-18T11:00:00.000Z',
  });
  data.closeDatabase();
}

async function run() {
  const routeSource = await fs.readFile(
    new URL('../app/api/results/projection-accuracy/route.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    routeSource.includes('getDatabaseReadOnly') &&
      routeSource.includes('closeReadOnlyInstance'),
    'projection accuracy route must use the read-only DB lifecycle',
  );
  assert.ok(
    routeSource.includes('getProjectionAccuracyEvalSummary') &&
      routeSource.includes('getProjectionAccuracyEvals') &&
      routeSource.includes('getProjectionAccuracyMarketHealth'),
    'projection accuracy route must read summary and row-level eval data',
  );
  assert.ok(
    routeSource.includes('PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY') &&
      routeSource.includes('const VALID_MARKETS = new Set(Object.keys(PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY));'),
    'projection accuracy route must derive allowed market filters from the shared data-layer analytics contract',
  );
  assert.ok(
    routeSource.includes("lineRole: 'SYNTHETIC'"),
    'projection accuracy route must report synthetic-line grading by default',
  );
  assert.ok(
    routeSource.includes('summary,') &&
      routeSource.includes('marketHealth,') &&
      routeSource.includes('rows,'),
    'projection accuracy route response must include summary, marketHealth, and rows',
  );

  await seedProjectionAccuracyDb();
  const { GET } = await import('../app/api/results/projection-accuracy/route.ts');
  const response = await GET(
    new Request('http://localhost/api/results/projection-accuracy?market_family=MLB_PITCHER_K&days=365'),
  );
  assert.strictEqual(response.status, 200);
  const payload = await response.json();
  assert.strictEqual(payload.lookbackDays, 365);
  assert.strictEqual(payload.summary.wins, 1);
  assert.strictEqual(payload.summary.losses, 0);
  assert.strictEqual(payload.rows.length, 1);
  assert.strictEqual(payload.rows[0].projection_raw, 6.8);
  assert.strictEqual(payload.rows[0].synthetic_line, 6.5);
  // WI-1115: attribution contract — all bucket-mapping fields must be present
  assert.strictEqual(payload.rows[0].weak_direction_flag, 0, 'weak_direction_flag must be 0 for a STRONG direction row');
  assert.strictEqual(payload.rows[0].direction_strength, 'STRONG', 'direction_strength must be STRONG');
  assert.strictEqual(payload.rows[0].confidence_band, 'TRUST', 'confidence_band must match seeded value');
  assert.ok(payload.rows[0].projection_confidence != null, 'projection_confidence must be present');
  assert.ok(typeof payload.rows[0].edge_distance === 'number', 'edge_distance must be a number');
  assert.ok(
    Math.abs(payload.rows[0].edge_distance - Math.abs(payload.rows[0].projection_raw - payload.rows[0].synthetic_line)) < 1e-9,
    'edge_distance must equal abs(projection_raw - synthetic_line)',
  );
  assert.strictEqual(payload.marketHealth.length, 1);
  assert.strictEqual(payload.marketHealth[0].market_family, 'MLB_PITCHER_K');

  const supportedEmptyResponse = await GET(
    new Request('http://localhost/api/results/projection-accuracy?market_family=NHL_PLAYER_SHOTS_1P&days=365'),
  );
  assert.strictEqual(supportedEmptyResponse.status, 200, 'shared contract families must be accepted even when no rows are present');
  const supportedEmptyPayload = await supportedEmptyResponse.json();
  assert.ok(Array.isArray(supportedEmptyPayload.rows), 'shared contract family response must still include rows array');

  const badResponse = await GET(
    new Request('http://localhost/api/results/projection-accuracy?market_family=BAD_MARKET'),
  );
  assert.strictEqual(badResponse.status, 400);

  console.log('✅ Projection accuracy results API seeded route contract passed');
}

run().catch((error) => {
  console.error('❌ Projection accuracy results API source contract failed');
  console.error(error.message || error);
  process.exit(1);
});
