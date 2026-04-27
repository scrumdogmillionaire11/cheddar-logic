/**
 * Pipeline Health Check Watchdog
 *
 * Runs every 5 minutes to verify all pipeline phases are healthy and emits
 * Discord alerts when multiple consecutive failures are detected.
 *
 * Checks: schedule freshness, odds freshness (with self-healing remediation),
 * cards freshness, settlement backlog, per-sport model freshness, MLB F5/game-line
 * market availability, NHL SOG sync freshness (feature-aware), calibration kill
 * switches, and watchdog heartbeat.
 *
 * Writes all results to pipeline_health for UI visibility.
 *
 * Env:
 * - ENABLE_PIPELINE_HEALTH_WATCHDOG (default: true — set to 'false' to disable)
 * - PIPELINE_HEALTH_INTERVAL_MINUTES (default: 5)
 * - LIVE_ODDS_HEALTH_MAX_AGE_MINUTES (default: slot + 15 minutes, minimum 15)
 *     Intentionally independent from execution-gate hardMaxMinutes (120 min).
 *     The watchdog monitors live odds pipeline health right now; execution gate
 *     decides whether a model write was acceptable at card-generation time.
 *     Keeping this tighter (default ~75 min) preserves early-warning fidelity.
 * - CARDS_FRESHNESS_MAX_AGE_MINUTES (default: 30; informational stale-card age only)
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
const { getContractForSport } = require('./execution-gate-freshness-contract');
const { buildMlbMarketAvailability } = require('./run_mlb_model');
const { getCurrentQuotaTier } = require('../schedulers/quota');
const { keyTminus, TMINUS_BANDS } = require('../schedulers/windows');
const { sendDiscordMessages } = require('./post_discord_cards');
const { SPORTS_CONFIG: ODDS_SPORTS_CONFIG } = require('@cheddar-logic/odds/src/config');
const { isFeatureEnabled } = require('@cheddar-logic/data/src/feature-flags');
const { refreshStaleOdds } = require('./refresh_stale_odds');

// Align freshness threshold with the fetch slot size so alerts don't fire
// continuously during the normal gap between pulls. When ODDS_FETCH_SLOT_MINUTES
// is 180 (April 2026 budget mode) a hardcoded 15-min threshold fires on every
// check. Default: slot + 15 min buffer, minimum 15 min.
const ODDS_FETCH_SLOT_MINUTES = Number(process.env.ODDS_FETCH_SLOT_MINUTES || 60);
// Intentionally NOT derived from execution-gate hardMaxMinutes (120 min).
// This is a live watchdog threshold for current odds pipeline health, not a
// per-card execution gate. Default: slot + 15 min buffer (≈75 min at 60-min cadence).
// card_payload.freshness_tier records what was true at card-generation time and
// must not be read here — it is historical metadata, not a live health signal.
const LIVE_ODDS_HEALTH_MAX_AGE_MINUTES = Number(
  process.env.LIVE_ODDS_HEALTH_MAX_AGE_MINUTES ||
  process.env.ODDS_FRESHNESS_MAX_AGE_MINUTES ||
  Math.max(15, ODDS_FETCH_SLOT_MINUTES + 15),
);
const ODDS_FRESHNESS_ALERT_WINDOW_HOURS = Number(
  process.env.ODDS_FRESHNESS_ALERT_WINDOW_HOURS || Math.max(2, Math.ceil(ODDS_FETCH_SLOT_MINUTES / 60)),
);
const SEED_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.SEED_FRESHNESS_MAX_AGE_MINUTES || Math.max(15, ODDS_FETCH_SLOT_MINUTES + 15),
);
const CARDS_FRESHNESS_MAX_AGE_MINUTES = Number(
  process.env.CARDS_FRESHNESS_MAX_AGE_MINUTES || 30,
);
// Per-sport model freshness threshold (WI-0950).
// Imported from execution-gate-freshness-contract; health check uses 4x the moneyline hardMax
// per operational policy (health check is stricter to catch issues earlier).
// Default: 120m hardMax * 4 = 480m, but env var can override.
function getModelFreshnessMaxAgeMinutes() {
  const envOverride = Number(process.env.MODEL_FRESHNESS_MAX_AGE_MINUTES || 0);
  if (envOverride > 0) return envOverride;
  // Use contract hardMax * 4 for health check window (typically 120m * 4 = 480m)
  const contract = getContractForSport('mlb');
  return contract.hardMaxMinutes * 4;
}
// Alert timing windows for checks that depend on T-minus execution, not schedule ingestion.
const MODEL_FRESHNESS_ALERT_WINDOW_HOURS = Number(
  process.env.MODEL_FRESHNESS_ALERT_WINDOW_HOURS || 2,
);
const MLB_F5_ALERT_WINDOW_HOURS = Number(
  process.env.MLB_F5_ALERT_WINDOW_HOURS || 2,
);
const NHL_BLK_RATES_MAX_AGE_HOURS = Number(
  process.env.NHL_BLK_RATES_MAX_AGE_HOURS || 96,
);
const PIPELINE_HEALTH_ALERT_CONSECUTIVE = Number(
  process.env.PIPELINE_HEALTH_ALERT_CONSECUTIVE || 3,
);
const PIPELINE_HEALTH_COOLDOWN_MINUTES = Number(
  process.env.PIPELINE_HEALTH_COOLDOWN_MINUTES || 30,
);
const CARD_HEALTH_MODEL_JOB_BY_SPORT = Object.freeze({
  nba: { jobName: 'run_nba_model', env: 'ENABLE_NBA_MODEL' },
  nhl: { jobName: 'run_nhl_model', env: 'ENABLE_NHL_MODEL' },
  mlb: { jobName: 'run_mlb_model', env: 'ENABLE_MLB_MODEL' },
  nfl: { jobName: 'run_nfl_model', env: 'ENABLE_NFL_MODEL' },
});

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

function buildOddsFreshnessMatchupKey(game) {
  const sport = String(game.sport || '').toLowerCase();
  const away = String(game.away_team || '').trim().toUpperCase();
  const home = String(game.home_team || '').trim().toUpperCase();
  const gameDate = String(game.game_time_utc || '').slice(0, 10);
  return `${sport}|${away}|${home}|${gameDate}`;
}

function dedupeOddsFreshnessGames(gamesWithFreshness) {
  const byMatchup = new Map();

  for (const game of gamesWithFreshness) {
    const key = buildOddsFreshnessMatchupKey(game);
    const bucket = byMatchup.get(key);
    if (bucket) {
      bucket.push(game);
    } else {
      byMatchup.set(key, [game]);
    }
  }

  const deduped = [];
  for (const duplicates of byMatchup.values()) {
    duplicates.sort((a, b) => {
      const aFresh = !a.isStale;
      const bFresh = !b.isStale;
      if (aFresh !== bFresh) return aFresh ? -1 : 1;

      const aHasSnapshot = Boolean(a.latestCapturedAt);
      const bHasSnapshot = Boolean(b.latestCapturedAt);
      if (aHasSnapshot !== bHasSnapshot) return aHasSnapshot ? -1 : 1;

      const aCapturedAt = a.latestCapturedAt || '';
      const bCapturedAt = b.latestCapturedAt || '';
      if (aCapturedAt !== bCapturedAt) return bCapturedAt.localeCompare(aCapturedAt);

      return String(a.game_time_utc || '').localeCompare(String(b.game_time_utc || ''));
    });

    const winner = duplicates[0];
    deduped.push({
      ...winner,
      duplicateGameIds: duplicates.map((entry) => entry.game_id),
      duplicateCount: duplicates.length,
    });
  }

  return deduped;
}

/**
 * Check 2: Odds freshness
 * For games within T-6h, verify latest odds snapshot is < 15 min old.
 * When near-term stale games are detected, attempts bounded remediation via
 * refreshStaleOdds before writing a final 'failed' status.
 */
async function checkOddsFreshness() {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc;
  const endUtc = nowUtc.plus({ hours: 6 });

  // Only check sports whose odds are actively fetched.
  const activeSports = Object.entries(ODDS_SPORTS_CONFIG)
    .filter(([, cfg]) => cfg.active)
    .map(([sport]) => sport.toLowerCase());

  if (activeSports.length === 0) {
    return { ok: true, reason: 'No sports with active odds configured' };
  }

  const sportPlaceholders = activeSports.map(() => '?').join(', ');

  // Find games within T-6h for active-odds sports only
  const upcomingGames = db
    .prepare(
      `SELECT game_id, sport, home_team, away_team, game_time_utc
       FROM games
       WHERE game_time_utc >= ? AND game_time_utc <= ?
         AND LOWER(sport) IN (${sportPlaceholders})`,
    )
    .all(startUtc.toISO(), endUtc.toISO(), ...activeSports);

  if (upcomingGames.length === 0) {
    return { ok: true, reason: 'No games within T-6h for active-odds sports' };
  }

  // Check latest odds snapshot age for these games
  const gamesWithFreshness = [];
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

    const capturedAt = latestOdds?.captured_at
      ? DateTime.fromISO(latestOdds.captured_at, { zone: 'utc' })
      : null;
    const ageMinutes = capturedAt
      ? nowUtc.diff(capturedAt, 'minutes').minutes
      : null;
    const isStale = !capturedAt || ageMinutes > LIVE_ODDS_HEALTH_MAX_AGE_MINUTES;

    gamesWithFreshness.push({
      ...game,
      latestCapturedAt: latestOdds?.captured_at || null,
      ageMinutes,
      isStale,
    });
  }

  const dedupedGames = dedupeOddsFreshnessGames(gamesWithFreshness);
  const staleGames = dedupedGames.filter((game) => game.isStale);
  const duplicateRowsIgnored = upcomingGames.length - dedupedGames.length;

  if (staleGames.length === 0) {
    const duplicateSuffix =
      duplicateRowsIgnored > 0
        ? ` (${duplicateRowsIgnored} duplicate game_id rows ignored)`
        : '';
    const reason = `All ${dedupedGames.length} games within T-6h have fresh odds${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        detected: 0,
        blocked: 0,
        refreshed: 0,
      },
    };
  }

  // Only escalate to failed/alert when stale games are inside the configured alert window.
  // Games outside this window are warning-only because they still have runway before tip.
  const alertWindowEnd = nowUtc.plus({ hours: ODDS_FRESHNESS_ALERT_WINDOW_HOURS });
  const staleNearTerm = staleGames.filter(
    (g) => DateTime.fromISO(g.game_time_utc, { zone: 'utc' }) <= alertWindowEnd,
  );

  const quotaTier = getCurrentQuotaTier();
  const quotaConstrained = ['MEDIUM', 'LOW', 'CRITICAL'].includes(quotaTier);
  const duplicateSuffix =
    duplicateRowsIgnored > 0
      ? ` (${duplicateRowsIgnored} duplicate game_id rows ignored)`
      : '';

  if (quotaConstrained) {
    const reason = `${staleGames.length}/${dedupedGames.length} games within T-6h have stale odds (>${LIVE_ODDS_HEALTH_MAX_AGE_MINUTES}m old; alert window T-${ODDS_FRESHNESS_ALERT_WINDOW_HOURS}h) — odds fetch paused (quota tier: ${quotaTier})${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'warning', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        detected: staleGames.length,
        blocked: staleNearTerm.length,
        refreshed: 0,
      },
    };
  }

  if (staleNearTerm.length === 0) {
    const reason = `${staleGames.length}/${dedupedGames.length} games within T-6h have stale odds (>${LIVE_ODDS_HEALTH_MAX_AGE_MINUTES}m old) but none within alert window T-${ODDS_FRESHNESS_ALERT_WINDOW_HOURS}h${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'warning', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        detected: staleGames.length,
        blocked: 0,
        refreshed: 0,
      },
    };
  }

  // Attempt bounded remediation before writing final fail status.
  let remediationDiag = { detected: staleGames.length, refreshed: 0, blocked: staleNearTerm.length };
  try {
    const remResult = await refreshStaleOdds({ jobKey: null });
    if (remResult?.staleDiagnostics) {
      remediationDiag = remResult.staleDiagnostics;
    }
  } catch (_err) {
    // Remediation threw — proceed with original stale classification.
  }

  // Re-check near-term stale games after remediation.
  const nowUtcAfter = DateTime.utc();
  const stillStaleNearTerm = staleNearTerm.filter((game) => {
    const dbNow = getDatabase();
    const latest = dbNow
      .prepare('SELECT captured_at FROM odds_snapshots WHERE game_id = ? ORDER BY captured_at DESC LIMIT 1')
      .get(game.game_id);
    const capturedAt = latest?.captured_at ? DateTime.fromISO(latest.captured_at, { zone: 'utc' }) : null;
    const ageMinutes = capturedAt ? nowUtcAfter.diff(capturedAt, 'minutes').minutes : null;
    return !capturedAt || ageMinutes > LIVE_ODDS_HEALTH_MAX_AGE_MINUTES;
  });

  const remSuffix = `remediation: detected=${remediationDiag.detected} refreshed=${remediationDiag.refreshed} blocked=${remediationDiag.blocked}`;

  if (stillStaleNearTerm.length === 0) {
    const reason = `Stale near-term odds cleared by remediation (${remSuffix})${duplicateSuffix}`;
    writePipelineHealth('odds', 'freshness', 'ok', reason);
    return { ok: true, reason, diagnostics: remediationDiag };
  }

  const reason = `${stillStaleNearTerm.length}/${dedupedGames.length} games within alert window T-${ODDS_FRESHNESS_ALERT_WINDOW_HOURS}h still stale after remediation (${remSuffix})${duplicateSuffix}`;
  writePipelineHealth('odds', 'freshness', 'failed', reason);
  return { ok: false, reason, diagnostics: remediationDiag };
}

/**
 * Check 3: Cards freshness
 * For games within T-2h, verify the most recent completed model window ran
 * successfully. Missing/stale card_payloads are informational only because some
 * model runners legitimately emit no actionable card.
 */
function checkCardsFreshness() {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const startUtc = nowUtc;
  const endUtc = nowUtc.plus({ hours: 2 });

  const upcomingGames = db
    .prepare(
      `
    SELECT game_id, game_time_utc, sport
    FROM games
    WHERE game_time_utc >= ? AND game_time_utc <= ?
  `,
    )
    .all(startUtc.toISO(), endUtc.toISO());

  if (upcomingGames.length === 0) {
    return { ok: true, reason: 'No games within T-2h' };
  }

  const modelRunMisses = [];
  let dueWindowCount = 0;
  let awaitingFirstWindowCount = 0;
  let unsupportedSportCount = 0;
  let informationalCardLagCount = 0;

  for (const game of upcomingGames) {
    const sport = String(game.sport || '').toLowerCase();
    const descriptor = CARD_HEALTH_MODEL_JOB_BY_SPORT[sport] || null;
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

    const latestCardAgeMinutes = latestCard
      ? nowUtc.diff(DateTime.fromISO(latestCard.created_at, { zone: 'utc' }), 'minutes').minutes
      : null;
    const hasCardLag = latestCardAgeMinutes === null || latestCardAgeMinutes > CARDS_FRESHNESS_MAX_AGE_MINUTES;

    if (!descriptor || process.env[descriptor.env] === 'false') {
      unsupportedSportCount += 1;
      if (hasCardLag) informationalCardLagCount += 1;
      continue;
    }

    const minsUntilStart = Math.floor(
      DateTime.fromISO(game.game_time_utc, { zone: 'utc' }).diff(nowUtc, 'minutes').minutes,
    );
    const completedBands = TMINUS_BANDS.filter((band) => minsUntilStart < band.min);
    const latestCompletedBand = completedBands[completedBands.length - 1] || null;

    if (!latestCompletedBand) {
      awaitingFirstWindowCount += 1;
      if (hasCardLag) informationalCardLagCount += 1;
      continue;
    }

    dueWindowCount += 1;
    const jobKey = keyTminus(sport, game.game_id, latestCompletedBand.minutes);
    const recentModelRun = db
      .prepare(
        `
      SELECT started_at
      FROM job_runs
      WHERE job_name = ?
        AND job_key = ?
        AND status = 'success'
      ORDER BY started_at DESC
      LIMIT 1
    `,
      )
      .get(descriptor.jobName, jobKey);

    if (!recentModelRun) {
      modelRunMisses.push({
        gameId: game.game_id,
        sport,
        expectedWindowMinutes: latestCompletedBand.minutes,
      });
      continue;
    }

    if (hasCardLag) informationalCardLagCount += 1;
  }

  if (modelRunMisses.length === 0) {
    const reasonParts = [];
    if (dueWindowCount === 0) {
      reasonParts.push(`No games within T-2h have a completed model window yet`);
    } else {
      reasonParts.push(`All ${dueWindowCount} completed model windows within T-2h have recent model runs`);
    }
    if (awaitingFirstWindowCount > 0) {
      reasonParts.push(`${awaitingFirstWindowCount} games awaiting first model window`);
    }
    if (unsupportedSportCount > 0) {
      reasonParts.push(`${unsupportedSportCount} games skipped (unsupported or disabled sport model)`);
    }
    if (informationalCardLagCount > 0) {
      reasonParts.push(`${informationalCardLagCount}/${upcomingGames.length} missing/stale cards are informational`);
    }
    const reason = reasonParts.join('; ');
    writePipelineHealth('cards', 'freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const reasonParts = [
    `${modelRunMisses.length}/${dueWindowCount} games within T-2h missing expected model runs`,
  ];
  if (informationalCardLagCount > 0) {
    reasonParts.push(`${informationalCardLagCount}/${upcomingGames.length} missing/stale cards are informational`);
  }
  const reason = reasonParts.join('; ');
  writePipelineHealth('cards', 'freshness', 'warning', reason);
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

const MLB_REJECT_REASON_FAMILIES = Object.freeze([
  'DATA_STALENESS',
  'NO_EDGE',
  'INPUT_FAILURE',
  'EXECUTION_POLICY',
  'UNCATEGORIZED',
]);

const MLB_REJECT_MARKETS = Object.freeze([
  'f5_total',
  'full_game_total',
  'full_game_ml',
]);
const MLB_GAME_LINE_MARKETS = Object.freeze([
  { key: 'full_game_total', cardType: 'mlb-full-game' },
  { key: 'full_game_ml', cardType: 'mlb-full-game-ml' },
]);
const MLB_GAME_LINE_REASON_BUCKETS = Object.freeze([
  'no_card_row',
  'current_blocked',
  'current_projection_only',
  'current_non_publishable',
  'stale_snapshot',
  'stale_or_unverifiable_snapshot',
]);
const MLB_GAME_LINE_SAMPLE_LIMIT = 5;
const MLB_GAME_LINE_FALLBACK_MAX_AGE_MINUTES = Number(
  process.env.API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES || 90,
);
const MLB_GAME_LINE_ODDS_TOLERANCE_MINUTES = Number(
  process.env.API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES || 10,
);

function mapMlbCardTypeToRejectMarket(cardType) {
  if (cardType === 'mlb-f5') return 'f5_total';
  if (cardType === 'mlb-full-game') return 'full_game_total';
  if (cardType === 'mlb-full-game-ml') return 'full_game_ml';
  return null;
}

function classifyMlbRejectReasonFamily(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (!code) return 'UNCATEGORIZED';
  if (code.includes('STALE') || code.includes('SNAPSHOT_AGE') || code.includes('SNAPSHOT_MISSING')) {
    return 'DATA_STALENESS';
  }
  if (code.includes('NO_EDGE') || code.includes('EDGE_INSUFFICIENT') || code.includes('PASS_NO_EDGE')) {
    return 'NO_EDGE';
  }
  if (
    code.includes('INPUT') ||
    code.includes('MISSING') ||
    code.includes('UNAVAILABLE') ||
    code.includes('NO_MARKET') ||
    code.includes('CONTRACT')
  ) {
    return 'INPUT_FAILURE';
  }
  if (
    code.includes('PROJECTION_ONLY') ||
    code.includes('ROLL') ||
    code.includes('DISABLED') ||
    code.includes('QUARANTINE') ||
    code.includes('POLICY')
  ) {
    return 'EXECUTION_POLICY';
  }
  return 'UNCATEGORIZED';
}

function summarizeMlbRejectReasonFamilies(db, lookbackHours = 24) {
  const reasonFamilyCounts = MLB_REJECT_MARKETS.reduce((acc, market) => {
    acc[market] = MLB_REJECT_REASON_FAMILIES.reduce((families, family) => {
      families[family] = 0;
      return families;
    }, {});
    return acc;
  }, {});

  const rows = db
    .prepare(
      `SELECT
         card_type,
         json_extract(payload_data, '$.decision_v2.primary_reason_code') AS decision_reason,
         json_extract(payload_data, '$.pass_reason_code') AS pass_reason,
         json_extract(payload_data, '$.reason_codes') AS reason_codes_json,
         COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'MLB'
         AND card_type IN ('mlb-f5', 'mlb-full-game', 'mlb-full-game-ml')
         AND created_at > datetime('now', ?)
       GROUP BY 1, 2, 3, 4`,
    )
    .all(`-${lookbackHours} hours`);

  for (const row of rows) {
    const market = mapMlbCardTypeToRejectMarket(row.card_type);
    if (!market) continue;

    const codes = [];
    if (typeof row.decision_reason === 'string' && row.decision_reason.length > 0) {
      codes.push(row.decision_reason);
    }
    if (typeof row.pass_reason === 'string' && row.pass_reason.length > 0) {
      codes.push(row.pass_reason);
    }

    if (typeof row.reason_codes_json === 'string' && row.reason_codes_json.length > 0) {
      try {
        const parsed = JSON.parse(row.reason_codes_json);
        if (Array.isArray(parsed)) {
          for (const code of parsed) {
            if (typeof code === 'string' && code.length > 0) {
              codes.push(code);
            }
          }
        }
      } catch (_error) {
        // Keep deterministic fallback to UNCATEGORIZED when reason_codes is malformed.
      }
    }

    const family = codes.length > 0
      ? classifyMlbRejectReasonFamily(codes[0])
      : 'UNCATEGORIZED';
    reasonFamilyCounts[market][family] += Number(row.cnt || 0);
  }

  const uncategorizedCount = MLB_REJECT_MARKETS.reduce(
    (sum, market) => sum + Number(reasonFamilyCounts[market].UNCATEGORIZED || 0),
    0,
  );

  return {
    lookback_hours: lookbackHours,
    reason_family_counts: reasonFamilyCounts,
    uncategorized_count: uncategorizedCount,
  };
}

// ---------------------------------------------------------------------------
// TD-04: NHL market-call reject reason-family diagnostics
// ---------------------------------------------------------------------------

const NHL_REJECT_REASON_FAMILIES = Object.freeze([
  'DATA_STALENESS',
  'NO_EDGE',
  'INTEGRITY_VETO',
  'SUPPORT_FAIL',
  'CONTRACT_MISMATCH',
  'UNCATEGORIZED',
]);

const NHL_MARKET_CALL_CARD_TYPES = Object.freeze([
  'nhl-totals-call',
  'nhl-spread-call',
  'nhl-moneyline-call',
]);

function classifyNhlRejectReasonFamily(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (!code) return 'UNCATEGORIZED';
  if (code.includes('STALE') || code.includes('SNAPSHOT_AGE') || code.includes('SNAPSHOT_MISSING')) {
    return 'DATA_STALENESS';
  }
  if (
    code.includes('NO_EDGE') ||
    code.includes('EDGE_INSUFFICIENT') ||
    code.includes('PASS_NO_EDGE') ||
    code.includes('PASS_EXECUTION_GATE') ||
    code.includes('EDGE_VERIFICATION')
  ) {
    return 'NO_EDGE';
  }
  if (
    code.includes('GOALIE') ||
    code.includes('INJURY') ||
    code.includes('UNCERTAINTY') ||
    code.includes('INTEGRITY') ||
    code.includes('VETO') ||
    code.includes('VERIFICATION_REQUIRED') ||
    code.includes('CAUTION')
  ) {
    return 'INTEGRITY_VETO';
  }
  if (
    code.includes('SUPPORT') ||
    code.includes('INSUFFICIENT_DATA') ||
    code.includes('TOTAL_INSUFFICIENT')
  ) {
    return 'SUPPORT_FAIL';
  }
  if (
    code.includes('CONTRACT') ||
    code.includes('MARKET_UNAVAILABLE') ||
    code.includes('PROJECTION_ONLY') ||
    code.includes('NO_ODDS_MODE') ||
    code.includes('MISSING')
  ) {
    return 'CONTRACT_MISMATCH';
  }
  return 'UNCATEGORIZED';
}

function summarizeNhlRejectReasonFamilies(db, lookbackHours = 24) {
  const reasonFamilyCounts = NHL_MARKET_CALL_CARD_TYPES.reduce((acc, cardType) => {
    acc[cardType] = NHL_REJECT_REASON_FAMILIES.reduce((families, family) => {
      families[family] = 0;
      return families;
    }, {});
    return acc;
  }, {});

  const rows = db
    .prepare(
      `SELECT
         card_type,
         json_extract(payload_data, '$.decision_v2.primary_reason_code') AS decision_reason,
         json_extract(payload_data, '$.pass_reason_code') AS pass_reason,
         json_extract(payload_data, '$.reason_codes') AS reason_codes_json,
         COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'NHL'
         AND card_type IN ('nhl-totals-call', 'nhl-spread-call', 'nhl-moneyline-call')
         AND created_at > datetime('now', ?)
       GROUP BY 1, 2, 3, 4`,
    )
    .all(`-${lookbackHours} hours`);

  for (const row of rows) {
    const cardType = row.card_type;
    if (!reasonFamilyCounts[cardType]) continue;

    const codes = [];
    if (typeof row.decision_reason === 'string' && row.decision_reason.length > 0) {
      codes.push(row.decision_reason);
    }
    if (typeof row.pass_reason === 'string' && row.pass_reason.length > 0) {
      codes.push(row.pass_reason);
    }
    if (typeof row.reason_codes_json === 'string' && row.reason_codes_json.length > 0) {
      try {
        const parsed = JSON.parse(row.reason_codes_json);
        if (Array.isArray(parsed)) {
          for (const code of parsed) {
            if (typeof code === 'string' && code.length > 0) {
              codes.push(code);
            }
          }
        }
      } catch (_error) {
        // deterministic fallback to UNCATEGORIZED when reason_codes is malformed
      }
    }

    const family = codes.length > 0
      ? classifyNhlRejectReasonFamily(codes[0])
      : 'UNCATEGORIZED';
    reasonFamilyCounts[cardType][family] += Number(row.cnt || 0);
  }

  const uncategorizedCount = NHL_MARKET_CALL_CARD_TYPES.reduce(
    (sum, ct) => sum + Number(reasonFamilyCounts[ct].UNCATEGORIZED || 0),
    0,
  );

  return {
    lookback_hours: lookbackHours,
    reason_family_counts: reasonFamilyCounts,
    uncategorized_count: uncategorizedCount,
  };
}

function checkNhlMarketCallDiagnostics() {
  const db = getDatabase();
  const diag = summarizeNhlRejectReasonFamilies(db);
  const ok = diag.uncategorized_count === 0;
  const parts = NHL_MARKET_CALL_CARD_TYPES.map((ct) => {
    const counts = diag.reason_family_counts[ct];
    return `${ct}:[${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(',')}]`;
  });
  const reason = ok
    ? `NHL market call diagnostics: all blockers categorized (${parts.join(' ')})`
    : `NHL market call diagnostics: ${diag.uncategorized_count} uncategorized blocker(s) (${parts.join(' ')})`;
  writePipelineHealth('nhl', 'market_call_blockers', ok ? 'ok' : 'warning', reason);
  return { ok, reason, diagnostics: diag };
}

function checkNhlMoneylineCoverage({ lookaheadHours = 6, lookbackHours = 12 } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });

  const readSingleCount = (statement, ...args) => {
    if (statement && typeof statement.get === 'function') {
      const row = statement.get(...args);
      return Number(row?.cnt || 0);
    }
    if (statement && typeof statement.all === 'function') {
      const rows = statement.all(...args);
      return Number(rows?.[0]?.cnt || 0);
    }
    return 0;
  };

  const h2hGamesStmt = db.prepare(
    `SELECT COUNT(DISTINCT g.game_id) AS cnt
     FROM games g
     JOIN odds_snapshots o ON o.game_id = g.game_id
     WHERE g.sport = 'NHL'
       AND g.game_time_utc >= ?
       AND g.game_time_utc <= ?
       AND o.captured_at > datetime('now', ?)
       AND (o.h2h_home IS NOT NULL OR o.h2h_away IS NOT NULL)`,
  );
  const h2hGamesCount = readSingleCount(
    h2hGamesStmt,
    nowUtc.toISO(),
    endUtc.toISO(),
    `-${lookbackHours} hours`,
  );

  const mlCardsStmt = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM card_payloads
     WHERE sport = 'NHL'
       AND card_type = 'nhl-moneyline-call'
       AND created_at > datetime('now', ?)`,
  );
  const moneylineCardsCount = readSingleCount(mlCardsStmt, `-${lookbackHours} hours`);

  if (h2hGamesCount === 0) {
    const reason = `NHL moneyline coverage: no games with h2h odds in next ${lookaheadHours}h`;
    writePipelineHealth('nhl', 'moneyline_coverage', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        nhl_games_with_h2h_odds: 0,
        nhl_moneyline_cards_count: moneylineCardsCount,
        alert_code: null,
      },
    };
  }

  if (moneylineCardsCount === 0) {
    const reason = `NHL_ML_SURFACING_GAP: ${h2hGamesCount} game(s) with h2h odds in next ${lookaheadHours}h but 0 nhl-moneyline-call cards in last ${lookbackHours}h`;
    writePipelineHealth('nhl', 'moneyline_coverage', 'failed', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        nhl_games_with_h2h_odds: h2hGamesCount,
        nhl_moneyline_cards_count: 0,
        alert_code: 'NHL_ML_SURFACING_GAP',
      },
    };
  }

  const reason = `NHL moneyline coverage: ${h2hGamesCount} game(s) with h2h odds and ${moneylineCardsCount} nhl-moneyline-call card(s) in last ${lookbackHours}h`;
  writePipelineHealth('nhl', 'moneyline_coverage', 'ok', reason);
  return {
    ok: true,
    reason,
    diagnostics: {
      nhl_games_with_h2h_odds: h2hGamesCount,
      nhl_moneyline_cards_count: moneylineCardsCount,
      alert_code: null,
    },
  };
}

// ---------------------------------------------------------------------------
// TD-04: NBA market-call reject reason-family diagnostics
// ---------------------------------------------------------------------------

const NBA_REJECT_REASON_FAMILIES = Object.freeze([
  'DATA_STALENESS',
  'NO_EDGE',
  'INTEGRITY_VETO',
  'SUPPORT_FAIL',
  'POLICY_QUARANTINE',
  'CONTRACT_MISMATCH',
  'UNCATEGORIZED',
]);

const NBA_MARKET_CALL_CARD_TYPES = Object.freeze([
  'nba-totals-call',
  'nba-spread-call',
]);

function classifyNbaRejectReasonFamily(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (!code) return 'UNCATEGORIZED';
  if (code.includes('NBA_TOTAL_QUARANTINE_DEMOTE')) {
    return 'POLICY_QUARANTINE';
  }
  if (code.includes('STALE') || code.includes('SNAPSHOT_AGE') || code.includes('SNAPSHOT_MISSING')) {
    return 'DATA_STALENESS';
  }
  if (
    code.includes('NO_EDGE') ||
    code.includes('EDGE_INSUFFICIENT') ||
    code.includes('PASS_NO_EDGE') ||
    code.includes('PASS_EXECUTION_GATE') ||
    code.includes('EDGE_VERIFICATION')
  ) {
    return 'NO_EDGE';
  }
  if (
    code.includes('INJURY') ||
    code.includes('UNCERTAINTY') ||
    code.includes('INTEGRITY') ||
    code.includes('VETO') ||
    code.includes('VERIFICATION_REQUIRED') ||
    code.includes('CAUTION')
  ) {
    return 'INTEGRITY_VETO';
  }
  if (
    code.includes('SUPPORT') ||
    code.includes('INSUFFICIENT_DATA') ||
    code.includes('TOTAL_INSUFFICIENT')
  ) {
    return 'SUPPORT_FAIL';
  }
  if (
    code.includes('CONTRACT') ||
    code.includes('MARKET_UNAVAILABLE') ||
    code.includes('PROJECTION_ONLY') ||
    code.includes('NO_ODDS_MODE') ||
    code.includes('MISSING')
  ) {
    return 'CONTRACT_MISMATCH';
  }
  return 'UNCATEGORIZED';
}

function summarizeNbaRejectReasonFamilies(db, lookbackHours = 24) {
  const reasonFamilyCounts = NBA_MARKET_CALL_CARD_TYPES.reduce((acc, cardType) => {
    acc[cardType] = NBA_REJECT_REASON_FAMILIES.reduce((families, family) => {
      families[family] = 0;
      return families;
    }, {});
    return acc;
  }, {});

  const rows = db
    .prepare(
      `SELECT
         card_type,
         json_extract(payload_data, '$.decision_v2.primary_reason_code') AS decision_reason,
         json_extract(payload_data, '$.pass_reason_code') AS pass_reason,
         json_extract(payload_data, '$.reason_codes') AS reason_codes_json,
         COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'NBA'
         AND card_type IN ('nba-totals-call', 'nba-spread-call')
         AND created_at > datetime('now', ?)
       GROUP BY 1, 2, 3, 4`,
    )
    .all(`-${lookbackHours} hours`);

  for (const row of rows) {
    const cardType = row.card_type;
    if (!reasonFamilyCounts[cardType]) continue;

    const codes = [];
    if (typeof row.decision_reason === 'string' && row.decision_reason.length > 0) {
      codes.push(row.decision_reason);
    }
    if (typeof row.pass_reason === 'string' && row.pass_reason.length > 0) {
      codes.push(row.pass_reason);
    }
    if (typeof row.reason_codes_json === 'string' && row.reason_codes_json.length > 0) {
      try {
        const parsed = JSON.parse(row.reason_codes_json);
        if (Array.isArray(parsed)) {
          for (const code of parsed) {
            if (typeof code === 'string' && code.length > 0) {
              codes.push(code);
            }
          }
        }
      } catch (_error) {
        // deterministic fallback to UNCATEGORIZED when reason_codes is malformed
      }
    }

    const family = codes.length > 0
      ? classifyNbaRejectReasonFamily(codes[0])
      : 'UNCATEGORIZED';
    reasonFamilyCounts[cardType][family] += Number(row.cnt || 0);
  }

  const uncategorizedCount = NBA_MARKET_CALL_CARD_TYPES.reduce(
    (sum, ct) => sum + Number(reasonFamilyCounts[ct].UNCATEGORIZED || 0),
    0,
  );

  return {
    lookback_hours: lookbackHours,
    reason_family_counts: reasonFamilyCounts,
    uncategorized_count: uncategorizedCount,
  };
}

function checkNbaMarketCallDiagnostics() {
  const db = getDatabase();
  const diag = summarizeNbaRejectReasonFamilies(db);
  const ok = diag.uncategorized_count === 0;
  const parts = NBA_MARKET_CALL_CARD_TYPES.map((ct) => {
    const counts = diag.reason_family_counts[ct];
    return `${ct}:[${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(',')}]`;
  });
  const reason = ok
    ? `NBA market call diagnostics: all blockers categorized (${parts.join(' ')})`
    : `NBA market call diagnostics: ${diag.uncategorized_count} uncategorized blocker(s) (${parts.join(' ')})`;
  writePipelineHealth('nba', 'market_call_blockers', ok ? 'ok' : 'warning', reason);
  return { ok, reason, diagnostics: diag };
}

function checkNbaMoneylineCoverage({ lookaheadHours = 6, lookbackHours = 12 } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });

  const upcomingGames = db
    .prepare(
      `SELECT game_id, sport, game_time_utc
       FROM games
       WHERE sport = 'NBA'
         AND game_time_utc >= ?
         AND game_time_utc <= ?
       ORDER BY game_time_utc ASC`,
    )
    .all(nowUtc.toISO(), endUtc.toISO());

  if (!Array.isArray(upcomingGames) || upcomingGames.length === 0) {
    const reason = `NBA moneyline coverage: no NBA games in next ${lookaheadHours}h`;
    writePipelineHealth('nba', 'moneyline_coverage', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        nba_games_with_spread_or_total: 0,
        nba_games_missing_ml: 0,
        nba_moneyline_cards_count: 0,
        alert_code: null,
      },
    };
  }

  let gamesWithSpreadOrTotal = 0;
  let gamesMissingMl = 0;
  const sampleMissingGameIds = [];

  for (const game of upcomingGames) {
    const snapshot = getLatestOddsSnapshot(db, game.game_id);
    if (!snapshot) continue;

    const hasSpreadOrTotal =
      snapshot.spread_home != null ||
      snapshot.spread_away != null ||
      snapshot.total != null;
    const hasMoneyline = snapshot.h2h_home != null || snapshot.h2h_away != null;

    if (!hasSpreadOrTotal) continue;
    gamesWithSpreadOrTotal += 1;
    if (!hasMoneyline) {
      gamesMissingMl += 1;
      if (sampleMissingGameIds.length < 5) {
        sampleMissingGameIds.push(game.game_id);
      }
    }
  }

  const mlCardsRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM card_payloads
       WHERE sport = 'NBA'
         AND card_type = 'nba-moneyline-call'
         AND created_at > datetime('now', ?)`,
    )
    .get(`-${lookbackHours} hours`);
  const moneylineCardsCount = Number(mlCardsRow?.cnt || 0);

  if (gamesWithSpreadOrTotal === 0) {
    const reason =
      `NBA moneyline coverage: no games with spread/total odds in next ${lookaheadHours}h`;
    writePipelineHealth('nba', 'moneyline_coverage', 'ok', reason);
    return {
      ok: true,
      reason,
      diagnostics: {
        nba_games_with_spread_or_total: 0,
        nba_games_missing_ml: 0,
        nba_moneyline_cards_count: moneylineCardsCount,
        alert_code: null,
      },
    };
  }

  if (gamesMissingMl > 0) {
    const reason =
      `NBA_ML_MISSING_WITH_OTHER_MARKETS: ${gamesMissingMl}/${gamesWithSpreadOrTotal} game(s) have spread/total odds but missing moneyline in next ${lookaheadHours}h` +
      (sampleMissingGameIds.length > 0
        ? ` (sample=${sampleMissingGameIds.join(',')})`
        : '');
    writePipelineHealth('nba', 'moneyline_coverage', 'warning', reason);
    return {
      ok: false,
      reason,
      diagnostics: {
        nba_games_with_spread_or_total: gamesWithSpreadOrTotal,
        nba_games_missing_ml: gamesMissingMl,
        nba_moneyline_cards_count: moneylineCardsCount,
        sample_game_ids: sampleMissingGameIds,
        alert_code: 'NBA_ML_MISSING_WITH_OTHER_MARKETS',
      },
    };
  }

  const reason =
    `NBA moneyline coverage: ${gamesWithSpreadOrTotal} game(s) have spread/total+moneyline odds in next ${lookaheadHours}h`;
  writePipelineHealth('nba', 'moneyline_coverage', 'ok', reason);
  return {
    ok: true,
    reason,
    diagnostics: {
      nba_games_with_spread_or_total: gamesWithSpreadOrTotal,
      nba_games_missing_ml: 0,
      nba_moneyline_cards_count: moneylineCardsCount,
      alert_code: null,
    },
  };
}

/**
 * Check 4: MLB F5 market availability
 * For upcoming MLB games in the near T-minus window, report F5 total
 * availability separately
 * from full-game totals so watchdog output matches MLB market intent.
 *
 * Games within T-15min of gametime are excluded: F5 markets close before
 * gametime so their absence at that point is expected, not a pipeline failure.
 */
function checkMlbF5MarketAvailability({ expectF5Ml = false } = {}) {
  // In true without-odds mode, F5 market data will never be present in
  // odds_snapshots and the check would fail spuriously.
  if (!ODDS_SPORTS_CONFIG.MLB.active) {
    const skipReason = 'MLB odds inactive — F5 market check skipped';
    writePipelineHealth('mlb', 'f5_market_availability', 'ok', skipReason);
    return {
      ok: true,
      reason: skipReason,
      games_checked: 0,
      missing_f5_total_count: 0,
      missing_full_game_total_count: 0,
      expected_f5_ml_count: 0,
      missing_f5_ml_count: 0,
    };
  }

  const configuredMlbMarkets = Array.isArray(ODDS_SPORTS_CONFIG?.MLB?.markets)
    ? ODDS_SPORTS_CONFIG.MLB.markets.map((market) =>
        String(market || '').toLowerCase(),
      )
    : [];
  const enforceF5Totals = configuredMlbMarkets.some((market) =>
    [
      'totals_1st_5_innings',
      'totals_f5',
      'first_5_totals',
      'f5_totals',
    ].includes(market),
  );

  const db = getDatabase();
  const nowUtc = DateTime.utc();
  // Exclude games within 15 minutes of start — F5 markets are already closed
  const checkFromUtc = nowUtc.plus({ minutes: 15 });
  const endUtc = nowUtc.plus({ hours: MLB_F5_ALERT_WINDOW_HOURS });
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
      reason: `No MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h`,
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
  const rejectReasonDiagnostics = summarizeMlbRejectReasonFamilies(db);

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

    if (enforceF5Totals && !availability.f5_line_ok) {
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

  const reasonParts = [];
  if (enforceF5Totals) {
    const f5Reason =
      missingF5Total.length === 0
        ? `F5 totals available for all ${upcomingGames.length} MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h`
        : `${missingF5Total.length}/${upcomingGames.length} MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h missing F5 totals`;
    reasonParts.push(f5Reason);
  } else {
    reasonParts.push('F5 totals not enforced (disabled in odds featured-market config)');
  }

  if (missingFullGameTotal.length > 0) {
    reasonParts.push(
      `${missingFullGameTotal.length}/${upcomingGames.length} MLB games within T-${MLB_F5_ALERT_WINDOW_HOURS}h missing full-game totals`,
    );
  }
  if (expectedF5MlCount > 0) {
    reasonParts.push(
      `${missingF5Ml.length}/${expectedF5MlCount} missing F5 ML`,
    );
  }
  reasonParts.push(
    `reason families uncategorized=${rejectReasonDiagnostics.uncategorized_count}`,
  );

  const reason = reasonParts.join('; ');

  const hardFailF5 = enforceF5Totals && missingF5Total.length > 0;
  const hardFailFullGame =
    missingFullGameTotal.length > 0 &&
    missingFullGameTotal.length === upcomingGames.length;
  const warnFullGame =
    missingFullGameTotal.length > 0 && !hardFailFullGame;

  if (hardFailF5 || hardFailFullGame) {
    writePipelineHealth('mlb', 'f5_market_availability', 'failed', reason);
  } else if (warnFullGame) {
    writePipelineHealth('mlb', 'f5_market_availability', 'warning', reason);
  } else if (upcomingGames.length > 0) {
    writePipelineHealth('mlb', 'f5_market_availability', 'ok', reason);
  }

  return {
    ok: !(hardFailF5 || hardFailFullGame),
    reason,
    games_checked: upcomingGames.length,
    missing_f5_total_count: missingF5Total.length,
    missing_f5_total_games: missingF5Total,
    missing_full_game_total_count: missingFullGameTotal.length,
    missing_full_game_total_games: missingFullGameTotal,
    expected_f5_ml_count: expectedF5MlCount,
    missing_f5_ml_count: missingF5Ml.length,
    missing_f5_ml_games: missingF5Ml,
    reject_reason_diagnostics: rejectReasonDiagnostics,
  };
}

function parseMlbCardPayload(payloadData) {
  if (typeof payloadData !== 'string' || payloadData.length === 0) return null;
  try {
    return JSON.parse(payloadData);
  } catch (_error) {
    return null;
  }
}

function getMlbOfficialStatus(payload) {
  const d2 = payload && typeof payload.decision_v2 === 'object' ? payload.decision_v2 : null;
  const canonical = d2 && typeof d2.canonical_envelope_v2 === 'object'
    ? d2.canonical_envelope_v2
    : null;
  const fromCanonical = typeof canonical?.official_status === 'string'
    ? canonical.official_status.toUpperCase()
    : null;
  if (fromCanonical === 'PLAY' || fromCanonical === 'LEAN' || fromCanonical === 'PASS') {
    return fromCanonical;
  }
  const fromD2 = typeof d2?.official_status === 'string' ? d2.official_status.toUpperCase() : null;
  if (fromD2 === 'PLAY' || fromD2 === 'LEAN' || fromD2 === 'PASS') return fromD2;
  return null;
}

function hasMlbSelection(payload) {
  const d2 = payload && typeof payload.decision_v2 === 'object' ? payload.decision_v2 : null;
  const canonical = d2 && typeof d2.canonical_envelope_v2 === 'object'
    ? d2.canonical_envelope_v2
    : null;
  const side = String(
    canonical?.selection_side ||
      d2?.selection_side ||
      payload?.selection?.side ||
      payload?.prediction ||
      '',
  ).toUpperCase();
  return side !== '' && side !== 'NONE' && side !== 'NEUTRAL';
}

function hasMarketLineContext(payload, marketKey) {
  const oddsContext = payload && typeof payload.odds_context === 'object' ? payload.odds_context : null;
  const wager =
    payload &&
    typeof payload.market_context === 'object' &&
    payload.market_context &&
    typeof payload.market_context.wager === 'object'
      ? payload.market_context.wager
      : null;

  if (marketKey === 'full_game_total') {
    const line = Number(
      payload?.line ?? payload?.total_line ?? wager?.called_line ?? oddsContext?.total,
    );
    const price = Number(payload?.price ?? payload?.juice ?? wager?.called_price);
    return Number.isFinite(line) && Number.isFinite(price);
  }

  const mlHome = Number(payload?.ml_home ?? payload?.h2h_home ?? oddsContext?.h2h_home);
  const mlAway = Number(payload?.ml_away ?? payload?.h2h_away ?? oddsContext?.h2h_away);
  return Number.isFinite(mlHome) && Number.isFinite(mlAway);
}

function evaluateMlbGameLinePublishability({ row, payload, marketKey, latestOddsCapturedAt, nowUtc }) {
  const basis = String(payload?.basis || '').toUpperCase();
  const executionStatus = String(payload?.execution_status || '').toUpperCase();
  const officialStatus = getMlbOfficialStatus(payload);

  if (executionStatus === 'BLOCKED') {
    return { publishable: false, bucket: 'current_blocked' };
  }
  if (executionStatus === 'PROJECTION_ONLY') {
    return { publishable: false, bucket: 'current_projection_only' };
  }
  if (executionStatus !== 'EXECUTABLE') {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (basis !== 'ODDS_BACKED') {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (officialStatus !== 'PLAY' && officialStatus !== 'LEAN') {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (payload?.execution_gate?.drop_reason) {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (!hasMlbSelection(payload)) {
    return { publishable: false, bucket: 'current_non_publishable' };
  }
  if (!hasMarketLineContext(payload, marketKey)) {
    return { publishable: false, bucket: 'current_non_publishable' };
  }

  const snapshotAtRaw = payload?.snapshot_at || payload?.captured_at || payload?.created_at || row.created_at;
  const snapshotAt = snapshotAtRaw ? DateTime.fromISO(String(snapshotAtRaw), { zone: 'utc' }) : null;
  if (!snapshotAt || !snapshotAt.isValid || !latestOddsCapturedAt) {
    return { publishable: false, bucket: 'stale_or_unverifiable_snapshot' };
  }

  const snapshotAgeMinutes = nowUtc.diff(snapshotAt, 'minutes').minutes;
  if (!Number.isFinite(snapshotAgeMinutes) || snapshotAgeMinutes < 0) {
    return { publishable: false, bucket: 'stale_or_unverifiable_snapshot' };
  }
  if (snapshotAgeMinutes > MLB_GAME_LINE_FALLBACK_MAX_AGE_MINUTES) {
    return { publishable: false, bucket: 'stale_snapshot' };
  }

  const latestOddsAt = DateTime.fromISO(String(latestOddsCapturedAt), { zone: 'utc' });
  if (!latestOddsAt.isValid) {
    return { publishable: false, bucket: 'stale_or_unverifiable_snapshot' };
  }

  const oddsDeltaMinutes = latestOddsAt.diff(snapshotAt, 'minutes').minutes;
  if (oddsDeltaMinutes > MLB_GAME_LINE_ODDS_TOLERANCE_MINUTES) {
    return { publishable: false, bucket: 'stale_snapshot' };
  }

  return { publishable: true, bucket: null };
}

function checkMlbGameLineCoverage({ lookaheadHours = MLB_F5_ALERT_WINDOW_HOURS } = {}) {
  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const endUtc = nowUtc.plus({ hours: lookaheadHours });
  const checkFromUtc = nowUtc.plus({ minutes: 15 });

  const upcomingGames = db
    .prepare(
      `SELECT game_id, game_time_utc, home_team, away_team
       FROM games
       WHERE LOWER(sport) = 'mlb'
         AND game_time_utc >= ?
         AND game_time_utc <= ?`,
    )
    .all(checkFromUtc.toISO(), endUtc.toISO());

  const diagnostics = {
    full_game_total: {
      games_with_odds: 0,
      current_publishable_count: 0,
      fallback_publishable_count: 0,
      missing_count: 0,
    },
    full_game_ml: {
      games_with_odds: 0,
      current_publishable_count: 0,
      fallback_publishable_count: 0,
      missing_count: 0,
    },
  };

  const reasonBuckets = MLB_GAME_LINE_REASON_BUCKETS.reduce((acc, bucket) => {
    acc[bucket] = { count: 0, sample_game_ids: [] };
    return acc;
  }, {});

  const registerReason = (bucket, gameId) => {
    const target = reasonBuckets[bucket];
    if (!target) return;
    target.count += 1;
    if (
      target.sample_game_ids.length < MLB_GAME_LINE_SAMPLE_LIMIT &&
      !target.sample_game_ids.includes(gameId)
    ) {
      target.sample_game_ids.push(gameId);
    }
  };

  const latestRunId = db
    .prepare(
      `SELECT run_id
       FROM card_payloads
       WHERE sport = 'MLB'
         AND run_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get()?.run_id;

  for (const game of upcomingGames) {
    const latestOdds = getLatestOddsSnapshot(db, game.game_id);
    const latestOddsCapturedAt = latestOdds?.captured_at || null;
    const hasTotalOdds = Number.isFinite(Number(latestOdds?.total));
    const hasMlOdds =
      Number.isFinite(Number(latestOdds?.h2h_home)) &&
      Number.isFinite(Number(latestOdds?.h2h_away));

    for (const market of MLB_GAME_LINE_MARKETS) {
      const marketOddsAvailable =
        market.key === 'full_game_total' ? hasTotalOdds : hasMlOdds;
      if (!marketOddsAvailable) continue;

      diagnostics[market.key].games_with_odds += 1;

      const rows = db
        .prepare(
          `SELECT id, game_id, card_type, payload_data, created_at, run_id
           FROM card_payloads
           WHERE game_id = ?
             AND card_type = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 25`,
        )
        .all(game.game_id, market.cardType);

      if (rows.length === 0) {
        diagnostics[market.key].missing_count += 1;
        registerReason('no_card_row', game.game_id);
        continue;
      }

      const currentRow = latestRunId
        ? rows.find((row) => row.run_id && row.run_id === latestRunId) || null
        : rows[0] || null;

      if (currentRow) {
        const payload = parseMlbCardPayload(currentRow.payload_data);
        if (!payload) {
          diagnostics[market.key].missing_count += 1;
          registerReason('current_non_publishable', game.game_id);
          continue;
        }
        const currentEval = evaluateMlbGameLinePublishability({
          row: currentRow,
          payload,
          marketKey: market.key,
          latestOddsCapturedAt,
          nowUtc,
        });
        if (currentEval.publishable) {
          diagnostics[market.key].current_publishable_count += 1;
          continue;
        }

        if (currentEval.bucket) {
          registerReason(currentEval.bucket, game.game_id);
        }

        const fallbackCandidate = rows.find((row) => {
          if (latestRunId && row.run_id && row.run_id === latestRunId) return false;
          const fallbackPayload = parseMlbCardPayload(row.payload_data);
          if (!fallbackPayload) return false;
          return evaluateMlbGameLinePublishability({
            row,
            payload: fallbackPayload,
            marketKey: market.key,
            latestOddsCapturedAt,
            nowUtc,
          }).publishable;
        });

        if (fallbackCandidate) {
          diagnostics[market.key].fallback_publishable_count += 1;
        } else {
          diagnostics[market.key].missing_count += 1;
        }
      }
    }
  }

  const rejectReasonDiagnostics = summarizeMlbRejectReasonFamilies(db);
  const missingTotal =
    diagnostics.full_game_total.missing_count + diagnostics.full_game_ml.missing_count;
  const status = missingTotal > 0 ? 'warning' : 'ok';
  const reason =
    missingTotal > 0
      ? `MLB game-line coverage missing=${missingTotal}; uncategorized reject families=${rejectReasonDiagnostics.uncategorized_count}`
      : `MLB game-line coverage complete; uncategorized reject families=${rejectReasonDiagnostics.uncategorized_count}`;

  writePipelineHealth('mlb', 'game_line_coverage', status, reason);
  return {
    ok: missingTotal === 0,
    reason,
    markets: diagnostics,
    reason_buckets: reasonBuckets,
    reject_reason_diagnostics: rejectReasonDiagnostics,
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

function checkMlbSeedFreshness(maxAgeMinutes = SEED_FRESHNESS_MAX_AGE_MINUTES) {
  const mlbWithoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true';

  if (!mlbWithoutOddsMode) {
    const reason = 'MLB live-odds mode active - seed freshness check skipped';
    writePipelineHealth('mlb', 'seed_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const db = getDatabase();
  const nowUtc = DateTime.utc();
  const horizonUtc = nowUtc.plus({ hours: 6 });
  const upcomingCount = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM games
       WHERE LOWER(sport) = 'mlb'
         AND game_time_utc >= ?
         AND game_time_utc <= ?`,
    )
    .get(nowUtc.toISO(), horizonUtc.toISO()).cnt;

  if (upcomingCount === 0) {
    const reason = 'No MLB games within T-6h - seed freshness check skipped';
    writePipelineHealth('mlb', 'seed_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const thresholdDesc =
    maxAgeMinutes >= 60
      ? `${Math.round(maxAgeMinutes / 60)}h`
      : `${maxAgeMinutes}m`;
  const recentlyRan = wasJobRecentlySuccessful(
    'pull_espn_games_direct',
    maxAgeMinutes,
  );

  if (recentlyRan) {
    const reason = `pull_espn_games_direct ran successfully within last ${thresholdDesc} (${upcomingCount} upcoming MLB games)`;
    writePipelineHealth('mlb', 'seed_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  const reason = `pull_espn_games_direct has NOT run successfully in last ${thresholdDesc} — ${upcomingCount} upcoming MLB games at risk`;
  writePipelineHealth('mlb', 'seed_freshness', 'failed', reason);
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
  const horizonUtc = nowUtc.plus({ hours: MODEL_FRESHNESS_ALERT_WINDOW_HOURS });

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
      reason: `No ${sport.toUpperCase()} games within T-${MODEL_FRESHNESS_ALERT_WINDOW_HOURS}h - model check skipped`,
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
 * Check: Calibration kill switch state
 * Queries calibration_reports for any active kill switches.
 * Returns gracefully if the table does not exist (dev environment).
 */
function checkCalibrationKillSwitches() {
  try {
    const db = getDatabase();
    // Latest row per market
    const rows = db
      .prepare(
        `SELECT market, kill_switch_active, ece, n_samples, computed_at
         FROM calibration_reports
         GROUP BY market
         HAVING computed_at = MAX(computed_at)
         ORDER BY market`,
      )
      .all();

    const calibrationRows = rows.map((row) => ({
      market: row.market,
      kill_switch_active: Number(row.kill_switch_active || 0),
      ece: row.ece,
      n_samples: row.n_samples,
      computed_at: row.computed_at,
    }));

    const activeSwitches = calibrationRows.filter((r) => r.kill_switch_active === 1);

    if (activeSwitches.length > 0) {
      const detail = activeSwitches
        .map((r) => `${r.market}(ECE=${r.ece},n=${r.n_samples})`)
        .join(', ');
      const reason = `CALIB_KILL_SWITCH_ACTIVE — ${activeSwitches.length} market(s) suppressed: ${detail}`;
      writePipelineHealth('calibration', 'kill_switch', 'warning', reason);
      return {
        ok: false,
        reason,
        calibrationKillSwitches: activeSwitches,
        calibrationRows,
      };
    }

    const detail = calibrationRows
      .map((r) => `${r.market}(ECE=${r.ece},n=${r.n_samples},kill=${r.kill_switch_active})`)
      .join(', ');
    const reason = calibrationRows.length === 0
      ? 'No calibration_reports rows found'
      : `${calibrationRows.length} market(s) calibration OK — no active kill switches: ${detail}`;
    if (calibrationRows.length > 0) {
      writePipelineHealth('calibration', 'kill_switch', 'ok', reason);
    }
    return { ok: true, reason, calibrationKillSwitches: [], calibrationRows };
  } catch (_err) {
    // Table may not exist in dev — skip gracefully
    return {
      ok: true,
      reason: 'calibration_reports table absent — skipped',
      calibrationKillSwitches: [],
      calibrationRows: [],
    };
  }
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

function writeOverallDegradedState(results) {
  const failingChecks = Object.entries(results)
    .filter(([, result]) => result && result.ok === false)
    .map(([checkName]) => checkName);

  if (failingChecks.length === 0) {
    writePipelineHealth('watchdog', 'degraded_state', 'ok', 'Pipeline healthy: all checks passed');
    return;
  }

  const summary = failingChecks.slice(0, 6).join(', ');
  const suffix = failingChecks.length > 6 ? ` (+${failingChecks.length - 6} more)` : '';
  writePipelineHealth(
    'watchdog',
    'degraded_state',
    'failed',
    `Pipeline degraded: ${failingChecks.length} failing check(s): ${summary}${suffix}`,
  );
}

/**
 * Self-check: alert when check_pipeline_health hasn't run successfully in > 2h.
 * Writes a pipeline_health row with phase='watchdog', check_name='heartbeat'.
 */
async function checkWatchdogHeartbeat() {
  const db = getDatabase();
  const prev = db
    .prepare(
      `SELECT started_at FROM job_runs
       WHERE job_name = 'check_pipeline_health' AND status = 'success'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get();

  if (!prev) return; // First ever run — skip

  const gapMs = Date.now() - new Date(prev.started_at).getTime();
  const gapH = (gapMs / 3600000).toFixed(1);
  const isGap = gapMs > 2 * 60 * 60 * 1000;

  writePipelineHealth(
    'watchdog',
    'heartbeat',
    isGap ? 'warning' : 'ok',
    isGap
      ? `Last watchdog run was ${gapH}h ago`
      : `Heartbeat OK (${gapH}h since last run)`,
  );

  if (isGap && process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG !== 'false') {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn('[check_pipeline_health] DISCORD_ALERT_WEBHOOK_URL not set — skipping watchdog heartbeat alert');
    } else {
      const message = buildHealthAlertMessage([{
        phase: 'watchdog',
        checkName: 'heartbeat',
        reason: `check_pipeline_health gap: ${gapH}h (threshold: 2h)`,
      }]);
      await sendDiscordMessages({ webhookUrl, messages: [message] });
      console.warn(`[check_pipeline_health] Watchdog heartbeat alert sent — ${gapH}h gap`);
    }
  }
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

    await checkWatchdogHeartbeat();

    const checks = {
      schedule_freshness: checkScheduleFreshness,
      odds_freshness: checkOddsFreshness,
      cards_freshness: checkCardsFreshness,
      mlb_f5_market_availability: checkMlbF5MarketAvailability,
      mlb_game_line_coverage: checkMlbGameLineCoverage,
      mlb_seed_freshness: () => checkMlbSeedFreshness(),
      settlement_backlog: checkSettlementBacklog,
      // Per-sport model freshness (only fires when upcoming games exist for that sport)
      // Uses 4x moneyline hardMax from contract per operational policy (stricter health check)
      nhl_model_freshness: () =>
        checkSportModelFreshness('nhl', 'run_nhl_model', 'model_freshness', getModelFreshnessMaxAgeMinutes()),
      nhl_market_call_diagnostics: checkNhlMarketCallDiagnostics,
      nhl_moneyline_coverage: checkNhlMoneylineCoverage,
      nhl_sog_sync_freshness: checkNhlSogSyncFreshness,
      nhl_sog_pull_freshness: checkNhlSogPullFreshness,
      nhl_shots_model_freshness: () =>
        checkSportModelFreshness('nhl', 'run-nhl-player-shots-model', 'shots_model_freshness', getModelFreshnessMaxAgeMinutes()),
      nhl_blk_rates_nst_freshness: checkNhlBlkRatesFreshness,
      nhl_blk_rates_moneypuck_freshness: checkNhlMoneyPuckBlkRatesFreshness,
      nhl_blk_source_integrity: checkNhlBlkSourceIntegrity,
      nba_model_freshness: () =>
        checkSportModelFreshness('nba', 'run_nba_model', 'model_freshness', getModelFreshnessMaxAgeMinutes()),
      nba_market_call_diagnostics: checkNbaMarketCallDiagnostics,
      nba_moneyline_coverage: checkNbaMoneylineCoverage,
      mlb_model_freshness: () =>
        checkSportModelFreshness('mlb', 'run_mlb_model', 'model_freshness', getModelFreshnessMaxAgeMinutes()),
      calibration_kill_switches: checkCalibrationKillSwitches,
    };

    const results = {};
    let allOk = true;

    for (const [checkName, checkFn] of Object.entries(checks)) {
      const result = await checkFn();
      results[checkName] = result;

      if (result.ok) {
        console.log(`  ✓ ${checkName}: ${result.reason}`);
      } else {
        console.warn(`  ⚠️  ${checkName}: ${result.reason}`);
        allOk = false;
      }
    }

    // Persist a run-level degraded/healthy state so the latest system posture is
    // visible even after worker restarts.
    writeOverallDegradedState(results);

    // --- Discord watchdog alert ---
    if (process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG !== 'false' && !allOk) {
      const checkPhaseLookup = {
        schedule_freshness: ['schedule', 'freshness'],
        odds_freshness: ['odds', 'freshness'],
        cards_freshness: ['cards', 'freshness'],
        mlb_f5_market_availability: ['mlb', 'f5_market_availability'],
        mlb_game_line_coverage: ['mlb', 'game_line_coverage'],
        mlb_seed_freshness: ['mlb', 'seed_freshness'],
        settlement_backlog: ['settlement', 'backlog'],
        nhl_model_freshness: ['nhl', 'model_freshness'],
        nhl_market_call_diagnostics: ['nhl', 'market_call_blockers'],
        nhl_moneyline_coverage: ['nhl', 'moneyline_coverage'],
        nhl_sog_sync_freshness: ['nhl', 'sog_sync_freshness'],
        nhl_sog_pull_freshness: ['nhl', 'sog_pull_freshness'],
        nhl_shots_model_freshness: ['nhl', 'shots_model_freshness'],
        nhl_blk_rates_nst_freshness: ['nhl', 'blk_rates_nst_freshness'],
        nhl_blk_rates_moneypuck_freshness: ['nhl', 'blk_rates_moneypuck_freshness'],
        nhl_blk_source_integrity: ['nhl', 'blk_source_integrity'],
        nba_model_freshness: ['nba', 'model_freshness'],
        nba_market_call_diagnostics: ['nba', 'market_call_blockers'],
        nba_moneyline_coverage: ['nba', 'moneyline_coverage'],
        mlb_model_freshness: ['mlb', 'model_freshness'],
        calibration_kill_switches: ['calibration', 'kill_switch'],
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
        const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
        if (!webhookUrl) {
          console.warn('[check_pipeline_health] DISCORD_ALERT_WEBHOOK_URL not set — skipping Discord alert');
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

    const calibrationKillSwitches = (results.calibration_kill_switches?.calibrationKillSwitches) || [];
    const calibrationRows = (results.calibration_kill_switches?.calibrationRows) || [];
    if (calibrationRows.length > 0) {
      console.log(
        `[check_pipeline_health] Calibration rows: ${calibrationRows.map((r) => `${r.market}(ECE=${r.ece},n=${r.n_samples},kill=${r.kill_switch_active})`).join(', ')}`,
      );
    }
    if (calibrationKillSwitches.length > 0) {
      console.warn(`[check_pipeline_health] CALIB_KILL_SWITCH_ACTIVE: ${calibrationKillSwitches.map((r) => r.market).join(', ')}`);
    }
    return { allOk, summary, calibrationKillSwitches, calibrationRows };
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

function checkNhlSogSyncFreshness() {
  if (!isFeatureEnabled('nhl', 'sog-sync')) {
    const reason = 'sync_nhl_sog_player_ids feature disabled';
    writePipelineHealth('nhl', 'sog_sync_freshness', 'ok', reason);
    return { ok: true, reason };
  }
  return checkSportModelFreshness('nhl', 'sync_nhl_sog_player_ids', 'sog_sync_freshness', 1440);
}

function checkNhlSogPullFreshness() {
  return checkSportModelFreshness('nhl', 'pull_nhl_player_shots', 'sog_pull_freshness', 1440);
}

function getLatestBlkSchemaDriftFailure(jobName, lookbackHours = 72) {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT started_at, error_message
       FROM job_runs
       WHERE job_name = ?
         AND status = 'failed'
         AND started_at >= datetime('now', ?)
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(jobName, `-${lookbackHours} hours`);
}

function checkNhlBlkSourceIntegrity() {
  if (!isFeatureEnabled('nhl', 'blk-ingest')) {
    const reason = 'NHL BLK ingest feature disabled';
    writePipelineHealth('nhl', 'blk_source_integrity', 'ok', reason);
    return { ok: true, reason };
  }

  const failures = [];
  const nstFailure = getLatestBlkSchemaDriftFailure('pull_nst_blk_rates');
  const moneypuckFailure = getLatestBlkSchemaDriftFailure('pull_moneypuck_blk_rates');
  const isSchemaDriftMessage = (value) => /schema[_\s-]?drift|missing required headers/i.test(String(value || ''));

  if (nstFailure && isSchemaDriftMessage(nstFailure.error_message)) {
    failures.push(`NST schema drift at ${nstFailure.started_at}`);
  }
  if (moneypuckFailure && isSchemaDriftMessage(moneypuckFailure.error_message)) {
    failures.push(`MoneyPuck schema drift at ${moneypuckFailure.started_at}`);
  }

  if (failures.length > 0) {
    const reason = `BLK source integrity failure: ${failures.join('; ')}`;
    writePipelineHealth('nhl', 'blk_source_integrity', 'failed', reason);
    return { ok: false, reason };
  }

  const reason = 'BLK source integrity checks passed (no recent schema-drift failures)';
  writePipelineHealth('nhl', 'blk_source_integrity', 'ok', reason);
  return { ok: true, reason };
}

function checkNhlBlkRatesFreshness() {
  if (!isFeatureEnabled('nhl', 'blk-ingest')) {
    const reason = 'NHL BLK ingest feature disabled';
    writePipelineHealth('nhl', 'blk_rates_nst_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  return checkSportModelFreshness(
    'nhl',
    'pull_nst_blk_rates',
    'blk_rates_nst_freshness',
    NHL_BLK_RATES_MAX_AGE_HOURS * 60,
  );
}

function checkNhlMoneyPuckBlkRatesFreshness() {
  if (!isFeatureEnabled('nhl', 'blk-ingest')) {
    const reason = 'NHL BLK ingest feature disabled';
    writePipelineHealth('nhl', 'blk_rates_moneypuck_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  if (!isFeatureEnabled('nhl', 'moneypuck-blk')) {
    const reason = 'MoneyPuck BLK feature disabled';
    writePipelineHealth('nhl', 'blk_rates_moneypuck_freshness', 'ok', reason);
    return { ok: true, reason };
  }

  return checkSportModelFreshness(
    'nhl',
    'pull_moneypuck_blk_rates',
    'blk_rates_moneypuck_freshness',
    NHL_BLK_RATES_MAX_AGE_HOURS * 60,
  );
}

module.exports = {
  writePipelineHealth,
  writeOverallDegradedState,
  checkPipelineHealth,
  checkNhlSogSyncFreshness,
  checkNhlSogPullFreshness,
  checkNhlBlkSourceIntegrity,
  checkNhlBlkRatesFreshness,
  checkNhlMoneyPuckBlkRatesFreshness,
  checkCardsFreshness,
  checkMlbF5MarketAvailability,
  checkMlbGameLineCoverage,
  summarizeMlbRejectReasonFamilies,
  checkMlbSeedFreshness,
  checkOddsFreshness,
  checkCalibrationKillSwitches,
  checkWatchdogHeartbeat,
  shouldSendAlert,
  buildHealthAlertMessage,
  summarizeNhlRejectReasonFamilies,
  checkNhlMarketCallDiagnostics,
  checkNhlMoneylineCoverage,
  summarizeNbaRejectReasonFamilies,
  checkNbaMarketCallDiagnostics,
  checkNbaMoneylineCoverage,
  NBA_MARKET_CALL_CARD_TYPES,
  NBA_REJECT_REASON_FAMILIES,
};
