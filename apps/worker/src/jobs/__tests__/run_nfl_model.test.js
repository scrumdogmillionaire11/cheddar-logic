const { validateCardPayload } = require('@cheddar-logic/data');
const { generateNFLCard } = require('../run_nfl_model');

function buildOddsSnapshot(overrides = {}) {
  return {
    id: 'odds-row-001',
    game_id: 'nfl-game-001',
    home_team: 'Buffalo Bills',
    away_team: 'New York Jets',
    game_time_utc: '2026-09-10T20:15:00.000Z',
    captured_at: '2026-09-10T12:00:00.000Z',
    h2h_home: -135,
    h2h_away: 115,
    spread_home: -2.5,
    spread_away: 2.5,
    total: 46.5,
    ...overrides,
  };
}

function buildModelOutput(overrides = {}) {
  return {
    prediction: 'HOME',
    confidence: 0.67,
    ev_threshold_passed: true,
    reasoning: 'Model prefers home side off the current moneyline.',
    inference_source: 'mock',
    model_endpoint: null,
    is_mock: true,
    ...overrides,
  };
}

function loadRunNFLModel({
  oddsSnapshots = [buildOddsSnapshot()],
  inferImplementation,
  shouldRunJobKey = true,
  validationResult = { success: true, errors: [] },
  prepareWriteResult = { deletedOutputs: 0, deletedCards: 0 },
} = {}) {
  jest.resetModules();

  const mockInsertJobRun = jest.fn();
  const mockMarkJobRunSuccess = jest.fn();
  const mockMarkJobRunFailure = jest.fn();
  const mockSetCurrentRunId = jest.fn();
  const mockGetOddsWithUpcomingGames = jest.fn(() => oddsSnapshots);
  const mockInsertModelOutput = jest.fn();
  const mockInsertCardPayload = jest.fn();
  const mockPrepareModelAndCardWrite = jest.fn(() => prepareWriteResult);
  const mockValidateCardPayload = jest.fn(() => validationResult);
  const mockShouldRunJobKey = jest.fn(() => shouldRunJobKey);
  const mockWithDb = jest.fn(async (fn) => fn());
  const mockInfer = jest.fn(
    inferImplementation || (async () => buildModelOutput()),
  );
  const mockGetModel = jest.fn(() => ({
    infer: mockInfer,
  }));
  const mockUuidValues = [
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000006',
  ];
  const mockUuid = jest.fn(
    () => mockUuidValues.shift() || '00000000-0000-0000-0000-00000000ffff',
  );

  jest.doMock('@cheddar-logic/data', () => ({
    insertJobRun: mockInsertJobRun,
    markJobRunSuccess: mockMarkJobRunSuccess,
    markJobRunFailure: mockMarkJobRunFailure,
    setCurrentRunId: mockSetCurrentRunId,
    getOddsSnapshots: jest.fn(),
    getOddsWithUpcomingGames: mockGetOddsWithUpcomingGames,
    getLatestOdds: jest.fn(),
    insertModelOutput: mockInsertModelOutput,
    insertCardPayload: mockInsertCardPayload,
    prepareModelAndCardWrite: mockPrepareModelAndCardWrite,
    validateCardPayload: mockValidateCardPayload,
    shouldRunJobKey: mockShouldRunJobKey,
    withDb: mockWithDb,
  }));

  jest.doMock('../../models', () => ({
    getModel: mockGetModel,
  }));

  jest.doMock('uuid', () => ({
    v4: mockUuid,
  }));

  const moduleUnderTest = require('../run_nfl_model');

  return {
    ...moduleUnderTest,
    mocks: {
      mockInsertJobRun,
      mockMarkJobRunSuccess,
      mockMarkJobRunFailure,
      mockSetCurrentRunId,
      mockGetOddsWithUpcomingGames,
      mockInsertModelOutput,
      mockInsertCardPayload,
      mockPrepareModelAndCardWrite,
      mockValidateCardPayload,
      mockShouldRunJobKey,
      mockWithDb,
      mockInfer,
      mockGetModel,
    },
  };
}

describe('generateNFLCard', () => {
  test('builds a validator-clean FIRE payload with expected NFL fields', () => {
    const oddsSnapshot = buildOddsSnapshot();
    const modelOutput = buildModelOutput();

    const card = generateNFLCard(oddsSnapshot.game_id, modelOutput, oddsSnapshot);

    expect(card.cardType).toBe('nfl-model-output');
    expect(card.sport).toBe('NFL');
    expect(card.cardTitle).toBe('NFL Model: HOME');
    expect(card.id).toMatch(/^card-nfl-nfl-game-001-/);
    expect(card.payloadData).toMatchObject({
      game_id: 'nfl-game-001',
      sport: 'NFL',
      model_version: 'nfl-model-v1',
      home_team: 'Buffalo Bills',
      away_team: 'New York Jets',
      prediction: 'HOME',
      confidence: 0.67,
      confidence_pct: 67,
      recommended_bet_type: 'moneyline',
      reasoning: 'Model prefers home side off the current moneyline.',
      ev_passed: true,
      meta: {
        inference_source: 'mock',
        model_endpoint: null,
        is_mock: true,
      },
      odds_context: {
        h2h_home: -135,
        h2h_away: 115,
        spread_home: -2.5,
        spread_away: 2.5,
        total: 46.5,
        captured_at: '2026-09-10T12:00:00.000Z',
      },
    });
    expect(card.payloadData.recommendation).toMatchObject({
      type: 'ML_HOME',
      pass_reason: null,
    });
    expect(card.payloadData.market).toMatchObject({
      moneyline_home: '-135',
      moneyline_away: '+115',
      spread_home: -2.5,
      total_line: 46.5,
    });
    expect(validateCardPayload(card.cardType, card.payloadData)).toEqual({
      success: true,
      errors: [],
    });
  });
});

describe('runNFLModel', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    delete process.env.ENABLE_NFL_MODEL;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('dedupes snapshots by latest capture and writes a FIRE card', async () => {
    const olderSnapshot = buildOddsSnapshot({
      id: 'odds-old',
      game_id: 'game-fire',
      captured_at: '2026-09-10T10:00:00.000Z',
      h2h_home: -120,
    });
    const newerSnapshot = buildOddsSnapshot({
      id: 'odds-new',
      game_id: 'game-fire',
      captured_at: '2026-09-10T12:00:00.000Z',
      h2h_home: -145,
    });

    const { runNFLModel, mocks } = loadRunNFLModel({
      oddsSnapshots: [olderSnapshot, newerSnapshot],
      inferImplementation: async () =>
        buildModelOutput({
          prediction: 'AWAY',
          confidence: 0.71,
          reasoning: 'Away side has the stronger price-adjusted edge.',
        }),
      prepareWriteResult: { deletedOutputs: 1, deletedCards: 1 },
    });

    const result = await runNFLModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 1,
      cardsFailed: 0,
      errors: [],
    });
    expect(mocks.mockGetModel).toHaveBeenCalledWith('NFL');
    expect(mocks.mockInfer).toHaveBeenCalledTimes(1);
    expect(mocks.mockInfer).toHaveBeenCalledWith('game-fire', newerSnapshot);
    expect(mocks.mockPrepareModelAndCardWrite).toHaveBeenCalledWith(
      'game-fire',
      'nfl-model-v1',
      'nfl-model-output',
      { runId: result.jobRunId },
    );
    expect(mocks.mockValidateCardPayload).toHaveBeenCalledTimes(1);
    expect(mocks.mockInsertModelOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model-nfl-game-fire-00000000',
        gameId: 'game-fire',
        sport: 'NFL',
        modelName: 'nfl-model-v1',
        confidence: 0.71,
        oddsSnapshotId: 'odds-new',
        jobRunId: result.jobRunId,
      }),
    );

    const insertedCard = mocks.mockInsertCardPayload.mock.calls[0][0];
    expect(insertedCard).toMatchObject({
      gameId: 'game-fire',
      sport: 'NFL',
      cardType: 'nfl-model-output',
      cardTitle: 'NFL Model: AWAY',
      modelOutputIds: 'model-nfl-game-fire-00000000',
      runId: result.jobRunId,
    });
    expect(insertedCard.payloadData.run_id).toBe(result.jobRunId);
    expect(insertedCard.payloadData.prediction).toBe('AWAY');
    expect(insertedCard.payloadData.odds_context.h2h_home).toBe(-145);
    expect(mocks.mockMarkJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.mockSetCurrentRunId).toHaveBeenCalledWith(
      result.jobRunId,
      'nfl',
    );
    expect(mocks.mockMarkJobRunFailure).not.toHaveBeenCalled();
  });

  test('abstains without writes when the model does not pass threshold', async () => {
    const { runNFLModel, mocks } = loadRunNFLModel({
      inferImplementation: async () =>
        buildModelOutput({
          confidence: 0.41,
          ev_threshold_passed: false,
          reasoning: 'Confidence is below the publish threshold.',
        }),
    });

    const result = await runNFLModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
      cardsFailed: 0,
      errors: [],
    });
    expect(mocks.mockInfer).toHaveBeenCalledTimes(1);
    expect(mocks.mockInsertModelOutput).not.toHaveBeenCalled();
    expect(mocks.mockInsertCardPayload).not.toHaveBeenCalled();
    expect(mocks.mockValidateCardPayload).not.toHaveBeenCalled();
    expect(mocks.mockMarkJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.mockSetCurrentRunId).toHaveBeenCalledWith(
      result.jobRunId,
      'nfl',
    );
  });

  test('returns success with zero cards when no upcoming odds exist', async () => {
    const { runNFLModel, mocks } = loadRunNFLModel({
      oddsSnapshots: [],
    });

    const result = await runNFLModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
    });
    expect(mocks.mockInfer).not.toHaveBeenCalled();
    expect(mocks.mockInsertModelOutput).not.toHaveBeenCalled();
    expect(mocks.mockInsertCardPayload).not.toHaveBeenCalled();
    expect(mocks.mockMarkJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.mockSetCurrentRunId).not.toHaveBeenCalled();
  });

  test('honors dryRun without recording a job or touching the model', async () => {
    const { runNFLModel, mocks } = loadRunNFLModel();

    const result = await runNFLModel({ dryRun: true });

    expect(result).toEqual({
      success: true,
      jobRunId: null,
      dryRun: true,
      jobKey: null,
    });
    expect(mocks.mockInsertJobRun).not.toHaveBeenCalled();
    expect(mocks.mockGetOddsWithUpcomingGames).not.toHaveBeenCalled();
    expect(mocks.mockInfer).not.toHaveBeenCalled();
    expect(mocks.mockMarkJobRunSuccess).not.toHaveBeenCalled();
    expect(mocks.mockMarkJobRunFailure).not.toHaveBeenCalled();
  });

  test('skips execution when jobKey is already claimed', async () => {
    const { runNFLModel, mocks } = loadRunNFLModel({
      shouldRunJobKey: false,
    });

    const result = await runNFLModel({ jobKey: 'nfl:2026-09-10T20' });

    expect(result).toEqual({
      success: true,
      jobRunId: null,
      skipped: true,
      jobKey: 'nfl:2026-09-10T20',
    });
    expect(mocks.mockShouldRunJobKey).toHaveBeenCalledWith('nfl:2026-09-10T20');
    expect(mocks.mockInsertJobRun).not.toHaveBeenCalled();
    expect(mocks.mockGetOddsWithUpcomingGames).not.toHaveBeenCalled();
  });

  test('fails the job when card payload validation fails', async () => {
    const { runNFLModel, mocks } = loadRunNFLModel({
      validationResult: {
        success: false,
        errors: ['payload_data.market is invalid'],
      },
    });

    const result = await runNFLModel();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid card payload');
    expect(result.error).toContain('payload_data.market is invalid');
    expect(mocks.mockInsertModelOutput).not.toHaveBeenCalled();
    expect(mocks.mockInsertCardPayload).not.toHaveBeenCalled();
    expect(mocks.mockMarkJobRunFailure).toHaveBeenCalledWith(
      result.jobRunId,
      expect.stringContaining('Invalid card payload'),
    );
    expect(mocks.mockMarkJobRunSuccess).not.toHaveBeenCalled();
    expect(mocks.mockSetCurrentRunId).not.toHaveBeenCalled();
  });

  test('accumulates per-game errors without failing the whole job', async () => {
    const failingSnapshot = buildOddsSnapshot({
      id: 'odds-fail',
      game_id: 'game-fail',
      captured_at: '2026-09-10T11:00:00.000Z',
    });
    const passingSnapshot = buildOddsSnapshot({
      id: 'odds-pass',
      game_id: 'game-pass',
      captured_at: '2026-09-10T12:00:00.000Z',
    });

    const { runNFLModel, mocks } = loadRunNFLModel({
      oddsSnapshots: [failingSnapshot, passingSnapshot],
      inferImplementation: async (gameId) => {
        if (gameId === 'game-fail') {
          throw new Error('remote inference timeout');
        }
        return buildModelOutput({
          prediction: 'AWAY',
          confidence: 0.74,
          reasoning: 'Away side cleared the threshold after the failed game.',
        });
      },
    });

    const result = await runNFLModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 1,
      cardsFailed: 1,
    });
    expect(result.errors).toEqual(
      expect.arrayContaining(['game-fail: remote inference timeout']),
    );
    expect(mocks.mockInsertModelOutput).toHaveBeenCalledTimes(1);
    expect(mocks.mockInsertCardPayload).toHaveBeenCalledTimes(1);
    expect(mocks.mockMarkJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.mockMarkJobRunFailure).not.toHaveBeenCalled();
  });
});
