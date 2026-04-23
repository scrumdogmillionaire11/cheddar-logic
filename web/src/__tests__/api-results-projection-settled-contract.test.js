import assert from 'node:assert/strict';
import { normalizeToConfidenceTier } from '../lib/types/projection-accuracy.ts';

const VALID_TIERS = new Set(['LOW', 'MED', 'HIGH']);

function assertConfidenceTier(value, label) {
  assert.ok(
    VALID_TIERS.has(value),
    `${label}: expected LOW|MED|HIGH, got ${JSON.stringify(value)}`,
  );
}

function run() {
  // Canonical pass-through
  assertConfidenceTier(normalizeToConfidenceTier('HIGH'), 'canonical HIGH');
  assertConfidenceTier(normalizeToConfidenceTier('MED'), 'canonical MED');
  assertConfidenceTier(normalizeToConfidenceTier('LOW'), 'canonical LOW');

  // Legacy vocab mapping
  assert.strictEqual(normalizeToConfidenceTier('STRONG'), 'HIGH', 'STRONG maps to HIGH');
  assert.strictEqual(normalizeToConfidenceTier('TRUST'), 'MED', 'TRUST maps to MED');
  assert.strictEqual(normalizeToConfidenceTier('WATCH'), 'LOW', 'WATCH maps to LOW');

  // Case-insensitive input
  assert.strictEqual(normalizeToConfidenceTier('high'), 'HIGH', 'lowercase high maps to HIGH');
  assert.strictEqual(normalizeToConfidenceTier('med'), 'MED', 'lowercase med maps to MED');

  // Confidence score fallback
  assert.strictEqual(normalizeToConfidenceTier(null, 75), 'HIGH', 'score 75 → HIGH');
  assert.strictEqual(normalizeToConfidenceTier(null, 60), 'MED', 'score 60 → MED');
  assert.strictEqual(normalizeToConfidenceTier(null, 40), 'LOW', 'score 40 → LOW');

  // Win-probability fallback
  assert.strictEqual(normalizeToConfidenceTier(null, null, 0.75), 'HIGH', 'win_prob 0.75 (|p-0.5|=0.25) → HIGH');
  assert.strictEqual(normalizeToConfidenceTier(null, null, 0.58), 'MED', 'win_prob 0.58 (|p-0.5|=0.08) → MED');
  assert.strictEqual(normalizeToConfidenceTier(null, null, 0.52), 'LOW', 'win_prob 0.52 (|p-0.5|=0.02) → LOW');

  // Null/undefined/empty → LOW
  assertConfidenceTier(normalizeToConfidenceTier(null), 'null band');
  assertConfidenceTier(normalizeToConfidenceTier(undefined), 'undefined band');
  assertConfidenceTier(normalizeToConfidenceTier(''), 'empty string band');

  // Every output must be a canonical tier
  const inputs = ['HIGH', 'MED', 'LOW', 'STRONG', 'TRUST', 'WATCH', null, undefined, '', 'UNKNOWN'];
  for (const input of inputs) {
    const result = normalizeToConfidenceTier(input);
    assertConfidenceTier(result, `normalizeToConfidenceTier(${JSON.stringify(input)})`);
  }

  console.log('api-results-projection-settled-contract: all assertions passed');
}

run();
