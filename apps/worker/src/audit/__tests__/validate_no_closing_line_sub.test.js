'use strict';

const {
  buildClosingLineSubstitutionReport,
  classifyPreGameSnapshot,
} = require('../validate_no_closing_line_sub');

describe('classifyPreGameSnapshot', () => {
  test('marks snapshot as qualifying when before event_start - buffer', () => {
    const result = classifyPreGameSnapshot({
      snapshotTimeIso: '2026-04-16T16:30:00Z',
      eventStartIso: '2026-04-16T18:00:00Z',
      priceBufferMinutes: 60,
    });
    expect(result.status).toBe('QUALIFYING');
    expect(result.qualifying).toBe(true);
  });

  test('marks snapshot as disqualified when inside buffer', () => {
    const result = classifyPreGameSnapshot({
      snapshotTimeIso: '2026-04-16T17:30:00Z',
      eventStartIso: '2026-04-16T18:00:00Z',
      priceBufferMinutes: 60,
    });
    expect(result.status).toBe('WITHIN_BUFFER_OR_POST_START');
    expect(result.qualifying).toBe(false);
  });

  test('marks missing snapshot timestamp as disqualified', () => {
    const result = classifyPreGameSnapshot({
      snapshotTimeIso: null,
      eventStartIso: '2026-04-16T18:00:00Z',
      priceBufferMinutes: 60,
    });
    expect(result.status).toBe('MISSING_SNAPSHOT_TIME');
    expect(result.qualifying).toBe(false);
  });
});

describe('buildClosingLineSubstitutionReport', () => {
  test('fails when excluded game ratio meets or exceeds threshold', () => {
    const rows = [
      {
        game_id: 'g1',
        event_start_utc: '2026-04-16T18:00:00Z',
        snapshot_time_utc: '2026-04-16T15:30:00Z',
      },
      {
        game_id: 'g2',
        event_start_utc: '2026-04-16T19:00:00Z',
        snapshot_time_utc: '2026-04-16T18:30:00Z',
      },
      {
        game_id: 'g3',
        event_start_utc: '2026-04-16T20:00:00Z',
        snapshot_time_utc: null,
      },
    ];

    const report = buildClosingLineSubstitutionReport(rows, {
      maxExcludedRate: 0.2,
      priceBufferMinutes: 60,
    });

    expect(report.summary.games_with_known_event_start).toBe(3);
    expect(report.summary.games_with_timestamped_snapshot).toBe(2);
    expect(report.summary.games_with_qualifying_snapshot).toBe(1);
    expect(report.summary.games_excluded_no_qualifying_snapshot).toBe(1);
    expect(report.summary.excluded_game_rate).toBeCloseTo(0.5, 4);
    expect(report.summary.should_fail).toBe(true);
  });

  test('passes when excluded game ratio is below threshold', () => {
    const rows = [
      {
        game_id: 'g1',
        event_start_utc: '2026-04-16T18:00:00Z',
        snapshot_time_utc: '2026-04-16T16:00:00Z',
      },
      {
        game_id: 'g2',
        event_start_utc: '2026-04-16T19:00:00Z',
        snapshot_time_utc: '2026-04-16T16:30:00Z',
      },
      {
        game_id: 'g3',
        event_start_utc: '2026-04-16T20:00:00Z',
        snapshot_time_utc: '2026-04-16T19:30:00Z',
      },
      {
        game_id: 'g4',
        event_start_utc: '2026-04-16T21:00:00Z',
        snapshot_time_utc: '2026-04-16T20:30:00Z',
      },
      {
        game_id: 'g5',
        event_start_utc: '2026-04-16T22:00:00Z',
        snapshot_time_utc: '2026-04-16T21:30:00Z',
      },
      {
        game_id: 'g6',
        event_start_utc: '2026-04-16T23:00:00Z',
        snapshot_time_utc: '2026-04-16T22:30:00Z',
      },
    ];

    const report = buildClosingLineSubstitutionReport(rows, {
      maxExcludedRate: 0.2,
      priceBufferMinutes: 60,
    });

    expect(report.summary.games_with_known_event_start).toBe(6);
    expect(report.summary.games_with_timestamped_snapshot).toBe(6);
    expect(report.summary.games_excluded_no_qualifying_snapshot).toBe(4);
    expect(report.summary.excluded_game_rate).toBeCloseTo(0.6667, 4);
    expect(report.summary.should_fail).toBe(true);

    const strictReport = buildClosingLineSubstitutionReport(rows, {
      maxExcludedRate: 0.7,
      priceBufferMinutes: 60,
    });
    expect(strictReport.summary.should_fail).toBe(false);
  });

  test('does not fail solely due to missing snapshot timestamps', () => {
    const rows = [
      {
        game_id: 'g1',
        event_start_utc: '2026-04-16T18:00:00Z',
        snapshot_time_utc: null,
      },
      {
        game_id: 'g2',
        event_start_utc: '2026-04-16T19:00:00Z',
        snapshot_time_utc: null,
      },
    ];

    const report = buildClosingLineSubstitutionReport(rows, {
      maxExcludedRate: 0.2,
      priceBufferMinutes: 60,
    });

    expect(report.summary.games_with_known_event_start).toBe(2);
    expect(report.summary.games_with_timestamped_snapshot).toBe(0);
    expect(report.summary.games_excluded_no_qualifying_snapshot).toBe(0);
    expect(report.summary.excluded_game_rate).toBe(0);
    expect(report.summary.should_fail).toBe(false);
  });
});
