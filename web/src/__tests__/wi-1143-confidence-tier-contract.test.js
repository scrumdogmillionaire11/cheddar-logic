/*
 * WI-1143: ConfidenceTier normalization contract tests.
 * Covers all 13 behavior cases from the plan spec.
 *
 * Run: node --import tsx/esm web/src/__tests__/wi-1143-confidence-tier-contract.test.js
 */

import assert from 'node:assert/strict';
import { normalizeToConfidenceTier } from '../lib/types/projection-accuracy.ts';

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  PASS: ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${description}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// --- Canonical values pass through unchanged ---
test("normalizeToConfidenceTier('HIGH') -> 'HIGH'", () => {
  assert.strictEqual(normalizeToConfidenceTier('HIGH'), 'HIGH');
});

test("normalizeToConfidenceTier('MED') -> 'MED'", () => {
  assert.strictEqual(normalizeToConfidenceTier('MED'), 'MED');
});

test("normalizeToConfidenceTier('LOW') -> 'LOW'", () => {
  assert.strictEqual(normalizeToConfidenceTier('LOW'), 'LOW');
});

// --- Legacy vocabulary mapping ---
test("normalizeToConfidenceTier('STRONG') -> 'HIGH'", () => {
  assert.strictEqual(normalizeToConfidenceTier('STRONG'), 'HIGH');
});

test("normalizeToConfidenceTier('TRUST') -> 'MED'", () => {
  assert.strictEqual(normalizeToConfidenceTier('TRUST'), 'MED');
});

test("normalizeToConfidenceTier('WATCH') -> 'LOW'", () => {
  assert.strictEqual(normalizeToConfidenceTier('WATCH'), 'LOW');
});

// --- Confidence score fallback (null band) ---
test("normalizeToConfidenceTier(null, 80) -> 'HIGH' (score >= 70)", () => {
  assert.strictEqual(normalizeToConfidenceTier(null, 80), 'HIGH');
});

test("normalizeToConfidenceTier(null, 60) -> 'MED' (score >= 55)", () => {
  assert.strictEqual(normalizeToConfidenceTier(null, 60), 'MED');
});

test("normalizeToConfidenceTier(null, 40) -> 'LOW' (score < 55)", () => {
  assert.strictEqual(normalizeToConfidenceTier(null, 40), 'LOW');
});

// --- Win-probability distance fallback (MISSING_SIGNAL band) ---
test("normalizeToConfidenceTier('MISSING_SIGNAL', null, 0.75) -> 'HIGH' (dist 0.25 >= 0.20)", () => {
  assert.strictEqual(normalizeToConfidenceTier('MISSING_SIGNAL', null, 0.75), 'HIGH');
});

test("normalizeToConfidenceTier('MISSING_SIGNAL', null, 0.60) -> 'MED' (dist 0.10 >= 0.05)", () => {
  assert.strictEqual(normalizeToConfidenceTier('MISSING_SIGNAL', null, 0.60), 'MED');
});

test("normalizeToConfidenceTier('MISSING_SIGNAL', null, 0.51) -> 'LOW' (dist 0.01 < 0.05)", () => {
  assert.strictEqual(normalizeToConfidenceTier('MISSING_SIGNAL', null, 0.51), 'LOW');
});

// --- Final default ---
test("normalizeToConfidenceTier(null) with no fallbacks -> 'LOW'", () => {
  assert.strictEqual(normalizeToConfidenceTier(null), 'LOW');
});

// --- Summary ---
console.log('');
console.log(`WI-1143 confidence tier contract: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log('All 13 behavior cases passed.');
