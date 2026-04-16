/**
 * Scheduler Window Utilities
 *
 * Pure key generators and window predicates shared by all sport sub-schedulers.
 * No DB calls, no side effects. Safe to require from any sub-scheduler module.
 */

'use strict';

/**
 * Job key builders (deterministic identifiers for idempotency)
 */
function keyEspnGamesDirect(nowEt) {
  const ODDS_FETCH_SLOT_MINUTES = Number(process.env.ODDS_FETCH_SLOT_MINUTES || 180);
  const minuteOfDay = nowEt.hour * 60 + nowEt.minute;
  const slot = Math.floor(minuteOfDay / ODDS_FETCH_SLOT_MINUTES);
  return `espn_direct|${nowEt.toISODate()}|s${String(slot).padStart(3, '0')}`;
}

function keyOddsHourly(nowEt) {
  // Slot size is configurable via ODDS_FETCH_SLOT_MINUTES (default 180).
  // Conservative default keeps the main baseline at 09:00/12:00/15:00/18:00/21:00 ET.
  const ODDS_FETCH_SLOT_MINUTES = Number(process.env.ODDS_FETCH_SLOT_MINUTES || 180);
  const minuteOfDay = nowEt.hour * 60 + nowEt.minute;
  const slot = Math.floor(minuteOfDay / ODDS_FETCH_SLOT_MINUTES);
  return `odds|hourly|${nowEt.toISODate()}|s${String(slot).padStart(3, '0')}`;
}

function keyFixed(sport, nowEt, hhmm) {
  return `${sport}|fixed|${nowEt.toISODate()}|${hhmm.replace(':', '')}`;
}

function keyDiscordCardsSnapshot(nowEt, hhmm) {
  return `discord_cards|fixed|${nowEt.toISODate()}|${hhmm.replace(':', '')}`;
}

function keyTminus(sport, gameId, minutes) {
  return `${sport}|tminus|${gameId}|${minutes}`;
}

function keyNightlySweep(nowEt) {
  return `settle|nightly|${nowEt.toISODate()}`;
}

function keyNhlPlayerAvailabilitySync(nowEt) {
  return `sync_nhl_player_availability|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyNbaPlayerAvailabilitySync(nowEt) {
  return `sync_nba_player_availability|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyNhlGoalieStarters(nowEt) {
  return `pull_nhl_goalie_starters|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyNhlSogPlayerSync(nowEt) {
  const hhmm = `${String(nowEt.hour).padStart(2, '0')}${String(nowEt.minute).padStart(2, '0')}`;
  return `sync_nhl_sog_player_ids|${nowEt.toISODate()}|${hhmm}`;
}

function keyNhlTeamStats(nowEt) {
  return `pull_nhl_team_stats|${nowEt.toISODate()}`;
}

function keyPullScheduleNba(nowEt) {
  return `pull_schedule_nba|${nowEt.toISODate()}`;
}

function keyPullScheduleNhl(nowEt) {
  return `pull_schedule_nhl|${nowEt.toISODate()}`;
}

function keySettlementHealthReport(nowEt) {
  return `report_settlement_health|${nowEt.toISODate()}`;
}

function keyHourlySettlementSweep(nowEt) {
  return `settle|hourly|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyPublicSplits(nowEt) {
  return `pull_public_splits|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyVsinSplits(nowEt) {
  return `pull_vsin_splits|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyHourlySettlementJob(nowEt, suffix) {
  return `${keyHourlySettlementSweep(nowEt)}|${suffix}`;
}

function keyNightlySettlementJob(nowEt, suffix) {
  return `${keyNightlySweep(nowEt)}|${suffix}`;
}

function isHourlySettlementDue(nowEt) {
  const boundaryMinutes = Number(
    process.env.SETTLEMENT_HOURLY_BOUNDARY_MINUTES || 5,
  );
  return nowEt.minute >= 0 && nowEt.minute < Math.max(boundaryMinutes, 1);
}

function isNightlySettlementOwningHourlyWindow(nowEt) {
  return nowEt.hour === 2 && isHourlySettlementDue(nowEt);
}

/**
 * Calculate next odds pull interval based on game start time
 * @param {DateTime} nowUtc - Current UTC time
 * @param {DateTime} startUtc - Game start UTC time
 * @returns {number|null} - Minutes until next pull (null if game already started/ended)
 */
function getOddsIntervalMinutes(nowUtc, startUtc) {
  const minsUntilStart = Math.round(startUtc.diff(nowUtc, 'minutes').minutes);

  if (minsUntilStart < -30) return null; // Don't fetch for games >30m past start
  if (minsUntilStart <= 0) return 1; // Live mode: 1-2 min cadence
  if (minsUntilStart <= 30) return 1;
  if (minsUntilStart <= 120) return 2;
  if (minsUntilStart <= 360) return 5;
  if (minsUntilStart <= 1440) return 15;
  if (minsUntilStart <= 3600) return 30;
  return null; // Too far out, skip
}

/**
 * Check if schedule refresh is due based on time window
 * @param {DateTime} nowEt - Current ET time
 * @returns {object|null} - {type, reason} or null
 */
function getScheduleRefreshDue(nowEt) {
  const hour = nowEt.hour;
  const min = nowEt.minute;

  // 04:00 ET — full refresh (covers overnight changes)
  if (hour === 4 && min < 10) {
    return { type: 'full', reason: '04:00 ET daily full refresh' };
  }

  // 11:00 ET — same-day sanity check
  if (hour === 11 && min < 10) {
    return { type: 'sameday', reason: '11:00 ET same-day sanity refresh' };
  }

  // Every 2–4h for next 48h (every 180 min)
  const minsSinceMidnight = nowEt.diff(nowEt.startOf('day'), 'minutes').minutes;
  if (minsSinceMidnight % 180 < 10) {
    return { type: 'targeted', reason: '2–4h rolling window for next 48h' };
  }

  return null;
}

/**
 * Determine if a game needs odds refresh based on time-to-start
 * @param {DateTime} nowUtc - Current time
 * @param {object} game - Game object with game_time_utc
 * @returns {boolean} - Should refresh odds for this game
 */
function shouldRefreshOddsForGame(nowUtc, game) {
  const { DateTime } = require('luxon');
  const startUtc = DateTime.fromISO(game.game_time_utc, { zone: 'utc' });
  const interval = getOddsIntervalMinutes(nowUtc, startUtc);
  if (!interval) return false;

  // For now, check if within refresh window
  const minsUntilStart = Math.round(startUtc.diff(nowUtc, 'minutes').minutes);
  return minsUntilStart > -30; // Pull if game hasn't ended yet
}

/**
 * Check if fixed time window is due
 * Only returns true if:
 * 1) Current time is past the target time AND
 * 2) It's the same calendar day (prevents multi-day catchup)
 * 3) FIXED_CATCHUP is enabled (or we're past the window by more than tick interval)
 */
function isFixedDue(nowEt, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const target = nowEt.set({ hour: h, minute: m, second: 0, millisecond: 0 });

  // Must be same day to prevent yesterday's windows from firing
  const sameDay = nowEt.toISODate() === target.toISODate();
  if (!sameDay) return false;

  // Must be past the target time
  if (nowEt < target) return false;

  // If FIXED_CATCHUP is disabled, only fire if we're within one tick interval
  const catchupEnabled = process.env.FIXED_CATCHUP !== 'false';
  if (!catchupEnabled) {
    const tickMs = Number(process.env.TICK_MS || 60_000);
    const msSinceTarget = nowEt.diff(target, 'milliseconds').milliseconds;
    // Only due if we just crossed the window (within 2x tick interval buffer)
    return msSinceTarget <= tickMs * 2;
  }

  return true;
}

/**
 * @typedef {object} TMinusFreshnessOverride
 * @property {number} minutesToGameLte - Upper bound of minutes-to-game for this band (inclusive)
 * @property {number} requiredMaxSnapshotAgeMinutes - Maximum allowable snapshot age in minutes
 * @property {boolean} triggerPreModelRefresh - Whether to enqueue a pre-model odds pull
 */

/**
 * MLB T-minus freshness override ladder.
 * Ordered ascending by minutesToGameLte so that resolveTMinusFreshnessOverride
 * can find the strictest (smallest) matching band efficiently.
 *
 * @type {TMinusFreshnessOverride[]}
 */
const MLB_TMINUS_FRESHNESS_OVERRIDES = [
  { minutesToGameLte: 180, requiredMaxSnapshotAgeMinutes: 75, triggerPreModelRefresh: false },
  { minutesToGameLte: 90,  requiredMaxSnapshotAgeMinutes: 30, triggerPreModelRefresh: true  },
  { minutesToGameLte: 45,  requiredMaxSnapshotAgeMinutes: 20, triggerPreModelRefresh: true  },
  { minutesToGameLte: 15,  requiredMaxSnapshotAgeMinutes: 10, triggerPreModelRefresh: true  },
];

/**
 * Resolve the strictest (smallest minutesToGameLte) freshness override band
 * that satisfies minutesToGame <= minutesToGameLte.
 *
 * @param {number} minutesToGame - Minutes until game starts
 * @param {TMinusFreshnessOverride[]} [overrides] - Override ladder (defaults to MLB_TMINUS_FRESHNESS_OVERRIDES)
 * @returns {TMinusFreshnessOverride|null} - Matched row, or null if no row matches
 */
function resolveTMinusFreshnessOverride(minutesToGame, overrides) {
  const ladder = overrides !== undefined ? overrides : MLB_TMINUS_FRESHNESS_OVERRIDES;
  if (ladder.length === 0) return null;
  // Floor: must be at least the smallest minutesToGameLte in the ladder
  const minBandLte = Math.min(...ladder.map((r) => r.minutesToGameLte));
  if (minutesToGame < minBandLte) return null;
  // Ceiling: must not exceed the largest minutesToGameLte
  const matches = ladder.filter((row) => minutesToGame <= row.minutesToGameLte);
  if (matches.length === 0) return null;
  // Return the row with the smallest minutesToGameLte (strictest match)
  return matches.reduce((best, row) =>
    row.minutesToGameLte < best.minutesToGameLte ? row : best,
  );
}

/**
 * Build a deduped job key for an MLB pre-model odds pull in a T-minus band.
 *
 * @param {string} gameId - MLB game identifier
 * @param {number} matchedBandMinutes - The minutesToGameLte of the matched override band
 * @param {string} slotStartIsoUtc - Minute-precision UTC ISO string (will be truncated to YYYY-MM-DDTHH:MM)
 * @returns {string} - e.g. 'pull-odds:mlb:premodel:mlb_game_1:45:2026-04-15T19:38'
 */
function keyMlbPremodelOdds(gameId, matchedBandMinutes, slotStartIsoUtc) {
  const slotMinute = String(slotStartIsoUtc).slice(0, 16);
  return `pull-odds:mlb:premodel:${gameId}:${matchedBandMinutes}:${slotMinute}`;
}

/**
 * T-minus window bands with tolerance
 * If game starts at 19:00, T-120 window = 17:00 ± 5 min
 */
const TMINUS_BANDS = [
  { minutes: 120, min: 115, max: 120 },
  { minutes: 90, min: 85, max: 90 },
  { minutes: 60, min: 55, max: 60 },
  { minutes: 30, min: 25, max: 30 },
];

/**
 * Detect which T-minus windows are due for a game
 * @param {DateTime} nowUtc - Current UTC time
 * @param {DateTime} startUtc - Game start UTC time
 * @returns {number[]} - List of due window minutes (e.g., [120, 60])
 */
function dueTminusMinutes(nowUtc, startUtc) {
  const delta = Math.floor(startUtc.diff(nowUtc, 'minutes').minutes);
  return TMINUS_BANDS.filter((b) => delta >= b.min && delta <= b.max).map(
    (b) => b.minutes,
  );
}

/**
 * Returns true if the sport uses projection models (NBA/NHL) that need
 * team-metrics cache and T-minus odds pulls.
 */
function isProjectionModelSport(sport) {
  return ['nba', 'nhl'].includes(String(sport || '').toLowerCase());
}

module.exports = {
  MLB_TMINUS_FRESHNESS_OVERRIDES,
  resolveTMinusFreshnessOverride,
  keyMlbPremodelOdds,
  isProjectionModelSport,
  keyEspnGamesDirect,
  keyOddsHourly,
  keyFixed,
  keyDiscordCardsSnapshot,
  keyTminus,
  keyNightlySweep,
  keyNhlPlayerAvailabilitySync,
  keyNbaPlayerAvailabilitySync,
  keyNhlGoalieStarters,
  keyNhlSogPlayerSync,
  keyNhlTeamStats,
  keyPullScheduleNba,
  keyPullScheduleNhl,
  keySettlementHealthReport,
  keyHourlySettlementSweep,
  keyPublicSplits,
  keyVsinSplits,
  keyHourlySettlementJob,
  keyNightlySettlementJob,
  isHourlySettlementDue,
  isNightlySettlementOwningHourlyWindow,
  getOddsIntervalMinutes,
  getScheduleRefreshDue,
  shouldRefreshOddsForGame,
  isFixedDue,
  dueTminusMinutes,
  TMINUS_BANDS,
};
