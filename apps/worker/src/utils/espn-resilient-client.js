/**
 * Resilient ESPN API Client
 *
 * Wraps the basic ESPN client with:
 * - Exponential backoff retry logic (configurable)
 * - Timeout enforcement (30s default, configurable)
 * - Response validation (non-null, JSON structure)
 * - Rate-limit detection (429 backoff)
 * - Structured logging for observability
 *
 * Usage:
 *   const client = new ResilientESPNClient({
 *     maxRetries: 3,
 *     timeoutMs: 30000,
 *     baseDelayMs: 1000,
 *   });
 *   const events = await client.fetchScoreboardEvents('hockey/nhl', '20260304');
 */

'use strict';

const {
  espnGet,
  fetchScoreboardEvents,
} = require('../../../../packages/data/src/espn-client');

/**
 * Exponential backoff with jitter
 * @param {number} attempt - 0-indexed retry attempt
 * @param {number} baseDelayMs - base delay in milliseconds
 * @returns {number} delay in milliseconds
 */
function exponentialBackoffDelay(attempt, baseDelayMs = 1000) {
  const exponential = Math.pow(2, attempt);
  const jitter = Math.random() * 0.1; // ±10% jitter
  return baseDelayMs * exponential * (1 + jitter);
}

/**
 * Sleep for N milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ResilientESPNClient {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.onLog = options.onLog ?? console.log; // Configurable logger
    this.onWarn = options.onWarn ?? console.warn;
    this.onError = options.onError ?? console.error;
    this.monitor = options.monitor ?? null; // Optional monitoring integration
  }

  /**
   * Execute a fetch function with retry logic
   * @param {string} label - For logging (e.g., "fetch_scoreboard_nhl")
   * @param {Function} fetchFn - Async function that returns data or throws
   * @param {object} context - Log context (espnPath, dateStr, etc.)
   * @returns {Promise<object|null>}
   */
  async executeWithRetry(label, fetchFn, context = {}) {
    let lastError = null;
    let lastResponse = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.onLog(
          `[ESPNClient:${label}] Attempt ${attempt + 1}/${this.maxRetries + 1}`,
          context,
        );

        // Track in monitor
        if (this.monitor) {
          this.monitor.recordESPNAttempt(label, attempt > 0, attempt - 1);
        }

        // Set up a timeout wrapper (since basic client has 5s hardcoded)
        const response = await this._withTimeout(fetchFn(), this.timeoutMs);

        // Validate response structure
        if (response === null) {
          lastResponse = null;
          if (attempt < this.maxRetries) {
            const delayMs = exponentialBackoffDelay(attempt, this.baseDelayMs);
            this.onWarn(
              `[ESPNClient:${label}] Null response, retrying in ${delayMs}ms`,
              context,
            );
            await sleep(delayMs);
            continue;
          }
          break;
        }

        // Success
        this.onLog(`[ESPNClient:${label}] Success on attempt ${attempt + 1}`, {
          ...context,
          responseKeys: Object.keys(response),
        });

        // Track success in monitor
        if (this.monitor) {
          const resultCount = Array.isArray(response) ? response.length : 1;
          this.monitor.recordESPNSuccess(label, resultCount);
        }

        return response;
      } catch (err) {
        lastError = err;

        // Detect rate limit (429)
        const isRateLimit = err.code === 429 || err.statusCode === 429;
        const delayMs = isRateLimit
          ? Math.min(
              60000,
              exponentialBackoffDelay(attempt + 1, this.baseDelayMs),
            ) // Cap at 60s for rate limit
          : exponentialBackoffDelay(attempt, this.baseDelayMs);

        if (attempt < this.maxRetries) {
          const reason = isRateLimit
            ? 'rate_limited'
            : err.code || 'unknown_error';
          this.onWarn(
            `[ESPNClient:${label}] Error (${reason}), retrying in ${delayMs}ms`,
            {
              ...context,
              attempt,
              error: err.message,
              code: err.code,
            },
          );
          await sleep(delayMs);
        } else {
          this.onError(
            `[ESPNClient:${label}] Failed after ${this.maxRetries + 1} attempts`,
            {
              ...context,
              attempt,
              error: err.message,
              code: err.code,
            },
          );

          // Track final failure in monitor
          if (this.monitor) {
            this.monitor.recordESPNFailure(label, err, this.maxRetries);
          }
        }
      }
    }

    // All retries exhausted
    if (lastError && this.monitor && !lastResponse) {
      // Only record if not already recorded above
      if (lastError) {
        this.monitor.recordESPNFailure(label, lastError, this.maxRetries);
      }
    }
    if (lastError) {
      return null; // Return null (same as basic client) but with full logging
    }
    return lastResponse || null;
  }

  /**
   * Timeout wrapper for promises
   * @param {Promise} promise
   * @param {number} timeoutMs
   * @returns {Promise}
   */
  _withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`ESPN API timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Fetch scoreboard events with resilience
   * @param {string} espnPath - e.g. "hockey/nhl"
   * @param {string} dateStr - YYYYMMDD or null
   * @param {object} options - Query options
   * @returns {Promise<Array>}
   */
  async fetchScoreboardEvents(espnPath, dateStr = null, options = null) {
    const context = { espnPath, dateStr, options };

    const result = await this.executeWithRetry(
      'scoreboard',
      () => fetchScoreboardEvents(espnPath, dateStr, options),
      context,
    );

    // Validate result is an array
    if (!Array.isArray(result)) {
      this.onWarn('[ESPNClient:scoreboard] Response was not an array', {
        ...context,
        result,
      });
      return [];
    }

    return result;
  }

  /**
   * Fetch ESPN data with resilience
   * @param {string} path
   * @returns {Promise<object|null>}
   */
  async fetch(path) {
    const context = { path };

    const result = await this.executeWithRetry(
      'fetch',
      () => espnGet(path),
      context,
    );

    return result;
  }
}

module.exports = { ResilientESPNClient, exponentialBackoffDelay };
