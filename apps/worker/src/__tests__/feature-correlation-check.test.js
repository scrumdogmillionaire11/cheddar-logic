'use strict';
/**
 * WI-0833: Tests for feature correlation CI gate
 */

const { pearsonR } = require('../../../../packages/models/src/feature-correlation');
const {
  runCheck,
  runBuildGate,
  runCheckWithGitLog,
} = require('../audit/feature_correlation_check');

// ─── Synthetic feature data ────────────────────────────────────────────────

// 20 samples with perfectly linear progression — r = 1.0 with itself
const perfectCorr = Array.from({ length: 20 }, (_, i) => i * 0.05);

// Near-perfect correlation (identical) → r = 1.0
const perfectCorrCopy = perfectCorr.slice();

// Shared xs base (0..19)
const baseXs = Array.from({ length: 20 }, (_, i) => i);

// INFO-tier: |r| ≈ 0.718 — x*0.5 + sin(x*1.5)*4 provides [0.60, 0.80) range
const xs70 = baseXs;
const ys70 = baseXs.map((x) => x * 0.5 + Math.sin(x * 1.5) * 4);

// ALERT-tier: |r| ≈ 0.850 — x + sin(x*2)*5 provides [0.80, 0.90) range
const xsAlert = baseXs;
const ysAlert = baseXs.map((x) => x + Math.sin(x * 2) * 5);

// Verify array characteristics before tests run
const r70 = pearsonR(xs70, ys70);
const rAlert = pearsonR(xsAlert, ysAlert);

// Sanity assertions at module load — fail fast if data doesn't meet tier requirements
if (Math.abs(r70) < 0.60 || Math.abs(r70) >= 0.80) {
  throw new Error(
    'Test data sanity: xs70/ys70 must have |r| in [0.60, 0.80), got ' + r70,
  );
}
if (Math.abs(rAlert) < 0.80 || Math.abs(rAlert) >= 0.90) {
  throw new Error(
    'Test data sanity: xsAlert/ysAlert must have |r| in [0.80, 0.90), got ' + rAlert,
  );
}

// ─── Suppression helpers ───────────────────────────────────────────────────

function makeSuppression(overrides) {
  return Object.assign(
    {
      sport: 'NBA',
      feature_a: 'featA',
      feature_b: 'featB',
      rationale: 'test suppression',
    },
    overrides,
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('feature_correlation_check — tier classification', function () {
  test('Test 1 — INFO pair: |r| ≈ 0.70 appears in warnings, not violations', function () {
    const result = runCheckWithGitLog(
      'NBA',
      [xs70, ys70],
      ['featA', 'featB'],
      [],
      '',
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      sport: 'NBA',
      feature_a: 'featA',
      feature_b: 'featB',
      level: 'INFO',
    });
    expect(Math.abs(result.warnings[0].r)).toBeGreaterThanOrEqual(0.60);
    expect(Math.abs(result.warnings[0].r)).toBeLessThan(0.80);
    expect(result.violations).toHaveLength(0);
  });

  test('Test 2 — ALERT without suppression: |r| ≈ 0.83 appears in violations as ALERT', function () {
    const result = runCheckWithGitLog(
      'NBA',
      [xsAlert, ysAlert],
      ['featA', 'featB'],
      [],
      '',
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      sport: 'NBA',
      feature_a: 'featA',
      feature_b: 'featB',
      level: 'ALERT',
      suppressed: false,
      suppression_expired: false,
    });
    expect(Math.abs(result.violations[0].r)).toBeGreaterThanOrEqual(0.80);
    expect(Math.abs(result.violations[0].r)).toBeLessThan(0.90);
    expect(result.warnings).toHaveLength(0);
  });

  test('Test 3 — ALERT with valid non-expired suppression: pair is NOT a violation', function () {
    const suppression = makeSuppression({
      sport: 'NBA',
      feature_a: 'featA',
      feature_b: 'featB',
    });

    const result = runCheckWithGitLog(
      'NBA',
      [xsAlert, ysAlert],
      ['featA', 'featB'],
      [suppression],
      '', // empty git log → suppression is not expired
    );

    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('Test 4 — CRITICAL always fails even when matching suppression present', function () {
    const suppression = makeSuppression({
      sport: 'NBA',
      feature_a: 'featA',
      feature_b: 'featB',
    });

    const result = runCheckWithGitLog(
      'NBA',
      [perfectCorr, perfectCorrCopy],
      ['featA', 'featB'],
      [suppression],
      '',
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      level: 'CRITICAL',
      suppressed: false,
    });
    expect(Math.abs(result.violations[0].r)).toBeGreaterThanOrEqual(0.90);
  });
});

describe('feature_correlation_check — suppression expiry', function () {
  test('Test 5 — Expired WI suppression: expires_after_wi="WI-0823" in git log → violation', function () {
    const suppression = makeSuppression({
      sport: 'NHL',
      feature_a: 'goalie_gsax',
      feature_b: 'homeGoalieSavePct',
      expires_after_wi: 'WI-0823',
    });

    // Provide a git log string that contains "WI-0823" — simulates WI-0823 being merged
    const fakeGitLog =
      '1848b4f docs(quick-142): WI-0823: NHL unified goalie signal — consolidate GSaX and SV%';

    const result = runCheckWithGitLog(
      'NHL',
      [xsAlert, ysAlert],
      ['goalie_gsax', 'homeGoalieSavePct'],
      [suppression],
      fakeGitLog,
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      sport: 'NHL',
      feature_a: 'goalie_gsax',
      feature_b: 'homeGoalieSavePct',
      level: 'ALERT',
      suppressed: false,
      suppression_expired: true,
    });
  });
});

describe('feature_correlation_check — runBuildGate', function () {
  test('Test 6 — runBuildGate throws when violations present, message contains feature names', function () {
    const fakeViolation = {
      sport: 'NBA',
      feature_a: 'xwoba_vs_hand',
      feature_b: 'iso',
      r: 0.83,
      level: 'ALERT',
      suppressed: false,
      suppression_expired: false,
    };

    expect(function () {
      runBuildGate({ violations: [fakeViolation], warnings: [] });
    }).toThrow(/xwoba_vs_hand/);
  });

  test('Test 7 — runBuildGate returns true when no violations', function () {
    const result = runBuildGate({ violations: [], warnings: [] });
    expect(result).toBe(true);
  });
});

describe('feature_correlation_check — MLB synthetic fixture', function () {
  test('Test 8 — MLB xwoba_vs_hand + iso identical arrays → r=1.0 → CRITICAL violation', function () {
    const xwoba_vs_hand = Array.from({ length: 20 }, (_, i) => 0.280 + i * 0.010);
    const iso = xwoba_vs_hand.slice(); // identical → r = 1.0

    const result = runCheckWithGitLog(
      'MLB',
      [xwoba_vs_hand, iso],
      ['xwoba_vs_hand', 'iso'],
      [],
      '',
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      sport: 'MLB',
      feature_a: 'xwoba_vs_hand',
      feature_b: 'iso',
      level: 'CRITICAL',
    });
    expect(Math.abs(result.violations[0].r)).toBeGreaterThanOrEqual(0.90);
  });
});
