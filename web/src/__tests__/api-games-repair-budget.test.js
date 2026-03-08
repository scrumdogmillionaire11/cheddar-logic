/*
 * Contract guard for wave-1 decision_v2 pass-through.
 * Run: npm --prefix web run test:api:games:repair-budget
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const WAVE1_SPORTS = new Set(['NBA', 'NHL', 'NCAAM']);
const WAVE1_MARKETS = new Set([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
]);

function isWave1Play(game, play) {
  const sport = String(game?.sport ?? '').toUpperCase();
  const kind = String(play?.kind ?? 'PLAY').toUpperCase();
  const marketType = String(play?.market_type ?? '').toUpperCase();
  return (
    kind === 'PLAY' &&
    WAVE1_SPORTS.has(sport) &&
    WAVE1_MARKETS.has(marketType)
  );
}

async function runSourceContractAssertions(assert) {
  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const fs = fsModule.default || fsModule;
  const path = pathModule.default || pathModule;
  const routePath = path.resolve('src/app/api/games/route.ts');
  const source = fs.readFileSync(routePath, 'utf8');

  assert.ok(
    source.includes('if (wave1Eligible) {') &&
      source.includes('if (!play.decision_v2) {') &&
      source.includes('applyWave1DecisionFields(play);'),
    'route must hard-require worker decision_v2 and map wave-1 fields from it',
  );

  assert.ok(
    !source.includes('repair_applied') &&
      !source.includes('repair_rule_id') &&
      !source.includes('repair_stats:'),
    'route must not inject legacy repair metadata in API output',
  );
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  await runSourceContractAssertions(assert);

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/api/games?limit=200`);
  assert.strictEqual(response.ok, true, `API response not ok: ${response.status}`);

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(payload, 'repair_stats'),
    false,
    'API payload must not include repair_stats metadata',
  );

  const games = Array.isArray(payload.data) ? payload.data : [];
  const wave1Plays = games.flatMap((game) =>
    (Array.isArray(game.plays) ? game.plays : []).filter((play) =>
      isWave1Play(game, play),
    ),
  );

  for (const play of wave1Plays) {
    assert.ok(play.decision_v2, 'wave-1 play must include decision_v2');
    assert.strictEqual(
      play.decision_v2.pipeline_version,
      'v2',
      'wave-1 decision_v2 must be v2',
    );
    assert.ok(
      ['PLAY', 'LEAN', 'PASS'].includes(play.decision_v2.official_status),
      'wave-1 decision_v2.official_status must be PLAY/LEAN/PASS',
    );
    assert.strictEqual(
      typeof play.decision_v2.primary_reason_code,
      'string',
      'wave-1 decision_v2.primary_reason_code must be a string',
    );
    assert.ok(
      play.decision_v2.primary_reason_code.length > 0,
      'wave-1 decision_v2.primary_reason_code must be non-empty',
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(play, 'repair_applied'),
      false,
      'wave-1 play must not expose repair_applied',
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(play, 'repair_rule_id'),
      false,
      'wave-1 play must not expose repair_rule_id',
    );
  }

  console.log('✅ API games decision_v2 pass-through contract test passed');
}

run().catch((error) => {
  console.error('❌ API games decision_v2 pass-through contract test failed');
  console.error(error.message || error);
  process.exit(1);
});
