/**
 * FPL Deadline-Based Scheduler
 *
 * Architecture note
 * -----------------
 * FPL uses GAMEWEEK DEADLINES (when transfers lock) as the scheduling axis, not
 * game-start times. A deadline is the moment the FPL API locks team changes for
 * an upcoming gameweek — typically Thursday ~18:30 UK time.
 *
 * This module is intentionally separate from the game-time window scheduler in
 * schedulers/main.js, which operates on T-120/T-90/T-60/T-30 bands relative to
 * match kick-offs. Those bands are meaningless for FPL because:
 *   - Multiple matches span several days per GW
 *   - The model needs to run BEFORE the deadline, not before each game
 *   - Running at kick-off time would produce stale picks (transfers already locked)
 *
 * Window model
 * ------------
 * For each GW deadline we fire the FPL model at configurable offset windows BEFORE
 * the deadline (default: T-48h, T-24h, T-6h). Each offset gets its own idempotency
 * key so re-runs within the same window are skipped by the DB gate in the tick loop.
 *
 * Key format:  fpl|deadline|GW<n>|T<h>h
 * Example:     fpl|deadline|GW34|T48h
 *
 * env vars
 * --------
 * ENABLE_FPL_MODEL          — set to "false" to disable entirely (default: enabled)
 * FPL_WINDOW_OFFSET_HOURS   — comma-separated hours-before-deadline windows
 *                             (default: "48,24,6")
 * FIXED_CATCHUP             — set to "false" for strict 2×TICK_MS window (same as
 *                             main.js isFixedDue). Default: true (fire any time
 *                             after window has passed — safe for catch-up on restart)
 * TICK_MS                   — scheduler tick interval in ms (default: 60000)
 *
 * GW deadlines
 * ------------
 * Hardcoded for season 2025-26 (remaining from 2026-03-28).
 * Deadlines are given in Europe/London local time — Luxon resolves DST automatically.
 * Update FPL_GW_DEADLINES when the following season fixture list is published.
 * Source: officialfpl.com / Premier League fixtures
 */

'use strict';

require('dotenv').config();

const { DateTime } = require('luxon');
const { runFPLModel } = require('../jobs/run_fpl_model');

// ─── Config ──────────────────────────────────────────────────────────────────

const FPL_TZ = 'Europe/London';

/**
 * Remaining GW deadlines for the 2025-26 FPL season.
 * Deadline strings are in Europe/London local time (Luxon handles BST/GMT automatically).
 * GW32–38 listed; GW29-31 already passed by 2026-03-28.
 *
 * @type {Array<{gw: number, deadline: string}>}
 */
const FPL_GW_DEADLINES = [
  { gw: 32, deadline: '2026-04-02T18:30:00' },
  { gw: 33, deadline: '2026-04-09T18:30:00' },
  { gw: 34, deadline: '2026-04-21T17:30:00' },
  { gw: 35, deadline: '2026-04-28T17:30:00' },
  { gw: 36, deadline: '2026-05-05T17:30:00' },
  { gw: 37, deadline: '2026-05-09T10:00:00' }, // double GW midweek
  { gw: 38, deadline: '2026-05-23T14:00:00' }, // final day
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse the FPL_WINDOW_OFFSET_HOURS env var.
 * Falls back to [48, 24, 6] if unset or unparseable.
 *
 * @returns {number[]} sorted descending (earliest window first)
 */
function getFplWindowOffsets() {
  const env = process.env.FPL_WINDOW_OFFSET_HOURS;
  if (env) {
    const parsed = env
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parsed.length > 0) return parsed.sort((a, b) => b - a);
  }
  return [48, 24, 6];
}

/**
 * Build the deterministic idempotency key for a GW / offset-window pair.
 *
 * @param {number} gw - Gameweek number (e.g. 34)
 * @param {number} offsetHours - Hours before the deadline (e.g. 48)
 * @returns {string} e.g. "fpl|deadline|GW34|T48h"
 */
function keyFplDeadline(gw, offsetHours) {
  return `fpl|deadline|GW${gw}|T${offsetHours}h`;
}

/**
 * Determine whether a given offset window is currently due.
 *
 * Mirrors the FIXED_CATCHUP logic in main.js#isFixedDue:
 *   - If FIXED_CATCHUP !== "false" (default): fire any time after the window (safe on restart)
 *   - If FIXED_CATCHUP === "false": only fire within 2×TICK_MS ms of the window
 *
 * @param {DateTime} nowUtc  - Current UTC time
 * @param {DateTime} windowUtc - The window trigger time (deadline minus offset) in UTC
 * @returns {boolean}
 */
function isFplWindowDue(nowUtc, windowUtc) {
  if (nowUtc < windowUtc) return false; // window hasn't opened yet

  const catchupEnabled = process.env.FIXED_CATCHUP !== 'false';
  if (catchupEnabled) return true;

  const tickMs = Number(process.env.TICK_MS || 60_000);
  const msSinceWindow = nowUtc.diff(windowUtc, 'milliseconds').milliseconds;
  return msSinceWindow <= tickMs * 2;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Compute FPL model jobs that are due for the current tick.
 *
 * Pure function — no DB calls, no side effects.
 * Returns job specs consumed by main.js#computeDueJobs in the same format as
 * other sections of that function: { jobName, jobKey, execute, args, reason }.
 *
 * @param {DateTime} nowEt - Current ET time (wall clock reference; UTC derived internally)
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]
 * @returns {Array<{jobName: string, jobKey: string, execute: Function, args: object, reason: string}>}
 */
function computeFplDueJobs(nowEt, { dryRun = false } = {}) {
  if (process.env.ENABLE_FPL_MODEL === 'false') {
    console.log('[FPLSage][FROZEN] FPL Sage model runs are disabled — ENABLE_FPL_MODEL=false. No jobs enqueued.');
    return [];
  }

  const nowUtc = nowEt.toUTC();
  const offsets = getFplWindowOffsets();
  const jobs = [];

  for (const { gw, deadline } of FPL_GW_DEADLINES) {
    const deadlineLocal = DateTime.fromISO(deadline, { zone: FPL_TZ });
    const deadlineUtc = deadlineLocal.toUTC();

    for (const offsetH of offsets) {
      const windowUtc = deadlineUtc.minus({ hours: offsetH });

      if (!isFplWindowDue(nowUtc, windowUtc)) continue;

      const jobKey = keyFplDeadline(gw, offsetH);
      jobs.push({
        jobName: 'run_fpl_model',
        jobKey,
        execute: runFPLModel,
        args: { jobKey, dryRun },
        reason: `FPL GW${gw} deadline T-${offsetH}h (deadline ${deadlineLocal.toISO()})`,
      });
    }
  }

  return jobs;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  computeFplDueJobs,
  keyFplDeadline,
  isFplWindowDue,
  FPL_GW_DEADLINES,
};
