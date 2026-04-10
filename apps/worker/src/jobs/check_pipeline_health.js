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
const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  createJob,
  wasJobRecentlySuccessful,
} = require('@cheddar-logic/data');
const { buildMlbMarketAvailability } = require('./run_mlb_model');
const { getCurrentQuotaTier } = require('../schedulers/quota');
const { sendDiscordMessages } = require('./post_discord_cards');

const ODDS_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.ODDS_FRESHNESS_MAX_AGE_MINUTES || 15,
);
const CARDS_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.CARDS_FRESHNESS_MAX_AGE_MINUTES || 30,
);
// Per-sport model freshness threshold. Only fires when upcoming games exist.
const MODEL_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.MODEL_FRESHNESS_MAX_AGE_MINUTES || 240, // 4h default
);
const PIPELINE_HEALTH_ALERT_CONSECUTIVE = Number(
  process.env.PIPELINE_HEALTH_ALERT_CONSECUTIVE || 3,
);
const PIPELINE_HEALTH_COOLDOWN_MINUTES = Number(
  process.env.PIPELINE_HEALTH_COOLDOWN_MINUTES || 30,
);

/**
 * Write health check result to pipeline_health table
 */
function writePipelineHealth(phase, check, status, reason) {
  const db = getDatabase();
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
  const db = getDatabase();
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
    const reason = `${count} upcoming games found`;
    writePipelineHealth('schedule', 'freshness', 'ok', reason);
    return { ok: true, reason };
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
  const db = getDatabase();
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

    const capturedAt = DateTime.fromISO(latestOdds.captured_at, {
      zone: 'utc',
    });
    const ageMinutes = nowUtc.diff(capturedAt, 'minutes').minutes;

    if (ageMinutes > ODDS_FRESHNESS_MAX_AGE_MINUTES) {
      staleGames.push(game.game_id);
    }
  }

  if (staleGames.length === 0) {
    const reason = `All ${upcomingGames.length} games within T-6h have fresh odds`;
    writePipelineHealth('odds', 'freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const quotaTier = getCurrentQuotaTier();
  const quotaConstrained = ['MEDIUM', 'LOW', 'CRITICAL'].includes(quotaTier);

  if (quotaConstrained) {
    const reason = `${staleGames.length}/${upcomingGames.length} games within T-6h have stale odds (>${ODDS_FRESHNESS_MAX_AGE_MINUTES}m old) — odds fetch paused (quota tier: ${quotaTier})`;
    writePipelineHealth('odds', 'freshness', 'warning', reason);
    return { ok: false, reason };
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
  const db = getDatabase();
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
    const reason = `All ${upcomingGames.length} games within T-2h have fresh cards`;
    writePipelineHealth('cards', 'freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const reason = `${missingCards.length}/${upcomingGames.length} games within T-2h missing/stale cards (>${CARDS_FRESHNESS_MAX_AGE_MINUTES}m old)`;
  writePipelineHealth('cards', 'freshness', 'failed', reason);
  return { ok: false, reason };
}

function getLatestOddsSnapshot(db, gameId) {
  return db
    .prepare(
      `
    SELECT *
    FROM odds_snapshots
    WHERE game_id = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `,
    )
    .get(gameId);
}

/**
 * Check 4: MLB F5 market availability
 * For upcoming MLB games within T-6h, report F5 total availability separately
 * from full-game totals so watchdog output matches MLB market intent.
 *
 * Games within T-15min of gametime are excluded: F5 markets close before
 * gametime so their absence at that point is expected, not a pipeline failure.
 */
function checkMlbF5MarketAvailability({ expectF5Ml = false } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  // Exclude games within 15 minutes of start — F5 markets are already closed
  const checkFromUtc = nowUtc.plus({ minutes: 15 });
  const endUtc = nowUtc.plus({ hours: 6 });
  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, game_time_utc, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'mlb'
      AND game_time_utc >= ?
      AND game_time_utc <= ?
  `,
    )
    .all(checkFromUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    return {
      ok: true,
      reason: 'No MLB games within T-6h',
      games_checked: 0,
      missing_f5_total_count: 0,
      missing_full_game_total_count: 0,
      expected_f5_ml_count: 0,
      missing_f5_ml_count: 0,
    };
  }

  const missingF5Total = [];
  const missingFullGameTotal = [];
  const missingF5Ml = [];
  let expectedF5MlCount = 0;

  for (const game of upcomingGames) {
    const latestOdds = getLatestOddsSnapshot(db, game.game_id);
    const availability = buildMlbMarketAvailability(
      latestOdds
        ? {
            ...latestOdds,
            game_id: game.game_id,
            game_time_utc: game.game_time_utc,
            home_team: game.home_team,
            away_team: game.away_team,
          }
        : {
            game_id: game.game_id,
            game_time_utc: game.game_time_utc,
            home_team: game.home_team,
            away_team: game.away_team,
          },
      { expectF5Ml },
    );

    if (!availability.f5_line_ok) {
      missingF5Total.push(game.game_id);
    }
    if (!availability.full_game_total_ok) {
      missingFullGameTotal.push(game.game_id);
    }
    if (availability.expect_f5_ml) {
      expectedF5MlCount += 1;
      if (!availability.f5_ml_ok) {
        missingF5Ml.push(game.game_id);
      }
    }
  }

  const baseReason =
    missingF5Total.length === 0
      ? `F5 totals available for all ${upcomingGames.length} MLB games within T-6h`
      : `${missingF5Total.length}/${upcomingGames.length} MLB games within T-6h missing F5 totals`;
  const reasonParts = [baseReason];

  if (missingFullGameTotal.length > 0) {
    reasonParts.push(
      `${missingFullGameTotal.length} missing full-game totals (informational)`,
    );
  }
  if (expectedF5MlCount > 0) {
    reasonParts.push(
      `${missingF5Ml.length}/${expectedF5MlCount} missing F5 ML`,
    );
  }

  const reason = reasonParts.join('; ');
  if (missingF5Total.length > 0) {
    writePipelineHealth('mlb', 'f5_market_availability', 'failed', reason);
  } else if (upcomingGames.length > 0) {
    writePipelineHealth('mlb', 'f5_market_availability', 'ok', reason);
  }

  return {
    ok: missingF5Total.length === 0,
    reason,
    games_checked: upcomingGames.length,
    missing_f5_total_count: missingF5Total.length,
    missing_f5_total_games: missingF5Total,
    missing_full_game_total_count: missingFullGameTotal.length,
    missing_full_game_total_games: missingFullGameTotal,
    expected_f5_ml_count: expectedF5MlCount,
    missing_f5_ml_count: missingF5Ml.length,
    missing_f5_ml_games: missingF5Ml,
  };
}

/**
 * Check 5: Settlement backlog
 * Find games with status='final' but no game_results entry
 */
function checkSettlementBacklog() {
  const db = getDatabase();

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
    const reason = 'No settlement backlog';
    writePipelineHealth('settlement', 'backlog', 'ok', reason);
    return { ok: true, reason };
  }

  const reason = `${backlog} final games pending settlement`;
  writePipelineHealth('settlement', 'backlog', 'warning', reason);
  return { ok: false, reason };
}

/**
 * Check: Per-sport model freshness
 * Verifies the named job ran successfully within the threshold, but only
 * reports when there are upcoming games for that sport (avoids false negatives
 * on off-days and off-season).
 */
function checkSportModelFreshness(sport, jobName, checkName, maxAgeMinutes) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const horizonUtc = nowUtc.plus({ hours: 6 });

  const upcomingCount = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM games
       WHERE LOWER(sport) = LOWER(?)
         AND game_time_utc >= ?
         AND game_time_utc <= ?`,
    )
    .get(sport, nowUtc.toISO(), horizonUtc.toISO()).cnt;

  if (upcomingCount === 0) {
    return {
      ok: true,
      reason: `No ${sport.toUpperCase()} games within T-6h - model check skipped`,
    };
  }

  const thresholdDesc =
    maxAgeMinutes >= 60
      ? `${Math.round(maxAgeMinutes / 60)}h`
      : `${maxAgeMinutes}m`;

  const recentlyRan = wasJobRecentlySuccessful(jobName, maxAgeMinutes);

  if (recentlyRan) {
    const reason = `${jobName} ran successfully within last ${thresholdDesc} (${upcomingCount} upcoming games)`;
    writePipelineHealth(sport.toLowerCase(), checkName, 'ok', reason);
    return { ok: true, reason };
  }

  const reason = `${jobName} has NOT run successfully in last ${thresholdDesc} — ${upcomingCount} upcoming ${sport.toUpperCase()} games at risk`;
  writePipelineHealth(sport.toLowerCase(), checkName, 'failed', reason);
  return { ok: false, reason };
}


/**
 * Returns true when the given (phase, check_name) has reached consecutiveRequired
 * consecutive 'failed' rows AND the oldest row in that streak was written within
 * cooldownMinutes ago (i.e. the streak just crossed the threshold on this tick).
 * Once the streak is older than the cooldown window we suppress further alerts.
 */
function shouldSendAlert(phase, checkName, consecutiveRequired, cooldownMinutes) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT status, created_at
       FROM pipeline_health
       WHERE phase = ? AND check_name = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(phase, checkName, consecutiveRequired);

  if (rows.length < consecutiveRequired) return false;
  if (rows.some((r) => r.status !== 'failed')) return false;

  // oldest row in the streak is the last element (DESC order)
  const oldestRow = rows[consecutiveRequired - 1];
  const oldestAt = DateTime.fromISO(oldestRow.created_at, { zone: 'utc' });
  const ageMinutes = DateTime.utc().diff(oldestAt, 'minutes').minutes;
  return ageMinutes <= cooldownMinutes;
}

/**
 * Formats a Discord alert message for a list of failed pipeline checks.
 */
function buildHealthAlertMessage(failedChecks) {
  const lines = ['🚨 **Pipeline Health Alert**', '', 'The following checks are failing:'];
  for (const { phase, checkName, reason } of failedChecks) {
    lines.push(`• \`${phase} / ${checkName}\` — ${reason}`);
  }
  return lines.join('\n');
}

/**
 * Main health check runner
 */
async function checkPipelineHealth({ jobKey, dryRun }) {

  if (dryRun) {
    console.log(`[check_pipeline_health] DRY_RUN: ${jobKey}`);
    return;
  }

  const runId = uuidV4();
  insertJobRun('check_pipeline_health', runId, jobKey);

  try {
    console.log(`[check_pipeline_health] Running health checks...`);

    const checks = {
      schedule_freshness: checkScheduleFreshness,
      odds_freshness: checkOddsFreshness,
      cards_freshness: checkCardsFreshness,
      mlb_f5_market_availability: checkMlbF5MarketAvailability,
      settlement_backlog: checkSettlementBacklog,
      // Per-sport model freshness (only fires when upcoming games exist for that sport)
      nhl_model_freshness: () =>
        checkSportModelFreshness('nhl', 'run_nhl_model', 'model_freshness', MODEL_FRESHNESS_MAX_AGE_MINUTES),
      nhl_shots_model_freshness: () =>
        checkSportModelFreshness('nhl', 'run-nhl-player-shots-model', 'shots_model_freshness', MODEL_FRESHNESS_MAX_AGE_MINUTES),
      nba_model_freshness: () =>
        checkSportModelFreshness('nba', 'run_nba_model', 'model_freshness', MODEL_FRESHNESS_MAX_AGE_MINUTES),
      mlb_model_freshness: () =>
        checkSportModelFreshness('mlb', 'run_mlb_model', 'model_freshness', 180),
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

    // --- Discord watchdog alert ---
    if (process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG === 'true' && !allOk) {
      const checkPhaseLookup = {
        schedule_freshness: ['schedule', 'freshness'],
        odds_freshness: ['odds', 'freshness'],
        cards_freshness: ['cards', 'freshness'],
        mlb_f5_market_availability: ['mlb', 'f5_market_availability'],
        settlement_backlog: ['settlement', 'backlog'],
        nhl_model_freshness: ['nhl', 'model_freshness'],
        nhl_shots_model_freshness: ['nhl', 'shots_model_freshness'],
        nba_model_freshness: ['nba', 'model_freshness'],
        mlb_model_freshness: ['mlb', 'model_freshness'],
      };

      const alertCandidates = [];
      for (const [key, result] of Object.entries(results)) {
        if (result.ok) continue;
        const mapping = checkPhaseLookup[key];
        if (!mapping) continue;
        const [phase, dbCheckName] = mapping;
        if (shouldSendAlert(phase, dbCheckName, PIPELINE_HEALTH_ALERT_CONSECUTIVE, PIPELINE_HEALTH_COOLDOWN_MINUTES)) {
          alertCandidates.push({ phase, checkName: dbCheckName, reason: result.reason });
        }
      }

      if (alertCandidates.length > 0) {
        const webhookUrl = process.env.DISCORD_CARD_WEBHOOK_URL;
        if (!webhookUrl) {
          console.warn('[check_pipeline_health] DISCORD_CARD_WEBHOOK_URL not set — skipping Discord alert');
        } else {
          const message = buildHealthAlertMessage(alertCandidates);
          await sendDiscordMessages({ webhookUrl, messages: [message] });
          console.log(`[check_pipeline_health] Sent Discord alert for ${alertCandidates.length} failed check(s)`);
        }
      }
    }
    // --- end Discord watchdog alert ---

    const summary = allOk
      ? 'All pipeline health checks passed'
      : 'Some pipeline health checks failed (see logs)';

    markJobRunSuccess(runId);
    console.log(`[check_pipeline_health] ${summary}`);
  } catch (error) {
    console.error(`[check_pipeline_health] Error:`, error);
    markJobRunFailure(runId, error.message);
    throw error;
  }
}

if (require.main === module) {
  createJob('check_pipeline_health', ({ dryRun }) =>
    checkPipelineHealth({
      jobKey: `check_pipeline_health-${new Date().toISOString().slice(0, 16)}`,
      dryRun,
    })
  );
}

module.exports = {
  checkPipelineHealth,
  checkMlbF5MarketAvailability,
  checkOddsFreshness,
  shouldSendAlert,
  buildHealthAlertMessage,
};
