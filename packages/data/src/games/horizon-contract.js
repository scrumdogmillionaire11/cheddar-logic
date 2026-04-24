'use strict';
/**
 * MLB Games Visibility Horizon Contract
 *
 * Canonical ET-day-boundary rule: games are visible when their game_time_utc
 * falls on or before the end of the next America/New_York calendar day (23:59:59 ET).
 *
 * Algorithm:
 *   now_et = current time in America/New_York
 *   horizon_end = start of (now_et.date + 2 days) in ET, minus 1 second
 *   horizon_end_utc = convert horizon_end to UTC
 *
 * This replaces all hardcoded hour offsets (36h, 48h) that caused dev/prod drift.
 */

const { DateTime } = require('luxon');

/** @type {string} */
const HORIZON_CONTRACT_VERSION = 'v1-et-boundary-aware';

/**
 * Compute the MLB games visibility horizon end time (ET day boundary).
 *
 * Games are visible when their game_time_utc <= horizon_end_utc.
 * The horizon extends through the end of the next America/New_York calendar day.
 *
 * @param {Date} nowUtc - current time as a JS Date (UTC)
 * @returns {string} ISO-style UTC timestamp (YYYY-MM-DD HH:MM:SS), inclusive horizon end
 */
function computeMLBHorizonEndUtc(nowUtc) {
  const nowET = DateTime.fromJSDate(nowUtc, { zone: 'utc' }).setZone('America/New_York');
  // End of tomorrow ET = start of (today + 2 days) ET minus 1 second
  const tomorrowEnd = nowET.plus({ days: 2 }).startOf('day').minus({ seconds: 1 });
  return tomorrowEnd.toUTC().toISO().substring(0, 19).replace('T', ' ');
}

/**
 * For diagnostics/logging only: approximate hours from now to horizon end.
 * Never use this for query construction — use computeMLBHorizonEndUtc instead.
 *
 * @param {Date} nowUtc - current time as a JS Date (UTC)
 * @returns {number} approximate hours until horizon end
 */
function horizonEndToApproximateHours(nowUtc) {
  const end = computeMLBHorizonEndUtc(nowUtc);
  const endMs = new Date(end.replace(' ', 'T') + 'Z').getTime();
  const nowMs = nowUtc.getTime();
  return Math.round((endMs - nowMs) / (60 * 60 * 1000));
}

module.exports = {
  HORIZON_CONTRACT_VERSION,
  computeMLBHorizonEndUtc,
  horizonEndToApproximateHours,
};
