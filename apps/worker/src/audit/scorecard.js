'use strict';

const fs = require('fs');
const path = require('path');

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
} = require('@cheddar-logic/data');

const {
  CALIBRATION_BUCKETS,
  generatePerformanceDriftReport,
  loadSettledRows,
} = require('./performance_drift_report');
const {
  runClosingLineSubstitutionValidation,
} = require('./validate_no_closing_line_sub');
const {
  defaultRunScope,
  OUTPUT_ROOT,
  runAuditCli,
  writeJsonOutput,
} = require('./run_model_audit');
const {
  buildNhl1pBaselineScorecard,
  buildNhl1pWalkForwardReport,
  evaluateNhl1pShadowGate,
} = require('../jobs/report_telemetry_calibration');

const TREND_DELTA_THRESHOLD = 0.02;

function parseCliArgs(argv = process.argv.slice(2)) {
  const parsed = {
    all: false,
    audit_report: null,
    generated_at: null,
    output_dir: null,
    performance_report: null,
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
      flag === '--output-dir' ||
      flag === '--run-scope' ||
      flag === '--audit-report' ||
      flag === '--performance-report' ||
      flag === '--generated-at'
    ) {
      const nextValue = inlineValue !== null ? inlineValue : argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
      }
      parsed[flag.slice(2).replace(/-/g, '_')] = nextValue;
      if (inlineValue === null) index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.all && !parsed.sport) {
    parsed.all = true;
  }

  return parsed;
}

function sanitizeRunScope(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'manual';
}

function resolveOutputPaths(parsedArgs) {
  const generatedAt = parsedArgs.generated_at || new Date().toISOString();
  const runScope = sanitizeRunScope(parsedArgs.run_scope || defaultRunScope(generatedAt));
  const outputDir = path.resolve(parsedArgs.output_dir || path.join(OUTPUT_ROOT, runScope));

  return {
    audit_report_path: parsedArgs.audit_report
      ? path.resolve(parsedArgs.audit_report)
      : path.join(outputDir, 'audit-report.json'),
    generated_at: generatedAt,
    markdown_path: path.join(outputDir, 'audit-scorecard.md'),
    output_dir: outputDir,
    performance_report_path: parsedArgs.performance_report
      ? path.resolve(parsedArgs.performance_report)
      : path.join(outputDir, 'performance-report.json'),
    run_scope: runScope,
    scorecard_path: path.join(outputDir, 'scorecard.json'),
  };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function buildAuditArgs(parsedArgs, paths) {
  const args = [];
  if (parsedArgs.all) args.push('--all');
  else args.push('--sport', parsedArgs.sport);
  args.push('--output-dir', paths.output_dir);
  args.push('--run-scope', paths.run_scope);
  args.push('--out', paths.audit_report_path);
  args.push('--run-at', paths.generated_at);
  return args;
}

function loadAuditReport(parsedArgs, paths) {
  if (fs.existsSync(paths.audit_report_path)) {
    return readJsonFile(paths.audit_report_path);
  }

  return runAuditCli(buildAuditArgs(parsedArgs, paths), {
    runAt: paths.generated_at,
    runScope: paths.run_scope,
    stdout: { write() {} },
    writeArtifacts: true,
  });
}

function emptyPerformanceReport(generatedAt, errorMessage = null) {
  return {
    alerts: [],
    dimensions: [],
    generated_at: generatedAt,
    unavailable_reason: errorMessage,
    windows: {},
  };
}

function loadPerformanceContext(parsedArgs, paths) {
  if (fs.existsSync(paths.performance_report_path)) {
    return {
      error: null,
      report: readJsonFile(paths.performance_report_path),
      rows: [],
    };
  }

  let db;
  try {
    db = getDatabaseReadOnly();
    const report = generatePerformanceDriftReport({
      all: parsedArgs.all,
      db,
      generatedAt: paths.generated_at,
      sport: parsedArgs.sport,
    });
    const rows = loadSettledRows({
      db,
      sport: parsedArgs.all ? null : parsedArgs.sport,
    });
    const nhl1pBaseline = buildNhl1pBaselineScorecard(db);
    const nhl1pWalkForward = buildNhl1pWalkForwardReport(db);
    const nhl1pShadowGate = evaluateNhl1pShadowGate(nhl1pWalkForward, nhl1pBaseline);
    writeJsonOutput(report, paths.performance_report_path);
    return {
      error: null,
      nhl1pShadowGate,
      report,
      rows,
    };
  } catch (error) {
    const emptyReport = emptyPerformanceReport(paths.generated_at, error.message);
    writeJsonOutput(emptyReport, paths.performance_report_path);
    return {
      error: error.message,
      nhl1pShadowGate: null,
      report: emptyReport,
      rows: [],
    };
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}

function familyKey(sport, cardFamily) {
  return `${sport || 'UNKNOWN'}::${cardFamily || 'UNKNOWN'}`;
}

function toDirection(delta) {
  if (!Number.isFinite(delta) || Math.abs(delta) < TREND_DELTA_THRESHOLD) return 'STABLE';
  return delta > 0 ? 'UP' : 'DOWN';
}

function calculateCalibrationDivergence(rows) {
  const buckets = CALIBRATION_BUCKETS.map((bucket) => ({
    count: 0,
    hit_rate: null,
    losses: 0,
    wins: 0,
    ...bucket,
  }));

  rows.forEach((row) => {
    if (!Number.isFinite(row.p_fair) || row.p_fair < 0.5) return;
    if (row.result !== 'WIN' && row.result !== 'LOSS') return;

    const bucket = buckets.find((candidate) => (
      candidate.max === Number.POSITIVE_INFINITY
        ? row.p_fair >= candidate.min
        : row.p_fair >= candidate.min && row.p_fair < candidate.max
    ));
    if (!bucket) return;
    bucket.count += 1;
    if (row.result === 'WIN') bucket.wins += 1;
    if (row.result === 'LOSS') bucket.losses += 1;
  });

  let maxDivergence = null;
  for (let index = 0; index < buckets.length - 1; index += 1) {
    const left = buckets[index];
    const right = buckets[index + 1];
    if (left.count < 10 || right.count < 10) continue;
    const leftRate = left.wins + left.losses > 0 ? left.wins / (left.wins + left.losses) : null;
    const rightRate = right.wins + right.losses > 0 ? right.wins / (right.wins + right.losses) : null;
    if (!Number.isFinite(leftRate) || !Number.isFinite(rightRate)) continue;
    const divergence = Math.abs(leftRate - rightRate);
    if (maxDivergence === null || divergence > maxDivergence) {
      maxDivergence = divergence;
    }
  }

  return maxDivergence;
}

function collectFamilyTrends(rows) {
  const sortedRows = [...rows].sort((left, right) => {
    if (left.settled_at_ms !== right.settled_at_ms) return right.settled_at_ms - left.settled_at_ms;
    return String(right.settled_at || '').localeCompare(String(left.settled_at || ''));
  });

  if (sortedRows.length < 100) return {};

  const currentRows = sortedRows.slice(0, 50);
  const baselineRows = sortedRows.slice(50, 100);
  const familyKeys = new Set(
    [...currentRows, ...baselineRows].map((row) => familyKey(row.sport, row.card_family)),
  );
  const trends = {};

  familyKeys.forEach((key) => {
    const [sport, cardFamily] = key.split('::');
    const currentFamilyRows = currentRows.filter((row) => familyKey(row.sport, row.card_family) === key);
    const baselineFamilyRows = baselineRows.filter((row) => familyKey(row.sport, row.card_family) === key);

    if (currentFamilyRows.length === 0 || baselineFamilyRows.length === 0) {
      trends[key] = {
        calibration: 'STABLE',
        executable_rate: 'STABLE',
        pass_rate: 'STABLE',
        sport,
        card_family: cardFamily,
      };
      return;
    }

    const currentExecutableRate =
      currentFamilyRows.filter((row) => row.execution_status === 'EXECUTABLE').length /
      currentFamilyRows.length;
    const baselineExecutableRate =
      baselineFamilyRows.filter((row) => row.execution_status === 'EXECUTABLE').length /
      baselineFamilyRows.length;
    const currentPassRate =
      currentFamilyRows.filter((row) => row.official_status === 'PASS').length /
      currentFamilyRows.length;
    const baselinePassRate =
      baselineFamilyRows.filter((row) => row.official_status === 'PASS').length /
      baselineFamilyRows.length;
    const currentCalibration = calculateCalibrationDivergence(currentFamilyRows);
    const baselineCalibration = calculateCalibrationDivergence(baselineFamilyRows);

    trends[key] = {
      calibration:
        Number.isFinite(currentCalibration) && Number.isFinite(baselineCalibration)
          ? toDirection(baselineCalibration - currentCalibration)
          : 'STABLE',
      card_family: cardFamily,
      executable_rate: toDirection(currentExecutableRate - baselineExecutableRate),
      pass_rate: toDirection(currentPassRate - baselinePassRate),
      sport,
    };
  });

  return trends;
}

function buildAuditFamilySummary(auditReport) {
  const families = new Map();

  (auditReport.results || []).forEach((result) => {
    const key = familyKey(result.sport, result.card_family);
    if (!families.has(key)) {
      families.set(key, {
        audit_warn_count: 0,
        card_family: result.card_family,
        critical_count: 0,
        failed: 0,
        fixture_count: 0,
        high_severity_count: 0,
        passed: 0,
        sport: result.sport,
      });
    }

    const summary = families.get(key);
    summary.fixture_count += 1;
    summary.critical_count += result.critical_count || 0;
    summary.high_severity_count += result.high_severity_count || 0;
    summary.audit_warn_count += result.warn_count || 0;
    if (result.passed) summary.passed += 1;
    else summary.failed += 1;
  });

  return families;
}

function buildPerformanceAlertSummary(performanceReport) {
  const families = new Map();

  (performanceReport.alerts || []).forEach((alert) => {
    const key = familyKey(alert.sport, alert.card_family);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push({
      alert_type: alert.alert_type,
      severity: alert.severity,
      threshold: alert.threshold,
      value: alert.value,
      window: alert.window,
    });
  });

  return families;
}

function determineFamilyRisk(auditSummary, performanceAlerts) {
  const alerts = performanceAlerts || [];
  const hasCriticalAlert = alerts.some((alert) => alert.severity === 'CRITICAL');
  const hasHighAlert = alerts.some((alert) => alert.severity === 'HIGH');
  const hasWarnAlert = alerts.some((alert) => alert.severity === 'WARN');
  const repeatedAlertPattern = alerts.length >= 2;
  const reasons = [];

  if ((auditSummary?.critical_count || 0) > 0) reasons.push('CRITICAL_AUDIT_BREACH');
  if ((auditSummary?.high_severity_count || 0) > 0) reasons.push('HIGH_AUDIT_DRIFT');
  if ((auditSummary?.audit_warn_count || 0) > 0) reasons.push('WARN_AUDIT_DRIFT');
  alerts.forEach((alert) => reasons.push(`${alert.severity}_PERFORMANCE_ALERT:${alert.alert_type}`));

  let risk = 'LOW';
  if ((auditSummary?.critical_count || 0) > 0 || hasCriticalAlert) {
    risk = 'CRITICAL';
  } else if ((auditSummary?.high_severity_count || 0) > 0 || hasHighAlert || repeatedAlertPattern) {
    risk = 'HIGH';
  } else if ((auditSummary?.audit_warn_count || 0) > 0 || hasWarnAlert) {
    risk = 'MEDIUM';
  }

  return {
    reasons: Array.from(new Set(reasons)),
    risk,
  };
}

function buildScorecard({ auditReport, generatedAt, performanceContext, runScope }) {
  const performanceReport = performanceContext.report || emptyPerformanceReport(generatedAt);
  const familyAudit = buildAuditFamilySummary(auditReport);
  const familyAlerts = buildPerformanceAlertSummary(performanceReport);
  const familyTrends = collectFamilyTrends(performanceContext.rows || []);
  const keys = new Set([
    ...familyAudit.keys(),
    ...familyAlerts.keys(),
    ...Object.keys(familyTrends),
  ]);

  const families = {};
  Array.from(keys).sort().forEach((key) => {
    const [sport, cardFamily] = key.split('::');
    const auditSummary = familyAudit.get(key) || {
      audit_warn_count: 0,
      card_family: cardFamily,
      critical_count: 0,
      failed: 0,
      fixture_count: 0,
      high_severity_count: 0,
      passed: 0,
      sport,
    };
    const performanceAlerts = familyAlerts.get(key) || [];
    const risk = determineFamilyRisk(auditSummary, performanceAlerts);
    const modelDecay =
      performanceAlerts.length > 0 &&
      (auditSummary.critical_count || 0) === 0 &&
      (auditSummary.high_severity_count || 0) === 0;

    families[`${sport}.${cardFamily}`] = {
      audit: {
        critical_count: auditSummary.critical_count,
        failed: auditSummary.failed,
        fixture_count: auditSummary.fixture_count,
        high_severity_count: auditSummary.high_severity_count,
        passed: auditSummary.passed,
        warn_count: auditSummary.audit_warn_count,
      },
      card_family: cardFamily,
      ...(modelDecay ? { model_decay: true } : {}),
      performance_alerts: performanceAlerts,
      reasons: risk.reasons,
      risk: risk.risk,
      sport,
      trend: familyTrends[key] || {
        calibration: 'STABLE',
        executable_rate: 'STABLE',
        pass_rate: 'STABLE',
      },
    };
  });

  return {
    audit: {
      by_sport: auditReport.by_sport || {},
      critical_count: auditReport.critical_count || 0,
      drift_categories: auditReport.drift_categories || [],
      failed: auditReport.failed || 0,
      fixture_count: auditReport.fixture_count || auditReport.total || 0,
      gate_failures: auditReport.gate_failures || [],
      high_severity_count: auditReport.high_severity_count || 0,
      passed: auditReport.passed || 0,
      warn_count: auditReport.warn_count || 0,
    },
    families,
    generated_at: generatedAt,
    nhl_1p_shadow_gate: performanceContext.nhl1pShadowGate || null,
    performance: {
      alert_count: (performanceReport.alerts || []).length,
      unavailable_reason: performanceContext.error,
    },
    run_scope: runScope,
  };
}

function formatScorecardMarkdown(scorecard) {
  const lines = [
    '# Audit Scorecard',
    '',
    `Generated at: ${scorecard.generated_at}`,
    `Run scope: ${scorecard.run_scope}`,
    '',
    `Audit fixtures: ${scorecard.audit.passed}/${scorecard.audit.fixture_count} passed`,
    `Severity counts: critical=${scorecard.audit.critical_count} high=${scorecard.audit.high_severity_count} warn=${scorecard.audit.warn_count}`,
  ];

  if (scorecard.performance.unavailable_reason) {
    lines.push(`Performance report unavailable: ${scorecard.performance.unavailable_reason}`);
  } else {
    lines.push(`Performance alerts: ${scorecard.performance.alert_count}`);
  }

  lines.push('', '## Family Risk');

  Object.keys(scorecard.families)
    .sort()
    .forEach((key) => {
      const family = scorecard.families[key];
      const reasons = family.reasons.length > 0 ? family.reasons.join(', ') : 'NONE';
      const decay = family.model_decay ? ' model_decay=true' : '';
      lines.push(
        `- ${key}: risk=${family.risk}${decay}; trend(executable=${family.trend.executable_rate}, pass=${family.trend.pass_rate}, calibration=${family.trend.calibration}); reasons=${reasons}`,
      );
    });

  if (scorecard.nhl_1p_shadow_gate) {
    const gate = scorecard.nhl_1p_shadow_gate;
    lines.push('', '## NHL 1P Shadow Gate');
    lines.push(`Verdict: ${gate.verdict}`);
    lines.push(`Rationale: ${gate.rationale}`);
    if (gate.promoteGateBuckets) {
      for (const b of gate.promoteGateBuckets) {
        const status = b.thinSample
          ? 'THIN_SAMPLE'
          : b.meetsTarget === true
            ? 'MEETS_TARGET'
            : b.meetsTarget === false
              ? 'REGRESSION'
              : 'UNKNOWN';
        lines.push(
          `- ${b.bucketRangeLabel}: status=${status}; wf_over_hit_rate=${b.walkForwardOverHitRate ?? 'n/a'}; baseline=${b.baselineOverHitRate ?? 'n/a'}`,
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const parsedArgs = parseCliArgs(argv);
  const paths = resolveOutputPaths(parsedArgs);
  fs.mkdirSync(paths.output_dir, { recursive: true });

  const auditReport = loadAuditReport(parsedArgs, paths);
  const performanceContext = loadPerformanceContext(parsedArgs, paths);
  const scorecard = buildScorecard({
    auditReport,
    generatedAt: paths.generated_at,
    performanceContext,
    runScope: paths.run_scope,
  });

  const closingLineValidation = runClosingLineSubstitutionValidation({
    outPath: path.join(paths.output_dir, 'closing-line-substitution-report.json'),
  });
  scorecard.closing_line_substitution = {
    excluded_game_rate: closingLineValidation.report.summary.excluded_game_rate,
    games_excluded_no_qualifying_snapshot:
      closingLineValidation.report.summary.games_excluded_no_qualifying_snapshot,
    games_with_known_event_start:
      closingLineValidation.report.summary.games_with_known_event_start,
    max_excluded_rate:
      closingLineValidation.report.policy.max_excluded_rate,
    should_fail: closingLineValidation.report.summary.should_fail,
  };

  if (!closingLineValidation.ok) {
    throw new Error(
      'Closing-line substitution validation failed: excluded-game rate exceeds threshold. ' +
        'See closing-line-substitution-report.json for details.',
    );
  }

  writeJsonOutput(scorecard, paths.scorecard_path);
  fs.writeFileSync(paths.markdown_path, formatScorecardMarkdown(scorecard), 'utf8');

  stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  stdout.write(`Wrote scorecard JSON to ${paths.scorecard_path}\n`);
  stdout.write(`Wrote scorecard markdown to ${paths.markdown_path}\n`);

  return {
    markdown_path: paths.markdown_path,
    performance_report_path: paths.performance_report_path,
    scorecard,
    scorecard_path: paths.scorecard_path,
  };
}

if (require.main === module) {
  try {
    runCli();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`[scorecard] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildScorecard,
  collectFamilyTrends,
  determineFamilyRisk,
  emptyPerformanceReport,
  formatScorecardMarkdown,
  parseCliArgs,
  resolveOutputPaths,
  runCli,
};
