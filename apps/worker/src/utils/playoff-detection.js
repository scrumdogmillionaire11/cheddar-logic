'use strict';

const PLAYOFF_SIGMA_MULTIPLIER = 1.2;
const PLAYOFF_EDGE_MIN_INCREMENT = 0.01;
const PLAYOFF_PACE_WEIGHT_CAP = 0.5;

/**
 * Detect whether an odds snapshot represents a playoff game.
 *
 * Reads raw_data for:
 * - ESPN season type encoding: season.type === 3 means playoffs
 * - gameType === 'P' (alternate encoding from some upstream sources)
 *
 * @param {object|null} oddsSnapshot - normalized odds snapshot (raw_data must be an object)
 * @returns {boolean}
 */
function isPlayoffGame(oddsSnapshot) {
  if (!oddsSnapshot) return false;
  const raw = oddsSnapshot.raw_data;
  if (!raw || typeof raw !== 'object') return false;
  if (raw.season?.type === 3) return true;
  if (raw.gameType === 'P') return true;
  return false;
}

module.exports = {
  isPlayoffGame,
  PLAYOFF_SIGMA_MULTIPLIER,
  PLAYOFF_EDGE_MIN_INCREMENT,
  PLAYOFF_PACE_WEIGHT_CAP,
};
