'use strict';

const { assertFeatureTimeliness, HIGH_RISK_FIELDS } = require('../feature-time-guard');

describe('assertFeatureTimeliness', () => {
  const BET_TIME = '2026-04-06T17:00:00Z';

  test('returns ok=true with empty violations when no feature_timestamps present', () => {
    const result = assertFeatureTimeliness({}, BET_TIME);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('returns ok=true with empty violations when feature_timestamps is empty object', () => {
    const result = assertFeatureTimeliness({ feature_timestamps: {} }, BET_TIME);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('skips fields with null available_at (Phase 1 soft mode)', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: null } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('ok=true when available_at is before bet_placed_at', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: '2026-04-06T12:00:00Z' } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('ok=true when available_at equals bet_placed_at', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { umpire_factor: BET_TIME } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('records violation when available_at is after bet_placed_at', () => {
    const available = '2026-04-06T19:00:00Z'; // 2h after bet
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: available } },
      BET_TIME,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      field: 'homeGoalieCertainty',
      available_at: available,
      bet_placed_at: BET_TIME,
    });
  });

  test('records multiple violations across different fields', () => {
    const result = assertFeatureTimeliness(
      {
        feature_timestamps: {
          homeGoalieCertainty: '2026-04-06T19:00:00Z',
          awayGoalieCertainty: '2026-04-06T20:00:00Z',
          umpire_factor: '2026-04-06T12:00:00Z', // clean
        },
      },
      BET_TIME,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.field).sort()).toEqual([
      'awayGoalieCertainty',
      'homeGoalieCertainty',
    ]);
  });

  test('ignores non-high-risk fields in feature_timestamps', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { some_other_field: '2026-04-07T00:00:00Z' } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('returns ok=true when betPlacedAt is invalid ISO string', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: '2026-04-06T12:00:00Z' } },
      'not-a-date',
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('skips fields with invalid available_at timestamps', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: 'bad-date' } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('handles null rawData gracefully', () => {
    const result = assertFeatureTimeliness(null, BET_TIME);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('HIGH_RISK_FIELDS exports the expected set', () => {
    expect(HIGH_RISK_FIELDS).toContain('umpire_factor');
    expect(HIGH_RISK_FIELDS).toContain('homeGoalieCertainty');
    expect(HIGH_RISK_FIELDS).toContain('awayGoalieCertainty');
    expect(HIGH_RISK_FIELDS).toContain('homeGoalsForL5');
    expect(HIGH_RISK_FIELDS).toContain('rolling_14d_wrc_plus_vs_hand');
  });
});
