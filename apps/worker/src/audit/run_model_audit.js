const fs = require('fs');
const path = require('path');

const { buildAuditSnapshot, deepClone } = require('./build_audit_snapshot');
const { compareSnapshots } = require('./compare_audit_snapshot');
const { normalizeReasonCodes } = require('./audit_rules_config');
const {
  isFixturePathCandidate,
  loadFixture,
  loadFixtureFromPath,
  loadFixturesForSport,
  normalizeSport,
} = require('./fixture_loader');

function parseCliArgs(argv = process.argv.slice(2)) {
  const parsed = {
    all: false,
    fixture: null,
    out: null,
    sport: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--all') {
      parsed.all = true;
      continue;
    }

    if (token === '--sport' || token === '--fixture' || token === '--out') {
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      parsed[token.slice(2)] = nextValue;
      index += 1;
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

  return {
    ...comparison,
    diffs: [...comparison.diffs, ...extraDiffs],
    high_severity_count:
      comparison.high_severity_count + extraDiffs.length,
    passed:
      comparison.critical_count === 0 &&
      comparison.high_severity_count + extraDiffs.length === 0,
  };
}

function runFixtureAudit(fixture, options = {}) {
  const fixtureId = fixture?.fixture_id || 'unknown_fixture';
  const sport = fixture?.sport || null;

  try {
    const snapshot = buildAuditSnapshot(fixture, options);
    const comparison = compareSnapshotToExpected(snapshot, fixture);
    const violations = Array.isArray(comparison.invariant_violations)
      ? comparison.invariant_violations
      : [];

    return {
      fixture_id: fixtureId,
      sport,
      passed: comparison.passed,
      snapshot,
      diffs: comparison.diffs,
      violations,
      error: null,
    };
  } catch (error) {
    return {
      fixture_id: fixtureId,
      sport,
      passed: false,
      snapshot: null,
      diffs: [
        {
          field_path: 'snapshot',
          expected: 'audit snapshot',
          actual: error.message,
          drift_type: 'SNAPSHOT_BUILD_FAILURE',
          severity: 'HIGH',
        },
      ],
      violations: [],
      error: error.message,
    };
  }
}

function summarizeResults(results) {
  const driftCategories = Array.from(
    new Set(
      results.flatMap((result) =>
        result.diffs.map((diff) => diff.drift_type).filter(Boolean),
      ),
    ),
  ).sort();

  const violations = results.flatMap((result) => result.violations || []);
  const criticalCount = violations.filter((violation) => violation.severity === 'CRITICAL').length;
  const failed = results.filter((result) => !result.passed).length;

  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    critical_count: criticalCount,
    drift_categories: driftCategories,
    violations,
  };
}

function loadFixturesFromParsedArgs(parsedArgs, options = {}) {
  if (parsedArgs.all) {
    return ['NBA', 'NHL', 'MLB'].flatMap((sport) =>
      loadFixturesForSport(sport, options),
    );
  }

  if (parsedArgs.fixture && isFixturePathCandidate(parsedArgs.fixture)) {
    return [loadFixtureFromPath(path.resolve(parsedArgs.fixture))];
  }

  if (parsedArgs.fixture) {
    if (!parsedArgs.sport) {
      throw new Error('--fixture <ID> requires --sport <SPORT>');
    }
    return [loadFixture(parsedArgs.sport, parsedArgs.fixture, options)];
  }

  return loadFixturesForSport(parsedArgs.sport, options);
}

function writeJsonOutput(report, outPath) {
  const resolvedPath = path.resolve(outPath);
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

function formatHumanSummary(summary, results) {
  const lines = [
    `Audit summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`,
  ];

  if (summary.drift_categories.length > 0) {
    lines.push(`Drift categories: ${summary.drift_categories.join(', ')}`);
  }

  results
    .filter((result) => !result.passed)
    .forEach((result) => {
      lines.push(`- ${result.fixture_id}: ${result.error || result.diffs[0]?.drift_type || 'FAILED'}`);
    });

  return lines.join('\n');
}

function runAuditSuite(fixtures, options = {}) {
  const results = fixtures.map((fixture) => runFixtureAudit(fixture, options));
  const summary = summarizeResults(results);
  return {
    ...summary,
    results,
  };
}

function runAuditCli(argv = process.argv.slice(2), options = {}) {
  const parsedArgs = parseCliArgs(argv);
  const fixtures = loadFixturesFromParsedArgs(parsedArgs, options);
  const report = runAuditSuite(fixtures, options);
  const stdout = options.stdout || process.stdout;

  stdout.write(`${formatHumanSummary(report, report.results)}\n`);

  if (parsedArgs.out) {
    const outputPath = writeJsonOutput(report, parsedArgs.out);
    stdout.write(`Wrote JSON report to ${outputPath}\n`);
  }

  return report;
}

function main(argv = process.argv.slice(2)) {
  try {
    const report = runAuditCli(argv);
    process.exit(report.failed === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  compareSnapshotToExpected,
  formatHumanSummary,
  loadFixturesFromParsedArgs,
  main,
  parseCliArgs,
  runAuditCli,
  runAuditSuite,
  runFixtureAudit,
  summarizeResults,
  writeJsonOutput,
};
