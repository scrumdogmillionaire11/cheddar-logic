'use strict';

/**
 * pull_public_splits.js
 *
 * Worker job — pull public betting splits from ActionNetwork, match to our
 * game IDs, and write to odds_snapshots.splits_* columns.
 *
 * Single-writer contract (ADR-0002): only this worker job writes splits data.
 * Web server routes must never call updateOddsSnapshotSplits.
 *
 * Schedule: 60-minute cadence, active-hours-only (registered in main.js).
 *
 * @see WORK_QUEUE/WI-0666.md
 */

const {
  getActiveGamesForSplits,
  updateOddsSnapshotSplits,
  getLatestOdds,
} = require('@cheddar-logic/data');

const {
  fetchSplitsForDate,
  normalizeSplitsResponse,
  matchSplitsToGameId,
} = require('@cheddar-logic/adapters/src/action-network');

// Sports we pull splits for.  Lowercase values fed to ActionNetwork.
const SUPPORTED_SPORTS = ['MLB', 'NBA', 'NHL', 'NFL'];

// Match rate at or above which we log INFO (below = WARN).
const MATCH_RATE_INFO_THRESHOLD = 0.70;

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns ['YYYY-MM-DD', 'YYYY-MM-DD'] for today + tomorrow in UTC.
 * ActionNetwork date param must be ET, but UTC date works for same-day games.
 */
function getTodayAndTomorrow() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return [today, tomorrow];
}

// ─── Per-sport logic ──────────────────────────────────────────────────────────

/**
 * Fetch + normalize splits for one sport across today and tomorrow.
 * Returns { normalizedGames: [], sourceStatus: 'OK'|'FETCH_ERROR'|... }
 *
 * Soft-fails on non-200 responses (logs and returns empty list).
 */
async function fetchNormalizedForSport(sport) {
  const dates = getTodayAndTomorrow();
  const allGames = [];

  for (const date of dates) {
    let result;
    try {
      result = await fetchSplitsForDate({ sport, date });
    } catch (err) {
      console.error(
        `[pull_public_splits] Unexpected error fetching ${sport} ${date}: ${err.message}`,
      );
      return { normalizedGames: [], sourceStatus: 'FETCH_ERROR' };
    }

    if (result.sourceStatus !== 'OK') {
      console.error(
        `[pull_public_splits] Non-OK response for ${sport} ${date}: ${result.sourceStatus}`,
      );
      // Soft-fail this sport — don't propagate throw, continue other sports
      return { normalizedGames: [], sourceStatus: result.sourceStatus };
    }

    const normalized = normalizeSplitsResponse(result.games);
    allGames.push(...normalized);
  }

  return { normalizedGames: allGames, sourceStatus: 'OK' };
}

/**
 * Write splits for matched games with source='action_network'.
 * For unmatched games that have spread_consensus_confidence='HIGH',
 * write splits_source='pinnacle_proxy' (pct fields null) to signal
 * that the Pinnacle-consensus line alone can serve as the inefficiency
 * anchor for WI-0667's pipeline gate.
 *
 * @param {string[]}  matchedGameIds   - game_ids successfully matched
 * @param {object[]}  allKnownGames    - full sport game list from DB
 * @param {Map}       matchedSplitsMap - gameId → splitsData for matched games
 * @returns {{ written: number, proxyFlagged: number }}
 */
function writeSplitsToDb(matchedGameIds, allKnownGames, matchedSplitsMap) {
  const matchedSet = new Set(matchedGameIds);
  let written = 0;
  let proxyFlagged = 0;

  // Step A: write matched action_network splits
  for (const [gameId, splitsData] of matchedSplitsMap.entries()) {
    const rows = updateOddsSnapshotSplits({
      gameId,
      splitsData: { ...splitsData, splits_source: 'action_network' },
    });
    if (rows > 0) written++;
  }

  // Step B: flag unmatched HIGH-consensus games as pinnacle_proxy
  for (const game of allKnownGames) {
    if (matchedSet.has(game.game_id)) continue;

    let snapshot = null;
    try {
      snapshot = getLatestOdds(game.game_id);
    } catch (_) {
      // no snapshot yet — skip
    }

    if (snapshot?.spread_consensus_confidence === 'HIGH') {
      const rows = updateOddsSnapshotSplits({
        gameId: game.game_id,
        splitsData: {
          splits_source: 'pinnacle_proxy',
          public_bets_pct_home: null,
          public_bets_pct_away: null,
          public_handle_pct_home: null,
          public_handle_pct_away: null,
          public_tickets_pct_home: null,
          public_tickets_pct_away: null,
        },
      });
      if (rows > 0) proxyFlagged++;
    }
  }

  return { written, proxyFlagged };
}

// ─── Exported job ─────────────────────────────────────────────────────────────

/**
 * Main entry point for the pull_public_splits job.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   sportsProcessed: number,
 *   totalMatched: number,
 *   totalWritten: number,
 *   totalProxyFlagged: number,
 *   sportStats: Record<string, object>,
 *   error?: string
 * }>}
 */
async function runPullPublicSplits() {
  const log = (msg) => console.log(`[pull_public_splits] ${msg}`);
  const warn = (msg) => console.warn(`[pull_public_splits] WARN ${msg}`);
  const error = (msg) => console.error(`[pull_public_splits] ERROR ${msg}`);

  log('Starting public splits pull');

  let allGames;
  try {
    allGames = getActiveGamesForSplits(SUPPORTED_SPORTS);
  } catch (err) {
    error(`DB error fetching active games: ${err.message}`);
    return { success: false, error: err.message };
  }

  if (allGames.length === 0) {
    log('No active games in next 48h — skipping');
    return {
      success: true,
      sportsProcessed: 0,
      totalMatched: 0,
      totalWritten: 0,
      totalProxyFlagged: 0,
      sportStats: {},
    };
  }

  // Group by sport
  const bySport = new Map();
  for (const game of allGames) {
    const sport = (game.sport || '').toUpperCase();
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport).push(game);
  }

  const sportStats = {};
  let totalMatched = 0;
  let totalWritten = 0;
  let totalProxyFlagged = 0;
  let sportsProcessed = 0;

  for (const [sport, gamesForSport] of bySport.entries()) {
    if (!SUPPORTED_SPORTS.includes(sport)) {
      log(`Skipping unsupported sport: ${sport}`);
      continue;
    }

    log(`Fetching splits for ${sport} (${gamesForSport.length} games)`);

    // Fetch + normalize — soft-fail per-sport
    const { normalizedGames, sourceStatus } = await fetchNormalizedForSport(sport);

    if (sourceStatus !== 'OK' || normalizedGames.length === 0) {
      warn(`No splits data for ${sport} (status=${sourceStatus}) — skipping sport`);
      sportStats[sport] = {
        games: gamesForSport.length,
        matched: 0,
        matchRate: 0,
        written: 0,
        proxyFlagged: 0,
        sourceStatus,
      };
      sportsProcessed++;
      continue;
    }

    // Match normalized AN games to our game_ids
    const knownGames = gamesForSport.map((g) => ({
      gameId: g.game_id,
      homeTeam: g.home_team,
      awayTeam: g.away_team,
    }));
    const matches = matchSplitsToGameId(normalizedGames, knownGames);

    const matchRate = gamesForSport.length > 0
      ? matches.length / gamesForSport.length
      : 0;

    const matchRatePct = (matchRate * 100).toFixed(1);

    if (matchRate >= MATCH_RATE_INFO_THRESHOLD) {
      log(`${sport} match rate: ${matchRatePct}% (${matches.length}/${gamesForSport.length})`);
    } else {
      warn(`${sport} low match rate: ${matchRatePct}% (${matches.length}/${gamesForSport.length})`);
    }

    // Build matchedSplitsMap from SPREAD market data (preferred) or ML
    const matchedSplitsMap = new Map();
    const matchedGameIds = [];

    for (const { gameId, game } of matches) {
      matchedGameIds.push(gameId);

      const validMarkets = (game.markets || []).filter((m) => m.valid);
      const spreadMkt   = validMarkets.find((m) => m.marketType === 'SPREAD');
      const mlMkt       = validMarkets.find((m) => m.marketType === 'ML');
      const source = spreadMkt || mlMkt; // prefer SPREAD for home/away bets pct

      if (!source) {
        matchedSplitsMap.set(gameId, {});
        continue;
      }

      matchedSplitsMap.set(gameId, {
        public_bets_pct_home:    source.home_or_over_bets_pct ?? null,
        public_bets_pct_away:    source.away_or_under_bets_pct ?? null,
        public_handle_pct_home:  source.home_or_over_handle_pct ?? null,
        public_handle_pct_away:  source.away_or_under_handle_pct ?? null,
        public_tickets_pct_home: source.home_or_over_tickets_pct ?? null,
        public_tickets_pct_away: source.away_or_under_tickets_pct ?? null,
      });
    }

    // Write to DB
    let written = 0;
    let proxyFlagged = 0;
    try {
      ({ written, proxyFlagged } = writeSplitsToDb(
        matchedGameIds,
        gamesForSport,
        matchedSplitsMap,
      ));
    } catch (err) {
      error(`DB write error for ${sport}: ${err.message}`);
    }

    log(
      `${sport} complete — matched=${matches.length} written=${written} proxy=${proxyFlagged}`,
    );

    sportStats[sport] = {
      games: gamesForSport.length,
      matched: matches.length,
      matchRate,
      written,
      proxyFlagged,
      sourceStatus,
    };

    totalMatched     += matches.length;
    totalWritten     += written;
    totalProxyFlagged += proxyFlagged;
    sportsProcessed++;
  }

  log(
    `Done — sports=${sportsProcessed} matched=${totalMatched} written=${totalWritten} proxy=${totalProxyFlagged}`,
  );

  return {
    success: true,
    sportsProcessed,
    totalMatched,
    totalWritten,
    totalProxyFlagged,
    sportStats,
  };
}

module.exports = { runPullPublicSplits };
