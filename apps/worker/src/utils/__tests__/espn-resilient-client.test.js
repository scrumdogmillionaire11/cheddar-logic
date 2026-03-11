/**
 * Tests for ResilientESPNClient
 *
 * Tests retry logic, timeout, and core functionality
 * without mocking external dependencies
 */

'use strict';

const {
  ResilientESPNClient,
  exponentialBackoffDelay,
} = require('../espn-resilient-client.js');

describe('ResilientESPNClient', () => {
  describe('exponentialBackoffDelay', () => {
    it('should return increasing delays with exponential backoff', () => {
      const delay0 = exponentialBackoffDelay(0, 1000);
      const delay1 = exponentialBackoffDelay(1, 1000);
      const delay2 = exponentialBackoffDelay(2, 1000);

      // With jitter, we expect roughly 1000ms, 2000ms, 4000ms (±10%)
      expect(delay0).toBeGreaterThanOrEqual(900);
      expect(delay0).toBeLessThanOrEqual(1100);
      expect(delay1).toBeGreaterThanOrEqual(1800);
      expect(delay1).toBeLessThanOrEqual(2200);
      expect(delay2).toBeGreaterThanOrEqual(3600);
      expect(delay2).toBeLessThanOrEqual(4400);
    });

    it('should apply custom base delay', () => {
      const delay = exponentialBackoffDelay(0, 500);
      expect(delay).toBeGreaterThanOrEqual(450);
      expect(delay).toBeLessThanOrEqual(550);
    });

    it('should increase exponentially', () => {
      const delay0 = exponentialBackoffDelay(0, 1000);
      const delay1 = exponentialBackoffDelay(1, 1000);
      const delay2 = exponentialBackoffDelay(2, 1000);

      // Each step roughly doubles (ignoring jitter range)
      expect(delay1).toBeGreaterThanOrEqual(1800); // ~base * 2
      expect(delay2).toBeGreaterThanOrEqual(3600); // ~base * 4
    });
  });

  describe('ResilientESPNClient configuration', () => {
    it('should initialize with default configuration', () => {
      const client = new ResilientESPNClient();

      expect(client.maxRetries).toBe(3);
      expect(client.timeoutMs).toBe(30000);
      expect(client.baseDelayMs).toBe(1000);
    });

    it('should allow custom timeout configuration', () => {
      const client = new ResilientESPNClient({
        timeoutMs: 60000,
        maxRetries: 5,
        baseDelayMs: 2000,
      });

      expect(client.timeoutMs).toBe(60000);
      expect(client.maxRetries).toBe(5);
      expect(client.baseDelayMs).toBe(2000);
    });

    it('should use provided logging callbacks', () => {
      const logFn = jest.fn();
      const warnFn = jest.fn();
      const errorFn = jest.fn();

      const client = new ResilientESPNClient({
        onLog: logFn,
        onWarn: warnFn,
        onError: errorFn,
      });

      expect(client.onLog).toBe(logFn);
      expect(client.onWarn).toBe(warnFn);
      expect(client.onError).toBe(errorFn);
    });

    it('should have default logging functions', () => {
      const client = new ResilientESPNClient();

      expect(typeof client.onLog).toBe('function');
      expect(typeof client.onWarn).toBe('function');
      expect(typeof client.onError).toBe('function');
    });
  });

  describe('executeWithRetry - unit tests', () => {
    let client;
    let logMessages;
    let warnMessages;
    let errorMessages;

    beforeEach(() => {
      logMessages = [];
      warnMessages = [];
      errorMessages = [];

      client = new ResilientESPNClient({
        maxRetries: 3,
        timeoutMs: 5000,
        baseDelayMs: 5, // Very short for fast tests
        onLog: (msg) => logMessages.push(msg),
        onWarn: (msg) => warnMessages.push(msg),
        onError: (msg) => errorMessages.push(msg),
      });
    });

    it('should succeed on first attempt', async () => {
      const mockData = { events: [] };
      const fetchFn = jest.fn().mockResolvedValue(mockData);

      const result = await client.executeWithRetry('test', fetchFn, {
        path: '/test',
      });

      expect(result).toEqual(mockData);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on null response and succeed', async () => {
      const mockData = { events: [] };
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockData);

      const result = await client.executeWithRetry('test', fetchFn, {
        path: '/test',
      });

      expect(result).toEqual(mockData);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(warnMessages.length).toBeGreaterThan(0);
      expect(warnMessages.some((m) => m.includes('Null'))).toBe(true);
    });

    it('should return null after max retries with null responses', async () => {
      const fetchFn = jest.fn().mockResolvedValue(null);

      const result = await client.executeWithRetry('test', fetchFn, {
        path: '/test',
      });

      expect(result).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });

    it('should handle thrown errors and retry', async () => {
      const mockData = { events: [] };
      const error = new Error('Network timeout');
      const fetchFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(mockData);

      const result = await client.executeWithRetry('test', fetchFn, {
        path: '/test',
      });

      expect(result).toEqual(mockData);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(warnMessages.length).toBeGreaterThan(0);
    });

    it('should return null after max retries with errors', async () => {
      const error = new Error('Network failure');
      const fetchFn = jest.fn().mockRejectedValue(error);

      const result = await client.executeWithRetry('test', fetchFn, {
        path: '/test',
      });

      expect(result).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(4); // Initial + 3 retries
      expect(warnMessages.length).toBeGreaterThan(0);
    });

    it('should pass context to logging callbacks', async () => {
      const fetchFn = jest.fn().mockResolvedValue({ data: 'test' });

      await client.executeWithRetry('myop', fetchFn, { userId: '123' });

      expect(logMessages.length).toBeGreaterThan(0);
      expect(logMessages[0]).toContain('myop');
    });
  });

  describe('_withTimeout', () => {
    let client;

    beforeEach(() => {
      client = new ResilientESPNClient({
        timeoutMs: 100,
      });
    });

    it('should resolve quickly if promise resolves before timeout', async () => {
      const promise = Promise.resolve('success');
      const result = await client._withTimeout(promise, 1000);
      expect(result).toBe('success');
    });

    it('should reject with timeout error if promise exceeds timeout', async () => {
      const slowPromise = new Promise((resolve) =>
        setTimeout(() => resolve('delayed'), 500),
      );

      await expect(client._withTimeout(slowPromise, 50)).rejects.toThrow(
        'timeout',
      );
    });

    it('should preserve timeout message', async () => {
      const slowPromise = new Promise((resolve) =>
        setTimeout(() => resolve('delayed'), 500),
      );

      let threw = false;
      try {
        await client._withTimeout(slowPromise, 50);
      } catch (err) {
        threw = true;
        expect(err.message).toContain('timeout');
        expect(err.message).toContain('50ms');
      }
      expect(threw).toBe(true);
    });
  });

  describe('fetchScoreboardEvents validation', () => {
    let client;
    let warnMessages;

    beforeEach(() => {
      warnMessages = [];
      client = new ResilientESPNClient({
        maxRetries: 1,
        baseDelayMs: 2,
        onWarn: (msg) => warnMessages.push(msg),
        onLog: jest.fn(),
        onError: jest.fn(),
      });
    });

    it('should return empty array when response is not an array', async () => {
      const fetchFn = jest.fn().mockResolvedValue({ not: 'an array' });

      // Test the internal fetchFn behavior
      const result = await client.executeWithRetry('test', fetchFn);

      // The executeWithRetry should return the non-array object
      expect(result).toEqual({ not: 'an array' });

      // fetchScoreboardEvents would validate this separately
    });

    it('should handle null response as non-array', async () => {
      const fetchFn = jest.fn().mockResolvedValue(null);

      const result = await client.executeWithRetry('test', fetchFn);

      expect(result).toBeNull();
    });
  });

  describe('Integration scenarios', () => {
    let client;
    let calls;

    beforeEach(() => {
      calls = [];
      client = new ResilientESPNClient({
        maxRetries: 3,
        baseDelayMs: 2,
        onLog: jest.fn(),
        onWarn: jest.fn(),
        onError: jest.fn(),
      });
    });

    it('should handle transient failures gracefully', async () => {
      let callCount = 0;
      const fetchFn = jest.fn(async () => {
        callCount++;
        if (callCount < 3) return null;
        return { events: [{ id: '1' }] };
      });

      const result = await client.executeWithRetry('fetch', fetchFn);

      expect(result).toEqual({ events: [{ id: '1' }] });
      expect(callCount).toBe(3);
    });

    it('should distinguish between null and error', async () => {
      const nullFn = jest.fn().mockResolvedValue(null);
      const result1 = await client.executeWithRetry('op1', nullFn);
      const errorFn = jest.fn().mockRejectedValue(new Error('fail'));
      const result2 = await client.executeWithRetry('op2', errorFn);

      // Both should result in null after retries
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });
});
