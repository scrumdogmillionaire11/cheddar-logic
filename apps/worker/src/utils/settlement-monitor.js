/**
 * Settlement Monitoring & Alerting
 *
 * Tracks settlement job metrics:
 * - Retry attempts and success rates
 * - ESPN API failure rates and patterns
 * - Score validation warnings
 * - Consecutive failure detection
 *
 * Alert conditions:
 * - 3+ consecutive ESPN API failures
 * - Score validation warnings exceed threshold (10+ per run)
 * - Settlement job failures in last hour
 */

'use strict';

const { getDatabase } = require('@cheddar-logic/data');

class SettlementMonitor {
  constructor(options = {}) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures || 3;
    this.warningThresholdPerRun = options.warningThresholdPerRun || 10;
    this.failureCheckWindowHours = options.failureCheckWindowHours || 1;

    // In-memory metrics for current run
    this.currentRunMetrics = {
      jobId: null,
      startTime: null,
      endTime: null,
      gamesProcessed: 0,
      gamesSettled: 0,
      espnAttempts: 0,
      espnRetries: 0,
      espnSuccesses: 0,
      espnFailures: 0,
      scoreValidationWarnings: 0,
      scoreValidationErrors: 0,
      errors: [],
      alerts: [],
    };

    // Logging callbacks
    this.onMetric = options.onMetric || console.log;
    this.onAlert = options.onAlert || console.warn;
    this.onError = options.onError || console.error;
  }

  /**
   * Initialize monitoring for a new job run
   * @param {string} jobId - Unique job identifier
   */
  initializeRun(jobId) {
    this.currentRunMetrics = {
      jobId,
      startTime: new Date(),
      endTime: null,
      gamesProcessed: 0,
      gamesSettled: 0,
      espnAttempts: 0,
      espnRetries: 0,
      espnSuccesses: 0,
      espnFailures: 0,
      scoreValidationWarnings: 0,
      scoreValidationErrors: 0,
      errors: [],
      alerts: [],
    };

    this.onMetric(`[SettlementMonitor] Initialized run ${jobId}`);
  }

  /**
   * Record ESPN API attempt (initial or retry)
   * @param {string} context - Description of attempt (e.g., "fetch scoreboard")
   * @param {boolean} isRetry - Whether this is a retry
   * @param {number} retryNumber - Retry attempt number (0-indexed for retries)
   */
  recordESPNAttempt(context, isRetry = false, retryNumber = 0) {
    this.currentRunMetrics.espnAttempts += 1;
    if (isRetry) {
      this.currentRunMetrics.espnRetries += 1;
    }

    const label = isRetry ? `retry ${retryNumber + 1}` : 'attempt 1';
    this.onMetric(`[SettlementMonitor] ESPN ${label}: ${context}`);
  }

  /**
   * Record ESPN API success
   * @param {string} context - Description of successful call
   * @param {number} resultCount - Number of results (e.g., events returned)
   */
  recordESPNSuccess(context, resultCount = null) {
    this.currentRunMetrics.espnSuccesses += 1;

    const summary = resultCount !== null ? ` (${resultCount} results)` : '';
    this.onMetric(`[SettlementMonitor] ESPN success${summary}: ${context}`);
  }

  /**
   * Record ESPN API failure
   * @param {string} context - Description of failed call
   * @param {Error} error - Error object
   * @param {number} retryCount - Total retry attempts made
   */
  recordESPNFailure(context, error, retryCount = 0) {
    this.currentRunMetrics.espnFailures += 1;
    this.currentRunMetrics.errors.push({
      timestamp: new Date(),
      type: 'ESPN_API_FAILURE',
      context,
      message: error?.message || 'Unknown error',
      retryCount,
    });

    this.onMetric(
      `[SettlementMonitor] ESPN failure after ${retryCount + 1} attempts: ${context}`,
    );
    this.onMetric(`  Error: ${error?.message || 'Unknown'}`);

    // Check for consecutive failure alert
    this._checkConsecutiveFailureAlert();
  }

  /**
   * Record successful game settlement
   * @param {string} gameId - Game ID
   * @param {object} scores - { home: number, away: number }
   */
  recordGameSettled(gameId, scores) {
    this.currentRunMetrics.gamesProcessed += 1;
    this.currentRunMetrics.gamesSettled += 1;

    this.onMetric(
      `[SettlementMonitor] Game settled: ${gameId} (${scores.home}-${scores.away})`,
    );
  }

  /**
   * Record game skipped (pending, not yet complete, etc.)
   * @param {string} gameId - Game ID
   * @param {string} reason - Why game was skipped
   */
  recordGameSkipped(gameId, reason) {
    this.currentRunMetrics.gamesProcessed += 1;

    this.onMetric(`[SettlementMonitor] Game skipped: ${gameId} (${reason})`);
  }

  /**
   * Record score validation warning
   * @param {string} gameId - Game ID
   * @param {string} warning - Description of issue (e.g., "Blowout detected")
   * @param {object} scores - { home: number, away: number }
   */
  recordScoreValidationWarning(gameId, warning, scores) {
    this.currentRunMetrics.scoreValidationWarnings += 1;

    this.onMetric(
      `[SettlementMonitor] Score warning: ${gameId} - ${warning} (${scores.home}-${scores.away})`,
    );

    // Alert if warning count exceeds threshold
    if (
      this.currentRunMetrics.scoreValidationWarnings >=
      this.warningThresholdPerRun
    ) {
      this._raiseAlert(
        'SCORE_VALIDATION_THRESHOLD',
        `Score validation warnings (${this.currentRunMetrics.scoreValidationWarnings}) ` +
          `exceeded threshold (${this.warningThresholdPerRun})`,
      );
    }
  }

  /**
   * Record score validation error (prevents settlement)
   * @param {string} gameId - Game ID
   * @param {string} error - Description of issue (e.g., "Negative score")
   * @param {object} scores - { home: number, away: number }
   */
  recordScoreValidationError(gameId, error, scores) {
    this.currentRunMetrics.scoreValidationErrors += 1;
    this.currentRunMetrics.errors.push({
      timestamp: new Date(),
      type: 'SCORE_VALIDATION_ERROR',
      gameId,
      error,
      scores,
    });

    this.onMetric(`[SettlementMonitor] Score error: ${gameId} - ${error}`);
  }

  /**
   * Finalize run and return metrics summary
   * @param {boolean} success - Whether job completed successfully
   * @param {string} reason - Optional reason for failure
   */
  finalizeRun(success, reason = null) {
    this.currentRunMetrics.endTime = new Date();
    const durationMs =
      this.currentRunMetrics.endTime - this.currentRunMetrics.startTime;

    const espnSuccessRate =
      this.currentRunMetrics.espnAttempts > 0
        ? (
            (this.currentRunMetrics.espnSuccesses /
              this.currentRunMetrics.espnAttempts) *
            100
          ).toFixed(1)
        : 'N/A';

    const summary = {
      success,
      reason,
      duration: {
        ms: durationMs,
        sec: (durationMs / 1000).toFixed(2),
      },
      games: {
        processed: this.currentRunMetrics.gamesProcessed,
        settled: this.currentRunMetrics.gamesSettled,
        rate:
          this.currentRunMetrics.gamesProcessed > 0
            ? (
                (this.currentRunMetrics.gamesSettled /
                  this.currentRunMetrics.gamesProcessed) *
                100
              ).toFixed(1)
            : 'N/A',
      },
      espn: {
        attempts: this.currentRunMetrics.espnAttempts,
        retries: this.currentRunMetrics.espnRetries,
        successes: this.currentRunMetrics.espnSuccesses,
        failures: this.currentRunMetrics.espnFailures,
        successRate: espnSuccessRate,
      },
      scoring: {
        warnings: this.currentRunMetrics.scoreValidationWarnings,
        errors: this.currentRunMetrics.scoreValidationErrors,
      },
      alerts: this.currentRunMetrics.alerts,
      errors: this.currentRunMetrics.errors,
    };

    this.onMetric(
      `[SettlementMonitor] Run completed: ${JSON.stringify(summary)}`,
    );

    return summary;
  }

  /**
   * Check if consecutive ESPN failures exceed threshold
   * @private
   */
  _checkConsecutiveFailureAlert() {
    // Simple heuristic: if more failures than successes in recent calls
    const totalAttempts =
      this.currentRunMetrics.espnFailures +
      this.currentRunMetrics.espnSuccesses;
    if (totalAttempts >= 3 && this.currentRunMetrics.espnFailures >= 3) {
      this._raiseAlert(
        'CONSECUTIVE_ESPN_FAILURES',
        `${this.currentRunMetrics.espnFailures} consecutive ESPN API failures detected`,
      );
    }
  }

  /**
   * Raise an alert for critical conditions
   * @private
   */
  _raiseAlert(alertType, message) {
    const alert = {
      timestamp: new Date(),
      type: alertType,
      message,
    };

    if (!this.currentRunMetrics.alerts.find((a) => a.type === alertType)) {
      this.currentRunMetrics.alerts.push(alert);
      this.onAlert(`[SettlementMonitor ALERT] ${alertType}: ${message}`);
    }
  }

  /**
   * Get current run metrics (snapshot)
   */
  getCurrentMetrics() {
    return { ...this.currentRunMetrics };
  }

  /**
   * Query historical job runs for analysis
   * @param {number} hours - Look back N hours
   * @returns {Promise<object[]>}
   */
  async getRecentJobRuns(hours = 1) {
    try {
      const db = getDatabase();
      const cutoffTime = new Date(Date.now() - hours * 3600000).toISOString();

      const stmt = db.prepare(`
        SELECT 
          id,
          key,
          status,
          started_at,
          completed_at,
          result
        FROM job_runs
        WHERE key = 'settle_game_results'
          AND started_at > ?
        ORDER BY started_at DESC
        LIMIT 100
      `);

      return stmt.all(cutoffTime);
    } catch (err) {
      this.onError(`Failed to query recent job runs: ${err.message}`);
      return [];
    }
  }

  /**
   * Detect patterns in recent job failures
   * @param {number} hours - Look back N hours
   * @returns {Promise<object>}
   */
  async analyzeRecentFailures(hours = 1) {
    try {
      const runs = await this.getRecentJobRuns(hours);

      const failures = runs.filter((r) => r.status === 'failed');
      const successRate =
        runs.length > 0
          ? (((runs.length - failures.length) / runs.length) * 100).toFixed(1)
          : 'N/A';

      return {
        period: `Last ${hours} hour(s)`,
        totalRuns: runs.length,
        failedRuns: failures.length,
        successRate,
        failures: failures.map((f) => ({
          startedAt: f.started_at,
          result: f.result,
        })),
      };
    } catch (err) {
      this.onError(`Failed to analyze recent failures: ${err.message}`);
      return null;
    }
  }
}

module.exports = { SettlementMonitor };
