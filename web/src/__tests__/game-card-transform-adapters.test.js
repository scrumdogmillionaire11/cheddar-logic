/*
 * Unit tests for the v1 legacy-repair adapter boundary.
 * Exercises all five payload-probe helpers and verifies re-exports from legacy-repair.
 * Run: node web/src/__tests__/game-card-transform-adapters.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveMlbFallbackOfficialStatus,
  hasMlbFallbackDropReason,
  hasMlbFallbackActionableSelection,
  hasMlbFallbackMarketContext,
  getMlbFallbackSnapshotEpoch,
  // re-exported legacy-repair helpers
  normalizeCardType,
  getSportCardTypeContract,
  isPlayItem,
  isEvidenceItem,
  getSourcePlayAction,
  resolveSourceModelProb,
} from '../lib/game-card/transform/adapters/v1-legacy-repair.ts';

console.log('🧪 v1-legacy-repair adapter boundary tests');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// resolveMlbFallbackOfficialStatus
// ---------------------------------------------------------------------------

test('resolveMlbFallbackOfficialStatus — canonical_envelope_v2 path wins', () => {
  const payload = {
    decision_v2: {
      official_status: 'PASS',
      canonical_envelope_v2: { official_status: 'PLAY' },
    },
  };
  assert.strictEqual(resolveMlbFallbackOfficialStatus(payload), 'PLAY');
});

test('resolveMlbFallbackOfficialStatus — falls back to decision_v2.official_status', () => {
  const payload = {
    decision_v2: { official_status: 'LEAN' },
  };
  assert.strictEqual(resolveMlbFallbackOfficialStatus(payload), 'LEAN');
});

test('resolveMlbFallbackOfficialStatus — returns null when no status present', () => {
  assert.strictEqual(resolveMlbFallbackOfficialStatus({}), null);
});

test('resolveMlbFallbackOfficialStatus — returns null for unknown status string', () => {
  const payload = { decision_v2: { official_status: 'UNKNOWN' } };
  assert.strictEqual(resolveMlbFallbackOfficialStatus(payload), null);
});

// ---------------------------------------------------------------------------
// hasMlbFallbackDropReason
// ---------------------------------------------------------------------------

test('hasMlbFallbackDropReason — true when drop_reason present', () => {
  const payload = { execution_gate: { drop_reason: 'GOALIE_UNCERTAIN' } };
  assert.strictEqual(hasMlbFallbackDropReason(payload), true);
});

test('hasMlbFallbackDropReason — false when execution_gate has no drop_reason', () => {
  const payload = { execution_gate: {} };
  assert.strictEqual(hasMlbFallbackDropReason(payload), false);
});

test('hasMlbFallbackDropReason — false when execution_gate absent', () => {
  assert.strictEqual(hasMlbFallbackDropReason({}), false);
});

// ---------------------------------------------------------------------------
// hasMlbFallbackActionableSelection
// ---------------------------------------------------------------------------

test('hasMlbFallbackActionableSelection — true via canonical_envelope_v2.selection_side', () => {
  const payload = {
    decision_v2: {
      canonical_envelope_v2: { selection_side: 'OVER' },
    },
  };
  assert.strictEqual(hasMlbFallbackActionableSelection(payload), true);
});

test('hasMlbFallbackActionableSelection — true via decision_v2.selection_side', () => {
  const payload = { decision_v2: { selection_side: 'HOME' } };
  assert.strictEqual(hasMlbFallbackActionableSelection(payload), true);
});

test('hasMlbFallbackActionableSelection — true via top-level prediction', () => {
  const payload = { prediction: 'AWAY' };
  assert.strictEqual(hasMlbFallbackActionableSelection(payload), true);
});

test('hasMlbFallbackActionableSelection — false when no side found', () => {
  assert.strictEqual(hasMlbFallbackActionableSelection({}), false);
});

// ---------------------------------------------------------------------------
// hasMlbFallbackMarketContext
// ---------------------------------------------------------------------------

test('hasMlbFallbackMarketContext — mlb-full-game true with line + juice', () => {
  const payload = { line: 8.5, juice: -110 };
  assert.strictEqual(hasMlbFallbackMarketContext(payload, 'mlb-full-game'), true);
});

test('hasMlbFallbackMarketContext — mlb-full-game true via wager.called_line/called_price', () => {
  const payload = { market_context: { wager: { called_line: 7.5, called_price: -115 } } };
  assert.strictEqual(hasMlbFallbackMarketContext(payload, 'mlb-full-game'), true);
});

test('hasMlbFallbackMarketContext — mlb-full-game false when price missing', () => {
  const payload = { line: 8.5 };
  assert.strictEqual(hasMlbFallbackMarketContext(payload, 'mlb-full-game'), false);
});

test('hasMlbFallbackMarketContext — mlb-full-game-ml true with home + away prices', () => {
  const payload = { ml_home: -130, ml_away: 110 };
  assert.strictEqual(hasMlbFallbackMarketContext(payload, 'mlb-full-game-ml'), true);
});

test('hasMlbFallbackMarketContext — mlb-full-game-ml true via odds_context', () => {
  const payload = { odds_context: { h2h_home: -145, h2h_away: 125 } };
  assert.strictEqual(hasMlbFallbackMarketContext(payload, 'mlb-full-game-ml'), true);
});

test('hasMlbFallbackMarketContext — mlb-full-game-ml false when home price missing', () => {
  const payload = { ml_away: 110 };
  assert.strictEqual(hasMlbFallbackMarketContext(payload, 'mlb-full-game-ml'), false);
});

test('hasMlbFallbackMarketContext — false for unknown card type', () => {
  assert.strictEqual(hasMlbFallbackMarketContext({ line: 8.5, juice: -110 }, 'mlb-f5'), false);
});

// ---------------------------------------------------------------------------
// getMlbFallbackSnapshotEpoch
// ---------------------------------------------------------------------------

test('getMlbFallbackSnapshotEpoch — uses payload.snapshot_at first', () => {
  const row = { created_at: '2026-01-01T00:00:00Z' };
  const payload = {
    snapshot_at: '2026-04-01T12:00:00Z',
    captured_at: '2026-03-01T00:00:00Z',
  };
  const expected = Date.parse('2026-04-01T12:00:00Z');
  assert.strictEqual(getMlbFallbackSnapshotEpoch(row, payload), expected);
});

test('getMlbFallbackSnapshotEpoch — falls back to payload.captured_at', () => {
  const row = { created_at: '2026-01-01T00:00:00Z' };
  const payload = { captured_at: '2026-04-02T10:00:00Z' };
  const expected = Date.parse('2026-04-02T10:00:00Z');
  assert.strictEqual(getMlbFallbackSnapshotEpoch(row, payload), expected);
});

test('getMlbFallbackSnapshotEpoch — falls back to row.created_at', () => {
  const row = { created_at: '2026-04-03T08:00:00Z' };
  const expected = Date.parse('2026-04-03T08:00:00Z');
  assert.strictEqual(getMlbFallbackSnapshotEpoch(row, {}), expected);
});

test('getMlbFallbackSnapshotEpoch — returns NaN when all timestamps absent', () => {
  const result = getMlbFallbackSnapshotEpoch({ created_at: '' }, {});
  assert.ok(Number.isNaN(result), `expected NaN, got ${result}`);
});

// ---------------------------------------------------------------------------
// Re-exported legacy-repair helpers (boundary smoke tests)
// ---------------------------------------------------------------------------

test('normalizeCardType re-export — trims and lowercases', () => {
  assert.strictEqual(normalizeCardType('  NHL-Totals-Call  '), 'nhl-totals-call');
});

test('getSportCardTypeContract re-export — returns contract for known sport', () => {
  const contract = getSportCardTypeContract('NHL');
  assert.ok(contract && typeof contract.playProducerCardTypes === 'object');
});

test('isPlayItem re-export — returns boolean', () => {
  const play = { cardType: 'nhl-totals-call', kind: 'PLAY' };
  assert.strictEqual(typeof isPlayItem(play, 'NHL'), 'boolean');
});

test('isEvidenceItem re-export — evidence kind returns true', () => {
  const play = { cardType: 'nhl-totals-call', kind: 'EVIDENCE' };
  assert.strictEqual(isEvidenceItem(play, 'NHL'), true);
});

test('getSourcePlayAction re-export — returns undefined for empty play', () => {
  assert.strictEqual(getSourcePlayAction(undefined), undefined);
});

test('resolveSourceModelProb re-export — returns undefined for non-numeric', () => {
  assert.strictEqual(resolveSourceModelProb({ model_prob: 'bad' }), undefined);
});

test('resolveSourceModelProb re-export — clamps valid probability', () => {
  const result = resolveSourceModelProb({ model_prob: 0.72 });
  assert.strictEqual(result, 0.72);
});

test('route-handler imports legacy probe helpers via v1 adapter boundary', () => {
  const routeHandlerPath = path.resolve(process.cwd(), 'src/lib/games/route-handler.ts');
  const source = fs.readFileSync(routeHandlerPath, 'utf8');
  assert.ok(
    source.includes("@/lib/game-card/transform/adapters/v1-legacy-repair"),
    'expected route-handler.ts to import from v1-legacy-repair adapter',
  );
});

test('transform index imports legacy helpers via v1 adapter boundary', () => {
  const transformIndexPath = path.resolve(process.cwd(), 'src/lib/game-card/transform/index.ts');
  const source = fs.readFileSync(transformIndexPath, 'utf8');
  assert.ok(
    source.includes("'./adapters/v1-legacy-repair'"),
    'expected transform/index.ts to import from v1-legacy-repair adapter',
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
