'use strict';

/**
 * Detect whether a game is in the T-60 window (55–60 minutes before start).
 * Player props only fire at T-60. T-120, T-90, T-30 are intentionally excluded.
 *
 * @param {DateTime} nowUtc   - Current UTC time
 * @param {DateTime} startUtc - Game start UTC time
 * @returns {boolean}
 */
function isTminusDue(nowUtc, startUtc) {
  const delta = Math.floor(startUtc.diff(nowUtc, 'minutes').minutes);
  return delta >= 55 && delta <= 60;
}

module.exports = { isTminusDue };
