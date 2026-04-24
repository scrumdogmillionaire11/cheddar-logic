/*
 * Reason-label sync guard
 * Ensures web/src/lib/game-card/reason-labels.ts stays in sync with
 * the canonical REASON_CODE_LABELS in packages/data/src/reason-codes.js.
 *
 * Run: node --import tsx/esm src/__tests__/reason-labels-sync.test.js
 */

async function run() {
  const assert = (await import('node:assert')).default;

  // Import canonical labels directly from the source file (no SQLite dependency).
  const canonical = await import('../../../packages/data/src/reason-codes.js');
  const { REASON_CODE_LABELS: canonicalLabels, ALL_REASON_CODES } = canonical;

  // Import inlined web labels.
  const {
    REASON_CODE_LABELS: inlinedLabels,
    getReasonCodeLabel,
  } = await import('../lib/game-card/reason-labels.ts');

  let passed = 0;
  let failed = 0;

  function check(name, ok, detail) {
    if (ok) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  console.log('\nreason-labels sync tests\n');

  // Every canonical label must exist in the inlined web map.
  const missingFromWeb = Object.keys(canonicalLabels).filter(k => !(k in inlinedLabels));
  check(
    'all canonical labels present in web map',
    missingFromWeb.length === 0,
    missingFromWeb.length > 0 ? `missing: ${missingFromWeb.join(', ')}` : '',
  );

  // Every bucketed reason code must have a label in the canonical map.
  const unlabeled = [...ALL_REASON_CODES].filter(code => !canonicalLabels[code]);
  check(
    'every bucketed reason code has a canonical label',
    unlabeled.length === 0,
    unlabeled.length > 0 ? `unlabeled: ${unlabeled.join(', ')}` : '',
  );

  check(
    'non-canonical separator variants normalize to canonical labels',
    getReasonCodeLabel('EDGE FOUND SIDE') === 'Edge found' &&
      getReasonCodeLabel('pass-execution-gate-net-edge-insufficient') === 'No edge at current price',
    'separator normalization should preserve canonical label lookup',
  );

  // Labels that exist in web but not in canonical are OK (legacy aliases),
  // but flag them so drift is visible.
  const extraInWeb = Object.keys(inlinedLabels).filter(k => !(k in canonicalLabels));
  if (extraInWeb.length > 0) {
    console.log(`  ℹ  web-only labels (legacy aliases — ok): ${extraInWeb.join(', ')}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
