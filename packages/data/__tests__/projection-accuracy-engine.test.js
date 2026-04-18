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
    } = require('../src/db/projection-accuracy');

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
      market_family: 'NHL_PLAYER_SHOTS_FULL_GAME',
      player_id: '8479318',
      selected_line: 3.5,
      nearest_half_line: 3,
      selected_direction: 'UNDER',
      weak_direction_flag: 0,
      market_trust: 'SYNTHETIC_FALLBACK',
      grade_status: 'PENDING',
    });

    const lineRows = getProjectionAccuracyLineEvals(db, { cardId: 'card-nhl-sog-pa-1', lineRole: 'NEAREST_HALF' });
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]).toMatchObject({
      line_role: 'NEAREST_HALF',
      eval_line: 3,
      direction: 'OVER',
      weak_direction_flag: 1,
    });
    expect(lineRows[0].confidence_score).toBeLessThan(0.5);

    setProjectionActualResult('card-nhl-sog-pa-1', { shots: 2 });

    const graded = getProjectionAccuracyEvals(db, { cardId: 'card-nhl-sog-pa-1' })[0];
    expect(graded).toMatchObject({
      actual_value: 2,
      grade_status: 'GRADED',
      graded_result: 'WIN',
    });
    expect(graded.absolute_error).toBeCloseTo(1.24);

    const selectedSummary = getProjectionAccuracyEvalSummary(db, {
      cardType: 'nhl-player-shots',
      lineRole: 'SELECTED_MARKET',
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
      marketFamily: 'MLB_PITCHER_STRIKEOUTS',
      selectedLine: null,
      nearestHalfLine: 7,
      marketTrust: 'PROJECTION_ONLY',
    });

    const db = getDatabase();
    expect(captureProjectionAccuracyEval(db, capture)).toBe(true);
    expect(captureProjectionAccuracyEval(db, capture)).toBe(true);

    const lines = getProjectionAccuracyLineEvals(db, { cardId: 'card-mlb-k-pa-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      eval_line: 7,
      direction: 'UNDER',
      weak_direction_flag: 1,
      market_trust: 'PROJECTION_ONLY',
    });
  });
});
