/**
 * @cheddar-logic/data
 * 
 * Entry point for data package
 * Exports database client and migration utilities
 * 
 * DUAL-DATABASE MODE (recommended for prod):
 *   - Record DB: shared reference data (read-only)
 *   - Local DB: environment-specific state (writable)
 *   Usage: await require('.').initDualDb({ recordDbPath, localDbPath })
 * 
 * SINGLE-DATABASE MODE (legacy, default):
 *   - Single DB for all data
 *   Usage: await require('.').initDb()
 */

const db = require('./src/db');
const dbDualInit = require('./src/db-dual-init');
const { runMigrations } = require('./src/migrate');
const { withDb } = require('./src/job-runtime');
const auth = require('./src/auth');
const { validateCardPayload } = require('./src/validators/card-payload');
const { getTeamMetrics, getTeamMetricsWithGames, computeMetricsFromGames } = require('./src/team-metrics');
const { enrichOddsSnapshotWithEspnMetrics, enrichOddsSnapshotsWithEspnMetrics } = require('./src/odds-enrichment');
const marketContract = require('./src/market-contract');
const dbPath = require('./src/db-path');
const dbTelemetry = require('./src/db-telemetry');

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
  getDatabaseReadOnly: db.getDatabaseReadOnly,
  closeDatabase: db.closeDatabase,
  closeDatabaseReadOnly: db.closeDatabaseReadOnly,
  closeReadOnlyInstance: db.closeReadOnlyInstance,
  checkSqliteIntegrity: db.checkSqliteIntegrity,
  getCurrentRunId: db.getCurrentRunId,
  setCurrentRunId: db.setCurrentRunId,
  insertJobRun: db.insertJobRun,
  markJobRunSuccess: db.markJobRunSuccess,
  markJobRunFailure: db.markJobRunFailure,
  getJobRunHistory: db.getJobRunHistory,
  wasJobRecentlySuccessful: db.wasJobRecentlySuccessful,
  hasSuccessfulJobRun: db.hasSuccessfulJobRun,
  hasRunningJobRun: db.hasRunningJobRun,
  hasRunningJobName: db.hasRunningJobName,
  shouldRunJobKey: db.shouldRunJobKey,
  getLatestJobRunByKey: db.getLatestJobRunByKey,
  wasJobKeyRecentlySuccessful: db.wasJobKeyRecentlySuccessful,
  
  // Convenience exports - odds_snapshots
  insertOddsSnapshot: db.insertOddsSnapshot,
  updateOddsSnapshotRawData: db.updateOddsSnapshotRawData,
  deleteOddsSnapshotsByGameAndCapturedAt: db.deleteOddsSnapshotsByGameAndCapturedAt,
  prepareOddsSnapshotWrite: db.prepareOddsSnapshotWrite,
  getLatestOdds: db.getLatestOdds,
  getOddsSnapshots: db.getOddsSnapshots,
  getOddsWithUpcomingGames: db.getOddsWithUpcomingGames,
  recordOddsIngestFailure: db.recordOddsIngestFailure,
  getOddsIngestFailureSummary: db.getOddsIngestFailureSummary,
  upsertPlayerShotLog: db.upsertPlayerShotLog,
  getPlayerShotLogs: db.getPlayerShotLogs,
  upsertTrackedPlayer: db.upsertTrackedPlayer,
  listTrackedPlayers: db.listTrackedPlayers,
  deactivateTrackedPlayersNotInSet: db.deactivateTrackedPlayersNotInSet,
  upsertPlayerAvailability: db.upsertPlayerAvailability,
  getPlayerAvailability: db.getPlayerAvailability,
  upsertPlayerPropLine: db.upsertPlayerPropLine,
  getPlayerPropLine: db.getPlayerPropLine,
  getPlayerPropLinesForGame: db.getPlayerPropLinesForGame,
  
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
  getDecisionRecord: db.getDecisionRecord,
  upsertDecisionRecord: db.upsertDecisionRecord,
  updateDecisionCandidateTracking: db.updateDecisionCandidateTracking,
  insertDecisionEvent: db.insertDecisionEvent,

  // Convenience exports - games
  getUpcomingGames: db.getUpcomingGames,
  upsertGame: db.upsertGame,
  upsertGameIdMap: db.upsertGameIdMap,

  // Convenience exports - game_results (settlement)
  upsertGameResult: db.upsertGameResult,
  getGameResult: db.getGameResult,
  getGameResults: db.getGameResults,

  // Convenience exports - tracking_stats (analytics)
  upsertTrackingStat: db.upsertTrackingStat,
  incrementTrackingStat: db.incrementTrackingStat,
  getTrackingStats: db.getTrackingStats,

  // Convenience exports - team_metrics_cache
  getTeamMetricsCache: db.getTeamMetricsCache,
  upsertTeamMetricsCache: db.upsertTeamMetricsCache,
  deleteStaleTeamMetricsCache: db.deleteStaleTeamMetricsCache,

  // Validation
  validateCardPayload,

  // Auth + entitlement helpers
  USER_ROLE: auth.USER_ROLE,
  USER_STATUS: auth.USER_STATUS,
  SUBSCRIPTION_STATUS: auth.SUBSCRIPTION_STATUS,
  RESOURCE: auth.RESOURCE,
  normalizeEmail: auth.normalizeEmail,
  hashTokenHmac: auth.hashTokenHmac,
  timingSafeEqualHex: auth.timingSafeEqualHex,
  randomToken: auth.randomToken,
  addMsIso: auth.addMsIso,
  parseFlags: auth.parseFlags,
  hasEntitlement: auth.hasEntitlement,
  createAccessToken: auth.createAccessToken,
  verifySignedPayload: auth.verifySignedPayload,

  // ESPN team metrics
  getTeamMetrics,
  getTeamMetricsWithGames,
  computeMetricsFromGames,

  // Odds enrichment
  enrichOddsSnapshotWithEspnMetrics,
  enrichOddsSnapshotsWithEspnMetrics,

  // Market contract
  CANONICAL_MARKET_TYPES: marketContract.CANONICAL_MARKET_TYPES,
  LOCKABLE_SELECTIONS: marketContract.LOCKABLE_SELECTIONS,
  buildMarketKey: marketContract.buildMarketKey,
  createMarketError: marketContract.createMarketError,
  deriveLockedMarketContext: marketContract.deriveLockedMarketContext,
  formatMarketSelectionLabel: marketContract.formatMarketSelectionLabel,
  normalizeMarketType: marketContract.normalizeMarketType,
  normalizeSelectionForMarket: marketContract.normalizeSelectionForMarket,
  parseAmericanOdds: marketContract.parseAmericanOdds,
  parseLine: marketContract.parseLine,
  resolveLockedPrice: marketContract.resolveLockedPrice,
  toRecommendedBetType: marketContract.toRecommendedBetType,

  // DB path contract
  DEFAULT_DATABASE_PATH: dbPath.DEFAULT_DATABASE_PATH,
  parseSqliteUrl: dbPath.parseSqliteUrl,
  resolveDatabasePath: dbPath.resolveDatabasePath,

  // Additive telemetry (flag-gated, default-off)
  recordClvEntry: dbTelemetry.recordClvEntry,
  settleClvEntry: dbTelemetry.settleClvEntry,
  recordProjectionEntry: dbTelemetry.recordProjectionEntry,
  settleProjectionEntry: dbTelemetry.settleProjectionEntry,

  // Token quota ledger
  getQuotaLedger: db.getQuotaLedger,
  upsertQuotaLedger: db.upsertQuotaLedger,
  isQuotaCircuitOpen: db.isQuotaCircuitOpen,

  // T-minus pull dedup log
  claimTminusPullSlot: db.claimTminusPullSlot,
  purgeStaleTminusPullLog: db.purgeStaleTminusPullLog,

  // Line delta utility
  computeLineDelta: db.computeLineDelta,

  // Dual-database mode (recommended for production)
  initDualDb: dbDualInit.initDualDb,
  closeDualDb: dbDualInit.closeDualDb,
  isDualModeActive: dbDualInit.isDualModeActive,
  getDualDb: dbDualInit.getDb,
  RECORD_TABLES: dbDualInit.RECORD_TABLES,
  LOCAL_TABLES: dbDualInit.LOCAL_TABLES,
};
