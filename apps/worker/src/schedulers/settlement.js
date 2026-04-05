'use strict';

/**
 * Settlement Sub-Scheduler
 *
 * Handles settlement and reporting job registrations:
 * - Settlement health report (2.65) — daily 08:00 ET
 * - Public splits (2.7) — hourly 09:00–23:00 ET
 * - VSIN/DK splits (2.75) — hourly 09:00–23:00 ET
 * - Hourly settlement sweep (4A) — first ~5 min of each hour
 * - Nightly backfill + settlement sweep (4B) — 02:00 ET
 * - MLB F5 settlement (4C) — when MLB model enabled
 *
 * Interface:
 *   computeSettlementDueJobs(nowEt, { nowUtc, dryRun, ENABLE_WITHOUT_ODDS_MODE })
 *
 * Note: hasRunningJobName is imported directly from @cheddar-logic/data since
 * settlement singleton checks need DB access at call time.
 */

const {
  isFixedDue,
  keyFixed,
  keySettlementHealthReport,
  keyHourlySettlementSweep,
  keyHourlySettlementJob,
  keyNightlySettlementJob,
  keyNightlySweep,
  keyPublicSplits,
  keyVsinSplits,
  isHourlySettlementDue,
  isNightlySettlementOwningHourlyWindow,
} = require('./windows');

const { hasRunningJobName } = require('@cheddar-logic/data');
const { settleGameResults } = require('../jobs/settle_game_results');
const { settleProjections } = require('../jobs/settle_projections');
const { settlePendingCards } = require('../jobs/settle_pending_cards');
const { syncGameStatuses } = require('../jobs/sync_game_statuses');
const { backfillCardResults } = require('../jobs/backfill_card_results');
const { settleMlbF5 } = require('../jobs/settle_mlb_f5');
const {
  generateSettlementHealthReport: runSettlementHealthReport,
} = require('../jobs/report_settlement_health');
const { runPullPublicSplits } = require('../jobs/pull_public_splits');
const { runPullVsinSplits } = require('../jobs/pull_vsin_splits');

/**
 * Compute due settlement and reporting jobs for this tick
 * @param {DateTime} nowEt - Current ET time
 * @param {object} ctx - Scheduler context
 * @returns {Array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeSettlementDueJobs(nowEt, {
  nowUtc,
  dryRun,
  ENABLE_WITHOUT_ODDS_MODE,
}) {
  const SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL =
    process.env.SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL === 'true';
  const SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL =
    process.env.SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL === 'true';

  const jobs = [];

  // ========== SETTLEMENT HEALTH REPORT (2.65) ==========
  // Daily read-only diagnostic so settlement failures surface in the scheduler flow.
  if (isFixedDue(nowEt, '08:00')) {
    const jobKey = keySettlementHealthReport(nowEt);
    jobs.push({
      jobName: 'report_settlement_health',
      jobKey,
      execute: runSettlementHealthReport,
      args: { jobKey, dryRun },
      reason: 'daily settlement health diagnostic (08:00 ET)',
    });
  }

  // ========== PUBLIC SPLITS (2.7) ==========
  // 60-minute cadence during active hours (09:00–23:00 ET).
  // Fetches Action Network public bet/handle pct and writes to odds_snapshots.
  // Unmatched HIGH-consensus games are flagged as pinnacle_proxy for WI-0667.
  if (nowEt.hour >= 9 && nowEt.hour < 23) {
    const jobKey = keyPublicSplits(nowEt);
    jobs.push({
      jobName: 'pull_public_splits',
      jobKey,
      execute: runPullPublicSplits,
      args: { jobKey, dryRun },
      reason: `hourly public splits (${nowEt.toISODate()} ${nowEt.hour}h)`,
    });
  }

  // ========== VSIN/DK SPLITS (2.75) ==========
  // 60-minute cadence during active hours (09:00–23:00 ET).
  // Fetches DraftKings public bets/handle pct from VSIN and writes dk_* columns.
  // Runs in parallel with pull_public_splits (Action Network) — separate column families.
  if (nowEt.hour >= 9 && nowEt.hour < 23) {
    const jobKey = keyVsinSplits(nowEt);
    jobs.push({
      jobName: 'pull_vsin_splits',
      jobKey,
      execute: runPullVsinSplits,
      args: { jobKey, dryRun },
      reason: `hourly VSIN/DK splits (${nowEt.toISODate()} ${nowEt.hour}h)`,
    });
  }

  // ========== SETTLEMENT (4) ==========
  // Settlement is disabled in Without Odds Mode — cards have no locked prices to settle against.
  if (!ENABLE_WITHOUT_ODDS_MODE && process.env.ENABLE_SETTLEMENT !== 'false') {
    const sweepDate = nowEt.toISODate();
    const nightlySettlementOwnsHourlyWindow =
      isNightlySettlementOwningHourlyWindow(nowEt);

    // Enforce singleton settlement across all processes (race mitigation)
    const settlementGameRunning = hasRunningJobName('settle_game_results');
    const settlementProjectionsRunning = hasRunningJobName('settle_projections');
    const settlementCardsRunning = hasRunningJobName('settle_pending_cards');

    // 4A) Hourly settlement sweep (default enabled)
    if (
      process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP !== 'false' &&
      isHourlySettlementDue(nowEt)
    ) {
      const hourlyKey = keyHourlySettlementSweep(nowEt);

      // Sync game statuses first so road-trip sequence logic (e.g. Welcome Home)
      // has accurate 'final' status before models and settlement run.
      jobs.push({
        jobName: 'sync_game_statuses',
        jobKey: `sync|game-statuses|${hourlyKey}`,
        execute: syncGameStatuses,
        args: { jobKey: `sync|game-statuses|${hourlyKey}`, dryRun },
        reason: `hourly game status sync ${hourlyKey}`,
      });

      if (nightlySettlementOwnsHourlyWindow) {
        console.log(
          '[Scheduler] Skipping hourly settlement enqueue — nightly settlement owns the 02:00 ET window',
        );
      } else if (!settlementGameRunning) {
        const gameResultsJobKey = keyHourlySettlementJob(nowEt, 'game-results');
        jobs.push({
          jobName: 'settle_game_results',
          jobKey: gameResultsJobKey,
          execute: settleGameResults,
          args: { jobKey: gameResultsJobKey, dryRun },
          reason: `hourly settlement sweep ${hourlyKey}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_game_results — already running in another process`,
        );
      }

      if (nightlySettlementOwnsHourlyWindow) {
        // Nightly sweep owns settlement for this minute; keep hourly status sync only.
      } else if (!settlementProjectionsRunning) {
        const projectionsJobKey = keyHourlySettlementJob(nowEt, 'projections');
        jobs.push({
          jobName: 'settle_projections',
          jobKey: projectionsJobKey,
          execute: settleProjections,
          args: { jobKey: projectionsJobKey, dryRun },
          reason: `hourly projection settlement ${hourlyKey}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_projections — already running in another process`,
        );
      }

      if (nightlySettlementOwnsHourlyWindow) {
        // Nightly sweep owns settlement for this minute; keep hourly status sync only.
      } else if (!settlementCardsRunning) {
        const pendingCardsJobKey = keyHourlySettlementJob(nowEt, 'pending-cards');
        jobs.push({
          jobName: 'settle_pending_cards',
          jobKey: pendingCardsJobKey,
          execute: settlePendingCards,
          args: {
            jobKey: pendingCardsJobKey,
            dryRun,
            allowDisplayBackfill: SETTLEMENT_HOURLY_ENABLE_DISPLAY_BACKFILL,
          },
          reason: `hourly card settlement ${hourlyKey}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_pending_cards — already running in another process`,
        );
      }
    }

    // 4B) Nightly backfill + settlement sweep (02:00 ET)
    if (isFixedDue(nowEt, '02:00')) {
      jobs.push({
        jobName: 'backfill_card_results',
        jobKey: `settle|backfill-card-results|${sweepDate}`,
        execute: backfillCardResults,
        args: { jobKey: `settle|backfill-card-results|${sweepDate}`, dryRun },
        reason: `nightly card_results backfill ${sweepDate}`,
      });

      if (!settlementGameRunning) {
        const gameResultsJobKey = keyNightlySettlementJob(nowEt, 'game-results');
        jobs.push({
          jobName: 'settle_game_results',
          jobKey: gameResultsJobKey,
          execute: settleGameResults,
          args: { jobKey: gameResultsJobKey, dryRun },
          reason: `nightly settlement sweep ${sweepDate}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_game_results — already running in another process`,
        );
      }

      if (!settlementProjectionsRunning) {
        const projectionsJobKey = keyNightlySettlementJob(nowEt, 'projections');
        jobs.push({
          jobName: 'settle_projections',
          jobKey: projectionsJobKey,
          execute: settleProjections,
          args: { jobKey: projectionsJobKey, dryRun },
          reason: `nightly projection settlement ${sweepDate}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_projections — already running in another process`,
        );
      }

      if (!settlementCardsRunning) {
        const pendingCardsJobKey = keyNightlySettlementJob(nowEt, 'pending-cards');
        jobs.push({
          jobName: 'settle_pending_cards',
          jobKey: pendingCardsJobKey,
          execute: settlePendingCards,
          args: {
            jobKey: pendingCardsJobKey,
            dryRun,
            allowDisplayBackfill: SETTLEMENT_NIGHTLY_ENABLE_DISPLAY_BACKFILL,
          },
          reason: `nightly card settlement ${sweepDate}`,
        });
      } else {
        console.log(
          `[Scheduler] Skipping settle_pending_cards — already running in another process`,
        );
      }
    }
  }

  // ========== MLB F5 SETTLEMENT (4C) ==========
  if (process.env.ENABLE_MLB_MODEL !== 'false') {
    const f5SettleKey = `settle_mlb_f5|${nowEt.toISODate()}|${nowEt.hour}`;
    jobs.push({
      jobName: 'settle_mlb_f5',
      jobKey: f5SettleKey,
      execute: settleMlbF5,
      args: { jobKey: f5SettleKey, dryRun },
      reason: 'MLB F5 card settlement (post-game)',
    });
  }

  return jobs;
}

module.exports = { computeSettlementDueJobs };
