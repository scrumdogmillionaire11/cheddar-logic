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

  test('line eval schema allows multiple common lines for one card after cleanup migration', () => {
    const { getDatabase } = require('../src/db/connection');
    const db = getDatabase();

    db.prepare(`
      INSERT INTO projection_accuracy_line_evals (
        card_id, line_role, line, eval_line, projection_value,
        direction, weak_direction_flag, edge_vs_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('schema-card-1', 'COMMON', 4.5, 4.5, 5.2, 'OVER', 0, 0.7);

    expect(() => {
      db.prepare(`
        INSERT INTO projection_accuracy_line_evals (
          card_id, line_role, line, eval_line, projection_value,
          direction, weak_direction_flag, edge_vs_line
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('schema-card-1', 'COMMON', 5.5, 5.5, 5.2, 'UNDER', 0, -0.3);
    }).not.toThrow();
  });

  test('backfills legacy projection accuracy rows without overwriting frozen raw values', () => {
    const {
      backfillProjectionAccuracyEvals,
      getProjectionAccuracyEvals,
      getProjectionAccuracyLineEvals,
    } = require('../src/db/projection-accuracy');
    const { getDatabase } = require('../src/db/connection');
    const db = getDatabase();

    db.prepare(`
      INSERT INTO projection_accuracy_evals (
        card_id, game_id, sport, card_type, market_family,
        projection_value, nearest_half_line, selected_direction,
        weak_direction_flag, confidence_band, market_trust,
        captured_at, actual_value, grade_status, graded_result,
        absolute_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-card-1',
      'legacy-game-1',
      'mlb',
      'mlb-pitcher-k',
      'MLB_PITCHER_K',
      6.76,
      6.5,
      'OVER',
      0,
      'UNKNOWN',
      'PROJECTION_ONLY',
      '2026-04-17T18:00:00.000Z',
      8,
      'GRADED',
      'WIN',
      1.24,
    );

    const result = backfillProjectionAccuracyEvals(db, {
      now: '2026-04-18T11:00:00.000Z',
    });

    expect(result).toMatchObject({
      processed: 1,
      updated: 1,
      graded: 1,
    });

    const row = getProjectionAccuracyEvals(db, { cardId: 'legacy-card-1' })[0];
    expect(row).toMatchObject({
      projection_raw: 6.76,
      synthetic_line: 6.5,
      synthetic_rule: 'nearest_half',
      synthetic_direction: 'OVER',
      direction_strength: 'STRONG',
      abs_error: 1.24,
      signed_error: -1.24,
      calibration_bucket: '6.0-6.9',
    });

    const lines = getProjectionAccuracyLineEvals(db, { cardId: 'legacy-card-1' });
    expect(lines.map((line) => line.eval_line)).toEqual(
      expect.arrayContaining([4.5, 5.5, 6.5, 7.5]),
    );
  });

  test('materializes market health rows from settled synthetic evals', () => {
    const {
      getProjectionAccuracyMarketHealth,
      materializeProjectionAccuracyMarketHealth,
    } = require('../src/db/projection-accuracy');
    const { getDatabase } = require('../src/db/connection');
    const db = getDatabase();

    const insertEval = db.prepare(`
      INSERT INTO projection_accuracy_evals (
        card_id, game_id, sport, card_type, market_family, market_type,
        projection_raw, projection_value, synthetic_line, synthetic_rule,
        synthetic_direction, direction_strength, nearest_half_line,
        selected_direction, weak_direction_flag, projection_confidence,
        confidence_score, confidence_band, market_trust, market_trust_status,
        failure_flags, captured_at, actual, actual_value, grade_status,
        graded_result, abs_error, signed_error, absolute_error,
        expected_over_prob, expected_direction_prob, calibration_bucket
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLine = db.prepare(`
      INSERT INTO projection_accuracy_line_evals (
        card_id, line_role, line, eval_line, projection_value,
        direction, weak_direction_flag, edge_vs_line, confidence_score,
        confidence_band, market_trust, expected_over_prob,
        expected_direction_prob, actual_value, grade_status,
        graded_result, hit_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let index = 0; index < 25; index += 1) {
      const won = index < 15;
      const actual = won ? 7 : 5;
      const cardId = `health-k-${index}`;
      insertEval.run(
        cardId,
        `health-game-${index}`,
        'mlb',
        'mlb-pitcher-k',
        'MLB_PITCHER_K',
        'MLB_PITCHER_K',
        6.8,
        6.8,
        6.5,
        'nearest_half',
        'OVER',
        'STRONG',
        6.5,
        'OVER',
        0,
        60,
        60,
        'TRUST',
        'PROJECTION_ONLY',
        'INSUFFICIENT_DATA',
        '[]',
        '2026-04-17T18:00:00.000Z',
        actual,
        actual,
        'GRADED',
        won ? 'WIN' : 'LOSS',
        Math.abs(6.8 - actual),
        6.8 - actual,
        Math.abs(6.8 - actual),
        won ? 1 : 0,
        won ? 1 : 0,
        '6.0-6.9',
      );
      insertLine.run(
        cardId,
        'SYNTHETIC',
        6.5,
        6.5,
        6.8,
        'OVER',
        0,
        0.3,
        60,
        'TRUST',
        'PROJECTION_ONLY',
        won ? 1 : 0,
        won ? 1 : 0,
        actual,
        'GRADED',
        won ? 'WIN' : 'LOSS',
        won ? 1 : 0,
      );
    }

    const rows = materializeProjectionAccuracyMarketHealth(db, {
      marketFamilies: ['MLB_PITCHER_K'],
      generatedAt: '2026-04-18T11:00:00.000Z',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      market_family: 'MLB_PITCHER_K',
      sample_size: 25,
      wins: 15,
      losses: 10,
      market_trust_status: 'SHARP',
    });
    expect(rows[0].win_rate).toBeCloseTo(0.6);

    const stored = getProjectionAccuracyMarketHealth(db, {
      marketFamily: 'MLB_PITCHER_K',
    })[0];
    expect(stored).toMatchObject({
      market_family: 'MLB_PITCHER_K',
      sample_size: 25,
      market_trust_status: 'SHARP',
    });
    expect(stored.confidence_lift.TRUST.win_rate).toBeCloseTo(0.6);
  });
});

describe('migration 081 — projection_accuracy_line_evals unique constraint repair', () => {
  let dbPath;

  function makeTempDbPath() {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-mig081-'));
    return path.join(dir, 'test.db');
  }

  function resetDbEnv() {
    delete process.env.CHEDDAR_DB_PATH;
    delete process.env.CHEDDAR_DB_AUTODISCOVER;
    delete process.env.DATABASE_PATH;
    delete process.env.DATABASE_URL;
    delete process.env.RECORD_DATABASE_PATH;
  }

  beforeEach(() => {
    jest.resetModules();
    resetDbEnv();
    dbPath = makeTempDbPath();
    process.env.CHEDDAR_DB_PATH = dbPath;
  });

  afterEach(() => {
    try { require('../src/db/connection').closeDatabase(); } catch {}
    resetDbEnv();
  });

  test('repair migration fixes legacy UNIQUE(card_id, eval_line) so ON CONFLICT(card_id, line_role) upserts succeed', async () => {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const path = require('path');

    // Bootstrap a DB that looks like the pre-081 schema:
    // projection_accuracy_line_evals has UNIQUE(card_id, eval_line) instead of UNIQUE(card_id, line_role)
    const legacySql = fs.readFileSync(
      path.join(__dirname, '../db/migrations/080_create_projection_accuracy_evals.sql'),
      'utf8',
    );

    // Substitute the constraint to simulate the legacy shape
    const legacyLineSql = legacySql.replace(
      'UNIQUE(card_id, line_role)',
      'UNIQUE(card_id, eval_line)',
    );

    const db = new Database(dbPath);
    // Minimal bootstrap: jobs table + games + card_payloads + the legacy projection tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        game_id TEXT UNIQUE NOT NULL,
        sport TEXT,
        home_team TEXT,
        away_team TEXT,
        game_time_utc TEXT,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS card_payloads (
        id TEXT PRIMARY KEY,
        game_id TEXT,
        sport TEXT,
        card_type TEXT,
        card_title TEXT,
        payload_data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        run_id TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_key TEXT,
        status TEXT,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      );
    `);
    db.exec(legacyLineSql);

    // Seed a row using the legacy conflict target so it is present pre-migration
    db.prepare(`
      INSERT INTO projection_accuracy_evals
        (card_id, game_id, sport, card_type, market_family, projection_value, nearest_half_line,
         weak_direction_flag, confidence_band, market_trust, captured_at)
      VALUES ('card-legacy-1', 'game-1', 'mlb', 'mlb-pitcher-k', 'MLB_PITCHER_STRIKEOUTS',
              6.76, 7, 0, 'MEDIUM', 'PROJECTION_ONLY', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO projection_accuracy_line_evals
        (eval_id, card_id, line_role, eval_line, projection_value, direction, weak_direction_flag, edge_vs_line)
      VALUES (NULL, 'card-legacy-1', 'NEAREST_HALF', 7, 6.76, 'UNDER', 1, -0.24)
    `).run();

    // Mark migrations up to 080 as already applied so runMigrations only applies 081
    for (let i = 1; i <= 80; i++) {
      const name = `${String(i).padStart(3, '0')}_create_projection_accuracy_evals.sql`.replace(
        /^\d+_/,
        `${String(i).padStart(3, '0')}_`,
      );
    }
    // Mark all files except 081 as applied
    const allMigFiles = fs.readdirSync(path.join(__dirname, '../db/migrations'))
      .filter(f => f.endsWith('.sql'))
      .sort()
      .filter(f => f !== '081_repair_projection_accuracy_line_evals_unique.sql');
    for (const f of allMigFiles) {
      db.prepare('INSERT OR IGNORE INTO migrations (name) VALUES (?)').run(f);
    }
    db.close();

    // Run migrations — should apply only 081
    const { runMigrations } = require('../src/migrate');
    await runMigrations();

    // Re-open and verify UNIQUE(card_id, line_role) is now in effect
    const db2 = new Database(dbPath, { readonly: true });
    const constraint = db2.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='projection_accuracy_line_evals'",
    ).get();
    expect(constraint.sql).toMatch(/UNIQUE\(card_id, line_role\)/);

    // Existing row should be preserved
    const existing = db2.prepare(
      "SELECT * FROM projection_accuracy_line_evals WHERE card_id = 'card-legacy-1'",
    ).get();
    expect(existing).toBeTruthy();
    expect(existing.line_role).toBe('NEAREST_HALF');
    db2.close();

    // ON CONFLICT(card_id, line_role) upsert should succeed without throwing
    const { getDatabase } = require('../src/db/connection');
    const { captureProjectionAccuracyEval, getProjectionAccuracyLineEvals } = require('../src/db/projection-accuracy');
    const liveDb = getDatabase();

    const capture = {
      cardId: 'card-legacy-1',
      gameId: 'game-1',
      sport: 'mlb',
      cardType: 'mlb-pitcher-k',
      marketFamily: 'MLB_PITCHER_STRIKEOUTS',
      projectionValue: 6.76,
      selectedLine: null,
      nearestHalfLine: 7,
      selectedDirection: 'UNDER',
      weakDirectionFlag: 1,
      confidenceScore: 0.55,
      confidenceBand: 'MEDIUM',
      marketTrust: 'PROJECTION_ONLY',
      marketTrustFlags: [],
      lineSource: null,
      basis: 'PROJECTION_ONLY',
      capturedAt: new Date().toISOString(),
      generatedAt: null,
      metadata: {},
      payloadData: {},
    };

    expect(() => captureProjectionAccuracyEval(liveDb, capture)).not.toThrow();
    const lines = getProjectionAccuracyLineEvals(liveDb, { cardId: 'card-legacy-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0].line_role).toBe('NEAREST_HALF');
  });
});
