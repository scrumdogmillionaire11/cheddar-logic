/**
 * Pipeline Health Check Watchdog
 *
 * Runs every 5 minutes to check the health of all pipeline phases:
 * 1. Schedule freshness (upcoming games exist)
 * 2. Odds freshness (recent snapshots for upcoming games)
 * 3. Cards freshness (card payloads generated for upcoming games)
 * 4. Settlement backlog (final games without results)
 *
 * Writes failures to pipeline_health table for UI visibility.
 *
 * Env:
 * - ENABLE_PIPELINE_HEALTH_WATCHDOG (default: false)
 * - PIPELINE_HEALTH_INTERVAL_MINUTES (default: 5)
 * - ODDS_FRESHNESS_MAX_AGE_MINUTES (default: 15)
 * - CARDS_FRESHNESS_MAX_AGE_MINUTES (default: 30)
 */

require('dotenv').config();
const { DateTime } = require('luxon');
const {
  initDb,
  getDb,
  recordJobStart,
  recordJobSuccess,
  recordJobError,
} = require('@cheddar-logic/data');

const ODDS_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.ODDS_FRESHNESS_MAX_AGE_MINUTES || 15,
);
const CARDS_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.CARDS_FRESHNESS_MAX_AGE_MINUTES || 30,
);

/**
 * Write health check result to pipeline_health table
 */
function writePipelineHealth(phase, check, status, reason) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO pipeline_health (phase, check_name, status, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(phase, check, status, reason, DateTime.utc().toISO());
}

/**
 * Check 1: Schedule freshness
 * Verify we have upcoming games for today + next 2 days
 */
function checkScheduleFreshness() {
  const db = getDb();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ days: 2 });

  const count = db
    .prepare(
      `
    SELECT COUNT(*) as cnt
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
  `,
    )
    .get(nowUtc.toISO(), endUtc.toISO()).cnt;

  if (count > 0) {
    return { ok: true, reason: `${count} upcoming games found` };
  }

  const reason = 'No upcoming games in next 48h (schedule may be stale)';
  writePipelineHealth('schedule', 'freshness', 'failed', reason);
  return { ok: false, reason };
}

/**
 * Check 2: Odds freshness
 * For games within T-6h, verify latest odds snapshot is < 15 min old
 */
function checkOddsFreshness() {
  const db = getDb();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc;
  const endUtc = nowUtc.plus({ hours: 6 });

  // Find games within T-6h
  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, game_time_utc
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
  `,
    )
    .all(startUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    return { ok: true, reason: 'No games within T-6h' };
  }

  // Check latest odds snapshot age for these games
  const staleGames = [];
  for (const game of upcomingGames) {
    const latestOdds = db
      .prepare(
        `
      SELECT captured_at
      FROM odds_snapshots
      WHERE game_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `,
      )
      .get(game.game_id);

    if (!latestOdds) {
      staleGames.push(game.game_id);
      continue;
    }

    const capturedAt = DateTime.fromISO(latestOdds.captured_at, { zone: 'utc' });
    const ageMinutes = nowUtc.diff(capturedAt, 'minutes').minutes;

    if (ageMinutes > ODDS_FRESHNESS_MAX_AGE_MINUTES) {
      staleGames.push(game.game_id);
    }
  }

  if (staleGames.length === 0) {
    return {
      ok: true,
      reason: `All ${upcomingGames.length} games within T-6h have fresh odds`,
    };
  }

  const reason = `${staleGames.length}/${upcomingGames.length} games within T-6h have stale odds (>${ODDS_FRESHNESS_MAX_AGE_MINUTES}m old)`;
  writePipelineHealth('odds', 'freshness', 'failed', reason);
  return { ok: false, reason };
}

/**
 * Check 3: Cards freshness
 * For games within T-2h, verify card_payloads exist and are recent
 */
function checkCardsFreshness() {
  const db = getDb();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc;
  const endUtc = nowUtc.plus({ hours: 2 });

  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, game_time_utc
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
  `,
    )
    .all(startUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    return { ok: true, reason: 'No games within T-2h' };
  }

  const missingCards = [];
  for (const game of upcomingGames) {
    const latestCard = db
      .prepare(
        `
      SELECT created_at
      FROM card_payloads
      WHERE game_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(game.game_id);

    if (!latestCard) {
      missingCards.push(game.game_id);
      continue;
    }

    const createdAt = DateTime.fromISO(latestCard.created_at, { zone: 'utc' });
    const ageMinutes = nowUtc.diff(createdAt, 'minutes').minutes;

    if (ageMinutes > CARDS_FRESHNESS_MAX_AGE_MINUTES) {
      missingCards.push(game.game_id);
    }
  }

  if (missingCards.length === 0) {
    return {
      ok: true,
      reason: `All ${upcomingGames.length} games within T-2h have fresh cards`,
    };
  }

  const reason = `${missingCards.length}/${upcomingGames.length} games within T-2h missing/stale cards (>${CARDS_FRESHNESS_MAX_AGE_MINUTES}m old)`;
  writePipelineHealth('cards', 'freshness', 'failed', reason);
  return { ok: false, reason };
}

/**
 * Check 4: Settlement backlog
 * Find games with status='final' but no game_results entry
 */
function checkSettlementBacklog() {
  const db = getDb();

  const backlog = db
    .prepare(
      `
    SELECT COUNT(*) as cnt
    FROM games g
    WHERE LOWER(g.status) IN ('final', 'ft', 'completed')
      AND NOT EXISTS (
        SELECT 1 FROM game_results gr
        WHERE gr.game_id = g.game_id
          AND gr.status = 'final'
      )
  `,
    )
    .get().cnt;

  if (backlog === 0) {
    return { ok: true, reason: 'No settlement backlog' };
  }

  const reason = `${backlog} final games pending settlement`;
  writePipelineHealth('settlement', 'backlog', 'warning', reason);
  return { ok: false, reason };
}

/**
 * Main health check runner
 */
async function checkPipelineHealth({ jobKey, dryRun }) {
  await initDb();

  if (dryRun) {
    console.log(`[check_pipeline_health] DRY_RUN: ${jobKey}`);
    return;
  }

  const runId = recordJobStart('check_pipeline_health', jobKey);

  try {
    console.log(`[check_pipeline_health] Running health checks...`);

    const checks = {
      schedule_freshness: checkScheduleFreshness,
      odds_freshness: checkOddsFreshness,
      cards_freshness: checkCardsFreshness,
      settlement_backlog: checkSettlementBacklog,
    };

    const results = {};
    let allOk = true;

    for (const [checkName, checkFn] of Object.entries(checks)) {
      const result = checkFn();
      results[checkName] = result;

      if (result.ok) {
        console.log(`  ✓ ${checkName}: ${result.reason}`);
      } else {
        console.warn(`  ⚠️  ${checkName}: ${result.reason}`);
        allOk = false;
      }
    }

    const summary = allOk
      ? 'All pipeline health checks passed'
      : 'Some pipeline health checks failed (see logs)';

    recordJobSuccess(runId, { summary, results });
    console.log(`[check_pipeline_health] ${summary}`);
  } catch (error) {
    console.error(`[check_pipeline_health] Error:`, error);
    recordJobError(runId, error.message);
    throw error;
  }
}

module.exports = { checkPipelineHealth };
