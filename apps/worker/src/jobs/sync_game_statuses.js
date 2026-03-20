/**
 * Sync Game Statuses Job
 *
 * Finds games in the `games` table with stale status ('scheduled' or 'in_progress')
 * where the game time has already passed, and updates them to 'final' using:
 *   1. ESPN public scoreboard (primary — free, no API key required)
 *   2. Odds API /scores endpoint (backup — requires ODDS_API_KEY)
 *
 * This ensures team-sequence logic like Welcome Home Fade has accurate road trip
 * data even when pull_schedule_nhl runs stale or is not in the scheduler.
 *
 * Usage:
 *   node src/jobs/sync_game_statuses.js
 *   node src/jobs/sync_game_statuses.js --dry-run
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

const {
  fetchScoreboardEvents,
} = require('../../../../packages/data/src/espn-client');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_HOURS_AFTER_START = Math.max(
  0,
  Number(process.env.SYNC_GAME_STATUSES_MIN_HOURS_AFTER_START) || 3,
);
const ODDS_API_SCORES_DAYS_FROM = Math.max(
  1,
  Math.min(3, Number(process.env.ODDS_API_SCORES_DAYS_FROM) || 3),
);
const ODDS_API_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.ODDS_API_TIMEOUT_MS) || 15000,
);
const ESPN_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.ESPN_API_TIMEOUT_MS) || 30000,
);
const MATCH_MAX_DELTA_MINUTES = 120;

const ODDS_API_BASE_URL = 'https://api.the-odds-api.com/v4/sports';

const ESPN_SPORT_MAP = {
  nhl: 'hockey/nhl',
  nba: 'basketball/nba',
  ncaam: 'basketball/mens-college-basketball',
};

const ODDS_API_SPORT_KEY_MAP = {
  nhl: 'icehockey_nhl',
  nba: 'basketball_nba',
  ncaam: 'basketball_ncaab',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeTeamName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function toDateKey(isoStr) {
  return new Date(isoStr).toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function getStaleGames(minHoursAfterStart) {
  const db = getDatabase();
  const cutoff = new Date(
    Date.now() - minHoursAfterStart * 60 * 60 * 1000,
  ).toISOString();
  return db
    .prepare(
      `SELECT game_id, sport, home_team, away_team, game_time_utc, status
       FROM games
       WHERE status != 'final'
         AND game_time_utc < ?
       ORDER BY game_time_utc ASC`,
    )
    .all(cutoff);
}

function markGameFinal(gameId) {
  const db = getDatabase();
  db.prepare(
    `UPDATE games SET status = 'final', updated_at = CURRENT_TIMESTAMP
     WHERE game_id = ?`,
  ).run(gameId);
}

// ── Source: ESPN ──────────────────────────────────────────────────────────────

async function fetchCompletedFromEspn(sport, dateKeys) {
  const leaguePath = ESPN_SPORT_MAP[sport];
  if (!leaguePath) return [];

  const completed = [];
  for (const dateKey of dateKeys) {
    try {
      const events = await fetchScoreboardEvents(leaguePath, dateKey);
      for (const event of events || []) {
        const comp = event?.competitions?.[0];
        if (!comp) continue;
        if (comp.status?.type?.state !== 'post') continue;

        const homeComp = comp.competitors?.find((c) => c.homeAway === 'home');
        const awayComp = comp.competitors?.find((c) => c.homeAway === 'away');
        if (!homeComp || !awayComp) continue;

        const homeTeam = homeComp.team?.displayName?.trim();
        const awayTeam = awayComp.team?.displayName?.trim();
        const gameTime = event.date || comp.date;
        if (!homeTeam || !awayTeam || !gameTime) continue;

        completed.push({
          source: 'espn',
          homeNorm: normalizeTeamName(homeTeam),
          awayNorm: normalizeTeamName(awayTeam),
          gameTimeMs: new Date(gameTime).getTime(),
        });
      }
    } catch (err) {
      console.warn(
        `[SyncStatuses] ESPN fetch failed for ${sport}/${dateKey}: ${err.message}`,
      );
    }
  }
  return completed;
}

// ── Source: Odds API ──────────────────────────────────────────────────────────

async function fetchCompletedFromOddsApi(sport) {
  const apiKey = process.env.ODDS_API_KEY;
  const sportKey = ODDS_API_SPORT_KEY_MAP[sport];

  if (!sportKey) return [];
  if (!apiKey) {
    console.warn(
      `[SyncStatuses] ODDS_API_KEY missing — skipping Odds API fallback for ${sport}`,
    );
    return [];
  }

  const params = new URLSearchParams({
    apiKey,
    daysFrom: String(ODDS_API_SCORES_DAYS_FROM),
  });
  const url = `${ODDS_API_BASE_URL}/${sportKey}/scores/?${params.toString()}`;

  try {
    const payload = await fetchJsonWithTimeout(url, ODDS_API_TIMEOUT_MS, {
      'User-Agent': 'cheddar-logic-sync-statuses/1.0',
    });
    if (!Array.isArray(payload)) return [];

    return payload
      .filter((e) => e.completed === true)
      .map((e) => {
        const homeTeam = String(e.home_team || '').trim();
        const awayTeam = String(e.away_team || '').trim();
        const gameTimeMs = new Date(
          e.commence_time || e.last_update,
        ).getTime();
        if (!homeTeam || !awayTeam || !Number.isFinite(gameTimeMs)) return null;
        return {
          source: 'oddsapi',
          homeNorm: normalizeTeamName(homeTeam),
          awayNorm: normalizeTeamName(awayTeam),
          gameTimeMs,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(
      `[SyncStatuses] Odds API fetch failed for ${sport}: ${err.message}`,
    );
    return [];
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────

function matchesCompleted(game, completedEvents) {
  const homeNorm = normalizeTeamName(game.home_team);
  const awayNorm = normalizeTeamName(game.away_team);
  const gameTimeMs = new Date(game.game_time_utc).getTime();

  for (const event of completedEvents) {
    if (event.homeNorm !== homeNorm || event.awayNorm !== awayNorm) continue;
    const deltaMinutes = Math.abs(event.gameTimeMs - gameTimeMs) / 60000;
    if (deltaMinutes <= MATCH_MAX_DELTA_MINUTES) return true;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function syncGameStatuses({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-sync-game-statuses-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  console.log(`[SyncStatuses] Starting: ${jobRunId}`);
  if (dryRun) console.log('[SyncStatuses] DRY_RUN=true — no writes');

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[SyncStatuses] Skipping (already ran): ${jobKey}`);
      return { success: true, skipped: true };
    }

    try {
      if (!dryRun) insertJobRun('sync_game_statuses', jobRunId, jobKey);

      const staleGames = getStaleGames(MIN_HOURS_AFTER_START);
      console.log(`[SyncStatuses] Found ${staleGames.length} stale games`);

      if (staleGames.length === 0) {
        if (!dryRun)
          markJobRunSuccess('sync_game_statuses', jobRunId, { updated: 0 });
        return { success: true, updated: 0 };
      }

      if (dryRun) {
        for (const g of staleGames) {
          console.log(
            `[SyncStatuses] [DRY] Would attempt: ${g.sport} ${g.home_team} vs ${g.away_team} @ ${g.game_time_utc}`,
          );
        }
        return { success: true, dryRun: true, staleCount: staleGames.length };
      }

      // Group by sport
      const bySport = {};
      for (const game of staleGames) {
        const s = game.sport.toLowerCase();
        if (!bySport[s]) bySport[s] = [];
        bySport[s].push(game);
      }

      let totalUpdated = 0;
      let totalNoMatch = 0;

      for (const [sport, games] of Object.entries(bySport)) {
        if (!ESPN_SPORT_MAP[sport] && !ODDS_API_SPORT_KEY_MAP[sport]) {
          console.log(
            `[SyncStatuses] No source configured for sport '${sport}' — skipping`,
          );
          continue;
        }

        console.log(
          `[SyncStatuses][${sport.toUpperCase()}] Processing ${games.length} stale games`,
        );

        // Unique date keys to fetch from ESPN scoreboard
        const dateKeys = [
          ...new Set(games.map((g) => toDateKey(g.game_time_utc))),
        ];

        // 1. ESPN (primary)
        const espnCompleted = await fetchCompletedFromEspn(sport, dateKeys);
        console.log(
          `[SyncStatuses][${sport.toUpperCase()}] ESPN: ${espnCompleted.length} completed events`,
        );

        const remaining = [];
        for (const game of games) {
          if (matchesCompleted(game, espnCompleted)) {
            console.log(
              `[SyncStatuses][${sport.toUpperCase()}] ESPN matched → final: ${game.home_team} vs ${game.away_team} @ ${game.game_time_utc}`,
            );
            markGameFinal(game.game_id);
            totalUpdated++;
          } else {
            remaining.push(game);
          }
        }

        if (remaining.length === 0) continue;

        // 2. Odds API (backup)
        console.log(
          `[SyncStatuses][${sport.toUpperCase()}] ${remaining.length} unmatched — trying Odds API`,
        );
        const oddsCompleted = await fetchCompletedFromOddsApi(sport);
        console.log(
          `[SyncStatuses][${sport.toUpperCase()}] Odds API: ${oddsCompleted.length} completed events`,
        );

        for (const game of remaining) {
          if (matchesCompleted(game, oddsCompleted)) {
            console.log(
              `[SyncStatuses][${sport.toUpperCase()}] OddsAPI matched → final: ${game.home_team} vs ${game.away_team} @ ${game.game_time_utc}`,
            );
            markGameFinal(game.game_id);
            totalUpdated++;
          } else {
            console.log(
              `[SyncStatuses][${sport.toUpperCase()}] No match: ${game.home_team} vs ${game.away_team} @ ${game.game_time_utc}`,
            );
            totalNoMatch++;
          }
        }
      }

      console.log(
        `[SyncStatuses] Done — updated: ${totalUpdated}, no match: ${totalNoMatch}`,
      );
      markJobRunSuccess('sync_game_statuses', jobRunId, {
        updated: totalUpdated,
        noMatch: totalNoMatch,
      });
      return { success: true, updated: totalUpdated, noMatch: totalNoMatch };
    } catch (err) {
      console.error(`[SyncStatuses] Fatal: ${err.message}`);
      markJobRunFailure('sync_game_statuses', jobRunId, err.message);
      throw err;
    }
  });
}

// Direct execution
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  syncGameStatuses({ dryRun })
    .then((result) => {
      console.log('[SyncStatuses] Result:', JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[SyncStatuses] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { syncGameStatuses };
