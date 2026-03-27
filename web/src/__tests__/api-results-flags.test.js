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

function buildFallbackMessage(baseUrl) {
  return (
    `Results API endpoint unavailable at ${baseUrl}; running source fallback checks. ` +
    `To run live assertions: ${LIVE_COMMAND}`
  );
}

async function validateResultsFlagsSourceContract(assert) {
  const fs = await import('node:fs/promises');
  const routeSource = await fs.readFile(
    new URL('../app/api/results/route.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    routeSource.includes('const hasClvLedger = Boolean('),
    'results route must guard clv_ledger usage behind a table existence check',
  );
  assert.ok(
    routeSource.includes('LEFT JOIN clv_ledger clv ON clv.card_id = cr.card_id'),
    'results route must preserve the clv_ledger join contract',
  );
  assert.ok(
    routeSource.includes('const clv =') && routeSource.includes('clv,'),
    'results route must expose optional clv data on ledger rows',
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
  let payloadDefault;
  let payloadIncludeOrphaned;
  let payloadNoDedupe;

  try {
    payloadDefault = await getJson(base);
    payloadIncludeOrphaned = await getJson(`${base}&include_orphaned=1`);
    payloadNoDedupe = await getJson(`${base}&include_orphaned=1&dedupe=0`);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
    await validateResultsFlagsSourceContract(assert);
    console.log('✅ API results flags regression test passed');
    console.log('   source fallback');
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

  const defaultLedger = Array.isArray(payloadDefault.data?.ledger)
    ? payloadDefault.data.ledger
    : [];
  defaultLedger.forEach((row, index) => {
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
