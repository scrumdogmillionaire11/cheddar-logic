/*
 * UI results smoke test
 * Ensures /api/results returns a well-formed payload for UI display.
 * Live mode: CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:ui:results
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:ui:results';

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
    `Results API endpoint unavailable at ${baseUrl}; running source fallback checks. ` +
    `To run live assertions: ${LIVE_COMMAND}`
  );
}

async function preflightResultsEndpoint(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/api/results?limit=1`);
  assert.strictEqual(
    response.ok,
    true,
    `Results API preflight not ok: ${response.status}`,
  );
}

async function validateResultsSourceContract(assert) {
  const fs = await import('node:fs/promises');
  const routeSource = await fs.readFile(
    new URL('../app/api/results/route.ts', import.meta.url),
    'utf8',
  );
  const pageSource = await fs.readFile(
    new URL('../app/results/page.tsx', import.meta.url),
    'utf8',
  );
  const projectionTableSource = await fs.readFile(
    new URL('../components/results/ProjectionResultsTable.tsx', import.meta.url),
    'utf8',
  );

  [
    'totalCards:',
    'settledCards:',
    'wins:',
    'losses:',
    'pushes:',
    'totalPnlUnits:',
    'winRate:',
    'avgPnl:',
    'avgClvPct:',
  ].forEach((token) => {
    assert.ok(
      routeSource.includes(token),
      `results route summary contract missing ${token}`,
    );
  });
  assert.ok(
    routeSource.includes("type DecisionSegmentId = 'play' | 'slight_edge';"),
    'results route must define play/slight_edge decision segments',
  );
  assert.ok(
    routeSource.includes(
      "{ id: 'play', label: 'PLAY', canonicalStatus: 'PLAY' }",
    ),
    'results route must keep PLAY decision segment metadata',
  );
  assert.ok(
    routeSource.includes(
      "{ id: 'slight_edge', label: 'SLIGHT EDGE', canonicalStatus: 'LEAN' }",
    ),
    'results route must keep SLIGHT EDGE decision segment metadata',
  );
  assert.ok(
    routeSource.includes('segmentFamilies: DECISION_SEGMENTS.map'),
    'results route must derive segmentFamilies from DECISION_SEGMENTS',
  );
  assert.ok(
    routeSource.includes('projectionSummaries: []') &&
      routeSource.includes('projectionSummaries,'),
    'results route must expose projectionSummaries in empty and populated responses',
  );
  assert.ok(
    routeSource.includes('ledger: []') &&
      routeSource.includes('ledger: ledgerRows'),
    'results route must expose ledger in empty and populated responses',
  );
  assert.ok(
    routeSource.includes('LEFT JOIN clv_ledger clv ON clv.card_id = cr.card_id') &&
      routeSource.includes('const clv =') &&
      routeSource.includes('clv,'),
    'results route must left join clv_ledger and expose optional clv data',
  );
  assert.ok(
    routeSource.includes('END AS market_period_token') &&
      routeSource.includes('marketPeriodToken: row.market_period_token'),
    'results route must expose market_period_token on ledger rows as marketPeriodToken',
  );
  assert.ok(
    pageSource.includes("return row.marketPeriodToken === '1P';") &&
      pageSource.includes('function renderPeriodBadge(row: LedgerRow)') &&
      pageSource.includes('renderPeriodBadge(row)') &&
      pageSource.includes('text-cyan-200'),
    'results page must reference marketPeriodToken and render a 1P badge path',
  );
  assert.ok(
    routeSource.includes("const DEFAULT_EXCLUDED_SPORT = 'NCAAM';") &&
      routeSource.includes('function buildSportFilter(') &&
      routeSource.includes(
        "sql: `AND UPPER(${sportExpr}) != '${DEFAULT_EXCLUDED_SPORT}'`",
      ),
    'results route must suppress NCAAM by default',
  );
  assert.ok(
    pageSource.match(/<option value="MLB">MLB<\/option>/g)?.length === 2 &&
    !pageSource.includes('<option value="NCAAM">NCAAM</option>'),
    'results page must expose MLB and must not expose NCAAM in sport filters',
  );
  assert.ok(
    pageSource.includes('Betting Record') &&
      pageSource.includes('Projection Settlement') &&
      pageSource.includes('NHL 1P totals and MLB F5') &&
      pageSource.includes('Awaiting settled outcome data'),
    'results page must render a single projection settlement lane for mapped projection families',
  );
  assert.ok(
    pageSource.includes('Bucket Mapping') &&
      /LOW:\s+confidence_score\s+(?:<|&lt;)\s+52%/.test(pageSource) &&
      pageSource.includes('WATCH: 52%-57.99%') &&
      pageSource.includes('TRUST: 58%-62.99%') &&
      /STRONG:\s+(?:>=|&gt;=)\s+63%/.test(pageSource),
    'results page must show explicit LOW/WATCH/TRUST/STRONG bucket threshold mapping',
  );
  assert.ok(
    /edge_distance\s+(?:<|&lt;)\s+0\.15\s+are\s+excluded\s+from\s+directional\s+W\/L\s+and\s+still\s+included\s+in\s+MAE\s+and\s+bias\s+auditing/.test(pageSource) &&
      pageSource.includes('FRAGILE is a presentation label for weak/no-edge directions') &&
      pageSource.includes('not a native confidence_band value'),
    'results page must document weak-direction policy and FRAGILE presentation semantics',
  );
  assert.ok(
    projectionTableSource.includes('attributionRows?: ProjectionAccuracyRecord[]') &&
      projectionTableSource.includes('projection_raw:') &&
      projectionTableSource.includes('synthetic_line:') &&
      projectionTableSource.includes('edge_distance:') &&
      projectionTableSource.includes('confidence_band:'),
    'projection results table must render API-backed attribution fields for bucket inspection',
  );
}

async function validateLiveResultsPayload(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/api/results?limit=5`);

  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');
  assert.ok(payload.data, 'API data is missing');

  const summary = payload.data.summary;
  assert.ok(summary, 'Summary missing');
  [
    'totalCards',
    'settledCards',
    'wins',
    'losses',
    'pushes',
    'totalPnlUnits',
    'winRate',
    'avgPnl',
    'avgClvPct',
  ].forEach((key) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(summary, key),
      `Summary missing ${key}`,
    );
  });
  ['totalCards', 'settledCards', 'wins', 'losses', 'pushes', 'winRate'].forEach(
    (key) => {
      assert.strictEqual(
        typeof summary[key],
        'number',
        `Summary ${key} must be numeric`,
      );
    },
  );
  assert.ok(
    summary.totalPnlUnits === null || typeof summary.totalPnlUnits === 'number',
    'Summary totalPnlUnits must be number|null',
  );
  assert.ok(
    summary.avgPnl === null || typeof summary.avgPnl === 'number',
    'Summary avgPnl must be number|null',
  );
  assert.ok(
    summary.avgClvPct === null || typeof summary.avgClvPct === 'number',
    'Summary avgClvPct must be number|null',
  );
  assert.ok(
    summary.wins + summary.losses + summary.pushes <= summary.settledCards,
    'Summary W/L/P counts cannot exceed settledCards',
  );

  assert.ok(Array.isArray(payload.data.segments), 'Segments is not an array');
  payload.data.segments.forEach((row, index) => {
    assert.notStrictEqual(
      String(row.sport || '').toUpperCase(),
      'NCAAM',
      `Segment row ${index} unexpectedly contains NCAAM`,
    );
  });
  assert.ok(
    Array.isArray(payload.data.segmentFamilies),
    'segmentFamilies is not an array',
  );
  const segmentFamilies = payload.data.segmentFamilies;
  ['play', 'slight_edge'].forEach((segmentId) => {
    assert.ok(
      segmentFamilies.some((segment) => segment.segmentId === segmentId),
      `segmentFamilies missing ${segmentId}`,
    );
  });
  assert.ok(
    Array.isArray(payload.data.projectionSummaries),
    'projectionSummaries is not an array',
  );
  payload.data.projectionSummaries.forEach((row, index) => {
    [
      'actualsAvailable',
      'bias',
      'cardFamily',
      'directionalAccuracy',
      'familyLabel',
      'mae',
      'rowsSeen',
      'sampleSize',
    ].forEach((key) => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, key),
        `projectionSummaries row ${index} missing ${key}`,
      );
    });
    assert.strictEqual(
      typeof row.actualsAvailable,
      'boolean',
      `projectionSummaries row ${index} actualsAvailable must be boolean`,
    );
  });
  assert.ok(Array.isArray(payload.data.ledger), 'Ledger is not an array');
  payload.data.ledger.forEach((row, index) => {
    assert.notStrictEqual(
      String(row.sport || '').toUpperCase(),
      'NCAAM',
      `Ledger row ${index} unexpectedly contains NCAAM`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(row, 'marketPeriodToken'),
      `Ledger row ${index} missing marketPeriodToken field`,
    );
    assert.ok(
      row.marketPeriodToken === null || typeof row.marketPeriodToken === 'string',
      `Ledger row ${index} marketPeriodToken must be string|null`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(row, 'clv'),
      `Ledger row ${index} missing clv field`,
    );
    if (row.clv !== null) {
      ['oddsAtPick', 'closingOdds', 'clvPct', 'recordedAt', 'closedAt'].forEach(
        (key) => {
          assert.ok(
            Object.prototype.hasOwnProperty.call(row.clv, key),
            `Ledger row ${index} clv missing ${key}`,
          );
        },
      );
    }
  });
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    await preflightResultsEndpoint(baseUrl, assert);
    await validateLiveResultsPayload(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
    await validateResultsSourceContract(assert);
  }

  console.log('✅ UI results smoke test passed');
}

run().catch((error) => {
  console.error('❌ UI results smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
