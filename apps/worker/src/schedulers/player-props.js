/**
 * Player Props Scheduler — projection-only support jobs
 *
 * Architecture note
 * -----------------
 * This module owns non-odds prep plus projection-only NHL player-prop model
 * scheduling. It is intentionally isolated from the game-time window scheduler
 * in schedulers/main.js (which handles T-120/T-90/T-60/T-30 for game-level
 * betting models).
 *
 * Cadence model
 * -------------
 * 09:00 ET (heavy ingest window):
 *   NHL: sync_nhl_sog_player_ids → pull_nhl_player_shots → [BLK chain] → run_nhl_player_shots_model
 *   MLB: pull_mlb_pitcher_stats → pull_mlb_weather
 *
 * 15:00 ET:
 *   NHL: run_nhl_player_shots_model
 *
 * T-60 per game:
 *   NHL: run_nhl_player_shots_model
 *
 * T-120, T-90, T-30: NO player-prop jobs — only T-60 band fires.
 *
 * Key format
 * ----------
 * player_props|nhl|fixed|YYYY-MM-DD|HH:MM          — fixed-time NHL window
 * player_props|nhl|tminus|<game_id>|T60             — T-60 NHL game
 * player_props|nhl_blk_ingest|daily|YYYY-MM-DD      — BLK ingest daily key
 * player_props|mlb|fixed|YYYY-MM-DD|HH:MM           — fixed-time MLB window
 * player_props|mlb|tminus|<game_id>|T60             — T-60 MLB game
 *
 * env vars
 * --------
 * ENABLE_PLAYER_PROPS_SCHEDULER  — set to "false" to disable entire scheduler
 * ENABLE_NHL_BLK_INGEST          — set to "false" to suppress the three BLK jobs only
 * PLAYER_PROPS_FIXED_TIMES_ET    — comma-separated HH:MM times (default "09:00,15:00")
 * FIXED_CATCHUP                  — set to "false" for strict 2×TICK_MS window (default: true)
 * TICK_MS                        — scheduler tick interval in ms (default: 60000)
 */

'use strict';

require('dotenv').config();

const { DateTime } = require('luxon');

// ─── Job imports ─────────────────────────────────────────────────────────────

const { syncNhlSogPlayerIds } = require('../jobs/sync_nhl_sog_player_ids');
const { pullNhlPlayerShots } = require('../jobs/pull_nhl_player_shots');
const { syncNhlBlkPlayerIds } = require('../jobs/sync_nhl_blk_player_ids');
const { pullNhlPlayerBlk } = require('../jobs/pull_nhl_player_blk');
const { ingestNstBlkRates } = require('../jobs/ingest_nst_blk_rates');
const { pullNstBlkRates } = require('../jobs/pull_nst_blk_rates');
const { pullMoneyPuckBlkRates } = require('../jobs/pull_moneypuck_blk_rates');
const { runNHLPlayerShotsModel } = require('../jobs/run_nhl_player_shots_model');
const { pullMlbPitcherStats } = require('../jobs/pull_mlb_pitcher_stats');
const { pullMlbWeather } = require('../jobs/pull_mlb_weather');
const { pullMlbStatcast } = require('../jobs/pull_mlb_statcast');

const { isFixedDue } = require('./windows');
const { isTminusDue } = require('./utils');
const { isFeatureEnabled } = require('@cheddar-logic/data/src/feature-flags');

// ─── Config helpers ───────────────────────────────────────────────────────────

/**
 * Parse PLAYER_PROPS_FIXED_TIMES_ET env var.
 * Defaults to ["09:00", "15:00"] if unset or unparseable.
 *
 * @returns {string[]} Array of "HH:MM" strings
 */
function getPlayerPropsFixedTimes() {
  const env = process.env.PLAYER_PROPS_FIXED_TIMES_ET;
  if (env) {
    const parsed = env
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{2}:\d{2}$/.test(s));
    if (parsed.length > 0) return parsed;
  }
  return ['09:00', '15:00'];
}

// ─── Key builders ─────────────────────────────────────────────────────────────

/**
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} hhmm    - HH:MM
 * @returns {string}
 */
function keyNhlFixed(dateStr, hhmm) {
  return `player_props|nhl|fixed|${dateStr}|${hhmm}`;
}

/**
 * @param {string} gameId
 * @returns {string}
 */
function keyNhlTminus(gameId) {
  return `player_props|nhl|tminus|${gameId}|T60`;
}

/**
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
function keyNhlBlkIngest(dateStr) {
  return `player_props|nhl_blk_ingest|daily|${dateStr}`;
}

/**
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} hhmm    - HH:MM
 * @returns {string}
 */
function keyMlbFixed(dateStr, hhmm) {
  return `player_props|mlb|fixed|${dateStr}|${hhmm}`;
}

/**
 * @param {string} gameId
 * @returns {string}
 */
function keyMlbTminus(gameId) {
  return `player_props|mlb|tminus|${gameId}|T60`;
}

/**
 * Weekly NST BLK rates pull key.
 * Keyed to ISO week (YYYY-WNN) so the job is idempotent within a calendar week.
 *
 * @param {DateTime} nowEt
 * @returns {string}
 */
function keyNstBlkRatesWeekly(nowEt) {
  const week = String(nowEt.weekNumber).padStart(2, '0');
  return `player_props|nst_blk_rates|weekly|${nowEt.year}-W${week}`;
}

/**
 * Weekly MoneyPuck BLK rates pull key.
 * Keyed to ISO week so the job is idempotent within a calendar week.
 *
 * @param {DateTime} nowEt
 * @returns {string}
 */
function keyMoneyPuckBlkRatesWeekly(nowEt) {
  const week = String(nowEt.weekNumber).padStart(2, '0');
  return `player_props|moneypuck_blk_rates|weekly|${nowEt.year}-W${week}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute player-prop jobs that are due for the current tick.
 *
 * Pure function — no DB calls, no side effects.
 * Returns job specs consumed by main.js#computeDueJobs in the same format:
 *   { jobName, jobKey, execute, args, reason }
 *
 * @param {DateTime} nowEt - Current ET time
 * @param {object}  [opts]
 * @param {Array}   [opts.games=[]]    - Upcoming games from DB
 * @param {boolean} [opts.dryRun=false]
 * @param {'FULL'|'MEDIUM'|'LOW'|'CRITICAL'} [opts.quotaTier='FULL']
 * @returns {Array<{jobName: string, jobKey: string, execute: Function, args: object, reason: string}>}
 */
function computePlayerPropsDueJobs(
  nowEt,
  { games = [], dryRun = false, quotaTier = 'FULL' } = {},
) {
  if (!isFeatureEnabled('internal', 'player-props-scheduler')) return [];

  const nowUtc = nowEt.toUTC();
  const dateStr = nowEt.toISODate();
  const fixedTimes = getPlayerPropsFixedTimes();
  const blkEnabled = isFeatureEnabled('nhl', 'blk-ingest');
  const mpBlkEnabled = blkEnabled && isFeatureEnabled('nhl', 'moneypuck-blk');
  const mlbFixedRefreshAllowed = quotaTier === 'FULL' || quotaTier === 'MEDIUM';
  const jobs = [];

  // ── Weekly BLK rates pulls (Monday 09:00 ET) ────────────────────────────
  // Two complementary sources — both run weekly on Monday so data refreshes
  // after weekend game activity.  Both are idempotent within the ISO week.
  //
  // pull_nst_blk_rates: NST CSV export (requires NHL_BLK_NST_*_CSV_URL env vars;
  //   warns and returns cleanly when URLs are unset).
  // pull_moneypuck_blk_rates: MoneyPuck season-summary CSV (no env vars needed;
  //   URL is derived from the calendar date and updated nightly).
  if (blkEnabled && nowEt.weekday === 1 && isFixedDue(nowEt, '09:00')) {
    const nstBlkKey = keyNstBlkRatesWeekly(nowEt);
    jobs.push({
      jobName: 'pull_nst_blk_rates',
      jobKey: nstBlkKey,
      execute: pullNstBlkRates,
      args: { jobKey: nstBlkKey, dryRun },
      reason: `weekly NST BLK rates pull (Monday 09:00 ET, week ${nowEt.year}-W${String(nowEt.weekNumber).padStart(2, '0')})`,
    });

    const mpBlkKey = keyMoneyPuckBlkRatesWeekly(nowEt);
    if (mpBlkEnabled) {
      jobs.push({
        jobName: 'pull_moneypuck_blk_rates',
        jobKey: mpBlkKey,
        execute: pullMoneyPuckBlkRates,
        args: { jobKey: mpBlkKey, dryRun },
        reason: `weekly MoneyPuck BLK rates pull (Monday 09:00 ET, week ${nowEt.year}-W${String(nowEt.weekNumber).padStart(2, '0')})`,
      });
    }
  }

  // ── Fixed-time windows ────────────────────────────────────────────────────
  for (const hhmm of fixedTimes) {
    if (!isFixedDue(nowEt, hhmm)) continue;

    const isHeavyWindow = hhmm === fixedTimes[0]; // first window is heavy-ingest (09:00 by default)

    // NHL fixed window
    // Heavy (09:00): sync SOG player IDs + pull SOG logs + optional BLK chain + shots model
    // Light (18:00+): shots prop + model only
    if (isHeavyWindow) {
      // SOG player sync — gated on canonical feature flag, same contract as nhl.js
      if (isFeatureEnabled('nhl', 'sog-sync')) {
        const sogSyncKey = keyNhlFixed(dateStr, hhmm);
        jobs.push({
          jobName: 'sync_nhl_sog_player_ids',
          jobKey: sogSyncKey,
          execute: syncNhlSogPlayerIds,
          args: { jobKey: sogSyncKey, dryRun },
          reason: `player-props heavy ingest NHL SOG player sync (${hhmm} ET)`,
        });
      }

      const sogPullKey = `${keyNhlFixed(dateStr, hhmm)}|shots_pull`;
      jobs.push({
        jobName: 'pull_nhl_player_shots',
        jobKey: sogPullKey,
        execute: pullNhlPlayerShots,
        args: { jobKey: sogPullKey, dryRun },
        reason: `player-props heavy ingest NHL SOG log pull (${hhmm} ET)`,
      });

      // BLK ingest chain — suppressible via ENABLE_NHL_BLK_INGEST=false
      if (blkEnabled) {
        const blkKey = keyNhlBlkIngest(dateStr);
        jobs.push({
          jobName: 'sync_nhl_blk_player_ids',
          jobKey: blkKey,
          execute: syncNhlBlkPlayerIds,
          args: { jobKey: blkKey, dryRun },
          reason: `player-props daily NHL BLK player sync (${hhmm} ET)`,
        });
        const blkPullKey = `${blkKey}|pull`;
        jobs.push({
          jobName: 'pull_nhl_player_blk',
          jobKey: blkPullKey,
          execute: pullNhlPlayerBlk,
          args: { jobKey: blkPullKey, dryRun },
          reason: `player-props daily NHL BLK stats pull (${hhmm} ET)`,
        });
        const blkIngestKey = `${blkKey}|ingest`;
        jobs.push({
          jobName: 'ingest_nst_blk_rates',
          jobKey: blkIngestKey,
          execute: ingestNstBlkRates,
          args: { jobKey: blkIngestKey, dryRun },
          reason: `player-props daily NST BLK rate ingest (${hhmm} ET)`,
        });
      }
    }

    // NHL projection-only model — runs at every fixed window
    {
      const nhlModelKey = `${keyNhlFixed(dateStr, hhmm)}|shots_model`;
      jobs.push({
        jobName: 'run_nhl_player_shots_model',
        jobKey: nhlModelKey,
        execute: runNHLPlayerShotsModel,
        args: { jobKey: nhlModelKey, dryRun },
        reason: `player-props NHL shots model (${hhmm} ET)`,
      });
    }

    // MLB fixed window
    // Heavy (09:00): non-odds prep only.
    if (isHeavyWindow && mlbFixedRefreshAllowed) {
      const mlbStatsKey = `${keyMlbFixed(dateStr, hhmm)}|pitcher_stats`;
      jobs.push({
        jobName: 'pull_mlb_pitcher_stats',
        jobKey: mlbStatsKey,
        execute: pullMlbPitcherStats,
        args: { jobKey: mlbStatsKey, dryRun },
        reason: `player-props daily MLB pitcher stats refresh (${hhmm} ET)`,
      });
      const mlbStatcastKey = `${keyMlbFixed(dateStr, hhmm)}|statcast`;
      jobs.push({
        jobName: 'pull_mlb_statcast',
        jobKey: mlbStatcastKey,
        execute: pullMlbStatcast,
        args: { jobKey: mlbStatcastKey, dryRun },
        reason: `player-props daily MLB Statcast velo/whiff% refresh (${hhmm} ET)`,
      });
      const mlbWeatherKey = `${keyMlbFixed(dateStr, hhmm)}|weather`;
      jobs.push({
        jobName: 'pull_mlb_weather',
        jobKey: mlbWeatherKey,
        execute: pullMlbWeather,
        args: { jobKey: mlbWeatherKey, dryRun },
        reason: `player-props daily MLB weather overlay (${hhmm} ET)`,
      });
      continue;
    }
  }

  // ── T-60 per game ─────────────────────────────────────────────────────────
  // Only T-60 (55–60 min band) fires. T-120, T-90, T-30 are explicitly excluded.
  for (const g of games) {
    const sport = String(g.sport).toLowerCase();
    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });

    if (!isTminusDue(nowUtc, startUtc)) continue;

    if (sport === 'nhl') {
      const nhlKey = keyNhlTminus(g.game_id);
      const nhlModelT60 = `${nhlKey}|shots_model`;
      jobs.push({
        jobName: 'run_nhl_player_shots_model',
        jobKey: nhlModelT60,
        execute: runNHLPlayerShotsModel,
        args: { jobKey: nhlModelT60, dryRun },
        reason: `player-props NHL shots model T-60 (${g.game_id})`,
      });
    }
  }

  return jobs;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  computePlayerPropsDueJobs,
  keyNhlFixed,
  keyNhlTminus,
  keyNhlBlkIngest,
  keyMlbFixed,
  keyMlbTminus,
  keyNstBlkRatesWeekly,
  keyMoneyPuckBlkRatesWeekly,
};
