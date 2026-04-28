const {
  AUTHORITY_STATUSES,
  CANONICAL_DECISION_SOURCE,
  resolveCanonicalDecision,
  toPipelineOfficialStatus,
} = require('../decision-authority');

describe('decision-authority lifecycle contract', () => {
  test('normalizes decision_v2 LEAN into canonical SLIGHT_EDGE', () => {
    const decision = resolveCanonicalDecision(
      {
        decision_v2: {
          official_status: 'LEAN',
          primary_reason_code: 'EDGE_CLEAR',
          source: CANONICAL_DECISION_SOURCE,
          watchdog_status: 'READY',
        },
      },
      { stage: 'read_api' },
    );

    expect(decision).toEqual({
      official_status: AUTHORITY_STATUSES.SLIGHT_EDGE,
      is_actionable: true,
      tier: AUTHORITY_STATUSES.SLIGHT_EDGE,
      reason_code: 'EDGE_CLEAR',
      source: CANONICAL_DECISION_SOURCE,
      lifecycle: [
        {
          stage: 'read_api',
          status: 'DOWNGRADED',
          reason_code: 'EDGE_CLEAR',
        },
      ],
    });
    expect(toPipelineOfficialStatus(decision.official_status)).toBe('LEAN');
  });

  test('fails closed when canonical decision status is missing', () => {
    const decision = resolveCanonicalDecision(
      {
        status: 'FIRE',
        action: 'FIRE',
        classification: 'BASE',
      },
      { stage: 'read_api' },
    );

    expect(decision).toEqual({
      official_status: AUTHORITY_STATUSES.INVALID,
      is_actionable: false,
      tier: AUTHORITY_STATUSES.INVALID,
      reason_code: 'MISSING_DECISION_V2',
      source: CANONICAL_DECISION_SOURCE,
      lifecycle: [
        {
          stage: 'read_api',
          status: 'INVALID',
          reason_code: 'MISSING_DECISION_V2',
        },
      ],
    });
  });

  test('can opt into legacy fallback for migration paths', () => {
    const decision = resolveCanonicalDecision(
      {
        status: 'WATCH',
        action: 'HOLD',
        classification: 'LEAN',
      },
      {
        stage: 'publisher',
        fallbackToLegacy: true,
      },
    );

    expect(decision).not.toBeNull();
    expect(decision.official_status).toBe(AUTHORITY_STATUSES.SLIGHT_EDGE);
    expect(decision.reason_code).toBe('MISSING_DECISION_V2');
    expect(decision.lifecycle).toEqual([
      {
        stage: 'publisher',
        status: 'DOWNGRADED',
        reason_code: 'MISSING_DECISION_V2',
      },
    ]);
  });

  test('rejects non-authoritative source when strict source is enabled', () => {
    const decision = resolveCanonicalDecision(
      {
        decision_v2: {
          official_status: 'PLAY',
          source: 'legacy_repair',
          primary_reason_code: 'EDGE_CLEAR',
        },
      },
      {
        stage: 'read_api',
        strictSource: true,
      },
    );

    expect(decision).toBeNull();
  });
});
