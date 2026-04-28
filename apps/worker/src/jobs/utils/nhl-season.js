'use strict';

/**
 * Derive NHL season start year from a timestamp.
 * NHL season starts in October and rolls over during September.
 *
 * @param {Date} [now]
 * @returns {number}
 */
function deriveSeasonStartYear(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return month >= 8 ? year : year - 1;
}

/**
 * Derive NHL season key used in data tables, e.g. "20252026".
 *
 * @param {Date} [now]
 * @returns {string}
 */
function deriveNhlSeasonKey(now = new Date()) {
  const start = deriveSeasonStartYear(now);
  return `${start}${start + 1}`;
}

module.exports = {
  deriveSeasonStartYear,
  deriveNhlSeasonKey,
};
