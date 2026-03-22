/*
 * API results decision-tier segmentation regression test
 * Ensures /api/results emits PLAY + SLIGHT EDGE segmentation
 * and that tier totals reconcile with actionable summary totals.
 *
 * Run: node web/src/__tests__/api-results-decision-segmentation.test.js
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

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
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API response not ok (${response.status}): ${url}`);
  }
  return response.json();
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
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

  console.log('✅ API results decision-tier segmentation test passed');
}

run().catch((error) => {
  console.error('❌ API results decision-tier segmentation test failed');
  console.error(error.message || error);
  process.exit(1);
});
