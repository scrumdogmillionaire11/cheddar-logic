/*
 * CI guardrail: repair budget must stay <= 20%.
 * Run: npm --prefix web run test:api:games:repair-budget
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

async function runSourceContractAssertions(assert) {
  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const fs = fsModule.default || fsModule;
  const path = pathModule.default || pathModule;
  const routePath = path.resolve('src/app/api/games/route.ts');
  const source = fs.readFileSync(routePath, 'utf8');

  assert.ok(
    source.includes('const resolvedAction: Play[\'action\'] | undefined =') &&
      source.includes('normalizedAction ??') &&
      source.includes('actionFromClassification(normalizedClassification)') &&
      source.includes('statusFromAction(resolvedAction) ?? normalizedStatus'),
    'route should enforce action-first precedence with controlled canonical/legacy fallback',
  );

  assert.ok(
    source.includes("'PASS_MISSING_MARKET_TYPE'") &&
      source.includes("'LEGACY_TITLE_INFERENCE_USED'") &&
      source.includes("'REPAIRED_LEGACY_CARD'"),
    'route should make legacy repair/inference explicit via deterministic reason codes',
  );
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  await runSourceContractAssertions(assert);

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/api/games?limit=200`);
  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');

  const repairStats = payload.repair_stats || {};
  const repairedCount = Number(repairStats.repaired_count || 0);
  const totalCount = Number(repairStats.total_count || 0);
  const ratio = totalCount > 0 ? repairedCount / totalCount : 0;
  const cap = 0.2;

  const plays = (payload.data || []).flatMap((game) => game.plays || []);
  const repairedPlays = plays.filter((play) => play.repair_applied === true);

  const byRuleId = repairedPlays.reduce((acc, play) => {
    const key = play.repair_rule_id || 'UNKNOWN_RULE';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const byCardType = repairedPlays.reduce((acc, play) => {
    const key = play.cardType || 'UNKNOWN_CARD_TYPE';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const topRuleIds = Object.entries(byRuleId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ruleId, count]) => `${ruleId}:${count}`)
    .join(', ');

  const topCardTypes = Object.entries(byCardType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cardType, count]) => `${cardType}:${count}`)
    .join(', ');

  assert.ok(
    ratio <= cap,
    `Repair budget exceeded (${ratio.toFixed(4)} > ${cap.toFixed(2)}). Top repair_rule_ids: [${topRuleIds}]. Top card types: [${topCardTypes}]`,
  );

  console.log('✅ API games repair budget test passed');
}

run().catch((error) => {
  console.error('❌ API games repair budget test failed');
  console.error(error.message || error);
  process.exit(1);
});
