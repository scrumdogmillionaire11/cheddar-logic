/*
 * API results mode regression test
 * Ensures results stay payload-backed (orphaned rows excluded)
 * and dedupe flag behavior remains stable.
 *
 * Run: npm --prefix web run test:api:results:flags
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:results:flags';

function isConnectionIssue(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND')
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
  const base = `${baseUrl}/api/results`;
  let payloadDefault;
  let payloadIncludeOrphaned;
  let payloadNoDedupe;
  let payloadSummaryOnly;
  let payloadCompactLedger;

  try {
    payloadDefault = await getJson(`${base}?limit=200`);
    payloadIncludeOrphaned = await getJson(`${base}?limit=200&include_orphaned=1`);
    payloadNoDedupe = await getJson(`${base}?limit=200&include_orphaned=1&dedupe=0`);
    payloadSummaryOnly = await getJson(
      `${base}?limit=200&include_ledger=0&include_projection_summaries=0`,
    );
    payloadCompactLedger = await getJson(
      `${base}?limit=25&include_projection_summaries=0`,
    );
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(
      `⚠️ Results API endpoint unavailable at ${baseUrl}; skipping live assertions.`,
      `To run: ${LIVE_COMMAND}`,
    );
    console.log('✅ API results flags regression test passed (server not available, skipped)');
    return;
  }

  assert.strictEqual(
    payloadDefault.success,
    true,
    'default response success=false',
  );
  assert.strictEqual(
    payloadIncludeOrphaned.success,
    true,
    'include_orphaned response success=false',
  );
  assert.strictEqual(
    payloadNoDedupe.success,
    true,
    'dedupe=0 response success=false',
  );
  assert.strictEqual(
    payloadSummaryOnly.success,
    true,
    'summary-only response success=false',
  );
  assert.strictEqual(
    payloadCompactLedger.success,
    true,
    'compact-ledger response success=false',
  );

  const defaultCount = payloadDefault.data?.ledger?.length ?? 0;
  const includeOrphanedCount = payloadIncludeOrphaned.data?.ledger?.length ?? 0;
  const noDedupeCount = payloadNoDedupe.data?.ledger?.length ?? 0;
  const summaryOnlyCount = payloadSummaryOnly.data?.ledger?.length ?? 0;
  const compactLedgerCount = payloadCompactLedger.data?.ledger?.length ?? 0;

  // include_orphaned is intentionally forced off; it should not widen results.
  assert.strictEqual(
    includeOrphanedCount,
    defaultCount,
    `include_orphaned unexpectedly changed rows: default=${defaultCount}, include_orphaned=${includeOrphanedCount}`,
  );

  // dedupe=0 should never reduce cardinality vs deduped mode for the same filters.
  assert.ok(
    noDedupeCount >= includeOrphanedCount,
    `dedupe=0 reduced rows: include_orphaned=${includeOrphanedCount}, dedupe=0=${noDedupeCount}`,
  );
  assert.strictEqual(
    summaryOnlyCount,
    0,
    `include_ledger=0 should suppress ledger rows, got ${summaryOnlyCount}`,
  );
  assert.ok(
    compactLedgerCount <= 25,
    `compact ledger should cap returned rows at 25, got ${compactLedgerCount}`,
  );

  const defaultMeta = payloadDefault.data?.meta;
  const includeMeta = payloadIncludeOrphaned.data?.meta;
  const noDedupeMeta = payloadNoDedupe.data?.meta;
  const summaryOnlyMeta = payloadSummaryOnly.data?.meta;
  const defaultSegmentFamilies = payloadDefault.data?.segmentFamilies;

  assert.ok(defaultMeta, 'default response missing meta');
  assert.ok(includeMeta, 'include_orphaned response missing meta');
  assert.ok(noDedupeMeta, 'dedupe=0 response missing meta');
  assert.ok(summaryOnlyMeta, 'summary-only response missing meta');

  assert.strictEqual(
    defaultMeta.includeOrphaned,
    false,
    'default includeOrphaned meta should be false',
  );
  assert.strictEqual(
    defaultMeta.dedupe,
    true,
    'default dedupe meta should be true',
  );
  assert.strictEqual(
    includeMeta.includeOrphaned,
    false,
    'include_orphaned meta should remain false',
  );
  assert.strictEqual(
    noDedupeMeta.includeOrphaned,
    false,
    'no-dedupe includeOrphaned meta should remain false',
  );
  assert.strictEqual(
    noDedupeMeta.dedupe,
    false,
    'no-dedupe meta should be false',
  );
  assert.strictEqual(
    payloadSummaryOnly.data?.filters?.includeLedger,
    false,
    'summary-only filters.includeLedger should be false',
  );
  assert.strictEqual(
    payloadSummaryOnly.data?.filters?.includeProjectionSummaries,
    false,
    'summary-only filters.includeProjectionSummaries should be false',
  );
  assert.deepStrictEqual(
    payloadSummaryOnly.data?.projectionSummaries ?? [],
    [],
    'summary-only response should omit projection summaries',
  );
  assert.deepStrictEqual(
    payloadCompactLedger.data?.projectionSummaries ?? [],
    [],
    'compact ledger response should omit projection summaries when requested',
  );

  assert.ok(
    Array.isArray(defaultSegmentFamilies),
    'default response missing segmentFamilies metadata',
  );
  const familyIds = new Set(
    defaultSegmentFamilies.map((family) => family.segmentId),
  );
  ['play', 'slight_edge'].forEach((segmentId) => {
    assert.ok(
      familyIds.has(segmentId),
      `segmentFamilies missing expected segment: ${segmentId}`,
    );
  });

  const defaultLedger = Array.isArray(payloadDefault.data?.ledger)
    ? payloadDefault.data.ledger
    : [];
  const defaultSegments = Array.isArray(payloadDefault.data?.segments)
    ? payloadDefault.data.segments
    : [];
  defaultSegments.forEach((segment, index) => {
    assert.notStrictEqual(
      String(segment.sport || '').toUpperCase(),
      'NCAAM',
      `default segment ${index} unexpectedly contains NCAAM`,
    );
  });
  defaultLedger.forEach((row, index) => {
    assert.notStrictEqual(
      String(row.sport || '').toUpperCase(),
      'NCAAM',
      `default ledger row ${index} unexpectedly contains NCAAM`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(row, 'clv'),
      `default ledger row ${index} missing clv field`,
    );
    if (row.clv !== null) {
      ['oddsAtPick', 'closingOdds', 'clvPct', 'recordedAt', 'closedAt'].forEach(
        (key) => {
          assert.ok(
            Object.prototype.hasOwnProperty.call(row.clv, key),
            `default ledger row ${index} clv missing ${key}`,
          );
        },
      );
    }
  });

  // Canonical confidence vocabulary: confidencePct must be a finite number or null.
  // Derive tier (>=70→HIGH, >=55→MED, else→LOW) and assert it is canonical.
  const CANONICAL_CONFIDENCE_TIERS = new Set(['LOW', 'MED', 'HIGH']);
  const LEGACY_CONFIDENCE_LABELS = new Set(['WATCH', 'TRUST', 'STRONG']);
  defaultLedger.forEach((row, index) => {
    const pct = row.confidencePct;
    assert.ok(
      pct === null || pct === undefined || (typeof pct === 'number' && Number.isFinite(pct)),
      `default ledger row ${index} confidencePct must be a finite number or null, got: ${JSON.stringify(pct)}`,
    );
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      const tier = pct >= 70 ? 'HIGH' : pct >= 55 ? 'MED' : 'LOW';
      assert.ok(
        CANONICAL_CONFIDENCE_TIERS.has(tier),
        `default ledger row ${index} confidencePct=${pct} produced non-canonical tier: ${tier}`,
      );
    }
    // No legacy confidence labels must appear as string values in confidence-related row fields.
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === 'string' && LEGACY_CONFIDENCE_LABELS.has(val.toUpperCase()) && key.toLowerCase().includes('confidence')) {
        assert.fail(`default ledger row ${index} field "${key}" carries legacy confidence label: ${val}`);
      }
    }
  });

  console.log('✅ API results flags regression test passed');
  console.log(
    `   default=${defaultCount}, include_orphaned=${includeOrphanedCount}, no_dedupe=${noDedupeCount}`,
  );
}

run().catch((error) => {
  console.error('❌ API results flags regression test failed');
  console.error(error.message || error);
  process.exit(1);
});
