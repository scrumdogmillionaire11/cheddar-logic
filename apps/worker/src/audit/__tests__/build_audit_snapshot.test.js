const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAuditSnapshot,
  stableHash,
} = require('../build_audit_snapshot');
const {
  loadFixtureFromPath,
  loadFixturesForSport,
  validateFixtureSchema,
} = require('../fixture_loader');
const {
  runAuditCli,
  runFixtureAudit,
  shouldFailGate,
} = require('../run_model_audit');

function makeFixture(sport = 'NBA', overrides = {}) {
  const isProjectionOnly = sport === 'MLB';
  const cardFamily = isProjectionOnly ? 'MLB_PITCHER_K' : sport === 'NHL' ? 'NHL_TOTAL' : 'NBA_TOTAL';
  const cardMode = isProjectionOnly ? 'PROJECTION_ONLY' : 'ODDS_BACKED';
  const base = {
    fixture_id: `${sport.toLowerCase()}_fixture_01`,
    sport,
    card_family: cardFamily,
    card_mode: cardMode,
    input_contract: 'ODDS_SNAPSHOT',
    match_key: {
      game_id: `${sport.toLowerCase()}_game_01`,
      market_type: 'TOTAL',
      selection: 'OVER',
    },
    input: {
      game_id: `${sport.toLowerCase()}_game_01`,
      sport,
      home_team: `${sport} Home`,
      away_team: `${sport} Away`,
      game_time_utc: '2026-04-02T00:00:00Z',
      captured_at: '2026-04-01T18:00:00Z',
      total: 224.5,
      ...(isProjectionOnly ? {} : {
        total_price_over: -110,
        total_price_under: -110,
      }),
    },
    expected: {
      input_hash: 'RECOMPUTE_ON_FIRST_RUN',
      classification: 'PLAY',
      execution_status: isProjectionOnly ? 'PROJECTION_ONLY' : 'EXECUTABLE',
      market_type: 'TOTAL',
    },
    baseline_reviewed: false,
  };

  return {
    ...base,
    ...overrides,
    match_key: {
      ...base.match_key,
      ...(overrides.match_key || {}),
    },
    input: {
      ...base.input,
      ...(overrides.input || {}),
    },
    expected: {
      ...base.expected,
      ...(overrides.expected || {}),
    },
  };
}

function makeTempFixturesRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixtures-'));
}

function writeFixture(root, sport, fileName, fixture) {
  const directory = path.join(root, sport.toLowerCase());
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, fileName),
    JSON.stringify(fixture, null, 2),
    'utf8',
  );
}

function buildInvariantBreakingAdapter() {
  return {
    runner: 'test_runner',
    enrich(input) {
      return { ...input };
    },
    model(enriched) {
      return {
        confidence: 0.61,
        game_id: enriched.game_id,
        market_type: 'TOTAL',
        p_fair: 0.54,
        prediction: 'OVER',
        projection: { total: 226 },
      };
    },
    decide(model) {
      return {
        _prediction_state: { reason: null, status: 'QUALIFIED' },
        _pricing_state: { reason: 'stale', status: 'STALE' },
        _publish_state: {
          block_reason: null,
          emit_allowed: true,
          execution_status: 'EXECUTABLE',
          publish_ready: true,
        },
        actionable: true,
        card_type: 'nba-total-call',
        classification: 'PLAY',
        confidence: model.confidence,
        consistency: {
          event_env: 'INDOOR',
          pace_tier: 'MID',
          total_bias: 'OK',
        },
        decision_v2: {
          official_status: 'PLAY',
          primary_reason_code: 'EDGE_CLEAR_AUDIT_STUB',
          watchdog_reason_codes: [],
          watchdog_status: 'OK',
        },
        execution_status: 'EXECUTABLE',
        game_id: model.game_id,
        market_type: 'TOTAL',
        prediction: 'OVER',
        reason_codes: ['EDGE_CLEAR_AUDIT_STUB'],
        selection: { side: 'OVER' },
      };
    },
    publish(decision) {
      return { ...decision };
    },
    extractFinalCards(publish) {
      return [{ ...publish }];
    },
  };
}

describe('audit snapshot hashing', () => {
  test('stable hash ignores object key order', () => {
    const left = { b: 2, a: 1, nested: { z: 9, y: 8 } };
    const right = { nested: { y: 8, z: 9 }, a: 1, b: 2 };

    expect(stableHash(left)).toBe(stableHash(right));
  });

  test('stable hash normalizes undefined to null', () => {
    const left = { a: 1, b: undefined };
    const right = { a: 1, b: null };

    expect(stableHash(left)).toBe(stableHash(right));
  });

  test('volatile fields are excluded from hash', () => {
    const left = {
      total: 224.5,
      generated_at: '2026-04-01T18:00:00Z',
      run_id: 'run-a',
    };
    const right = {
      total: 224.5,
      generated_at: '2026-04-02T18:00:00Z',
      run_id: 'run-b',
    };

    expect(stableHash(left)).toBe(stableHash(right));
  });
});

describe('fixture loader validation', () => {
  test('validateFixtureSchema throws on malformed fixture', () => {
    expect(() =>
      validateFixtureSchema({
        fixture_id: 'broken_fixture',
        input_contract: 'ODDS_SNAPSHOT',
        input: {},
        expected: {},
      }),
    ).toThrow(/sport/);
  });

  test('loadFixtureFromPath throws hard on malformed schema', () => {
    const root = makeTempFixturesRoot();
    const filePath = path.join(root, 'broken.json');

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        fixture_id: 'broken_fixture',
        sport: 'NBA',
        card_family: 'NBA_TOTAL',
        card_mode: 'ODDS_BACKED',
        input_contract: 'ODDS_SNAPSHOT',
        match_key: { game_id: 'nba_game_broken' },
        input: {},
        expected: {},
      }),
      'utf8',
    );

    expect(() => loadFixtureFromPath(filePath)).toThrow(/input\.game_id/);
  });
});

describe('buildAuditSnapshot', () => {
  test('does not mutate the original fixture object', () => {
    const fixture = makeFixture('NBA', {
      input: {
        nested: {
          label: 'original',
        },
      },
    });
    const before = JSON.stringify(fixture);

    buildAuditSnapshot(fixture, { runAt: '2026-04-02T02:00:00Z' });

    expect(JSON.stringify(fixture)).toBe(before);
  });

  test('deep-clones stage boundaries so downstream mutation does not contaminate earlier snapshots', () => {
    const fixture = makeFixture('NBA', {
      input: {
        nested: {
          steps: ['input'],
        },
      },
    });

    const snapshot = buildAuditSnapshot(fixture, {
      adapterOverrides: {
        NBA: {
          runner: 'test_runner',
          enrich(input) {
            return {
              ...input,
              nested: {
                ...input.nested,
                steps: [...input.nested.steps, 'enriched'],
              },
            };
          },
          model(enriched) {
            enriched.nested.steps.push('model-mutated');
            return {
              market_type: 'TOTAL',
              nested: enriched.nested,
            };
          },
          decide(model) {
            model.nested.steps.push('decision-mutated');
            return {
              market_type: 'TOTAL',
              classification: 'PLAY',
              execution_status: 'EXECUTABLE',
              nested: model.nested,
              reason_codes: ['EDGE_CLEAR_AUDIT_STUB'],
            };
          },
          publish(decision) {
            decision.nested.steps.push('publish-mutated');
            return decision;
          },
          extractFinalCards(publish) {
            return [publish];
          },
        },
      },
    });

    expect(snapshot.stages.enriched.payload.nested.steps).toEqual([
      'input',
      'enriched',
    ]);
    expect(snapshot.stages.model.payload.nested.steps).toEqual([
      'input',
      'enriched',
      'model-mutated',
    ]);
    expect(snapshot.stages.decision.payload.nested.steps).toEqual([
      'input',
      'enriched',
      'model-mutated',
      'decision-mutated',
    ]);
    expect(snapshot.stages.publish.payload.nested.steps).toEqual([
      'input',
      'enriched',
      'model-mutated',
      'decision-mutated',
      'publish-mutated',
    ]);
  });

  test('builds snapshots for NBA, MLB, and NHL stub fixtures', () => {
    ['NBA', 'MLB', 'NHL'].forEach((sport) => {
      const snapshot = buildAuditSnapshot(makeFixture(sport), {
        runAt: '2026-04-02T02:00:00Z',
      });

      expect(snapshot.snapshot_version).toBe('v1');
      expect(snapshot.stage_metadata.runner).toMatch(/^run_(nba|mlb|nhl)_model$/);
      expect(snapshot.stage_hashes.input).toHaveLength(64);
      // MLB fixtures are PROJECTION_ONLY — they do not produce publish-ready cards.
      // ODDS_BACKED sports (NBA, NHL) produce exactly one final card per fixture.
      if (sport === 'MLB') {
        expect(snapshot.final_cards.length).toBe(0);
      } else {
        expect(snapshot.final_cards.length).toBe(1);
      }
    });
  });

  test('builds canonical execution state first and derives compatibility fields second', () => {
    const snapshot = buildAuditSnapshot(makeFixture('NBA', {
      expected: {
        execution_status: 'PROJECTION_ONLY',
        prediction: 'OVER',
      },
    }));

    expect(snapshot.publish_snapshot._prediction_state).toMatchObject({
      status: 'QUALIFIED',
    });
    expect(snapshot.publish_snapshot._pricing_state).toMatchObject({
      status: 'NOT_REQUIRED',
    });
    expect(snapshot.publish_snapshot._publish_state).toMatchObject({
      publish_ready: false,
      execution_status: 'PROJECTION_ONLY',
    });
    expect(snapshot.publish_snapshot.pipeline_state.pricing_ready).toBe(false);
    expect(snapshot.publish_snapshot.selection.side).toBe('OVER');
    expect(snapshot.publish_snapshot.prediction).toBe('OVER');
  });

  test('throws when an unknown sport adapter is requested', () => {
    expect(() =>
      buildAuditSnapshot(makeFixture('WNBA')),
    ).toThrow(/No audit stage adapter registered/);
  });

  test('surfaces adapter errors from the model stage', () => {
    const result = runFixtureAudit(makeFixture('NBA'), {
      adapterOverrides: {
        NBA: {
          runner: 'test_runner',
          enrich(input) {
            return input;
          },
          model() {
            throw new Error('model stage exploded');
          },
          decide() {
            return {};
          },
          publish() {
            return {};
          },
          extractFinalCards() {
            return [];
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/model stage exploded/);
    expect(result.diffs[0].drift_type).toBe('SNAPSHOT_BUILD_FAILURE');
  });

  test('fails clearly on circular references in a stage payload', () => {
    const fixture = makeFixture('NBA');

    expect(() =>
      buildAuditSnapshot(fixture, {
        adapterOverrides: {
          NBA: {
            runner: 'test_runner',
            enrich(input) {
              const enriched = { ...input };
              enriched.self = enriched;
              return enriched;
            },
            model(input) {
              return input;
            },
            decide(input) {
              return input;
            },
            publish(input) {
              return input;
            },
            extractFinalCards() {
              return [];
            },
          },
        },
      }),
    ).toThrow(/Circular reference/);
  });

  test('fails clearly on non-serializable publish data', () => {
    const fixture = makeFixture('NBA');

    expect(() =>
      buildAuditSnapshot(fixture, {
        adapterOverrides: {
          NBA: {
            runner: 'test_runner',
            enrich(input) {
              return input;
            },
            model() {
              return { market_type: 'TOTAL' };
            },
            decide() {
              return {
                market_type: 'TOTAL',
                classification: 'PLAY',
                execution_status: 'EXECUTABLE',
              };
            },
            publish(decision) {
              return {
                ...decision,
                non_serializable: BigInt(4),
              };
            },
            extractFinalCards() {
              return [];
            },
          },
        },
      }),
    ).toThrow(/Non-serializable bigint/);
  });
});

describe('audit CLI and suite mode', () => {
  test('loadFixturesForSport returns all fixtures for a sport', () => {
    const root = makeTempFixturesRoot();
    writeFixture(root, 'NBA', 'fixture-a.json', makeFixture('NBA', { fixture_id: 'fixture_a' }));
    writeFixture(root, 'NBA', 'fixture-b.json', makeFixture('NBA', { fixture_id: 'fixture_b' }));

    const fixtures = loadFixturesForSport('NBA', { fixturesRoot: root });

    expect(fixtures).toHaveLength(2);
    expect(fixtures.map((fixture) => fixture.fixture_id)).toEqual([
      'fixture_a',
      'fixture_b',
    ]);
  });

  test('suite mode isolates bad fixtures and continues', () => {
    const root = makeTempFixturesRoot();
    writeFixture(root, 'NBA', 'good.json', makeFixture('NBA', { fixture_id: 'good_fixture' }));
    writeFixture(root, 'NBA', 'bad.json', {
      fixture_id: 'bad_fixture',
      sport: 'NBA',
      card_family: 'NBA_TOTAL',
      card_mode: 'ODDS_BACKED',
      input_contract: 'ODDS_SNAPSHOT',
      match_key: { game_id: 'bad_game', market_type: 'TOTAL', selection: 'OVER' },
      input: {
        game_id: 'bad_game',
        sport: 'NBA',
        total_price_over: -110,
        total_price_under: -110,
      },
      expected: {
        input_hash: 'RECOMPUTE_ON_FIRST_RUN',
        classification: 'PLAY',
        execution_status: 'EXECUTABLE',
        market_type: 'TOTAL',
        publish_snapshot: {
          classification: 'PASS',
        },
      },
      baseline_reviewed: false,
    });

    const stdout = { write: jest.fn() };
    const report = runAuditCli(['--sport', 'NBA'], {
      fixturesRoot: root,
      stdout,
      runAt: '2026-04-02T02:00:00Z',
    });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.drift_categories).toContain('PUBLISH_DRIFT');
    expect(stdout.write).toHaveBeenCalled();
  });

  test('single fixture path mode can write a JSON report', () => {
    const root = makeTempFixturesRoot();
    const fixturePath = path.join(root, 'single-fixture.json');
    const outPath = path.join(root, 'report.json');
    fs.writeFileSync(
      fixturePath,
      JSON.stringify(makeFixture('MLB', { fixture_id: 'single_fixture' }), null, 2),
      'utf8',
    );

    const report = runAuditCli(['--fixture', fixturePath, '--out', outPath], {
      stdout: { write: jest.fn() },
      runAt: '2026-04-02T02:00:00Z',
    });

    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    expect(report.total).toBe(1);
    expect(report.failed).toBe(0);
    expect(written.total).toBe(1);
    expect(written.results[0].fixture_id).toBe('single_fixture');
  });

  test('warn-only drift does not fail the audit gate', () => {
    const root = makeTempFixturesRoot();
    writeFixture(root, 'NBA', 'nba_warn_only_01.json', makeFixture('NBA', {
      expected: {
        input_hash: 'RECOMPUTE_ON_FIRST_RUN',
        model_snapshot: { confidence: 0.65 },
      },
    }));

    const report = runAuditCli(['--sport', 'NBA'], {
      fixturesRoot: root,
      runAt: '2026-04-02T02:00:00Z',
      stdout: { write: jest.fn() },
    });

    expect(report.failed).toBe(0);
    expect(report.warn_count).toBeGreaterThan(0);
    expect(shouldFailGate(report)).toBe(false);
  });

  test('fails the audit gate on invariant breach', () => {
    const root = makeTempFixturesRoot();
    writeFixture(root, 'NBA', 'nba_invariant_01.json', makeFixture('NBA'));

    const report = runAuditCli(['--sport', 'NBA'], {
      adapterOverrides: {
        NBA: buildInvariantBreakingAdapter(),
      },
      fixturesRoot: root,
      runAt: '2026-04-02T02:00:00Z',
      stdout: { write: jest.fn() },
    });

    expect(report.failed).toBe(1);
    expect(report.critical_count).toBeGreaterThan(0);
    expect(shouldFailGate(report)).toBe(true);
  });

  test('fails the gate when no fixtures are present', () => {
    const root = makeTempFixturesRoot();
    fs.mkdirSync(path.join(root, 'nba'), { recursive: true });

    const report = runAuditCli(
      ['--sport', 'NBA', '--output-dir', path.join(root, 'out')],
      {
        fixturesRoot: root,
        runAt: '2026-04-02T02:00:00Z',
        stdout: { write: jest.fn() },
      },
    );

    expect(report.fixture_count).toBe(0);
    expect(report.gate_failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drift_type: 'FIXTURE_SET_EMPTY' }),
      ]),
    );
    expect(shouldFailGate(report)).toBe(true);
  });

  test('fails the gate when a touched fixture still uses RECOMPUTE_ON_FIRST_RUN', () => {
    const root = makeTempFixturesRoot();
    const fileName = 'nba_touched_fixture_01.json';
    const fixturePath = path.join(root, 'nba', fileName);
    const changedFixturesPath = path.join(root, 'changed-fixtures.txt');
    writeFixture(root, 'NBA', fileName, makeFixture('NBA'));
    fs.writeFileSync(changedFixturesPath, `${fixturePath}\n`, 'utf8');

    const report = runAuditCli(
      ['--sport', 'NBA', '--changed-fixtures-file', changedFixturesPath],
      {
        fixturesRoot: root,
        runAt: '2026-04-02T02:00:00Z',
        stdout: { write: jest.fn() },
      },
    );

    expect(report.failing_fixtures[0].diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drift_type: 'BASELINE_REVIEW_REQUIRED' }),
      ]),
    );
    expect(shouldFailGate(report)).toBe(true);
  });

  test('fails the gate when baseline change note is malformed', () => {
    const root = makeTempFixturesRoot();
    const outputDir = path.join(root, 'out');
    writeFixture(root, 'NBA', 'nba_bad_note_01.json', makeFixture('NBA', {
      _baseline_change_note: {
        changed_by: 'WI-0730',
        reason: 'Approved baseline refresh',
      },
    }));

    const report = runAuditCli(
      ['--sport', 'NBA', '--output-dir', outputDir],
      {
        fixturesRoot: root,
        runAt: '2026-04-02T02:00:00Z',
        stdout: { write: jest.fn() },
      },
    );

    expect(report.gate_failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drift_type: 'FIXTURE_LOAD_FAILURE' }),
      ]),
    );
    expect(fs.existsSync(path.join(outputDir, 'audit-summary.json'))).toBe(true);
    expect(shouldFailGate(report)).toBe(true);
  });

  test('fails the gate when baseline change note expiry is exceeded', () => {
    const root = makeTempFixturesRoot();
    writeFixture(root, 'NBA', 'nba_expired_note_01.json', makeFixture('NBA', {
      _baseline_change_note: {
        changed_by: 'WI-0730',
        reason: 'Approved baseline refresh',
        approved_at: '2026-03-01T00:00:00Z',
        expires_after_runs: 3,
      },
    }));

    const report = runAuditCli(['--sport', 'NBA'], {
      fixturesRoot: root,
      runAt: '2026-04-02T02:00:00Z',
      stdout: { write: jest.fn() },
    });

    expect(report.failing_fixtures[0].diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drift_type: 'BASELINE_NOTE_EXPIRED' }),
      ]),
    );
    expect(shouldFailGate(report)).toBe(true);
  });
});
