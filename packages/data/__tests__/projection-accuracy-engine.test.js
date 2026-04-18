const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-projection-accuracy-'));
  return path.join(dir, 'test.db');
}

function resetDbEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.RECORD_DATABASE_PATH;
}

describe('projection accuracy confidence engine', () => {
  let dbPath;

  beforeEach(async () => {
    jest.resetModules();
    resetDbEnv();
    dbPath = makeTempDbPath();
    process.env.CHEDDAR_DB_PATH = dbPath;

    const { runMigrations } = require('../src/migrate');
    await runMigrations();
  });

  afterEach(() => {
    try {
      require('../src/db/connection').closeDatabase();
    } catch {
      // best effort cleanup
    }
    resetDbEnv();
  });

  test('insertCardPayload captures projection accuracy rows and grades from actual_result', () => {
    const { getDatabase } = require('../src/db/connection');
    const { upsertGame } = require('../src/db/games');
    const { insertCardPayload, setProjectionActualResult } = require('../src/db/cards');
    const {
      getProjectionAccuracyEvals,
      getProjectionAccuracyLineEvals,
      getProjectionAccuracyEvalSummary,
      roundToNearestHalf,
    } = require('../src/db/projection-accuracy');

    expect(roundToNearestHalf(5.2)).toBe(5.5);
    expect(roundToNearestHalf(4.7)).toBe(4.5);

    upsertGame({
      id: 'game-pa-1',
      gameId: 'nhl-proj-accuracy-1',
      sport: 'NHL',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Toronto Maple Leafs',
      gameTimeUtc: '2026-04-17T23:00:00.000Z',
      status: 'scheduled',
    });

    insertCardPayload({
      id: 'card-nhl-sog-pa-1',
      gameId: 'nhl-proj-accuracy-1',
      sport: 'NHL',
      cardType: 'nhl-player-shots',
      cardTitle: 'Auston Matthews Shots on Goal',
      createdAt: '2026-04-17T18:00:00.000Z',
      payloadData: {
        sport: 'NHL',
        card_type: 'nhl-player-shots',
        generated_at: '2026-04-17T18:00:00.000Z',
        recommended_bet_type: 'unknown',
        confidence: 0.8,
        line: 3.5,
        tags: ['no_odds_mode'],
        player_id: '8479318',
        player_name: 'Auston Matthews',
        team_abbr: 'TOR',
        selection: { side: 'under', line: 3.5 },
        decision: {
          projection: 3.24,
          market_line: 3.5,
          direction: 'UNDER',
          confidence: 0.8,
          market_line_source: 'synthetic_fallback',
        },
        play: {
          period: 'full_game',
          selection: { side: 'under', line: 3.5 },
        },
      },
    });

    const db = getDatabase();
    const rows = getProjectionAccuracyEvals(db, { cardId: 'card-nhl-sog-pa-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_id: 'card-nhl-sog-pa-1',
      card_type: 'nhl-player-shots',
      market_family: 'NHL_PLAYER_SHOTS',
      player_id: '8479318',
      selected_line: 3.5,
      nearest_half_line: 3.5,
      synthetic_line: 3.5,
      synthetic_rule: 'nearest_half',
      selected_direction: 'UNDER',
      weak_direction_flag: 0,
      market_trust: 'SYNTHETIC_FALLBACK',
      grade_status: 'PENDING',
    });

    const lineRows = getProjectionAccuracyLineEvals(db, { cardId: 'card-nhl-sog-pa-1', lineRole: 'SYNTHETIC' });
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]).toMatchObject({
      line_role: 'SYNTHETIC',
      eval_line: 3.5,
      direction: 'UNDER',
      weak_direction_flag: 0,
    });
    expect(lineRows[0].confidence_score).toBeGreaterThanOrEqual(0);

    setProjectionActualResult('card-nhl-sog-pa-1', { shots: 2 });

    const graded = getProjectionAccuracyEvals(db, { cardId: 'card-nhl-sog-pa-1' })[0];
    expect(graded).toMatchObject({
      actual_value: 2,
      grade_status: 'GRADED',
      graded_result: 'WIN',
      signed_error: 1.24,
    });
    expect(graded.absolute_error).toBeCloseTo(1.24);

    const selectedSummary = getProjectionAccuracyEvalSummary(db, {
      cardType: 'nhl-player-shots',
      lineRole: 'SYNTHETIC',
    });
    expect(selectedSummary).toMatchObject({
      total_cards: 1,
      total_line_evals: 1,
      graded_line_evals: 1,
      wins: 1,
      losses: 0,
    });
    expect(selectedSummary.hit_rate).toBe(1);
  });

  test('projection-only pitcher-K capture derives nearest-half line and confidence without a market line', () => {
    const {
      deriveProjectionAccuracyCapture,
      captureProjectionAccuracyEval,
      getProjectionAccuracyLineEvals,
    } = require('../src/db/projection-accuracy');
    const { getDatabase } = require('../src/db/connection');

    const capture = deriveProjectionAccuracyCapture({
      id: 'card-mlb-k-pa-1',
      gameId: 'mlb-proj-accuracy-1',
      sport: 'MLB',
      cardType: 'mlb-pitcher-k',
      createdAt: '2026-04-17T18:00:00.000Z',
      payloadData: {
        sport: 'MLB',
        card_type: 'mlb-pitcher-k',
        basis: 'PROJECTION_ONLY',
        tags: ['no_odds_mode'],
        confidence: 0.66,
        player_id: '669373',
        player_name: 'Example Starter',
        projection: { k_mean: 6.76 },
      },
    });

    expect(capture).toMatchObject({
      cardId: 'card-mlb-k-pa-1',
      cardType: 'mlb-pitcher-k',
      marketFamily: 'MLB_PITCHER_K',
      selectedLine: null,
      nearestHalfLine: 6.5,
      marketTrust: 'PROJECTION_ONLY',
    });

    const db = getDatabase();
    expect(captureProjectionAccuracyEval(db, capture)).toBe(true);
    expect(captureProjectionAccuracyEval(db, capture)).toBe(true);

    const lines = getProjectionAccuracyLineEvals(db, { cardId: 'card-mlb-k-pa-1' });
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const synthetic = lines.find((row) => row.line_role === 'SYNTHETIC');
    expect(synthetic).toMatchObject({
      eval_line: 6.5,
      direction: 'OVER',
      weak_direction_flag: 0,
      market_trust: 'PROJECTION_ONLY',
    });
  });

  test('captures MLB F5 totals and freezes projection_raw on repeated capture', () => {
    const {
      deriveProjectionAccuracyCapture,
      captureProjectionAccuracyEval,
      getProjectionAccuracyEvals,
      getProjectionAccuracyLineEvals,
      computeMarketTrustStatus,
    } = require('../src/db/projection-accuracy');
    const { getDatabase } = require('../src/db/connection');
    const db = getDatabase();

    const base = {
      id: 'card-mlb-f5-pa-1',
      gameId: 'mlb-f5-pa-1',
      sport: 'MLB',
      cardType: 'mlb-f5',
      createdAt: '2026-04-17T18:00:00.000Z',
      payloadData: {
        sport: 'MLB',
        card_type: 'mlb-f5',
        projection: { projected_total: 5.2 },
      },
    };

    expect(captureProjectionAccuracyEval(db, deriveProjectionAccuracyCapture(base))).toBe(true);
    expect(captureProjectionAccuracyEval(db, deriveProjectionAccuracyCapture({
      ...base,
      payloadData: { ...base.payloadData, projection: { projected_total: 8.1 } },
    }))).toBe(true);

    const row = getProjectionAccuracyEvals(db, { cardId: 'card-mlb-f5-pa-1' })[0];
    expect(row).toMatchObject({
      market_family: 'MLB_F5_TOTAL',
      projection_raw: 5.2,
      projection_value: 5.2,
      synthetic_line: 5.5,
      synthetic_direction: 'UNDER',
    });

    const lines = getProjectionAccuracyLineEvals(db, { cardId: 'card-mlb-f5-pa-1' });
    expect(lines.map((line) => line.eval_line)).toEqual(expect.arrayContaining([3.5, 4.5, 5.5]));

    expect(computeMarketTrustStatus({ wins: 10, losses: 10 })).toBe('INSUFFICIENT_DATA');
    expect(computeMarketTrustStatus({ wins: 12, losses: 13 })).toBe('NOISE');
    expect(computeMarketTrustStatus({ wins: 14, losses: 11, calibrationGap: 0.06 })).toBe('TRUSTED');
    expect(computeMarketTrustStatus({ wins: 16, losses: 9, calibrationGap: 0.04 })).toBe('SHARP');
    expect(computeMarketTrustStatus({ wins: 13, losses: 12, calibrationGap: 0.1 })).toBe('WATCH');
  });

  test('DIRECTION_TOO_WEAK excludes synthetic W/L but keeps error metrics', () => {
    const {
      deriveProjectionAccuracyCapture,
      captureProjectionAccuracyEval,
      gradeProjectionAccuracyEval,
      getProjectionAccuracyEvals,
    } = require('../src/db/projection-accuracy');
    const { getDatabase } = require('../src/db/connection');
    const db = getDatabase();

    const capture = deriveProjectionAccuracyCapture({
      id: 'card-mlb-k-pa-weak',
      gameId: 'mlb-proj-accuracy-weak',
      sport: 'MLB',
      cardType: 'mlb-pitcher-k',
      payloadData: {
        sport: 'MLB',
        card_type: 'mlb-pitcher-k',
        basis: 'PROJECTION_ONLY',
        tags: ['no_odds_mode'],
        projection: { k_mean: 6.42 },
      },
    });

    expect(capture.syntheticLine).toBe(6.5);
    expect(capture.failureFlags).toContain('DIRECTION_TOO_WEAK');
    expect(captureProjectionAccuracyEval(db, capture)).toBe(true);
    expect(gradeProjectionAccuracyEval(db, {
      cardId: 'card-mlb-k-pa-weak',
      actualResult: { pitcher_ks: 7 },
    })).toBe(true);

    const row = getProjectionAccuracyEvals(db, { cardId: 'card-mlb-k-pa-weak' })[0];
    expect(row).toMatchObject({
      graded_result: 'NO_BET',
      abs_error: 0.58,
      signed_error: -0.58,
    });
    expect(JSON.parse(row.failure_flags)).toContain('DIRECTION_TOO_WEAK');
  });
});
