const { getDatabase } = require('./connection');

/**
 * Delete model outputs for a game + model combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @returns {number} Count of deleted rows
 */
function deleteModelOutputsByGame(gameId, modelName) {
  return deleteModelOutputsForGame(gameId, modelName);
}

/**
 * Insert a model output (inference result)
 * @param {object} output - Model output data
 * @param {string} output.id - Unique ID
 * @param {string} output.gameId - Game ID
 * @param {string} output.sport - Sport name
 * @param {string} output.modelName - Model name (e.g., 'nhl-model-v1')
 * @param {string} output.modelVersion - Version string
 * @param {string} output.predictionType - Type of prediction (e.g., 'moneyline', 'spread', 'total')
 * @param {string} output.predictedAt - ISO 8601 timestamp
 * @param {number} output.confidence - Confidence score (0-1)
 * @param {object} output.outputData - Full inference output (will be stringified)
 * @param {string} output.oddsSnapshotId - Optional reference to odds_snapshot
 * @param {string} output.jobRunId - Optional reference to job_run
 */
function insertModelOutput(output) {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO model_outputs (
      id, game_id, sport, model_name, model_version, prediction_type,
      predicted_at, confidence, output_data, odds_snapshot_id, job_run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    output.id,
    output.gameId,
    output.sport,
    output.modelName,
    output.modelVersion,
    output.predictionType,
    output.predictedAt,
    output.confidence || null,
    output.outputData ? JSON.stringify(output.outputData) : '{}',
    output.oddsSnapshotId || null,
    output.jobRunId || null
  );
}

/**
 * Get latest model output for a game + model combo
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @returns {object|null} Model output or null
 */
function getLatestModelOutput(gameId, modelName) {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM model_outputs
    WHERE game_id = ? AND model_name = ?
    ORDER BY predicted_at DESC
    LIMIT 1
  `);

  return stmt.get(gameId, modelName) || null;
}

/**
 * Get all model outputs for a game
 * @param {string} gameId - Game ID
 * @returns {array} Model outputs
 */
function getModelOutputs(gameId) {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM model_outputs
    WHERE game_id = ?
    ORDER BY model_name, predicted_at DESC
  `);

  return stmt.all(gameId);
}

// Read surface: called by GET /api/model-outputs in web/src/app/api/model-outputs/route.ts
/**
 * Get model outputs for a sport since a given time
 * @param {string} sport - Sport name
 * @param {string} sinceUtc - ISO 8601 timestamp
 * @returns {array} Model outputs
 */
function getModelOutputsBySport(sport, sinceUtc) {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM model_outputs
    WHERE sport = ? AND predicted_at >= ?
    ORDER BY game_id, model_name, predicted_at DESC
  `);

  return stmt.all(sport, sinceUtc);
}

/**
 * Delete model outputs for a game + model combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @returns {number} Count of deleted rows
 */
function deleteModelOutputsForGame(gameId, modelName) {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM model_outputs
    WHERE game_id = ? AND model_name = ?
  `);

  const result = stmt.run(gameId, modelName);
  return result.changes;
}

module.exports = {
  insertModelOutput,
  deleteModelOutputsByGame,
  deleteModelOutputsForGame,
  getLatestModelOutput,
  getModelOutputs,
  getModelOutputsBySport,
};
