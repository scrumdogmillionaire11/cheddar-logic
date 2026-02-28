/**
 * Window-Based Scheduler — Tick loop with idempotency
 * 
 * Architecture:
 * - Fixed-time windows: 09:00 ET, 12:00 ET (daily model refresh)
 * - T-minus windows: T-120, T-90, T-60, T-30 (pre-game updates)
 * - Hourly odds bucket: captures odds every hour
 * 
 * Idempotency:
 * - Each job receives a deterministic job_key
 * - shouldRunJobKey() checks if already successful or running
 * - Tick loop reschedules on next pass
 * 
 * Can be started locally:
 *   node src/schedulers/main.js
 *   DRY_RUN=true node src/schedulers/main.js
 *   TZ=America/New_York TICK_MS=10000 node src/schedulers/main.js
 * 
 * Domain Split:
 * - Betting Engine: NHL/NBA/MLB/NFL (game-time windows)
 * - FPL-SAGE Engine: FPL (deadline-based, NOT game-time) — TODO future refactor
 */

const { DateTime } = require('luxon');
const { initDb, getUpcomingGames, shouldRunJobKey, hasRunningJobRun } = require('@cheddar-logic/data');

// Import all jobs
const { pullOddsHourly } = require('../jobs/pull_odds_hourly');
const { runNHLModel } = require('../jobs/run_nhl_model');
const { runNBAModel } = require('../jobs/run_nba_model');
const { runFPLModel } = require('../jobs/run_fpl_model');
const { runNFLModel } = require('../jobs/run_nfl_model');
const { runMLBModel } = require('../jobs/run_mlb_model');
const { runSoccerModel } = require('../jobs/run_soccer_model');
const { runNCAAMModel } = require('../jobs/run_ncaam_model');

// Timezone for fixed-time windows
const TZ = process.env.TZ || 'America/New_York';

/**
 * Sport-to-job mapping
 * FPL is included here temporarily but should be refactored to deadline scheduling
 */
const SPORT_JOBS = {
  nhl: { jobName: 'run_nhl_model', execute: runNHLModel, env: 'ENABLE_NHL_MODEL' },
  nba: { jobName: 'run_nba_model', execute: runNBAModel, env: 'ENABLE_NBA_MODEL' },
  mlb: { jobName: 'run_mlb_model', execute: runMLBModel, env: 'ENABLE_MLB_MODEL' },
  nfl: { jobName: 'run_nfl_model', execute: runNFLModel, env: 'ENABLE_NFL_MODEL' },
  soccer: { jobName: 'run_soccer_model', execute: runSoccerModel, env: 'ENABLE_SOCCER_MODEL' },
  ncaam: { jobName: 'run_ncaam_model', execute: runNCAAMModel, env: 'ENABLE_NCAAM_MODEL' },
  
  // TEMPORARY: FPL here until deadline-based scheduler refactor
  fpl: { jobName: 'run_fpl_model', execute: runFPLModel, env: 'ENABLE_FPL_MODEL' },
};

/**
 * Get list of enabled sports from environment
 */
function enabledSports() {
  return Object.keys(SPORT_JOBS).filter(s => process.env[SPORT_JOBS[s].env] !== 'false');
}

/**
 * Get current time in Eastern Time (for fixed windows)
 */
function nowET() {
  return DateTime.now().setZone(TZ);
}

/**
 * Job key builders (deterministic identifiers for idempotency)
 */
function keyOddsHourly(nowEt) {
  return `odds|hourly|${nowEt.toISODate()}|${String(nowEt.hour).padStart(2, '0')}`;
}

function keyFixed(sport, nowEt, hhmm) {
  return `${sport}|fixed|${nowEt.toISODate()}|${hhmm.replace(':', '')}`;
}

function keyTminus(sport, gameId, minutes) {
  return `${sport}|tminus|${gameId}|${minutes}`;
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
 * T-minus window bands with tolerance
 * If game starts at 19:00, T-120 window = 17:00 ± 5 min
 */
const TMINUS_BANDS = [
  { minutes: 120, min: 115, max: 120 },
  { minutes: 90,  min: 85,  max: 90  },
  { minutes: 60,  min: 55,  max: 60  },
  { minutes: 30,  min: 25,  max: 30  },
];

/**
 * Detect which T-minus windows are due for a game
 * @param {DateTime} nowUtc - Current UTC time
 * @param {DateTime} startUtc - Game start UTC time
 * @returns {number[]} - List of due window minutes (e.g., [120, 60])
 */
function dueTminusMinutes(nowUtc, startUtc) {
  const delta = Math.floor(startUtc.diff(nowUtc, 'minutes').minutes);
  return TMINUS_BANDS.filter(b => delta >= b.min && delta <= b.max).map(b => b.minutes);
}

/**
 * Compute due jobs (pure function, no side effects)
 * @param {object} params
 * @param {DateTime} params.nowEt - Current ET time
 * @param {DateTime} params.nowUtc - Current UTC time
 * @param {array} params.games - Games from DB
 * @param {boolean} params.dryRun - Dry run mode
 * @returns {array} - List of {jobName, jobKey, execute, args, reason}
 */
function computeDueJobs({ nowEt, nowUtc, games, dryRun }) {
  const jobs = [];
  const sports = enabledSports();

  // 1) Odds hourly bucket
  if (process.env.ENABLE_ODDS_PULL !== 'false') {
    const jobKey = keyOddsHourly(nowEt);
    jobs.push({
      jobName: 'pull_odds_hourly',
      jobKey,
      execute: pullOddsHourly,
      args: { jobKey, dryRun },
      reason: `hourly bucket ${nowEt.toISODate()} ${nowEt.hour}h`
    });
  }

  // 2) Fixed-time model runs (per sport)
  const fixedTimes = ['09:00', '12:00'];
  for (const sport of sports) {
    const { jobName, execute } = SPORT_JOBS[sport];
    for (const t of fixedTimes) {
      if (!isFixedDue(nowEt, t)) continue;
      const jobKey = keyFixed(sport, nowEt, t);
      jobs.push({
        jobName,
        jobKey,
        execute,
        args: { jobKey, dryRun },
        reason: `fixed ${t} ET`
      });
    }
  }

  // 3) T-minus windows (per game)
  for (const g of games) {
    const sport = String(g.sport).toLowerCase();
    if (!SPORT_JOBS[sport]) continue;
    if (!sports.includes(sport)) continue;

    const startUtc = DateTime.fromISO(g.game_time_utc, { zone: 'utc' });
    const minsList = dueTminusMinutes(nowUtc, startUtc);

    for (const mins of minsList) {
      const jobKey = keyTminus(sport, g.game_id, mins);
      jobs.push({
        jobName: SPORT_JOBS[sport].jobName,
        jobKey,
        execute: SPORT_JOBS[sport].execute,
        args: { jobKey, dryRun },
        reason: `T-${mins} for ${g.game_id}`
      });
    }
  }

  return jobs;
}

/**
 * Execute tick: check due jobs and run them if not already successful/running
 */
async function tick() {
  const dryRun = process.env.DRY_RUN === 'true';
  const nowEt = nowET();
  const nowUtc = DateTime.utc();

  // Get games in the next 36 hours (covers tomorrow + late games)
  const startUtcIso = nowUtc.minus({ hours: 1 }).toISO();   // small back buffer
  const endUtcIso   = nowUtc.plus({ hours: 36 }).toISO();

  const sports = enabledSports();
  const games = getUpcomingGames({ startUtcIso, endUtcIso, sports });

  const due = computeDueJobs({ nowEt, nowUtc, games, dryRun });

  // De-dup inside the tick so we don't schedule the same jobKey twice
  const seen = new Set();
  const uniqueDue = due.filter(j => {
    if (seen.has(j.jobKey)) return false;
    seen.add(j.jobKey);
    return true;
  });

  console.log(`[SCHEDULER] Tick ${nowEt.toISO()} ET — due candidates: ${uniqueDue.length}`);

  for (const job of uniqueDue) {
    // Idempotency gate
    if (!shouldRunJobKey(job.jobKey)) {
      console.log(`  ⏭️  skip ${job.jobKey} (${job.jobName})`);
      continue;
    }

    // Extra overlap gate
    if (hasRunningJobRun(job.jobKey)) {
      console.log(`  ⏳ running ${job.jobKey} (${job.jobName})`);
      continue;
    }

    if (dryRun) {
      console.log(`  🧪 DRY_RUN would run ${job.jobKey} (${job.jobName}) — ${job.reason}`);
      continue;
    }

    console.log(`  ▶️  run ${job.jobKey} (${job.jobName}) — ${job.reason}`);
    try {
      await job.execute(job.args);
    } catch (err) {
      console.error(`  ❌ ${job.jobKey} failed:`, err.message);
    }
  }
}

/**
 * Start the scheduler with tick loop
 */
async function start() {
  const tickMs = Number(process.env.TICK_MS || 60_000);

  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  CHEDDAR-LOGIC WINDOW SCHEDULER (Tick Loop)');
  console.log('═'.repeat(60));
  console.log(`  TZ: ${TZ}`);
  console.log(`  TICK_MS: ${tickMs}`);
  console.log(`  DRY_RUN: ${process.env.DRY_RUN || 'false'}`);
  console.log(`  FIXED_CATCHUP: ${process.env.FIXED_CATCHUP !== 'false' ? 'true' : 'false'}`);
  console.log(`  ENABLE_ODDS_PULL: ${process.env.ENABLE_ODDS_PULL !== 'false' ? 'true' : 'false'}`);
  console.log(`  Enabled sports: ${enabledSports().join(', ') || 'none'}`);
  console.log('═'.repeat(60));
  console.log('');

  // Initialize database
  console.log('[SCHEDULER] Initializing database...');
  await initDb();
  console.log('[SCHEDULER] Database ready.\n');

  // Initial tick
  tick().catch(err => console.error('[SCHEDULER] tick error', err));

  // Loop
  const interval = setInterval(() => {
    tick().catch(err => console.error('[SCHEDULER] tick error', err));
  }, tickMs);

  process.on('SIGTERM', () => {
    clearInterval(interval);
    console.log('\n[SCHEDULER] Received SIGTERM, exiting...');
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\n[SCHEDULER] Received SIGINT, exiting...');
    process.exit(0);
  });
}

// CLI execution
if (require.main === module) {
  start();
}

module.exports = { 
  start, 
  tick, 
  computeDueJobs,
  enabledSports,
  keyOddsHourly,
  keyFixed,
  keyTminus,
  isFixedDue,
  dueTminusMinutes,
  TMINUS_BANDS
};
