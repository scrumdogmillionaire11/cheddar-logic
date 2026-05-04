'use strict';

const {
  DISPLAY_LOG_NOT_ENROLLED_BUCKET,
  DISPLAY_LOG_NOT_ENROLLED_REASON,
  buildDisplayLogNotEnrolledDiagnostic,
  collectVisibilityIntegrityDiagnostics,
} = require('../jobs/report_settlement_health');

describe('settlement health DISPLAY_LOG_NOT_ENROLLED contract', () => {
  test('normalizes the explicit missing display-log bucket contract', () => {
    expect(buildDisplayLogNotEnrolledDiagnostic()).toEqual({
      bucket: DISPLAY_LOG_NOT_ENROLLED_BUCKET,
      reason: DISPLAY_LOG_NOT_ENROLLED_REASON,
      count: 0,
      samples: [],
    });
  });

  test('collects sampled rows under the explicit missing display-log bucket', () => {
    const rows = [
      {
        card_id: 'card-hidden-1',
        game_id: 'game-hidden-1',
        sport: 'NBA',
        card_type: 'nba-model-output',
        card_title: 'Hidden settled row',
        created_at: '2026-05-03T10:00:00.000Z',
        payload_data: JSON.stringify({
          kind: 'PLAY',
          sport: 'NBA',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          price: -115,
          decision_v2: { official_status: 'PLAY' },
        }),
        display_log_pick_id: null,
        displayed_at: null,
      },
      {
        card_id: 'card-enrolled-1',
        game_id: 'game-enrolled-1',
        sport: 'NBA',
        card_type: 'nba-model-output',
        card_title: 'Enrolled row',
        created_at: '2026-05-03T09:00:00.000Z',
        payload_data: JSON.stringify({
          kind: 'PLAY',
          sport: 'NBA',
          market_type: 'MONEYLINE',
          selection: 'AWAY',
          price: 105,
          decision_v2: { official_status: 'LEAN' },
        }),
        display_log_pick_id: 'card-enrolled-1',
        displayed_at: '2026-05-03T09:01:00.000Z',
      },
    ];
    const db = {
      prepare: jest.fn((sql) => {
        expect(sql).toContain('FROM card_payloads cp');
        expect(sql).toContain('LEFT JOIN card_display_log cdl ON cdl.pick_id = cp.id');
        return { all: () => rows };
      }),
    };

    const diagnostics = collectVisibilityIntegrityDiagnostics(db, { sampleLimit: 5 });

    expect(diagnostics.counts[DISPLAY_LOG_NOT_ENROLLED_BUCKET]).toBe(1);
    expect(diagnostics.displayLogNotEnrolled).toEqual({
      bucket: DISPLAY_LOG_NOT_ENROLLED_BUCKET,
      reason: DISPLAY_LOG_NOT_ENROLLED_REASON,
      count: 1,
      samples: [
        expect.objectContaining({
          cardId: 'card-hidden-1',
          gameId: 'game-hidden-1',
          sport: 'NBA',
          cardType: 'nba-model-output',
          officialStatus: 'PLAY',
        }),
      ],
    });
  });
});
