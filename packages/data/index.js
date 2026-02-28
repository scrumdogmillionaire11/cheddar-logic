/**
 * @cheddar-logic/data
 * 
 * Entry point for data package
 * Exports database client and migration utilities
 */

const db = require('./src/db');
const { runMigrations } = require('./src/migrate');
const { withDb } = require('./src/job-runtime');
const { validateCardPayload } = require('./src/validators/card-payload');
const { getTeamMetrics, getTeamMetricsWithGames, computeMetricsFromGames } = require('./src/team-metrics');
const { enrichOddsSnapshotWithEspnMetrics, enrichOddsSnapshotsWithEspnMetrics } = require('./src/odds-enrichment');

// Ensure migrations are run on first import (optional but recommended)
// Uncomment to auto-run migrations:
// runMigrations();

module.exports = {
  // Database client
  db,
  
  // Initialization (MUST be called before any DB operations)
  initDb: db.initDb,
  
  // Migration runner
  runMigrations,
  withDb,
  
  // Convenience exports - job_runs
  getDatabase: db.getDatabase,
  closeDatabase: db.closeDatabase,
  insertJobRun: db.insertJobRun,
  markJobRunSuccess: db.markJobRunSuccess,
  markJobRunFailure: db.markJobRunFailure,
  getJobRunHistory: db.getJobRunHistory,
  wasJobRecentlySuccessful: db.wasJobRecentlySuccessful,
  hasSuccessfulJobRun: db.hasSuccessfulJobRun,
  hasRunningJobRun: db.hasRunningJobRun,
  shouldRunJobKey: db.shouldRunJobKey,
  getLatestJobRunByKey: db.getLatestJobRunByKey,
  wasJobKeyRecentlySuccessful: db.wasJobKeyRecentlySuccessful,
  
  // Convenience exports - odds_snapshots
  insertOddsSnapshot: db.insertOddsSnapshot,
  deleteOddsSnapshotsByGameAndCapturedAt: db.deleteOddsSnapshotsByGameAndCapturedAt,
  prepareOddsSnapshotWrite: db.prepareOddsSnapshotWrite,
  getLatestOdds: db.getLatestOdds,
  getOddsSnapshots: db.getOddsSnapshots,
  getOddsWithUpcomingGames: db.getOddsWithUpcomingGames,
  
  // Convenience exports - model_outputs
  insertModelOutput: db.insertModelOutput,
  deleteModelOutputsByGame: db.deleteModelOutputsByGame,
  deleteModelOutputsForGame: db.deleteModelOutputsForGame,
  getLatestModelOutput: db.getLatestModelOutput,
  getModelOutputs: db.getModelOutputs,
  getModelOutputsBySport: db.getModelOutputsBySport,
  
  // Convenience exports - card_payloads
  insertCardPayload: db.insertCardPayload,
  insertCardResult: db.insertCardResult,
  deleteCardPayloadsByGameAndType: db.deleteCardPayloadsByGameAndType,
  deleteCardPayloadsForGame: db.deleteCardPayloadsForGame,
  prepareModelAndCardWrite: db.prepareModelAndCardWrite,
  getCardPayload: db.getCardPayload,
  getCardPayloads: db.getCardPayloads,
  getCardPayloadsByType: db.getCardPayloadsByType,
  getCardPayloadsBySport: db.getCardPayloadsBySport,
  expireCardPayload: db.expireCardPayload,
  deleteExpiredCards: db.deleteExpiredCards,

  // Convenience exports - games
  getUpcomingGames: db.getUpcomingGames,
  upsertGame: db.upsertGame,

  // Convenience exports - game_results (settlement)
  upsertGameResult: db.upsertGameResult,
  getGameResult: db.getGameResult,
  getGameResults: db.getGameResults,

  // Convenience exports - tracking_stats (analytics)
  upsertTrackingStat: db.upsertTrackingStat,
  getTrackingStats: db.getTrackingStats,

  // Validation
  validateCardPayload,

  // ESPN team metrics
  getTeamMetrics,
  getTeamMetricsWithGames,
  computeMetricsFromGames,

  // Odds enrichment
  enrichOddsSnapshotWithEspnMetrics,
  enrichOddsSnapshotsWithEspnMetrics};