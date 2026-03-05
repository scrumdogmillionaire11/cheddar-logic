/**
 * Tests for SettlementMonitor
 *
 * Tests metric tracking, alert detection, and historical analysis
 */

'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
}));

const { SettlementMonitor } = require('../settlement-monitor.js');

describe('SettlementMonitor', () => {
  let monitor;
  let metrics;
  let alerts;
  let logs;

  beforeEach(() => {
    metrics = [];
    alerts = [];
    logs = [];

    monitor = new SettlementMonitor({
      maxConsecutiveFailures: 3,
      warningThresholdPerRun: 10,
      failureCheckWindowHours: 1,
      onMetric: (msg) => metrics.push(msg),
      onAlert: (msg) => alerts.push(msg),
      onError: (msg) => logs.push(msg),
    });
  });

  describe('initialization', () => {
    it('should initialize with default configuration', () => {
      const defaultMonitor = new SettlementMonitor();
      expect(defaultMonitor.maxConsecutiveFailures).toBe(3);
      expect(defaultMonitor.warningThresholdPerRun).toBe(10);
      expect(defaultMonitor.failureCheckWindowHours).toBe(1);
    });

    it('should initialize with custom configuration', () => {
      expect(monitor.maxConsecutiveFailures).toBe(3);
      expect(monitor.warningThresholdPerRun).toBe(10);
    });
  });

  describe('initializeRun', () => {
    it('should reset metrics for new run', () => {
      monitor.initializeRun('job-123');

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.jobId).toBe('job-123');
      expect(metrics.gamesProcessed).toBe(0);
      expect(metrics.gamesSettled).toBe(0);
      expect(metrics.espnAttempts).toBe(0);
      expect(metrics.espnSuccesses).toBe(0);
      expect(metrics.espnFailures).toBe(0);
    });

    it('should set start time', () => {
      const beforeInit = new Date();
      monitor.initializeRun('job-123');
      const afterInit = new Date();

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.startTime.getTime()).toBeGreaterThanOrEqual(beforeInit.getTime());
      expect(metrics.startTime.getTime()).toBeLessThanOrEqual(afterInit.getTime());
    });
  });

  describe('ESPN API tracking', () => {
    beforeEach(() => {
      monitor.initializeRun('job-456');
    });

    it('should track initial ESPN attempt', () => {
      monitor.recordESPNAttempt('fetch scoreboard', false);

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.espnAttempts).toBe(1);
      expect(metrics.espnRetries).toBe(0);
    });

    it('should track ESPN retry attempts', () => {
      monitor.recordESPNAttempt('fetch scoreboard', false);
      monitor.recordESPNAttempt('fetch scoreboard', true, 0);
      monitor.recordESPNAttempt('fetch scoreboard', true, 1);

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.espnAttempts).toBe(3);
      expect(metrics.espnRetries).toBe(2);
    });

    it('should track ESPN successes', () => {
      monitor.recordESPNAttempt('fetch scoreboard', false);
      monitor.recordESPNSuccess('fetch scoreboard', 5);

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.espnSuccesses).toBe(1);
      expect(metrics.espnFailures).toBe(0);
    });

    it('should track ESPN failures', () => {
      monitor.recordESPNAttempt('fetch scoreboard', false);
      const error = new Error('Timeout');
      monitor.recordESPNFailure('fetch scoreboard', error, 2);

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.espnFailures).toBe(1);
      expect(metrics.errors.length).toBe(1);
      expect(metrics.errors[0].type).toBe('ESPN_API_FAILURE');
      expect(metrics.errors[0].message).toBe('Timeout');
      expect(metrics.errors[0].retryCount).toBe(2);
    });

    it('should detect consecutive ESPN failures', () => {
      const error = new Error('Network error');

      monitor.recordESPNAttempt('fetch 1', false);
      monitor.recordESPNFailure('fetch 1', error, 2);

      monitor.recordESPNAttempt('fetch 2', false);
      monitor.recordESPNFailure('fetch 2', error, 2);

      monitor.recordESPNAttempt('fetch 3', false);
      monitor.recordESPNFailure('fetch 3', error, 2);

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.some(a => a.includes('CONSECUTIVE_ESPN_FAILURES'))).toBe(true);
    });
  });

  describe('Game settlement tracking', () => {
    beforeEach(() => {
      monitor.initializeRun('job-789');
    });

    it('should track settled games', () => {
      monitor.recordGameSettled('game-1', { home: 3, away: 2 });
      monitor.recordGameSettled('game-2', { home: 1, away: 0 });

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.gamesProcessed).toBe(2);
      expect(metrics.gamesSettled).toBe(2);
    });

    it('should track skipped games', () => {
      monitor.recordGameSettled('game-1', { home: 3, away: 2 });
      monitor.recordGameSkipped('game-2', 'not yet complete');

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.gamesProcessed).toBe(2);
      expect(metrics.gamesSettled).toBe(1);
    });
  });

  describe('Score validation tracking', () => {
    beforeEach(() => {
      monitor.initializeRun('job-score');
    });

    it('should track score validation warnings', () => {
      monitor.recordScoreValidationWarning('game-1', 'Blowout detected', { home: 150, away: 80 });

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.scoreValidationWarnings).toBe(1);
    });

    it('should alert when warnings exceed threshold', () => {
      // Create 10 warnings to hit threshold
      for (let i = 0; i < 10; i++) {
        monitor.recordScoreValidationWarning(`game-${i}`, 'High score', { home: 120, away: 90 });
      }

      // Should have generated an alert
      expect(monitor.getCurrentMetrics().alerts.length).toBeGreaterThan(0);
      expect(monitor.getCurrentMetrics().alerts.some(a => a.type === 'SCORE_VALIDATION_THRESHOLD')).toBe(true);
    });

    it('should track score validation errors', () => {
      monitor.recordScoreValidationError('game-1', 'Negative home score', { home: -5, away: 100 });

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.scoreValidationErrors).toBe(1);
      expect(metrics.errors.length).toBe(1);
      expect(metrics.errors[0].type).toBe('SCORE_VALIDATION_ERROR');
    });
  });

  describe('finalizeRun', () => {
    beforeEach(() => {
      monitor.initializeRun('job-final');
    });

    it('should return summary for successful run', () => {
      monitor.recordESPNAttempt('fetch 1', false);
      monitor.recordESPNSuccess('fetch 1', 3);
      monitor.recordGameSettled('game-1', { home: 3, away: 2 });

      const summary = monitor.finalizeRun(true);

      expect(summary.success).toBe(true);
      expect(summary.games.processed).toBe(1);
      expect(summary.games.settled).toBe(1);
      expect(summary.espn.attempts).toBe(1);
      expect(summary.espn.successes).toBe(1);
      expect(summary.duration.ms).toBeGreaterThanOrEqual(0);
    });

    it('should return summary for failed run', () => {
      monitor.recordESPNAttempt('fetch 1', false);
      const error = new Error('Service unavailable');
      monitor.recordESPNFailure('fetch 1', error, 2);

      const summary = monitor.finalizeRun(false, 'ESPN API unavailable');

      expect(summary.success).toBe(false);
      expect(summary.reason).toBe('ESPN API unavailable');
      expect(summary.espn.failures).toBe(1);
    });

    it('should calculate success rates', () => {
      monitor.recordESPNAttempt('fetch 1', false);
      monitor.recordESPNSuccess('fetch 1', 3);
      monitor.recordESPNAttempt('fetch 2', false);
      monitor.recordESPNSuccess('fetch 2', 2);

      monitor.recordGameSettled('game-1', { home: 3, away: 2 });
      monitor.recordGameSettled('game-2', { home: 1, away: 0 });

      const summary = monitor.finalizeRun(true);

      expect(summary.espn.successRate).toBe('100.0');
      expect(summary.games.rate).toBe('100.0');
    });

    it('should set end time', () => {
      const beforeFinalize = new Date();
      monitor.finalizeRun(true);
      const afterFinalize = new Date();

      const metrics = monitor.getCurrentMetrics();
      expect(metrics.endTime.getTime()).toBeGreaterThanOrEqual(beforeFinalize.getTime());
      expect(metrics.endTime.getTime()).toBeLessThanOrEqual(afterFinalize.getTime());
    });
  });

  describe('Metrics snapshot', () => {
    it('should return current metrics without reference', () => {
      monitor.initializeRun('job-snap');
      monitor.recordGameSettled('game-1', { home: 3, away: 2 });

      const snapshot1 = monitor.getCurrentMetrics();
      monitor.recordGameSettled('game-2', { home: 1, away: 0 });
      const snapshot2 = monitor.getCurrentMetrics();

      // First snapshot should not be affected by later call
      expect(snapshot1.gamesSettled).toBe(1);
      expect(snapshot2.gamesSettled).toBe(2);
    });
  });

  describe('Logging', () => {
    it('should call metric logging callbacks', () => {
      monitor.initializeRun('job-log');
      monitor.recordESPNAttempt('test', false);

      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics.some(m => m.includes('Initialized run'))).toBe(true);
      expect(metrics.some(m => m.includes('ESPN'))).toBe(true);
    });

    it('should call alert logging callbacks', () => {
      monitor.initializeRun('job-alert');
      const error = new Error('fail');

      for (let i = 0; i < 3; i++) {
        monitor.recordESPNAttempt(`fetch ${i}`, false);
        monitor.recordESPNFailure(`fetch ${i}`, error, 2);
      }

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.some(a => a.includes('ALERT'))).toBe(true);
    });

    it('should use console by default', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const defaultMonitor = new SettlementMonitor();

      defaultMonitor.initializeRun('job-console');
      defaultMonitor.recordESPNFailure('test', new Error('fail'), 0);

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Analytics', () => {
    it('should calculate ESPN success rate for partial success', () => {
      monitor.initializeRun('job-rate');

      monitor.recordESPNAttempt('fetch 1', false);
      monitor.recordESPNSuccess('fetch 1', 1);
      monitor.recordESPNAttempt('fetch 2', false);
      const error = new Error('timeout');
      monitor.recordESPNFailure('fetch 2', error, 0);

      const summary = monitor.finalizeRun(true);

      expect(summary.espn.successRate).toBe('50.0');
      expect(summary.espn.attempts).toBe(2);
      expect(summary.espn.successes).toBe(1);
      expect(summary.espn.failures).toBe(1);
    });

    it('should handle zero attempts gracefully', () => {
      monitor.initializeRun('job-empty');
      const summary = monitor.finalizeRun(true);

      expect(summary.espn.successRate).toBe('N/A');
      expect(summary.games.rate).toBe('N/A');
    });
  });
});
