/*
 * API results mode regression test
 * Ensures results stay payload-backed (orphaned rows excluded)
 * and dedupe flag behavior remains stable.
 *
 * Run: npm --prefix web run test:api:results:flags
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

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

  const payloadDefault = await getJson(base);
  const payloadIncludeOrphaned = await getJson(`${base}&include_orphaned=1`);
  const payloadNoDedupe = await getJson(`${base}&include_orphaned=1&dedupe=0`);

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

  const defaultCount = payloadDefault.data?.ledger?.length ?? 0;
  const includeOrphanedCount = payloadIncludeOrphaned.data?.ledger?.length ?? 0;
  const noDedupeCount = payloadNoDedupe.data?.ledger?.length ?? 0;

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

  const defaultMeta = payloadDefault.data?.meta;
  const includeMeta = payloadIncludeOrphaned.data?.meta;
  const noDedupeMeta = payloadNoDedupe.data?.meta;
  const defaultSegmentFamilies = payloadDefault.data?.segmentFamilies;

  assert.ok(defaultMeta, 'default response missing meta');
  assert.ok(includeMeta, 'include_orphaned response missing meta');
  assert.ok(noDedupeMeta, 'dedupe=0 response missing meta');

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
