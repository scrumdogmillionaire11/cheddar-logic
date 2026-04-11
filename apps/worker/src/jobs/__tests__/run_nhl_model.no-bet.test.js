'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(() => ({})),
  updateOddsSnapshotRawData: jest.fn(),
}));

const { applyNoBetGuard } = require('../run_nhl_model');

function buildOddsSnapshot() {
  return {
    home_team: 'Home Team',
    away_team: 'Away Team',
    captured_at: '2026-04-11T15:00:00.000Z',
    h2h_home: -120,
    h2h_away: 105,
    total: 6.5,
    total_price_over: -110,
    total_price_under: -110,
  };
}

describe('run_nhl_model NO_BET guard', () => {
  test('DOUBLE_UNKNOWN_GOALIE writes explicit NO_BET pipeline state and increments count', () => {
    const gamePipelineStates = {};
    const logger = { log: jest.fn() };

    const result = applyNoBetGuard({
      marketDecisions: {
        status: 'NO_BET',
        reason_detail: 'DOUBLE_UNKNOWN_GOALIE',
        reason: 'NO_BET',
      },
      gameId: 'game-123',
      oddsSnapshot: buildOddsSnapshot(),
      gamePipelineStates,
      noBetCount: 0,
      logger,
    });

    expect(result).toEqual({
      handled: true,
      noBetCount: 1,
      reason: 'DOUBLE_UNKNOWN_GOALIE',
    });
    expect(logger.log).toHaveBeenCalledWith(
      '  [NO_BET] game-123: DOUBLE_UNKNOWN_GOALIE',
    );
    expect(gamePipelineStates['game-123']).toMatchObject({
      projection_ready: true,
      drivers_ready: false,
      pricing_ready: false,
      card_ready: false,
      blocking_reason_codes: ['DOUBLE_UNKNOWN_GOALIE'],
    });
  });

  test('non-NO_BET market decisions do not fire the guard', () => {
    const gamePipelineStates = {};

    const result = applyNoBetGuard({
      marketDecisions: {
        TOTAL: { status: 'WATCH' },
      },
      gameId: 'game-456',
      oddsSnapshot: buildOddsSnapshot(),
      gamePipelineStates,
      noBetCount: 3,
      logger: { log: jest.fn() },
    });

    expect(result).toEqual({
      handled: false,
      noBetCount: 3,
    });
    expect(gamePipelineStates).toEqual({});
  });
});
