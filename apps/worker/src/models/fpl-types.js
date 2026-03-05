/**
 * FPL Dual-Engine Contract - Worker Types
 *
 * These types define the contract between:
 * - Worker JS (this service)
 * - Sage Python (source of truth)
 */

/**
 * @typedef {Object} FPLPlayerPrediction
 * @property {number} player_id - FPL player ID
 * @property {number} predicted_points - Expected points in next GW
 * @property {number} confidence - 0-1 confidence score
 * @property {string} model_version - Sage model version that generated this
 * @property {string} timestamp - ISO8601 when prediction was generated
 */

/**
 * Fetch player predictions from Sage
 * @param {number} playerId - FPL player ID
 * @returns {Promise<FPLPlayerPrediction>}
 */
async function getSagePrediction(playerId) {
  // TODO: Implement call to Sage API
  throw new Error('getSagePrediction not yet implemented');
}

/**
 * Validate prediction matches schema
 * @param {FPLPlayerPrediction} prediction
 * @returns {boolean}
 */
function validatePredictionSchema(prediction) {
  return (
    typeof prediction.player_id === 'number' &&
    typeof prediction.predicted_points === 'number' &&
    typeof prediction.confidence === 'number' &&
    typeof prediction.model_version === 'string' &&
    typeof prediction.timestamp === 'string'
  );
}

module.exports = {
  getSagePrediction,
  validatePredictionSchema,
};
