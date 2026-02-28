/**
 * NHL API Payload Contract Check (live API)
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 node src/__tests__/api-nhl-payload-contract.test.js
 */

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateNhlCardShape(card) {
  assert(typeof card.id === 'string' && card.id.length > 0, 'card.id is required');
  assert(typeof card.gameId === 'string' && card.gameId.length > 0, 'card.gameId is required');
  assert(card.sport === 'NHL', `card.sport must be NHL, got ${card.sport}`);
  assert(card.cardType === 'nhl-model-output', `card.cardType must be nhl-model-output, got ${card.cardType}`);
  assert(typeof card.cardTitle === 'string' && card.cardTitle.length > 0, 'card.cardTitle is required');
  assert(isIsoDate(card.createdAt), 'card.createdAt must be ISO date');
  assert(card.expiresAt === null || isIsoDate(card.expiresAt), 'card.expiresAt must be null or ISO date');
  assert(card.payloadParseError === false, 'card.payloadParseError must be false for valid cards');
  assert(card.payloadData && typeof card.payloadData === 'object', 'card.payloadData object is required');

  const payload = card.payloadData;
  assert(payload.game_id === card.gameId, 'payload.game_id must match card.gameId');
  assert(payload.sport === 'NHL', `payload.sport must be NHL, got ${payload.sport}`);
  assert(typeof payload.model_version === 'string' && payload.model_version.length > 0, 'payload.model_version is required');
  assert(['HOME', 'AWAY'].includes(payload.prediction), `payload.prediction must be HOME/AWAY, got ${payload.prediction}`);
  assert(typeof payload.confidence === 'number', 'payload.confidence must be a number');
  assert(payload.confidence >= 0 && payload.confidence <= 1, `payload.confidence out of range: ${payload.confidence}`);
  assert(['moneyline', 'spread', 'puck_line', 'total', 'unknown'].includes(payload.recommended_bet_type), `payload.recommended_bet_type invalid: ${payload.recommended_bet_type}`);
  assert(typeof payload.reasoning === 'string' && payload.reasoning.length > 0, 'payload.reasoning is required');
  assert(payload.odds_context && typeof payload.odds_context === 'object', 'payload.odds_context is required');
  assert(payload.odds_context.captured_at == null || isIsoDate(payload.odds_context.captured_at), 'payload.odds_context.captured_at must be null or ISO date');
  assert(typeof payload.ev_passed === 'boolean', 'payload.ev_passed must be boolean');
  assert(typeof payload.disclaimer === 'string' && payload.disclaimer.length > 0, 'payload.disclaimer is required');
  assert(isIsoDate(payload.generated_at), 'payload.generated_at must be ISO date');

  assert(payload.meta && typeof payload.meta === 'object', 'payload.meta is required');
  assert(['mock', 'remote'].includes(payload.meta.inference_source), `payload.meta.inference_source invalid: ${payload.meta.inference_source}`);
  assert(typeof payload.meta.is_mock === 'boolean', 'payload.meta.is_mock must be boolean');
  assert(payload.meta.model_endpoint === null || typeof payload.meta.model_endpoint === 'string', 'payload.meta.model_endpoint must be null/string');

  if (payload.meta.inference_source === 'mock') {
    assert(payload.meta.is_mock === true, 'mock source must set meta.is_mock=true');
  }
  if (payload.meta.inference_source === 'remote') {
    assert(payload.meta.is_mock === false, 'remote source must set meta.is_mock=false');
  }

  assert(payload.drivers && typeof payload.drivers === 'object', 'payload.drivers is required');
  const requiredDrivers = [
    'goalie',
    'specialTeams',
    'shotEnvironment',
    'emptyNet',
    'totalFragility',
    'pdoRegression'
  ];

  const actualDriverKeys = Object.keys(payload.drivers).sort();
  const expectedDriverKeys = [...requiredDrivers].sort();
  assert(
    JSON.stringify(actualDriverKeys) === JSON.stringify(expectedDriverKeys),
    `payload.drivers keys must match NHL list. expected=${expectedDriverKeys.join(',')} actual=${actualDriverKeys.join(',')}`
  );

  for (const driverKey of requiredDrivers) {
    const driver = payload.drivers[driverKey];
    assert(driver && typeof driver === 'object', `payload.drivers.${driverKey} is required`);
    assert(typeof driver.score === 'number', `payload.drivers.${driverKey}.score must be number`);
    assert(driver.score >= 0 && driver.score <= 1, `payload.drivers.${driverKey}.score out of range`);
    assert(typeof driver.weight === 'number', `payload.drivers.${driverKey}.weight must be number`);
    assert(['ok', 'partial', 'missing'].includes(driver.status), `payload.drivers.${driverKey}.status invalid`);
    assert(driver.inputs && typeof driver.inputs === 'object', `payload.drivers.${driverKey}.inputs required`);
  }

  assert(payload.driver_summary && typeof payload.driver_summary === 'object', 'payload.driver_summary is required');
  assert(Array.isArray(payload.driver_summary.top_drivers), 'payload.driver_summary.top_drivers must be array');
}

async function getJson(url) {
  const response = await fetch(url);
  assert(response.ok, `request failed: ${response.status} ${response.statusText} (${url})`);
  return response.json();
}

async function run() {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  const listUrl = `${baseUrl}/api/cards?sport=nhl&limit=50`;

  console.log('🧪 NHL payload contract check');
  console.log(`→ Base URL: ${baseUrl}`);

  const listResult = await getJson(listUrl);
  assert(listResult && typeof listResult === 'object', 'list response must be object');
  assert(listResult.success === true, 'list response success must be true');
  assert(Array.isArray(listResult.data), 'list response data must be array');
  assert(listResult.data.length > 0, 'expected at least one NHL card; run NHL model first');

  const dedupeKeys = new Set();
  const comboCounts = new Map();

  for (const card of listResult.data) {
    validateNhlCardShape(card);

    const dedupeKey = `${card.gameId}|${card.cardType}`;
    assert(!dedupeKeys.has(dedupeKey), `default dedupe violated for key ${dedupeKey}`);
    dedupeKeys.add(dedupeKey);

    const comboKey = `${card.payloadData.prediction}|${card.payloadData.meta.inference_source}|ev:${card.payloadData.ev_passed}`;
    comboCounts.set(comboKey, (comboCounts.get(comboKey) || 0) + 1);
  }

  const sampleGameId = listResult.data[0].gameId;
  const gameUrl = `${baseUrl}/api/cards/${encodeURIComponent(sampleGameId)}?limit=10`;
  const gameResult = await getJson(gameUrl);

  assert(gameResult.success === true, 'game response success must be true');
  assert(Array.isArray(gameResult.data), 'game response data must be array');
  assert(gameResult.data.length > 0, `expected cards for game ${sampleGameId}`);

  for (const card of gameResult.data) {
    validateNhlCardShape(card);
    assert(card.gameId === sampleGameId, 'game endpoint returned card for wrong game');
  }

  console.log('✅ NHL payload contract passed');
  console.log(`✓ Cards validated: ${listResult.data.length}`);
  console.log(`✓ Unique game/type keys: ${dedupeKeys.size}`);
  console.log('✓ Observed prediction/source/ev combos:');
  for (const [key, count] of comboCounts.entries()) {
    console.log(`  - ${key}: ${count}`);
  }
}

run().catch((error) => {
  console.error('❌ NHL payload contract failed');
  console.error(error.message || error);
  process.exit(1);
});
