/*
 * API results decision-tier segmentation regression test
 * Ensures /api/results emits PLAY + SLIGHT EDGE segmentation
 * and that tier totals reconcile with actionable summary totals.
 *
 * Live mode: CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:results:decision-segmentation
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:results:decision-segmentation';

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

async function validateResultsSegmentationSourceContract(assert) {
  const fs = await import('node:fs/promises');
  const routeSource = await fs.readFile(
    new URL('../app/api/results/route.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    routeSource.includes("type DecisionSegmentId = 'play' | 'slight_edge';"),
    'results route must define play/slight_edge segment ids',
  );
  assert.ok(
    routeSource.includes(
      "{ id: 'play', label: 'PLAY', canonicalStatus: 'PLAY' }",
    ) &&
      routeSource.includes(
        "{ id: 'slight_edge', label: 'SLIGHT EDGE', canonicalStatus: 'LEAN' }",
      ),
    'results route must keep PLAY and SLIGHT EDGE segment metadata',
  );
  assert.ok(
    routeSource.includes("function deriveDecisionSegment(tier: 'PLAY' | 'LEAN')"),
    'results route must define deriveDecisionSegment helper',
  );
  assert.ok(
    routeSource.includes(
      "return tier === 'PLAY' ? DECISION_SEGMENTS[0] : DECISION_SEGMENTS[1];",
    ),
    'results route must map PLAY/LEAN tiers onto canonical decision segments',
  );
  assert.ok(
    routeSource.includes('segmentFamilies = DECISION_SEGMENTS.map') &&
      routeSource.includes("decisionTier === 'PLAY'") &&
      routeSource.includes("'SLIGHT EDGE'"),
    'results route must derive segment families and ledger labels from canonical decision tiers',
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
}

function sumNullable(values) {
  let sum = 0;
  let hasValue = false;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value;
      hasValue = true;
    }
  }
  return hasValue ? sum : null;
}

function nearlyEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon;
}

function assertDecisionSegmentation(payload, assert, label) {
  assert.strictEqual(payload?.success, true, `${label}: success=false`);
  assert.ok(payload?.data, `${label}: missing data payload`);

  const summary = payload.data.summary;
  const segments = Array.isArray(payload.data.segments) ? payload.data.segments : [];
  const families = Array.isArray(payload.data.segmentFamilies)
    ? payload.data.segmentFamilies
    : [];
  const ledger = Array.isArray(payload.data.ledger) ? payload.data.ledger : [];

  const familyIds = new Set(families.map((family) => family.segmentId));
  ['play', 'slight_edge'].forEach((segmentId) => {
    assert.ok(
      familyIds.has(segmentId),
      `${label}: missing decision family ${segmentId}`,
    );
  });

  const familiesById = new Map(families.map((family) => [family.segmentId, family]));
  assert.strictEqual(
    familiesById.get('play')?.segmentLabel,
    'PLAY',
    `${label}: play family label mismatch`,
  );
  assert.strictEqual(
    familiesById.get('slight_edge')?.segmentLabel,
    'SLIGHT EDGE',
    `${label}: slight_edge family label mismatch`,
  );

  for (const segment of segments) {
    assert.ok(
      segment.segmentId === 'play' || segment.segmentId === 'slight_edge',
      `${label}: unexpected segmentId ${segment.segmentId}`,
    );
    if (segment.segmentId === 'play') {
      assert.strictEqual(
        segment.segmentLabel,
        'PLAY',
        `${label}: play segment label mismatch`,
      );
      assert.strictEqual(
        segment.decisionTier,
        'PLAY',
        `${label}: play segment decisionTier mismatch`,
      );
    } else if (segment.segmentId === 'slight_edge') {
      assert.strictEqual(
        segment.segmentLabel,
        'SLIGHT EDGE',
        `${label}: slight_edge segment label mismatch`,
      );
      assert.strictEqual(
        segment.decisionTier,
        'LEAN',
        `${label}: slight_edge segment decisionTier mismatch`,
      );
    }
  }

  const settledFromSegments = segments.reduce(
    (sum, segment) => sum + Number(segment.settledCards || 0),
    0,
  );
  const winsFromSegments = segments.reduce(
    (sum, segment) => sum + Number(segment.wins || 0),
    0,
  );
  const lossesFromSegments = segments.reduce(
    (sum, segment) => sum + Number(segment.losses || 0),
    0,
  );
  const pushesFromSegments = segments.reduce(
    (sum, segment) => sum + Number(segment.pushes || 0),
    0,
  );
  const pnlFromSegments = sumNullable(segments.map((segment) => segment.totalPnlUnits));

  assert.strictEqual(
    Number(summary.settledCards || 0),
    settledFromSegments,
    `${label}: settledCards do not reconcile`,
  );
  assert.strictEqual(
    Number(summary.totalCards || 0),
    settledFromSegments,
    `${label}: totalCards do not reconcile`,
  );
  assert.strictEqual(
    Number(summary.wins || 0),
    winsFromSegments,
    `${label}: wins do not reconcile`,
  );
  assert.strictEqual(
    Number(summary.losses || 0),
    lossesFromSegments,
    `${label}: losses do not reconcile`,
  );
  assert.strictEqual(
    Number(summary.pushes || 0),
    pushesFromSegments,
    `${label}: pushes do not reconcile`,
  );

  if (summary.totalPnlUnits === null && pnlFromSegments === null) {
    // pass
  } else {
    assert.ok(
      typeof summary.totalPnlUnits === 'number' && typeof pnlFromSegments === 'number',
      `${label}: totalPnlUnits nullability mismatch`,
    );
    assert.ok(
      nearlyEqual(summary.totalPnlUnits, pnlFromSegments),
      `${label}: totalPnlUnits do not reconcile`,
    );
  }

  const playSettledFromSegments = segments
    .filter((segment) => segment.segmentId === 'play')
    .reduce((sum, segment) => sum + Number(segment.settledCards || 0), 0);
  const slightEdgeSettledFromSegments = segments
    .filter((segment) => segment.segmentId === 'slight_edge')
    .reduce((sum, segment) => sum + Number(segment.settledCards || 0), 0);

  assert.strictEqual(
    Number(familiesById.get('play')?.settledCards || 0),
    playSettledFromSegments,
    `${label}: play family settledCards mismatch`,
  );
  assert.strictEqual(
    Number(familiesById.get('slight_edge')?.settledCards || 0),
    slightEdgeSettledFromSegments,
    `${label}: slight_edge family settledCards mismatch`,
  );

  for (const [index, row] of ledger.entries()) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(row, 'marketPeriodToken'),
      `${label}: ledger row ${index} missing marketPeriodToken field`,
    );
    assert.ok(
      row.marketPeriodToken === null || typeof row.marketPeriodToken === 'string',
      `${label}: ledger row ${index} marketPeriodToken must be string|null`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(row, 'clv'),
      `${label}: ledger row ${index} missing clv field`,
    );
    if (row.clv !== null) {
      ['oddsAtPick', 'closingOdds', 'clvPct', 'recordedAt', 'closedAt'].forEach(
        (key) => {
          assert.ok(
            Object.prototype.hasOwnProperty.call(row.clv, key),
            `${label}: ledger row ${index} clv missing ${key}`,
          );
        },
      );
    }
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API response not ok (${response.status}): ${url}`);
  }
  return response.json();
}

async function runLiveAssertions(baseUrl, assert) {
  const base = `${baseUrl}/api/results?limit=200`;

  const scenarios = [
    { name: 'default', url: base },
    { name: 'sport-filter', url: `${base}&sport=NHL` },
    { name: 'category-filter', url: `${base}&card_category=driver` },
    { name: 'market-filter', url: `${base}&market=total` },
    { name: 'confidence-filter', url: `${base}&min_confidence=60` },
    {
      name: 'combined+no-dedupe',
      url: `${base}&sport=NHL&card_category=call&market=total&min_confidence=60&dedupe=0`,
    },
  ];

  for (const scenario of scenarios) {
    const payload = await getJson(scenario.url);
    assertDecisionSegmentation(payload, assert, scenario.name);
  }
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    await preflightResultsEndpoint(baseUrl, assert);
    await runLiveAssertions(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
    await validateResultsSegmentationSourceContract(assert);
  }

  console.log('✅ API results decision-tier segmentation test passed');
}

run().catch((error) => {
  console.error('❌ API results decision-tier segmentation test failed');
  console.error(error.message || error);
  process.exit(1);
});
