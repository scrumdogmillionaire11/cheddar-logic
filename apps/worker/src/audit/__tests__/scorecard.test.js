'use strict';

const {
  buildScorecard,
  determineFamilyRisk,
  formatScorecardMarkdown,
} = require('../scorecard');

function makeAuditReport(overrides = {}) {
  return {
    by_sport: {
      NBA: {
        critical_count: 0,
        failed: 0,
        fixture_count: 1,
        high_severity_count: 0,
        passed: 1,
        warn_count: 0,
      },
    },
    critical_count: 0,
    drift_categories: [],
    failed: 0,
    fixture_count: 1,
    gate_failures: [],
    high_severity_count: 0,
    passed: 1,
    results: [
      {
        card_family: 'NBA_TOTAL',
        critical_count: 0,
        fixture_id: 'nba_fixture_01',
        high_severity_count: 0,
        passed: true,
        sport: 'NBA',
        warn_count: 0,
      },
    ],
    warn_count: 0,
    ...overrides,
  };
}

function makePerformanceRow(index, overrides = {}) {
  return {
    card_family: 'NBA_TOTAL',
    execution_status: 'EXECUTABLE',
    official_status: 'PLAY',
    p_fair: 0.55,
    result: 'WIN',
    settled_at: new Date(Date.UTC(2026, 3, 30 - index)).toISOString(),
    settled_at_ms: Date.UTC(2026, 3, 30 - index),
    sport: 'NBA',
    ...overrides,
  };
}

describe('determineFamilyRisk', () => {
  test('maps LOW risk when no audit or performance issues exist', () => {
    expect(
      determineFamilyRisk(
        { audit_warn_count: 0, critical_count: 0, high_severity_count: 0 },
        [],
      ),
    ).toMatchObject({ risk: 'LOW' });
  });

  test('maps MEDIUM risk for warn-only signals', () => {
    expect(
      determineFamilyRisk(
        { audit_warn_count: 1, critical_count: 0, high_severity_count: 0 },
        [],
      ),
    ).toMatchObject({ risk: 'MEDIUM' });
  });

  test('maps HIGH risk for high audit drift', () => {
    expect(
      determineFamilyRisk(
        { audit_warn_count: 0, critical_count: 0, high_severity_count: 1 },
        [],
      ),
    ).toMatchObject({ risk: 'HIGH' });
  });

  test('maps CRITICAL risk for critical performance alerts', () => {
    expect(
      determineFamilyRisk(
        { audit_warn_count: 0, critical_count: 0, high_severity_count: 0 },
        [{ alert_type: 'PASS_RATE_COLLAPSE', severity: 'CRITICAL' }],
      ),
    ).toMatchObject({ risk: 'CRITICAL' });
  });
});

describe('buildScorecard', () => {
  test('marks model decay when performance alerts exist without high/critical audit drift and emits trend directions', () => {
    const currentRows = Array.from({ length: 50 }, (_, index) =>
      makePerformanceRow(index, {
        execution_status: index < 40 ? 'EXECUTABLE' : 'BLOCKED',
        official_status: index < 5 ? 'PASS' : 'PLAY',
      }),
    );
    const baselineRows = Array.from({ length: 50 }, (_, index) =>
      makePerformanceRow(index + 50, {
        execution_status: index < 20 ? 'EXECUTABLE' : 'BLOCKED',
        official_status: index < 15 ? 'PASS' : 'PLAY',
      }),
    );

    const scorecard = buildScorecard({
      auditReport: makeAuditReport({
        results: [
          {
            card_family: 'NBA_TOTAL',
            critical_count: 0,
            fixture_id: 'nba_fixture_01',
            high_severity_count: 0,
            passed: true,
            sport: 'NBA',
            warn_count: 1,
          },
        ],
        warn_count: 1,
      }),
      generatedAt: '2026-04-30T00:00:00Z',
      performanceContext: {
        error: null,
        report: {
          alerts: [
            {
              alert_type: 'PASS_RATE_COLLAPSE',
              card_family: 'NBA_TOTAL',
              severity: 'WARN',
              sport: 'NBA',
              threshold: 0.2,
              value: 0.1,
              window: 'last_50',
            },
          ],
          windows: {},
        },
        rows: [...currentRows, ...baselineRows],
      },
      runScope: 'ci-123',
    });

    expect(scorecard.families['NBA.NBA_TOTAL']).toMatchObject({
      model_decay: true,
      risk: 'MEDIUM',
      trend: {
        executable_rate: 'UP',
        pass_rate: 'DOWN',
      },
    });
  });

  test('produces markdown summary from the scorecard shape', () => {
    const scorecard = buildScorecard({
      auditReport: makeAuditReport(),
      generatedAt: '2026-04-30T00:00:00Z',
      performanceContext: {
        error: 'missing db',
        report: {
          alerts: [],
          windows: {},
        },
        rows: [],
      },
      runScope: 'ci-456',
    });

    const markdown = formatScorecardMarkdown(scorecard);

    expect(markdown).toContain('# Audit Scorecard');
    expect(markdown).toContain('NBA.NBA_TOTAL');
    expect(markdown).toContain('Performance report unavailable: missing db');
  });
});
