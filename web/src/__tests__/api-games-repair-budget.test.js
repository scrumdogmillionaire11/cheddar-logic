/*
 * Contract guard for wave-1 decision_v2 pass-through.
 * Live mode: CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:games:repair-budget
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:games:repair-budget';
const WAVE1_SPORTS = new Set(['NBA', 'NHL', 'MLB']);
const WAVE1_MARKETS = new Set([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
  'FIRST_PERIOD',
]);

function isWave1Play(game, play) {
  const sport = String(game?.sport ?? '').toUpperCase();
  const kind = String(play?.kind ?? 'PLAY').toUpperCase();
  const marketType = String(play?.market_type ?? '').toUpperCase();
  return (
    kind === 'PLAY' && WAVE1_SPORTS.has(sport) && WAVE1_MARKETS.has(marketType)
  );
}

function isConnectionIssue(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND')
  );
}

function buildFallbackMessage(baseUrl) {
  return (
    `Games API endpoint unavailable at ${baseUrl}; running source fallback checks. ` +
    `To run live assertions: ${LIVE_COMMAND}`
  );
}

async function preflightGamesEndpoint(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/api/games?limit=1`);
  assert.strictEqual(
    response.ok,
    true,
    `Games API preflight not ok: ${response.status}`,
  );
}

async function runSourceContractAssertions(assert) {
  const fs = await import('node:fs/promises');
  // WI-0621 thinned app/api/games/route.ts to a re-export shim; read the handler directly.
  const source = await fs.readFile(
    new URL('../lib/games/route-handler.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    source.includes("const isPropPlay = play.market_type === 'PROP';") &&
      source.includes('if (wave1Eligible && !isPropPlay) {') &&
      source.includes('if (!play.decision_v2) {') &&
      source.includes('applyWave1DecisionFields(play);'),
    'route must hard-require worker decision_v2 for non-PROP wave-1 rows and map fields from it',
  );
  assert.ok(
    source.includes("horizon_contract: 'v1-et-boundary-aware'") &&
      !source.includes('API_GAMES_HORIZON_HOURS') &&
      !source.includes('HAS_API_GAMES_HORIZON'),
    'route must enforce fixed ET-boundary horizon contract (no configurable hour-window overrides)',
  );
  assert.ok(
    source.includes("'base_games'") &&
      source.includes("'card_rows'") &&
      source.includes("'parsed_rows'") &&
      source.includes("'wave1_skipped_no_d2'") &&
      source.includes("'plays_emitted'") &&
      source.includes("'games_with_plays'"),
    'route must define all required stage counters',
  );
  assert.ok(
    source.includes('const combinedDiagnostics') &&
      source.includes('diagnostics: combinedDiagnostics'),
    'route must attach non-prod diagnostics metadata to response meta',
  );
  assert.ok(
    source.includes('buildGamesResponseData(deduplicatedRows, lifecycleMode') &&
      source.includes("response_mode: params.responseMode") &&
      source.includes('timeout_fallback: params.timeoutFallback ?? false') &&
      source.includes('cache_age_ms: params.cacheAgeMs ?? null'),
    'route must build /api/games responses through the timeout-aware payload helper',
  );
  assert.ok(
    source.includes('true_play: truePlayMap.get(row.game_id) ?? null') &&
      source.includes('db.pragma(`busy_timeout = ${busyTimeoutMs}`)') &&
      source.includes('buildGamesTimeoutFallbackPayload('),
    'route must preserve canonical true_play while applying read-only busy_timeout and timeout fallback handling',
  );

  assert.ok(
    !source.includes('repair_applied') &&
      !source.includes('repair_rule_id') &&
      !source.includes('repair_stats:'),
    'route must not inject legacy repair metadata in API output',
  );
}

async function validateLivePayload(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/api/games?limit=200`);

  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(payload, 'repair_stats'),
    false,
    'API payload must not include repair_stats metadata',
  );
  assert.ok(
    payload.meta && typeof payload.meta === 'object',
    'API payload must include meta',
  );
  assert.strictEqual(
    payload.meta.response_mode,
    'full',
    'healthy /api/games responses should report response_mode=full',
  );
  assert.strictEqual(
    payload.meta.timeout_fallback,
    false,
    'healthy /api/games responses should not report timeout_fallback',
  );

  if (payload.meta?.diagnostics) {
    const diagnostics = payload.meta.diagnostics;
    assert.ok(
      diagnostics.stage_counters &&
        typeof diagnostics.stage_counters === 'object',
      'diagnostics.stage_counters must be present in non-prod',
    );
    const requiredStages = [
      'base_games',
      'card_rows',
      'parsed_rows',
      'wave1_skipped_no_d2',
      'plays_emitted',
      'games_with_plays',
    ];
    for (const stage of requiredStages) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(diagnostics.stage_counters, stage),
        `diagnostics.stage_counters missing ${stage}`,
      );
    }
    assert.ok(
      diagnostics.card_type_contract &&
        diagnostics.card_type_contract.missing_playable_markets,
      'diagnostics.card_type_contract missing playable-market report',
    );
  }

  const games = Array.isArray(payload.data) ? payload.data : [];
  const wave1Plays = games.flatMap((game) =>
    (Array.isArray(game.plays) ? game.plays : []).filter((play) =>
      isWave1Play(game, play),
    ),
  );

  for (const game of games) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(game, 'true_play'),
      true,
      'each game must include true_play',
    );
    const truePlay = game.true_play;
    if (truePlay === null || truePlay === undefined) continue;
    assert.strictEqual(
      String(truePlay.kind ?? 'PLAY').toUpperCase(),
      'PLAY',
      'true_play must be a PLAY row',
    );
    if (truePlay?.decision_v2?.official_status) {
      assert.ok(
        ['PLAY', 'LEAN'].includes(
          String(truePlay.decision_v2.official_status),
        ),
        'true_play decision_v2 status must be actionable PLAY/LEAN',
      );
    }
  }

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
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  await runSourceContractAssertions(assert);

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    await preflightGamesEndpoint(baseUrl, assert);
    await validateLivePayload(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
  }

  console.log('✅ API games decision_v2 pass-through contract test passed');
}

run().catch((error) => {
  console.error('❌ API games decision_v2 pass-through contract test failed');
  console.error(error.message || error);
  process.exit(1);
});
