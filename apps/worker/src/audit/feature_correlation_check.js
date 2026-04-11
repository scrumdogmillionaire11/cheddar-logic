'use strict';

/**
 * WI-0833: Feature correlation CI gate — three-tier threshold check + suppression enforcement.
 *
 * Three tiers:
 *   INFO:     0.60 <= |r| < 0.80 — warning only, never fails build
 *   ALERT:    0.80 <= |r| < 0.90 — fails UNLESS valid non-expired suppression exists
 *   CRITICAL: |r| >= 0.90        — ALWAYS fails, suppressions are ignored
 *
 * Suppression expiry: if expires_after_wi is set and that WI string appears in git log,
 * the suppression is expired and the pair is treated as a violation.
 */

const { execSync } = require('child_process');
const { computeCorrelationMatrix } = require('../../../../packages/models/src/feature-correlation');

const THRESHOLD_INFO = 0.60;
const THRESHOLD_ALERT = 0.80;
const THRESHOLD_CRITICAL = 0.90;

/**
 * Determine the tier for an absolute r value.
 * Returns 'INFO', 'ALERT', 'CRITICAL', or null (below INFO threshold).
 *
 * @param {number} absR - Absolute value of Pearson r.
 * @returns {string|null}
 */
function classifyTier(absR) {
  if (absR >= THRESHOLD_CRITICAL) return 'CRITICAL';
  if (absR >= THRESHOLD_ALERT) return 'ALERT';
  if (absR >= THRESHOLD_INFO) return 'INFO';
  return null;
}

/**
 * Check whether a suppression entry matches the given sport + feature pair (order-independent).
 *
 * @param {Object} suppression
 * @param {string} sport
 * @param {string} featureA
 * @param {string} featureB
 * @returns {boolean}
 */
function suppressionMatches(suppression, sport, featureA, featureB) {
  if (!suppression || typeof suppression !== 'object') return false;
  const suppSport = typeof suppression.sport === 'string' ? suppression.sport.toUpperCase() : '';
  if (suppSport !== sport.toUpperCase()) return false;

  const fa = suppression.feature_a;
  const fb = suppression.feature_b;
  return (
    (fa === featureA && fb === featureB) ||
    (fa === featureB && fb === featureA)
  );
}

/**
 * Check whether a suppression is expired by searching gitLogOutput for the WI string.
 *
 * @param {Object} suppression
 * @param {string} gitLogOutput - Output of `git log --oneline`, as a string.
 * @returns {boolean} true if expired, false if not expired (or no expires_after_wi field).
 */
function isSuppressionExpired(suppression, gitLogOutput) {
  const wi = suppression.expires_after_wi;
  if (!wi || typeof wi !== 'string') return false;
  return gitLogOutput.includes(wi);
}

/**
 * Run the correlation check with an explicit git log string (testable variant).
 *
 * @param {string} sport - Sport identifier (e.g. "MLB", "NHL", "NBA").
 * @param {number[][]} featureMatrix - N arrays each of length S (samples).
 * @param {string[]} featureNames - N feature name strings.
 * @param {Array} suppressions - Suppression entries from correlation_suppressions.json.
 * @param {string} [gitLogOutput] - Output of `git log --oneline` as string.
 *   When undefined, the real git log is called. Callers may pass an empty string
 *   to treat all suppressions as non-expired.
 * @returns {{ violations: Array, warnings: Array }}
 */
function runCheckWithGitLog(sport, featureMatrix, featureNames, suppressions, gitLogOutput) {
  const suppressionList = Array.isArray(suppressions) ? suppressions : [];

  // Resolve git log if not provided
  let resolvedGitLog;
  if (gitLogOutput !== undefined) {
    resolvedGitLog = gitLogOutput;
  } else {
    try {
      resolvedGitLog = execSync('git log --oneline', { encoding: 'utf8', cwd: process.cwd() });
    } catch (_err) {
      // Non-git environment — treat all suppressions as unexpired (CI-safe)
      resolvedGitLog = '';
    }
  }

  const { names, matrix } = computeCorrelationMatrix(featureMatrix, featureNames);
  const n = names.length;

  const violations = [];
  const warnings = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = matrix[i][j];
      const absR = Math.abs(r);
      const tier = classifyTier(absR);

      if (!tier) continue;

      const featureA = names[i];
      const featureB = names[j];

      if (tier === 'INFO') {
        warnings.push({ sport, feature_a: featureA, feature_b: featureB, r, level: 'INFO' });
        continue;
      }

      if (tier === 'CRITICAL') {
        // Always a violation — no suppression allowed
        violations.push({
          sport,
          feature_a: featureA,
          feature_b: featureB,
          r,
          level: 'CRITICAL',
          suppressed: false,
          suppression_expired: false,
        });
        continue;
      }

      // ALERT tier — check for valid non-expired suppression
      const matchingSuppression = suppressionList.find(function (s) {
        return suppressionMatches(s, sport, featureA, featureB);
      });

      if (matchingSuppression) {
        const expired = isSuppressionExpired(matchingSuppression, resolvedGitLog);
        if (expired) {
          // Expired suppression — treat as unsuppressed violation
          violations.push({
            sport,
            feature_a: featureA,
            feature_b: featureB,
            r,
            level: 'ALERT',
            suppressed: false,
            suppression_expired: true,
          });
        } else {
          // Valid non-expired suppression — not a violation
          // (silently skip; suppressed pairs don't appear in warnings either)
        }
      } else {
        // No suppression — ALERT is a violation
        violations.push({
          sport,
          feature_a: featureA,
          feature_b: featureB,
          r,
          level: 'ALERT',
          suppressed: false,
          suppression_expired: false,
        });
      }
    }
  }

  return { violations, warnings };
}

/**
 * Run the correlation check using the real git log to evaluate suppression expiry.
 *
 * @param {string} sport
 * @param {number[][]} featureMatrix
 * @param {string[]} featureNames
 * @param {Array} suppressions
 * @returns {{ violations: Array, warnings: Array }}
 */
function runCheck(sport, featureMatrix, featureNames, suppressions) {
  return runCheckWithGitLog(sport, featureMatrix, featureNames, suppressions, undefined);
}

/**
 * Throw if any violations exist; return true if clean.
 *
 * @param {{ violations: Array, warnings: Array }} results
 * @returns {true}
 * @throws {Error} describing all violations.
 */
function runBuildGate(results) {
  if (!results || !Array.isArray(results.violations) || results.violations.length === 0) {
    return true;
  }

  const lines = results.violations.map(function (v) {
    const expiredNote = v.suppression_expired ? ' [suppression expired]' : '';
    return '  [' + v.level + '] ' + v.feature_a + ' <-> ' + v.feature_b +
      ' r=' + v.r.toFixed(4) + ' (' + v.sport + ')' + expiredNote;
  });

  throw new Error(
    'Feature correlation gate failed — ' + results.violations.length + ' violation(s):\n' +
    lines.join('\n')
  );
}

module.exports = {
  runCheck,
  runBuildGate,
  runCheckWithGitLog,
};
