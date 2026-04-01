'use strict';
/**
 * Pull NHL Player Shots On Goal Prop Lines
 *
 * Fetches player_shots_on_goal O/U market lines from The Odds API bulk
 * odds endpoint for upcoming NHL games, stores in player_prop_lines.
 * player_blocked_shots (BLK) is available but OFF by default — it is not
 * part of the canonical 7-token budget defined in packages/odds/src/config.js.
 *
 * Endpoint: GET /v4/sports/icehockey_nhl/odds
 *   ?markets=player_shots_on_goal&regions=us&bookmakers=...
 *
 * Token cost: 1 token per **market** for ALL games (bulk endpoint).
 *   Default (SOG only) = 1 token total regardless of game count.
 *
 * Guard flags:
 *   NHL_SOG_PROP_EVENTS_ENABLED   — enables player_shots_on_goal pull (default ON)
 *   NHL_BLK_PROP_EVENTS_ENABLED   — enables player_blocked_shots pull (default OFF)
 *
 * Exit codes: 0 = success, 1 = failure
 */
require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  getDatabase,
  withDb,
  upsertPlayerPropLine,
  upsertQuotaLedger,
} = require('@cheddar-logic/data');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'icehockey_nhl';
const SOG_MARKET = 'player_shots_on_goal';
const BLK_MARKET = 'player_blocked_shots';

/** Map Odds API market key → propType stored in player_prop_lines */
const MARKET_TO_PROP_TYPE = {
  [SOG_MARKET]: 'shots_on_goal',
  [BLK_MARKET]: 'blocked_shots',
};

const BOOKMAKERS = 'draftkings,fanduel,betmgm';
const HOURS_AHEAD = 36;
const DEFAULT_SLEEP_MS = Number(process.env.NHL_SOG_PROP_SLEEP_MS || 1000);
const JOB_NAME = 'pull-nhl-player-shots-props';

function normalizePriceToAmerican(rawPrice) {
  const numericPrice = Number(rawPrice);
  if (!Number.isFinite(numericPrice) || numericPrice === 0) return null;
  if (numericPrice <= -100 || numericPrice >= 100) {
    return Math.trunc(numericPrice);
  }
  if (numericPrice <= 1) return null;
  if (numericPrice >= 2) {
    return Math.round((numericPrice - 1) * 100);
  }
  return Math.round(-100 / (numericPrice - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'cheddar-logic-worker' } });
  if (!response.ok) {
    throw new Error(`Odds API ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchJsonWithHeaders(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'cheddar-logic-worker' } });
  if (!response.ok) {
    throw new Error(`Odds API ${response.status} for ${url}`);
  }
  const remaining = response.headers.get('x-requests-remaining');
  const remainingTokens = remaining != null ? parseInt(remaining, 10) : null;
  if (remainingTokens != null) {
    console.log(`[${JOB_NAME}] API quota remaining: ${remainingTokens}`);
    if (remainingTokens < 200) {
      console.warn(`[${JOB_NAME}] ⚠️  LOW API QUOTA: ${remainingTokens} requests remaining`);
    }
  }
  const data = await response.json();
  return { data, remainingTokens };
}

/**
 * Fetch all upcoming NHL game prop odds in a single bulk call.
 * Costs 1 token per market (vs 1 token per game per market on the per-event endpoint).
 * @param {string} apiKey
 * @param {string[]} marketKeys  - e.g. ['player_shots_on_goal', 'player_blocked_shots']
 * @returns {{ games: object[], remainingTokens: number|null }}
 */
async function fetchBulkPropOdds(apiKey, marketKeys) {
  const marketsParam = marketKeys.join(',');
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${marketsParam}&bookmakers=${BOOKMAKERS}&oddsFormat=american`;
  console.log(`[${JOB_NAME}] Bulk API call: markets=${marketsParam} (1 token/market for all games)`);
  const response = await fetchJsonWithHeaders(url);
  const now = Date.now();
  const cutoff = now + HOURS_AHEAD * 60 * 60 * 1000;
  const games = (Array.isArray(response.data) ? response.data : []).filter((g) => {
    const t = new Date(g.commence_time).getTime();
    return t > now && t <= cutoff;
  });
  return { games, remainingTokens: response.remainingTokens };
}

/**
 * Parse player prop lines from Odds API event odds response.
 * Supports multiple market keys in one response.
 * Returns array of upsert rows, one per (market, player, bookmaker).
 */
function parseEventPropLines(eventOdds, gameId, fetchedAt) {
  const rows = [];
  if (!eventOdds?.bookmakers) return rows;
  for (const bm of eventOdds.bookmakers) {
    for (const market of bm.markets || []) {
      const marketKey = market.key;
      const propType = MARKET_TO_PROP_TYPE[marketKey];
      if (!propType || !market.outcomes) continue;

      // Group outcomes by player + point so same-book ladders (e.g. 2.5 and 3.5)
      // remain distinct rows instead of overwriting each other.
      const byPlayer = {};
      for (const outcome of market.outcomes) {
        const playerName = outcome.description;
        const line = Number(outcome.point);
        if (!playerName || !Number.isFinite(line)) continue;
        const playerKey = `${playerName}::${line}`;
        if (!byPlayer[playerKey]) {
          byPlayer[playerKey] = {
            playerName,
            line,
          };
        }
        if (outcome.name === 'Over') {
          byPlayer[playerKey].overPrice = normalizePriceToAmerican(outcome.price);
        } else if (outcome.name === 'Under') {
          byPlayer[playerKey].underPrice = normalizePriceToAmerican(outcome.price);
        }
      }
      for (const data of Object.values(byPlayer)) {
        if (data.line == null) continue;
        rows.push({
          id: `nhl-${propType}-${gameId}-${data.playerName.replace(/\s+/g, '-').toLowerCase()}-${String(data.line).replace(/\./g, '_')}-${bm.key}-${uuidV4().slice(0, 6)}`,
          sport: 'NHL',
          gameId,
          oddsEventId: eventOdds.id,
          playerName: data.playerName,
          propType,
          period: 'full_game',
          line: data.line,
          overPrice: data.overPrice || null,
          underPrice: data.underPrice || null,
          bookmaker: bm.key,
          fetchedAt,
        });
      }
    }
  }
  return rows;
}

/**
 * Resolve canonical game_id from Odds API event using team name matching against games table.
 * Two-step strategy to align with the model runner's resolveCanonicalGameId:
 *   Step 1: exact LOWER() match within a 1-hour window (primary, safe)
 *   Step 2: 6-char normalized prefix match within 4-hour window (fallback heuristic)
 * Returns matched game_id or null.
 */
function resolveGameId(db, event) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const eventHome = norm(event.home_team);
  const eventAway = norm(event.away_team);

  // Step 1: exact normalized match within 1-hour window
  // This mirrors the model runner's fallback which uses LOWER() equality.
  // Uses a wider time window (3600s vs model runner's 900s) to account for
  // Odds API vs NHL-API scheduling drift, but still tight enough to be
  // unambiguous for a typical NHL slate.
  const exactCandidates = db.prepare(`
    SELECT game_id, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'nhl'
      AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 3600
    ORDER BY game_time_utc ASC
    LIMIT 20
  `).all(event.commence_time);

  for (const g of exactCandidates) {
    if (norm(g.home_team) === eventHome && norm(g.away_team) === eventAway) {
      return g.game_id;
    }
  }

  // Step 2: prefix heuristic fallback — 6-char normalized prefix, 4-hour window.
  // Only reached when Odds API uses shortened/different team names (e.g. city only).
  // Logs a warning so we can track and fix naming mismatches over time.
  const prefixCandidates = db.prepare(`
    SELECT game_id, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'nhl'
      AND status = 'scheduled'
      AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 14400
    ORDER BY game_time_utc ASC
    LIMIT 10
  `).all(event.commence_time);

  for (const g of prefixCandidates) {
    const dbHome = norm(g.home_team);
    const dbAway = norm(g.away_team);
    const homeMatch = dbHome.includes(eventHome.slice(0, 6)) || eventHome.includes(dbHome.slice(0, 6));
    const awayMatch = dbAway.includes(eventAway.slice(0, 6)) || eventAway.includes(dbAway.slice(0, 6));
    if (homeMatch && awayMatch) {
      console.warn(
        `[${JOB_NAME}] resolveGameId: prefix fallback used for ` +
        `"${event.away_team} @ ${event.home_team}" → ${g.game_id}. ` +
        `Odds API name mismatch vs games table ("${g.away_team} @ ${g.home_team}"). ` +
        `Consider adding an alias mapping.`,
      );
      return g.game_id;
    }
  }

  return null;
}

async function pullNhlPlayerShotsProps({ dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  if (process.env.APP_ENV === 'local') {
    console.log(`[${JOB_NAME}] Skipped — APP_ENV=local. Prop pulls must not hit the live API in dev.`);
    return { success: true, eventsProcessed: 0, linesInserted: 0 };
  }

  // Guard: SOG default ON; BLK default OFF (not in canonical 7-token budget)
  const sogEnabled = process.env.NHL_SOG_PROP_EVENTS_ENABLED !== 'false';
  const blkEnabled = process.env.NHL_BLK_PROP_EVENTS_ENABLED === 'true';

  if (!sogEnabled && !blkEnabled && !dryRun) {
    console.log(
      `[${JOB_NAME}] Skipped — NHL_SOG_PROP_EVENTS_ENABLED=false and NHL_BLK_PROP_EVENTS_ENABLED not set`,
    );
    return { success: true, skipped: true, reason: 'not_enabled' };
  }

  // Build active market list from enabled flags
  const activeMarkets = [
    ...(sogEnabled ? [SOG_MARKET] : []),
    ...(blkEnabled ? [BLK_MARKET] : []),
  ];

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error(`[${JOB_NAME}] ODDS_API_KEY not set`);
    return { success: false, error: 'ODDS_API_KEY not set' };
  }

  if (dryRun) {
    console.log(`[${JOB_NAME}] DRY_RUN — would fetch NHL event props for markets: ${activeMarkets.join(', ') || '(none enabled)'}`);
    return { success: true, dryRun: true };
  }

  return withDb(async () => {
    const db = getDatabase();
    try {
      insertJobRun(JOB_NAME, jobRunId, null);

const { games, remainingTokens } = await fetchBulkPropOdds(apiKey, activeMarkets);
      if (remainingTokens != null) {
        console.log(`[${JOB_NAME}] Tokens remaining after bulk fetch: ${remainingTokens}`);
        const _period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        try {
          upsertQuotaLedger({ provider: 'odds_api', period: _period, tokens_remaining: remainingTokens, updated_by: jobRunId });
        } catch (_ledgerErr) { /* DB not yet migrated */ }
      }
      if (games.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming NHL games in ${HOURS_AHEAD}h window from bulk response`);
        markJobRunSuccess(jobRunId, { eventsProcessed: 0, linesInserted: 0 });
        return { success: true, eventsProcessed: 0, linesInserted: 0 };
      }
      console.log(`[${JOB_NAME}] Bulk fetch returned ${games.length} NHL games, markets: [${activeMarkets.join(', ')}]`);

      let linesInserted = 0;
      let eventsProcessed = 0;
      const fetchedAt = new Date().toISOString();

      for (const game of games) {
        const gameId = resolveGameId(db, game);
        if (!gameId) {
          console.warn(`[${JOB_NAME}] Could not resolve game_id for ${game.away_team} @ ${game.home_team}`);
          continue;
        }

        try {
          const rows = parseEventPropLines(game, gameId, fetchedAt);
          rows.forEach((row) => {
            upsertPlayerPropLine(row);
            linesInserted += 1;
          });
          const sogRows = rows.filter((r) => r.propType === 'shots_on_goal').length;
          const blkRows = rows.filter((r) => r.propType === 'blocked_shots').length;
          eventsProcessed += 1;
          console.log(
            `[${JOB_NAME}] ${game.away_team} @ ${game.home_team}: ` +
            `${sogRows} SOG lines, ${blkRows} BLK lines`,
          );
        } catch (err) {
          console.error(`[${JOB_NAME}] Game ${game.id} failed: ${err.message}`);
        }
      }

      markJobRunSuccess(jobRunId, { eventsProcessed, linesInserted });
      console.log(`[${JOB_NAME}] Done: ${eventsProcessed} events, ${linesInserted} lines`);
      return { success: true, eventsProcessed, linesInserted };
    } catch (err) {
      console.error(`[${JOB_NAME}] Job failed:`, err.message);
      try { markJobRunFailure(jobRunId, { error: err.message }); } catch {}
      return { success: false, error: err.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullNhlPlayerShotsProps({ dryRun })
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { pullNhlPlayerShotsProps, parseEventPropLines, resolveGameId };
