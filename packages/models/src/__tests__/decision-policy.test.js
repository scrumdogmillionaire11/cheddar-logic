'use strict';

const {
  deriveLegacyDecisionEnvelope,
  deriveUiDisplayStatus,
  deriveWebhookBucket,
  collectReasonCodes,
  describeWebhookReason,
  deriveWebhookWatchState,
  deriveWebhookWouldBecomePlay,
  deriveWebhookDropToPass,
  deriveWebhookReasonCode,
  isOfficialStatusActionable,
  isWebhookLeanEligible,
  mapActionToClassification,
  normalizeOfficialStatus,
  rankOfficialStatus,
  resolveCanonicalPlayState,
  resolveWebhookDisplaySide,
} = require('../decision-policy');

describe('decision-policy helpers', () => {
  test('normalizeOfficialStatus accepts canonical values and uppercases', () => {
    expect(normalizeOfficialStatus('play')).toBe('PLAY');
    expect(normalizeOfficialStatus('LEAN')).toBe('LEAN');
    expect(normalizeOfficialStatus(' pass ')).toBe('PASS');
  });

  test('normalizeOfficialStatus returns empty token for unknown values', () => {
    expect(normalizeOfficialStatus('WATCH')).toBe('');
    expect(normalizeOfficialStatus(null)).toBe('');
    expect(normalizeOfficialStatus(undefined)).toBe('');
  });

  test('isOfficialStatusActionable only allows PLAY and LEAN', () => {
    expect(isOfficialStatusActionable('PLAY')).toBe(true);
    expect(isOfficialStatusActionable('lean')).toBe(true);
    expect(isOfficialStatusActionable('PASS')).toBe(false);
    expect(isOfficialStatusActionable('WATCH')).toBe(false);
  });

  test('rankOfficialStatus keeps deterministic ordering', () => {
    expect(rankOfficialStatus('PLAY')).toBe(2);
    expect(rankOfficialStatus('LEAN')).toBe(1);
    expect(rankOfficialStatus('PASS')).toBe(0);
    expect(rankOfficialStatus('UNKNOWN')).toBe(0);
  });

  test('deriveLegacyDecisionEnvelope maps official status to legacy fields', () => {
    expect(deriveLegacyDecisionEnvelope('PLAY')).toEqual({
      classification: 'BASE',
      action: 'FIRE',
      status: 'FIRE',
      passReasonCode: null,
    });
    expect(deriveLegacyDecisionEnvelope('LEAN')).toEqual({
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
      passReasonCode: null,
    });
    expect(deriveLegacyDecisionEnvelope('PASS')).toEqual({
      classification: 'PASS',
      action: 'PASS',
      status: 'PASS',
      passReasonCode: null,
    });
    expect(deriveLegacyDecisionEnvelope('wat')).toEqual({
      classification: 'PASS',
      action: 'PASS',
      status: 'PASS',
      passReasonCode: null,
    });
  });

  test('mapActionToClassification keeps legacy action contract', () => {
    expect(mapActionToClassification('FIRE')).toBe('BASE');
    expect(mapActionToClassification('hold')).toBe('LEAN');
    expect(mapActionToClassification('PASS')).toBe('PASS');
    expect(mapActionToClassification('UNKNOWN')).toBe('PASS');
  });

  test('deriveUiDisplayStatus preserves execution-status and official-status mapping', () => {
    expect(deriveUiDisplayStatus('PROJECTION_ONLY', 'PLAY')).toBe('WATCH');
    expect(deriveUiDisplayStatus('BLOCKED', 'PLAY')).toBe('PASS');
    expect(deriveUiDisplayStatus('EXECUTABLE', 'PLAY')).toBe('PLAY');
    expect(deriveUiDisplayStatus('EXECUTABLE', 'LEAN')).toBe('WATCH');
    expect(deriveUiDisplayStatus('EXECUTABLE', 'PASS')).toBe('PASS');
    expect(deriveUiDisplayStatus('', 'LEAN')).toBe('WATCH');
    expect(deriveUiDisplayStatus('', 'UNKNOWN')).toBe('PASS');
  });

  test('deriveWebhookBucket maps NHL totals status using canonical policy', () => {
    const payload = {
      nhl_totals_status: { status: 'SLIGHT EDGE' },
      action: 'HOLD',
      classification: 'LEAN',
    };

    expect(deriveWebhookBucket(payload, { isNhlTotal: true })).toBe('lean');
  });

  test('deriveWebhookBucket maps 1P surfaced status with slight edge handling', () => {
    const payload = {
      nhl_1p_decision: { surfaced_status: 'SLIGHT EDGE' },
    };

    expect(deriveWebhookBucket(payload, { is1P: true })).toBe('lean');
  });

  test('deriveWebhookBucket applies pass override regardless of prior bucket', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      action: 'PASS',
    };

    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });

  test('deriveWebhookReasonCode emits reason only for pass_blocked bucket', () => {
    const payload = {
      pass_reason_code: 'PASS_POLICY_GATE',
      nhl_totals_status: { reasonCodes: ['NHL_TOTALS_PASS'] },
    };

    expect(deriveWebhookReasonCode(payload, 'pass_blocked')).toBe('PASS_POLICY_GATE');
    expect(deriveWebhookReasonCode(payload, 'official')).toBeNull();
  });

  test('collectReasonCodes normalizes and de-duplicates canonical reason order', () => {
    const payload = {
      blocked_reason_code: 'LINE_NOT_CONFIRMED',
      pass_reason_code: 'PASS_EXECUTION_GATE_MIXED_BOOK_SOURCE_MISMATCH',
      reason_codes: ['NO_EDGE_AT_PRICE', 'NO_EDGE_AT_PRICE'],
      decision_v2: {
        primary_reason_code: 'LINE_NOT_CONFIRMED',
      },
    };

    expect(collectReasonCodes(payload)).toEqual([
      'LINE_NOT_CONFIRMED',
      'PASS_EXECUTION_GATE_MIXED_BOOK_SOURCE_MISMATCH',
      'NO_EDGE_AT_PRICE',
    ]);
  });

  test('watch-state helpers derive line-verification state and promotion condition', () => {
    const payload = {
      pass_reason_code: 'LINE_NOT_CONFIRMED',
      selection: { side: 'OVER' },
      line: 8,
      price: 105,
      edge: 0.21,
    };

    expect(deriveWebhookWatchState(payload)).toBe('line not verified');
    expect(deriveWebhookWouldBecomePlay(payload)).toBe(
      'Would become PLAY: OVER 8 if line verifies and edge >= +0.20 holds',
    );
    expect(deriveWebhookDropToPass(payload)).toBe(
      'Drops to PASS: edge < +0.20 or total moves to 8.5',
    );
    expect(describeWebhookReason(payload)).toBe(
      'Line not confirmed',
    );
  });

  test('resolveWebhookDisplaySide prefers nhl_1p projection side then selection then prediction', () => {
    expect(
      resolveWebhookDisplaySide({
        nhl_1p_decision: { projection: { side: 'over' } },
        selection: { side: 'under' },
        prediction: 'under',
      }),
    ).toBe('OVER');

    expect(
      resolveWebhookDisplaySide({
        selection: { side: 'under' },
        prediction: 'over',
      }),
    ).toBe('UNDER');

    expect(resolveWebhookDisplaySide({ prediction: 'over' })).toBe('OVER');
    expect(resolveWebhookDisplaySide({})).toBeNull();
  });

  test('isWebhookLeanEligible enforces absolute edge threshold when edge exists', () => {
    expect(isWebhookLeanEligible({ edge: 0.2 }, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge: -0.2 }, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge: 0.1 }, 0.15)).toBe(false);
  });

  test('isWebhookLeanEligible falls back to true when edge is missing or non-finite', () => {
    expect(isWebhookLeanEligible({}, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge_pct: null }, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge_over_pp: 'abc' }, 0.15)).toBe(true);
  });
});

describe('resolveCanonicalPlayState — canonical play-state contract', () => {
  // ── Invariant checks ──────────────────────────────────────────────────────

  test('null/undefined payload → NO_PLAY (safe default)', () => {
    expect(resolveCanonicalPlayState(null)).toBe('NO_PLAY');
    expect(resolveCanonicalPlayState(undefined)).toBe('NO_PLAY');
    expect(resolveCanonicalPlayState({})).toBe('NO_PLAY');
  });

  // ── Test 1: positive edge + hard gate failure → BLOCKED ───────────────────

  test('1: PLAY status + HEAVY_FAVORITE_PRICE_CAP → BLOCKED', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      reason_codes: ['HEAVY_FAVORITE_PRICE_CAP'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('BLOCKED');
  });

  test('1b: LEAN status + NO_PRIMARY_SUPPORT → BLOCKED', () => {
    const payload = {
      decision_v2: { official_status: 'LEAN' },
      reason_codes: ['NO_PRIMARY_SUPPORT'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('BLOCKED');
  });

  // ── Test 2: positive edge + market unavailable → WATCH ───────────────────

  test('2: LEAN + LINE_NOT_CONFIRMED → WATCH (not Slight Edge)', () => {
    const payload = {
      decision_v2: { official_status: 'LEAN' },
      reason_codes: ['LINE_NOT_CONFIRMED'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('WATCH');
  });

  test('2b: PLAY + EDGE_RECHECK_PENDING → WATCH', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      reason_codes: ['EDGE_RECHECK_PENDING'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('WATCH');
  });

  test('2c: LEAN + GOALIE_UNCONFIRMED → WATCH', () => {
    const payload = {
      decision_v2: { official_status: 'LEAN' },
      reason_codes: ['GOALIE_UNCONFIRMED'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('WATCH');
  });

  test('2d: PLAY + sharp_price_status PENDING_VERIFICATION → WATCH', () => {
    const payload = {
      decision_v2: {
        official_status: 'PLAY',
        sharp_price_status: 'PENDING_VERIFICATION',
      },
    };
    expect(resolveCanonicalPlayState(payload)).toBe('WATCH');
  });

  // ── Test 3: positive edge below official threshold → LEAN ─────────────────

  test('3: LEAN status, clean reason codes → LEAN', () => {
    const payload = {
      decision_v2: { official_status: 'LEAN' },
      reason_codes: [],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('LEAN');
  });

  test('3b: LEAN with no reason_codes at all → LEAN', () => {
    const payload = {
      decision_v2: { official_status: 'LEAN' },
    };
    expect(resolveCanonicalPlayState(payload)).toBe('LEAN');
  });

  // ── Test 4: official candidate passes all gates → OFFICIAL_PLAY ──────────

  test('4: PLAY status, no blocking or watch codes → OFFICIAL_PLAY', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      reason_codes: [],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('OFFICIAL_PLAY');
  });

  // ── Test 5: no OFFICIAL_PLAY candidates → LEAN state, not OFFICIAL_PLAY ──

  test('5: LEAN never maps to OFFICIAL_PLAY', () => {
    const payload = { decision_v2: { official_status: 'LEAN' } };
    // Invariant: official=[] in the router, POTD must return NO_PICK
    expect(resolveCanonicalPlayState(payload)).toBe('LEAN');
    expect(resolveCanonicalPlayState(payload)).not.toBe('OFFICIAL_PLAY');
  });

  // ── Test 6: negative-edge top-ranked raw candidate → NO_PLAY ─────────────

  test('6: PASS status → NO_PLAY (cannot be POTD eligible)', () => {
    const payload = {
      decision_v2: { official_status: 'PASS' },
      reason_codes: ['NO_EDGE_AT_PRICE'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('NO_PLAY');
  });

  test('6b: missing official_status → NO_PLAY', () => {
    const payload = { decision_v2: {} };
    expect(resolveCanonicalPlayState(payload)).toBe('NO_PLAY');
  });

  // ── Test 7: Discord renders strictly from final_play_state ────────────────

  test('7: deriveWebhookBucket — OFFICIAL_PLAY → official bucket', () => {
    const payload = { final_play_state: 'OFFICIAL_PLAY', action: 'FIRE', classification: 'BASE' };
    expect(deriveWebhookBucket(payload)).toBe('official');
  });

  test('7b: deriveWebhookBucket — LEAN → lean bucket (Slight Edge)', () => {
    const payload = { final_play_state: 'LEAN', action: 'HOLD', classification: 'LEAN' };
    expect(deriveWebhookBucket(payload)).toBe('lean');
  });

  test('7c: deriveWebhookBucket — WATCH → pass_blocked (NOT lean / NOT Slight Edge)', () => {
    // This is the core cross-surface bug: a verification-pending LEAN must not
    // be shown as "Slight Edge" on Discord. With final_play_state it won't be.
    const payload = { final_play_state: 'WATCH', action: 'HOLD', classification: 'LEAN' };
    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });

  test('7d: deriveWebhookBucket — BLOCKED → pass_blocked', () => {
    const payload = { final_play_state: 'BLOCKED', action: 'HOLD', classification: 'LEAN' };
    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });

  test('7e: deriveWebhookBucket — NO_PLAY → pass_blocked', () => {
    const payload = { final_play_state: 'NO_PLAY', action: 'PASS', classification: 'PASS' };
    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });

  // ── Test 8: /wedge payload equals canonical resolver output ───────────────

  test('8: LEAN + blocking reason codes → WATCH, not LEAN', () => {
    const payload = {
      decision_v2: { official_status: 'LEAN' },
      reason_codes: ['PRICE_SYNC_PENDING'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('WATCH');
  });

  test('8b: PLAY + MARKET_DATA_STALE → WATCH', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      reason_codes: ['MARKET_DATA_STALE'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('WATCH');
  });

  // ── Test 9: watchdog veto is terminal — cannot be overridden ─────────────

  test('9: watchdog_status BLOCKED + PLAY official_status → BLOCKED', () => {
    const payload = {
      decision_v2: {
        official_status: 'PLAY',
        watchdog_status: 'BLOCKED',
      },
    };
    expect(resolveCanonicalPlayState(payload)).toBe('BLOCKED');
  });

  test('9b: watchdog BLOCKED overrides even clean reason codes', () => {
    const payload = {
      decision_v2: {
        official_status: 'PLAY',
        watchdog_status: 'BLOCKED',
      },
      reason_codes: [],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('BLOCKED');
  });

  // ── Test 10: no downstream surface can manufacture a play from NO_QUALIFIED_PROPS

  test('10: PASS official_status, no reason codes → NO_PLAY', () => {
    const payload = {
      decision_v2: { official_status: 'PASS' },
      reason_codes: [],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('NO_PLAY');
  });

  test('10b: official_eligible=false overrides PLAY status → BLOCKED', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      official_eligible: false,
      reason_codes: [],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('BLOCKED');
  });

  test('10c: final_play_state WATCH cannot be selected as POTD (bucket is pass_blocked)', () => {
    const payload = { final_play_state: 'WATCH' };
    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });

  // ── Reason code precedence: BLOCKED beats WATCH beats positive status ──────

  test('HARD_GATE beats WATCH_REASON in the same payload', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      reason_codes: ['LINE_NOT_CONFIRMED', 'HEAVY_FAVORITE_PRICE_CAP'],
    };
    expect(resolveCanonicalPlayState(payload)).toBe('BLOCKED');
  });

  // ── forcePass override in deriveWebhookBucket still applies ───────────────

  test('forcePass action overrides final_play_state=OFFICIAL_PLAY → pass_blocked', () => {
    const payload = {
      final_play_state: 'OFFICIAL_PLAY',
      action: 'PASS',
      classification: 'BASE',
    };
    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });
});
