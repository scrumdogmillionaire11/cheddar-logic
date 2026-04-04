'use strict';

/**
 * pull_vsin_splits.js
 *
 * Worker job — pull DraftKings public betting splits from VSIN (data.vsin.com)
 * and write the dk_bets_pct_*, dk_handle_pct_* columns on the most-recent
 * odds_snapshot for each matched game.
 *
 * Runs IN PARALLEL with pull_public_splits.js (Action Network). Both jobs write
 * to separate column families (public_* vs dk_*) so neither overwrites the other.
 *
 * Single-writer contract (ADR-0002): only this worker job writes dk_* columns.
 * Web server routes must never call updateOddsSnapshotVsinSplits.
 *
 * Schedule: 60-minute cadence, active-hours-only (registered in main.js at
 * section 2.75, immediately after pull_public_splits).
 *
 * @see WORK_QUEUE/WI-0762.md
 * @see packages/adapters/src/vsin.js
 */

const {
  getActiveGamesForSplits,
  updateOddsSnapshotVsinSplits,
  updateOddsSnapshotCircaSplits,
} = require('@cheddar-logic/data');

const {
  fetchSplitsHtml,
  parseSplitsHtml,
  matchSplitsToGameId,
} = require('@cheddar-logic/adapters/src/vsin');

// Sports with gamecode slugs VSIN uses — used to filter parseSplitsHtml output.
const SUPPORTED_SPORTS = ['MLB', 'NBA', 'NHL', 'NFL'];

// Match rate at or above which we log INFO (below = WARN).
const MATCH_RATE_INFO_THRESHOLD = 0.70;

// ─── Exported job ─────────────────────────────────────────────────────────────

/**
 * Main entry point for the pull_vsin_splits job.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   totalMatched: number,
 *   totalWritten: number,
 *   sportStats: Record<string, object>,
 *   error?: string
 * }>}
 */
async function runPullVsinSplits() {
  const log = (msg) => console.log(`[pull_vsin_splits] ${msg}`);
  const warn = (msg) => console.warn(`[pull_vsin_splits] WARN ${msg}`);
  const error = (msg) => console.error(`[pull_vsin_splits] ERROR ${msg}`);

  log('Starting VSIN/DK splits pull');

  // Fetch DK source — single page covers all sports
  const { html, sourceStatus, error: fetchError } = await fetchSplitsHtml({ source: 'DK' });

  if (sourceStatus !== 'OK') {
    warn(`fetchSplitsHtml returned ${sourceStatus}${fetchError ? ': ' + fetchError : ''} — skipping`);
    return { success: true, totalMatched: 0, totalWritten: 0, sportStats: {}, sourceStatus };
  }

  // Parse all games from the DK page
  const allParsedGames = parseSplitsHtml(html, 'DK');
  log(`Parsed ${allParsedGames.length} games from VSIN DK page`);

  if (allParsedGames.length === 0) {
    log('No games parsed — nothing to write');
    return { success: true, totalMatched: 0, totalWritten: 0, sportStats: {} };
  }

  // Fetch our active games from DB
  let dbGames;
  try {
    dbGames = getActiveGamesForSplits(SUPPORTED_SPORTS);
  } catch (err) {
    error(`DB error fetching active games: ${err.message}`);
    return { success: false, error: err.message };
  }

  if (dbGames.length === 0) {
    log('No active games in next 48h — skipping');
    return { success: true, totalMatched: 0, totalWritten: 0, sportStats: {} };
  }

  // Group DB games by sport for per-sport stats
  const dbBySport = new Map();
  for (const g of dbGames) {
    const sport = (g.sport || '').toUpperCase();
    if (!dbBySport.has(sport)) dbBySport.set(sport, []);
    dbBySport.get(sport).push(g);
  }

  // Build knownGames for matching (format expected by matchSplitsToGameId)
  const knownGames = dbGames.map((g) => ({
    gameId: g.game_id,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
  }));

  // Match all parsed VSIN games to our game IDs
  const matches = matchSplitsToGameId(allParsedGames, knownGames);

  const matchRate = dbGames.length > 0 ? matches.length / dbGames.length : 0;
  const matchRatePct = (matchRate * 100).toFixed(1);

  if (matchRate >= MATCH_RATE_INFO_THRESHOLD) {
    log(`Match rate: ${matchRatePct}% (${matches.length}/${dbGames.length})`);
  } else {
    warn(`Low match rate: ${matchRatePct}% (${matches.length}/${dbGames.length})`);
  }

  // Write DK splits for each matched game
  let totalWritten = 0;
  const sportStats = {};

  for (const { gameId, game } of matches) {
    const sport = game.sport || 'UNKNOWN';

    // Only proceed if sport is in our supported list
    if (!SUPPORTED_SPORTS.includes(sport)) {
      log(`Skipping unsupported sport from VSIN: ${sport}`);
      continue;
    }

    // Extract DK bets/handle from the SPREAD market (preferred) or ML
    const validMarkets = (game.markets || []).filter((m) => m.valid);
    const spreadMkt = validMarkets.find((m) => m.marketType === 'SPREAD');
    const mlMkt = validMarkets.find((m) => m.marketType === 'ML');
    const source = spreadMkt || mlMkt;

    if (!source) {
      warn(`${sport} ${gameId}: no valid SPREAD or ML market data — skipping`);
      continue;
    }

    try {
      const rows = updateOddsSnapshotVsinSplits({
        gameId,
        vsinData: {
          dk_bets_pct_home:   source.public_bets_pct_home   ?? null,
          dk_bets_pct_away:   source.public_bets_pct_away   ?? null,
          dk_handle_pct_home: source.public_handle_pct_home ?? null,
          dk_handle_pct_away: source.public_handle_pct_away ?? null,
          // Tickets not available in VSIN HTML structure — left null
          dk_tickets_pct_home: null,
          dk_tickets_pct_away: null,
        },
      });

      if (rows > 0) {
        totalWritten++;
        if (!sportStats[sport]) sportStats[sport] = { matched: 0, written: 0 };
        sportStats[sport].matched++;
        sportStats[sport].written++;
      }
    } catch (err) {
      error(`DB write error for ${sport} ${gameId}: ${err.message}`);
    }
  }

  // Fill in matched count for sports with no writes
  for (const { game } of matches) {
    const sport = game.sport || 'UNKNOWN';
    if (!sportStats[sport]) sportStats[sport] = { matched: 0, written: 0 };
    sportStats[sport].matched = (sportStats[sport].matched || 0);
  }

  log(`Done — matched=${matches.length} written=${totalWritten}`);

  // ─── CIRCA pass (soft-fail — sharp splits) ────────────────────────────────────
  let circaTotalWritten = 0;
  const circaSportStats = {};
  try {
    log('Starting CIRCA splits pass');
    const { html: circaHtml, sourceStatus: circaStatus, error: circaFetchError } =
      await fetchSplitsHtml({ source: 'CIRCA' });

    if (circaStatus !== 'OK') {
      warn(`CIRCA fetchSplitsHtml returned ${circaStatus}${circaFetchError ? ': ' + circaFetchError : ''} — skipping CIRCA pass`);
    } else {
      const circaGames = parseSplitsHtml(circaHtml, 'CIRCA');
      log(`CIRCA: parsed ${circaGames.length} games`);

      const circaMatches = matchSplitsToGameId(circaGames, knownGames);
      log(`CIRCA: matched ${circaMatches.length}/${dbGames.length} games`);

      for (const { gameId, game } of circaMatches) {
        const sport = game.sport || 'UNKNOWN';
        if (!SUPPORTED_SPORTS.includes(sport)) continue;

        const validMarkets = (game.markets || []).filter((m) => m.valid);
        const spreadMkt = validMarkets.find((m) => m.marketType === 'SPREAD');
        const mlMkt     = validMarkets.find((m) => m.marketType === 'ML');
        const src = spreadMkt || mlMkt;

        if (!src) {
          warn(`CIRCA ${sport} ${gameId}: no valid SPREAD or ML market — skipping`);
          continue;
        }

        try {
          const rows = updateOddsSnapshotCircaSplits({
            gameId,
            circaData: {
              circa_handle_pct_home:  src.public_handle_pct_home  ?? null,
              circa_handle_pct_away:  src.public_handle_pct_away  ?? null,
              circa_tickets_pct_home: src.public_bets_pct_home    ?? null,
              circa_tickets_pct_away: src.public_bets_pct_away    ?? null,
            },
          });
          if (rows > 0) {
            circaTotalWritten++;
            if (!circaSportStats[sport]) circaSportStats[sport] = { matched: 0, written: 0 };
            circaSportStats[sport].matched++;
            circaSportStats[sport].written++;
          }
        } catch (err) {
          error(`CIRCA DB write error for ${sport} ${gameId}: ${err.message}`);
        }
      }
      log(`CIRCA done — matched=${circaMatches.length} written=${circaTotalWritten}`);
    }
  } catch (err) {
    warn(`CIRCA pass failed (non-fatal): ${err.message}`);
  }

  return {
    success: true,
    totalMatched: matches.length,
    totalWritten,
    sportStats,
    circaTotalWritten,
    circaSportStats,
  };
}

module.exports = { runPullVsinSplits };
