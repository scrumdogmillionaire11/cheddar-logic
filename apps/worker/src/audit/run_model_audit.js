'use strict';

const fs = require('fs');
const path = require('path');

const { buildAuditSnapshot, deepClone } = require('./build_audit_snapshot');
const { compareSnapshots } = require('./compare_audit_snapshot');
const { normalizeReasonCodes } = require('./audit_rules_config');
const {
  evaluateBaselineChangeNote,
  getFixtureDirectory,
  isFixturePathCandidate,
  loadFixtureFromPath,
  normalizeSport,
  resolveFixturePath,
} = require('./fixture_loader');

const SPORTS = Object.freeze(['NBA', 'NHL', 'MLB']);
const OUTPUT_ROOT = path.resolve(__dirname, '..', '..', 'audit-output');

function parseCliArgs(argv = process.argv.slice(2)) {
  const parsed = {
    all: false,
    changed_fixtures_file: null,
    fixture: null,
    out: null,
    output_dir: null,
    run_at: null,
    run_scope: null,
    sport: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--all') {
      parsed.all = true;
      continue;
    }

    const [flag, inlineValue] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, null];

    if (
      flag === '--sport' ||
      flag === '--fixture' ||
      flag === '--out' ||
      flag === '--output-dir' ||
      flag === '--run-scope' ||
      flag === '--changed-fixtures-file' ||
      flag === '--run-at'
    ) {
      const nextValue = inlineValue !== null ? inlineValue : argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
      }

      const key = flag.slice(2).replace(/-/g, '_');
      parsed[key] = nextValue;
      if (inlineValue === null) index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.all && !parsed.sport && !parsed.fixture) {
    throw new Error('Usage: --all | --sport <SPORT> [--fixture <ID>] | --fixture <PATH>');
  }

  if (parsed.all && (parsed.sport || parsed.fixture)) {
    throw new Error('--all cannot be combined with --sport or --fixture');
  }

  if (parsed.sport) {
    parsed.sport = normalizeSport(parsed.sport);
  }

  return parsed;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function sanitizeRunScope(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'manual';
}

function defaultRunScope(runAt = new Date().toISOString()) {
  return `manual-${runAt.replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`;
}

function resolveArtifactPaths(parsedArgs, options = {}) {
  const runAt = parsedArgs.run_at || options.runAt || new Date().toISOString();
  const runScope = sanitizeRunScope(parsedArgs.run_scope || options.runScope || defaultRunScope(runAt));
  const outputDir =
    parsedArgs.output_dir ||
    options.outputDir ||
    path.join(OUTPUT_ROOT, runScope);
  const reportPath = parsedArgs.out || path.join(outputDir, 'audit-report.json');
  const summaryPath = path.join(outputDir, 'audit-summary.json');

  return {
    output_dir: path.resolve(outputDir),
    report_path: path.resolve(reportPath),
    run_at: runAt,
    run_scope: runScope,
    summary_path: path.resolve(summaryPath),
  };
}

function writeJsonOutput(report, outPath) {
  const resolvedPath = path.resolve(outPath);
  ensureDirectory(path.dirname(resolvedPath));
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

function readChangedFixturePaths(filePath) {
  if (!filePath) return new Set();
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  return new Set(
    raw
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry)),
  );
}

function listFixturePathsForSport(sport, options = {}) {
  const directory = getFixtureDirectory(sport, options);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function safeLoadFixture(filePath, results) {
  try {
    results.fixtures.push(loadFixtureFromPath(path.resolve(filePath)));
  } catch (error) {
    results.load_errors.push({
      fixture_id: path.basename(filePath, '.json'),
      fixture_path: path.resolve(filePath),
      drift_type: 'FIXTURE_LOAD_FAILURE',
      error: error.message,
      severity: 'HIGH',
    });
  }
}

function loadFixturesFromParsedArgs(parsedArgs, options = {}) {
  const results = {
    fixtures: [],
    load_errors: [],
  };

  try {
    if (parsedArgs.all) {
      SPORTS.forEach((sport) => {
        listFixturePathsForSport(sport, options).forEach((filePath) => {
          safeLoadFixture(filePath, results);
        });
      });
      return results;
    }

    if (parsedArgs.fixture && isFixturePathCandidate(parsedArgs.fixture)) {
      safeLoadFixture(parsedArgs.fixture, results);
      return results;
    }

    if (parsedArgs.fixture) {
      if (!parsedArgs.sport) {
        throw new Error('--fixture <ID> requires --sport <SPORT>');
      }
      safeLoadFixture(resolveFixturePath(parsedArgs.sport, parsedArgs.fixture, options), results);
      return results;
    }

    listFixturePathsForSport(parsedArgs.sport, options).forEach((filePath) => {
      safeLoadFixture(filePath, results);
    });
  } catch (error) {
    results.load_errors.push({
      fixture_id: parsedArgs.fixture || parsedArgs.sport || 'fixture-set',
      fixture_path: null,
      drift_type: 'FIXTURE_LOAD_FAILURE',
      error: error.message,
      severity: 'HIGH',
    });
  }

  return results;
}

function mergeFixtureExpected(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(override)) return deepClone(override);
  if (!override || typeof override !== 'object') return override;
  const target =
    base && typeof base === 'object' && !Array.isArray(base)
      ? deepClone(base)
      : {};

  Object.keys(override).forEach((key) => {
    target[key] = mergeFixtureExpected(target[key], override[key]);
  });
  return target;
}

function buildExpectedBaselineSnapshot(snapshot, fixture) {
  const expected = fixture.expected || {};
  const baseline = deepClone(snapshot);

  if (expected.model_version !== undefined) {
    baseline.model_version = expected.model_version;
  }
  if (typeof expected.input_hash === 'string' && expected.input_hash !== 'RECOMPUTE_ON_FIRST_RUN') {
    baseline.stage_hashes.input = expected.input_hash;
    if (baseline.stages?.input) {
      baseline.stages.input.hash = expected.input_hash;
    }
  }

  if (expected.model_snapshot) {
    baseline.model_snapshot = mergeFixtureExpected(
      baseline.model_snapshot,
      expected.model_snapshot,
    );
    if (baseline.stages?.model) baseline.stages.model.payload = deepClone(baseline.model_snapshot);
  }
  if (expected.decision_snapshot) {
    baseline.decision_snapshot = mergeFixtureExpected(
      baseline.decision_snapshot,
      expected.decision_snapshot,
    );
    if (baseline.stages?.decision) baseline.stages.decision.payload = deepClone(baseline.decision_snapshot);
  }
  if (expected.publish_snapshot) {
    baseline.publish_snapshot = mergeFixtureExpected(
      baseline.publish_snapshot,
      expected.publish_snapshot,
    );
    if (baseline.stages?.publish) baseline.stages.publish.payload = deepClone(baseline.publish_snapshot);
  }
  if (expected.final_cards !== undefined) {
    baseline.final_cards = deepClone(expected.final_cards);
  }

  ['classification', 'execution_status', 'market_type', 'card_type'].forEach((field) => {
    if (expected[field] === undefined) return;
    baseline.publish_snapshot[field] = expected[field];
    if (baseline.stages?.publish) baseline.stages.publish.payload[field] = expected[field];
  });

  if (expected.stage_categories?.execution_status !== undefined) {
    baseline.publish_snapshot.execution_status = expected.stage_categories.execution_status;
    if (baseline.stages?.publish) {
      baseline.stages.publish.payload.execution_status = expected.stage_categories.execution_status;
    }
  }
  if (expected.stage_categories?.classification !== undefined) {
    baseline.publish_snapshot.classification = expected.stage_categories.classification;
    if (baseline.stages?.publish) {
      baseline.stages.publish.payload.classification = expected.stage_categories.classification;
    }
  }

  return baseline;
}

function compareSnapshotToExpected(snapshot, fixture) {
  const baseline = buildExpectedBaselineSnapshot(snapshot, fixture);
  const comparison = compareSnapshots(snapshot, baseline, {
    fixture_id: fixture?.fixture_id,
  });
  const expected = fixture.expected || {};
  const publishReasonCodes = normalizeReasonCodes(snapshot.publish_snapshot?.reason_codes);
  const extraDiffs = [];

  if (Array.isArray(expected.reason_codes_must_not_include)) {
    expected.reason_codes_must_not_include.forEach((code) => {
      const normalizedCode = String(code || '').trim().toUpperCase();
      if (!normalizedCode || !publishReasonCodes.includes(normalizedCode)) return;
      extraDiffs.push({
        card_key: `${fixture?.fixture_id || 'unknown_fixture'}|PUBLISH`,
        field_path: 'publish.reason_codes',
        expected: `must not include ${normalizedCode}`,
        actual: publishReasonCodes,
        drift_type: 'DECISION_DRIFT',
        severity: 'HIGH',
        comparison_class: 'strict',
        stage: 'publish',
      });
    });
  }

  return mergeComparisonWithDiffs(comparison, extraDiffs);
}

function mergeComparisonWithDiffs(comparison, extraDiffs = []) {
  const diffs = [...(comparison.diffs || []), ...extraDiffs];
  const invariantViolations = Array.isArray(comparison.invariant_violations)
    ? comparison.invariant_violations
    : [];
  const criticalCount = invariantViolations.filter((violation) => violation.severity === 'CRITICAL').length;
  const highSeverityCount = diffs.filter((diff) => diff.severity === 'HIGH').length;
  const warnCount =
    diffs.filter((diff) => diff.severity === 'WARN').length +
    invariantViolations.filter((violation) => violation.severity === 'WARN').length;

  return {
    ...comparison,
    critical_count: criticalCount,
    diffs,
    high_severity_count: highSeverityCount,
    invariant_violations: invariantViolations,
    passed: criticalCount === 0 && highSeverityCount === 0,
    warn_count: warnCount,
  };
}

function collectFixtureGateDiffs(fixture, options = {}) {
  const diffs = [];
  const changedFixturePaths = options.changedFixturePaths || new Set();
  const fixturePath = fixture?.fixture_file_path ? path.resolve(fixture.fixture_file_path) : null;
  const inputHash = fixture?.expected?.input_hash;

  if (
    fixturePath &&
    changedFixturePaths.has(fixturePath) &&
    inputHash === 'RECOMPUTE_ON_FIRST_RUN' &&
    fixture?.baseline_reviewed !== true
  ) {
    diffs.push({
      actual: inputHash,
      card_key: `${fixture.fixture_id}|FIXTURE`,
      comparison_class: 'governance',
      drift_type: 'BASELINE_REVIEW_REQUIRED',
      expected: 'reviewed baseline hash',
      field_path: 'expected.input_hash',
      severity: 'HIGH',
      stage: 'fixture',
    });
  }

  const noteStatus = evaluateBaselineChangeNote(fixture?._baseline_change_note, {
    runAt: options.runAt,
  });
  if (noteStatus.expired) {
    diffs.push({
      actual: {
        approved_at: fixture._baseline_change_note.approved_at,
        cycles_elapsed: noteStatus.cycles_elapsed,
        expires_after_runs: noteStatus.expires_after_runs,
      },
      card_key: `${fixture.fixture_id}|FIXTURE`,
      comparison_class: 'governance',
      drift_type: 'BASELINE_NOTE_EXPIRED',
      expected: {
        clear_or_renew_before_cycles_elapsed: noteStatus.expires_after_runs,
      },
      field_path: '_baseline_change_note',
      severity: 'HIGH',
      stage: 'fixture',
    });
  }

  return diffs;
}

function runFixtureAudit(fixture, options = {}) {
  const fixtureId = fixture?.fixture_id || 'unknown_fixture';
  const sport = fixture?.sport || null;
  const cardFamily = fixture?.card_family || null;
  const governanceDiffs = collectFixtureGateDiffs(fixture, options);

  try {
    const snapshot = buildAuditSnapshot(fixture, options);
    const comparison = mergeComparisonWithDiffs(
      compareSnapshotToExpected(snapshot, fixture),
      governanceDiffs,
    );
    const violations = Array.isArray(comparison.invariant_violations)
      ? comparison.invariant_violations
      : [];

    return {
      card_family: cardFamily,
      diffs: comparison.diffs,
      error: null,
      fixture_file_path: fixture?.fixture_file_path || null,
      fixture_id: fixtureId,
      governance_diff_count: governanceDiffs.length,
      high_severity_count: comparison.high_severity_count,
      critical_count: comparison.critical_count,
      passed: comparison.passed,
      snapshot,
      sport,
      violations,
      warn_count: comparison.warn_count,
    };
  } catch (error) {
    const diffs = [
      ...governanceDiffs,
      {
        actual: error.message,
        drift_type: 'SNAPSHOT_BUILD_FAILURE',
        expected: 'audit snapshot',
        field_path: 'snapshot',
        severity: 'HIGH',
        stage: 'snapshot',
      },
    ];
    return {
      card_family: cardFamily,
      critical_count: 0,
      diffs,
      error: error.message,
      fixture_file_path: fixture?.fixture_file_path || null,
      fixture_id: fixtureId,
      governance_diff_count: governanceDiffs.length,
      high_severity_count: diffs.filter((diff) => diff.severity === 'HIGH').length,
      passed: false,
      snapshot: null,
      sport,
      violations: [],
      warn_count: diffs.filter((diff) => diff.severity === 'WARN').length,
    };
  }
}

function summarizeResults(results, loadErrors = []) {
  const driftCategories = Array.from(
    new Set(
      [
        ...results.flatMap((result) =>
          result.diffs.map((diff) => diff.drift_type).filter(Boolean),
        ),
        ...loadErrors.map((error) => error.drift_type).filter(Boolean),
      ],
    ),
  ).sort();

  const violations = results.flatMap((result) => result.violations || []);
  const criticalCount = violations.filter((violation) => violation.severity === 'CRITICAL').length;
  const highSeverityCount =
    results.reduce((sum, result) => sum + (result.high_severity_count || 0), 0) +
    loadErrors.length;
  const warnCount = results.reduce((sum, result) => sum + (result.warn_count || 0), 0);
  const failed = results.filter((result) => !result.passed).length;

  return {
    critical_count: criticalCount,
    drift_categories: driftCategories,
    failed,
    high_severity_count: highSeverityCount,
    passed: results.length - failed,
    total: results.length,
    violations,
    warn_count: warnCount,
  };
}

function groupResultsBySport(results = []) {
  const grouped = {};

  results.forEach((result) => {
    const sport = result.sport || 'UNKNOWN';
    if (!grouped[sport]) {
      grouped[sport] = {
        critical_count: 0,
        failed: 0,
        fixture_count: 0,
        high_severity_count: 0,
        passed: 0,
        warn_count: 0,
      };
    }

    grouped[sport].fixture_count += 1;
    grouped[sport].critical_count += result.critical_count || 0;
    grouped[sport].high_severity_count += result.high_severity_count || 0;
    grouped[sport].warn_count += result.warn_count || 0;
    if (result.passed) grouped[sport].passed += 1;
    else grouped[sport].failed += 1;
  });

  return grouped;
}

function summarizeFailingFixtures(results = []) {
  return results
    .filter((result) => !result.passed)
    .map((result) => ({
      card_family: result.card_family,
      critical_count: result.critical_count || 0,
      diffs: (result.diffs || []).filter((diff) => diff.severity === 'CRITICAL' || diff.severity === 'HIGH'),
      drift_categories: Array.from(new Set((result.diffs || []).map((diff) => diff.drift_type).filter(Boolean))).sort(),
      error: result.error,
      fixture_file_path: result.fixture_file_path,
      fixture_id: result.fixture_id,
      high_severity_count: result.high_severity_count || 0,
      sport: result.sport,
      violations: result.violations || [],
      warn_count: result.warn_count || 0,
    }));
}

function summarizeGateFailures(fixtures, loadErrors = []) {
  const gateFailures = [...loadErrors];

  if (fixtures.length === 0) {
    gateFailures.push({
      drift_type: 'FIXTURE_SET_EMPTY',
      error: 'No audit fixtures were loaded',
      fixture_id: 'fixture-set',
      fixture_path: null,
      severity: 'HIGH',
    });
  }

  return gateFailures;
}

function buildSummaryReport(report) {
  return {
    by_sport: report.by_sport,
    critical_count: report.critical_count,
    drift_categories: report.drift_categories,
    failed: report.failed,
    failing_fixtures: report.failing_fixtures,
    fixture_count: report.fixture_count,
    gate_failures: report.gate_failures,
    gate_failure_count: report.gate_failure_count,
    generated_at: report.generated_at,
    high_severity_count: report.high_severity_count,
    passed: report.passed,
    run_scope: report.run_scope,
    warn_count: report.warn_count,
  };
}

function buildPrimaryFailureLine(result) {
  const firstViolation = (result.violations || []).find((violation) => violation.severity === 'CRITICAL');
  if (firstViolation) {
    return `${result.fixture_id}: ${firstViolation.invariant_id} ${firstViolation.field_path} expected=${JSON.stringify(firstViolation.expected)} actual=${JSON.stringify(firstViolation.actual)}`;
  }

  const firstDiff = (result.diffs || []).find((diff) => diff.severity === 'HIGH' || diff.severity === 'CRITICAL');
  if (firstDiff) {
    return `${result.fixture_id}: ${firstDiff.drift_type} ${firstDiff.field_path} expected=${JSON.stringify(firstDiff.expected)} actual=${JSON.stringify(firstDiff.actual)}`;
  }

  return `${result.fixture_id}: ${result.error || 'FAILED'}`;
}

function formatHumanSummary(report) {
  const lines = [
    `Audit summary: ${report.passed}/${report.fixture_count} passed, ${report.failed} failed, ${report.gate_failure_count} gate failures`,
    `Severity counts: critical=${report.critical_count} high=${report.high_severity_count} warn=${report.warn_count}`,
  ];

  if (report.drift_categories.length > 0) {
    lines.push(`Drift categories: ${report.drift_categories.join(', ')}`);
  }

  report.gate_failures.forEach((failure) => {
    lines.push(`- gate: ${failure.drift_type} ${failure.fixture_path || failure.fixture_id} ${failure.error}`);
  });

  report.results
    .filter((result) => !result.passed)
    .forEach((result) => {
      lines.push(`- ${buildPrimaryFailureLine(result)}`);
    });

  return lines.join('\n');
}

function runAuditSuite(fixtures, options = {}) {
  const results = fixtures.map((fixture) => runFixtureAudit(fixture, options));
  const summary = summarizeResults(results, options.loadErrors || []);
  const gateFailures = summarizeGateFailures(fixtures, options.loadErrors || []);

  return {
    ...summary,
    by_sport: groupResultsBySport(results),
    failing_fixtures: summarizeFailingFixtures(results),
    fixture_count: fixtures.length,
    gate_failure_count: gateFailures.length,
    gate_failures: gateFailures,
    generated_at: options.runAt || new Date().toISOString(),
    results,
    run_scope: options.runScope || null,
    total: fixtures.length,
  };
}

function shouldFailGate(report) {
  return report.failed > 0 || report.gate_failure_count > 0;
}

function runAuditCli(argv = process.argv.slice(2), options = {}) {
  const parsedArgs = parseCliArgs(argv);
  const artifactPaths = resolveArtifactPaths(parsedArgs, options);
  const stdout = options.stdout || process.stdout;
  const changedFixturePaths = readChangedFixturePaths(parsedArgs.changed_fixtures_file);
  const loaded = loadFixturesFromParsedArgs(parsedArgs, options);
  const report = runAuditSuite(loaded.fixtures, {
    ...options,
    changedFixturePaths,
    loadErrors: loaded.load_errors,
    runAt: artifactPaths.run_at,
    runScope: artifactPaths.run_scope,
  });

  report.output_dir = artifactPaths.output_dir;
  report.report_path = artifactPaths.report_path;
  report.summary_path = artifactPaths.summary_path;

  stdout.write(`${formatHumanSummary(report)}\n`);

  if (parsedArgs.out || parsedArgs.output_dir || parsedArgs.run_scope || options.writeArtifacts === true) {
    writeJsonOutput(report, artifactPaths.report_path);
    writeJsonOutput(buildSummaryReport(report), artifactPaths.summary_path);
    stdout.write(`Wrote JSON report to ${artifactPaths.report_path}\n`);
    stdout.write(`Wrote summary report to ${artifactPaths.summary_path}\n`);
  }

  return report;
}

function main(argv = process.argv.slice(2)) {
  try {
    const report = runAuditCli(argv);
    process.exit(shouldFailGate(report) ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  OUTPUT_ROOT,
  buildExpectedBaselineSnapshot,
  buildSummaryReport,
  collectFixtureGateDiffs,
  compareSnapshotToExpected,
  defaultRunScope,
  formatHumanSummary,
  loadFixturesFromParsedArgs,
  main,
  parseCliArgs,
  resolveArtifactPaths,
  runAuditCli,
  runAuditSuite,
  runFixtureAudit,
  shouldFailGate,
  summarizeResults,
  writeJsonOutput,
};
