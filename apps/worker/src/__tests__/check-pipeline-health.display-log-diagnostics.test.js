'use strict';

describe('pipeline health DISPLAY_LOG_NOT_ENROLLED contract', () => {
  let checkVisibilityIntegrity;
  let pipelineWrites;
  let visibilityRows;

  beforeEach(() => {
    jest.resetModules();
    pipelineWrites = [];
    visibilityRows = [];

    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO pipeline_health')) {
          return { run: (...args) => { pipelineWrites.push(args); } };
        }
        if (
          sql.includes('FROM card_payloads cp') &&
          sql.includes('LEFT JOIN card_display_log cdl ON cdl.pick_id = cp.id')
        ) {
          return { all: () => visibilityRows };
        }
        if (
          sql.includes('FROM pipeline_health') &&
          sql.includes('WHERE phase = ? AND check_name = ?')
        ) {
          return { all: () => [], get: () => null };
        }
        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      getDatabase: jest.fn(() => db),
      insertJobRun: jest.fn(() => 1),
      markJobRunSuccess: jest.fn(),
      markJobRunFailure: jest.fn(),
      createJob: jest.fn(),
      wasJobRecentlySuccessful: jest.fn(() => false),
      writePipelineHealthState: null,
      buildPipelineHealthCheckId: null,
    }));

    jest.doMock('../jobs/run_mlb_model', () => ({ buildMlbMarketAvailability: jest.fn() }));
    jest.doMock('../schedulers/quota', () => ({ getCurrentQuotaTier: jest.fn(() => 'FULL') }));
    jest.doMock('../jobs/post_discord_cards', () => ({ sendDiscordMessages: jest.fn() }));
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn(() => false),
    }));

    ({ checkVisibilityIntegrity } = require('../jobs/check_pipeline_health'));
  });

  test('returns the explicit missing-enrollment contract when visibility gaps exist', () => {
    visibilityRows = [
      {
        card_id: 'card-hidden-1',
        game_id: 'game-hidden-1',
        sport: 'nba',
        card_type: 'nba-model-output',
        card_title: 'Hidden row',
        created_at: '2026-05-03T11:30:00.000Z',
        payload_data: JSON.stringify({
          kind: 'PLAY',
          sport: 'NBA',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          price: -110,
          decision_v2: { official_status: 'PLAY' },
        }),
        display_log_pick_id: null,
        displayed_at: null,
      },
    ];

    const result = checkVisibilityIntegrity({ lookbackHours: 24, sampleLimit: 5 });

    expect(result.ok).toBe(false);
    expect(result.missingEnrollment).toMatchObject({
      bucket: 'DISPLAY_LOG_NOT_ENROLLED',
      count: 1,
      samples: [
        expect.objectContaining({
          cardId: 'card-hidden-1',
          gameId: 'game-hidden-1',
        }),
      ],
    });
    expect(result.missingEnrollment.reason).toContain('card_display_log');
    expect(result.missingEnrollmentCount).toBe(1);
    expect(result.sampleIds).toEqual(['card-hidden-1']);
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][2]).toBe('failed');
  });

  test('keeps the same contract shape when no visibility gaps exist', () => {
    visibilityRows = [
      {
        card_id: 'card-enrolled-1',
        game_id: 'game-enrolled-1',
        sport: 'nba',
        card_type: 'nba-model-output',
        card_title: 'Enrolled row',
        created_at: '2026-05-03T11:30:00.000Z',
        payload_data: JSON.stringify({
          kind: 'PLAY',
          sport: 'NBA',
          market_type: 'MONEYLINE',
          selection: 'AWAY',
          price: 105,
          decision_v2: { official_status: 'LEAN' },
        }),
        display_log_pick_id: 'card-enrolled-1',
        displayed_at: '2026-05-03T11:31:00.000Z',
      },
    ];

    const result = checkVisibilityIntegrity({ lookbackHours: 24, sampleLimit: 5 });

    expect(result.ok).toBe(true);
    expect(result.missingEnrollment).toEqual({
      bucket: 'DISPLAY_LOG_NOT_ENROLLED',
      reason:
        'Missing card_display_log enrollment keeps the row out of surfaced results; diagnostics do not attempt repair writes.',
      count: 0,
      samples: [],
    });
    expect(result.missingEnrollmentCount).toBe(0);
    expect(result.sampleIds).toEqual([]);
    expect(pipelineWrites).toHaveLength(1);
    expect(pipelineWrites[0][2]).toBe('ok');
  });
});
