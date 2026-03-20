'use strict';
/**
 * Pull NHL Player Shots On Goal + Blocked Shots Prop Lines
 *
 * Fetches player_shots_on_goal and/or player_blocked_shots O/U market lines
 * from The Odds API event player props endpoint for upcoming NHL games,
 * stores in player_prop_lines.
 *
 * Endpoint: GET /v4/sports/icehockey_nhl/events/{eventId}/odds
 *   ?markets=player_shots_on_goal,player_blocked_shots&regions=us&bookmakers=...
 *
 * Token cost: 1 token per event per **market** (only runs for games within 36h).
 * Guard flags (both default false — set to enable):
 *   NHL_SOG_PROP_EVENTS_ENABLED   — enables player_shots_on_goal pull
 *   NHL_BLK_PROP_EVENTS_ENABLED   — enables player_blocked_shots pull
 *
 * Both markets are requested in a single API call per event when both flags
 * are set, to minimise token spend.
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

/**
 * Fetch list of upcoming NHL events from The Odds API.
 * Returns events commencing within HOURS_AHEAD hours.
 */
async function fetchNhlEvents(apiKey) {
  const url = `${ODDS_API_BASE}/sports/${SPORT_KEY}/events?apiKey=${apiKey}`;
  const events = await fetchJson(url);
  const now = Date.now();
  const cutoff = now + HOURS_AHEAD * 60 * 60 * 1000;
  return (Array.isArray(events) ? events : []).filter((e) => {
    const t = new Date(e.commence_time).getTime();
    return t > now && t <= cutoff;
  });
}

/**
 * Fetch player prop lines for a single event.
 * @param {string} apiKey
 * @param {string} eventId
 * @param {string[]} marketKeys  - e.g. ['player_shots_on_goal', 'player_blocked_shots']
 */
async function fetchEventPropLines(apiKey, eventId, marketKeys) {
  const marketsParam = marketKeys.join(',');
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events/${eventId}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${marketsParam}&bookmakers=${BOOKMAKERS}`;
  return fetchJson(url);
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

      // Group outcomes by player name
      const byPlayer = {};
      for (const outcome of market.outcomes) {
        const playerName = outcome.description;
        if (!playerName) continue;
        if (!byPlayer[playerName]) byPlayer[playerName] = {};
        if (outcome.name === 'Over') {
          byPlayer[playerName].line = outcome.point;
          byPlayer[playerName].overPrice = outcome.price;
        } else if (outcome.name === 'Under') {
          byPlayer[playerName].line = outcome.point;
          byPlayer[playerName].underPrice = outcome.price;
        }
      }
      for (const [playerName, data] of Object.entries(byPlayer)) {
        if (data.line == null) continue;
        rows.push({
          id: `nhl-${propType}-${gameId}-${playerName.replace(/\s+/g, '-').toLowerCase()}-${bm.key}-${uuidV4().slice(0, 6)}`,
          sport: 'NHL',
          gameId,
          oddsEventId: eventOdds.id,
          playerName,
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
 * Returns matched game_id or null.
 */
function resolveGameId(db, event) {
  // Match by game_time_utc proximity (within 4 hours) + team name substring
  const stmt = db.prepare(`
    SELECT game_id, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'nhl'
      AND status = 'scheduled'
      AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 14400
    ORDER BY ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) ASC
    LIMIT 10
  `);
  const candidates = stmt.all(event.commence_time, event.commence_time);

  // Normalize for matching
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const eventHome = norm(event.home_team);
  const eventAway = norm(event.away_team);

  for (const g of candidates) {
    const dbHome = norm(g.home_team);
    const dbAway = norm(g.away_team);
    const homeMatch = dbHome.includes(eventHome.slice(0, 4)) || eventHome.includes(dbHome.slice(0, 4));
    const awayMatch = dbAway.includes(eventAway.slice(0, 4)) || eventAway.includes(dbAway.slice(0, 4));
    if (homeMatch && awayMatch) return g.game_id;
  }
  return null;
}

async function pullNhlPlayerShotsProps({ dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  // Guard: at least one market must be explicitly enabled
  const sogEnabled = process.env.NHL_SOG_PROP_EVENTS_ENABLED === 'true';
  const blkEnabled = process.env.NHL_BLK_PROP_EVENTS_ENABLED === 'true';

  if (!sogEnabled && !blkEnabled && !dryRun) {
    console.log(
      `[${JOB_NAME}] Skipped — set NHL_SOG_PROP_EVENTS_ENABLED=true and/or NHL_BLK_PROP_EVENTS_ENABLED=true to enable`,
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

      const events = await fetchNhlEvents(apiKey);
      if (events.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming NHL events in ${HOURS_AHEAD}h window`);
        markJobRunSuccess(jobRunId, { eventsProcessed: 0, linesInserted: 0 });
        return { success: true, eventsProcessed: 0, linesInserted: 0 };
      }
      console.log(`[${JOB_NAME}] ${events.length} NHL events in window, markets: [${activeMarkets.join(', ')}]`);

      let linesInserted = 0;
      let eventsProcessed = 0;

      for (const event of events) {
        const gameId = resolveGameId(db, event);
        if (!gameId) {
          console.warn(`[${JOB_NAME}] Could not resolve game_id for event ${event.id} (${event.away_team} @ ${event.home_team})`);
          continue;
        }

        try {
          const eventOdds = await fetchEventPropLines(apiKey, event.id, activeMarkets);
          const rows = parseEventPropLines(eventOdds, gameId, new Date().toISOString());
          rows.forEach((row) => {
            upsertPlayerPropLine(row);
            linesInserted += 1;
          });
          const sogRows = rows.filter((r) => r.propType === 'shots_on_goal').length;
          const blkRows = rows.filter((r) => r.propType === 'blocked_shots').length;
          eventsProcessed += 1;
          console.log(
            `[${JOB_NAME}] ${event.away_team} @ ${event.home_team}: ` +
            `${sogRows} SOG lines, ${blkRows} BLK lines`,
          );
        } catch (err) {
          console.error(`[${JOB_NAME}] Event ${event.id} failed: ${err.message}`);
        }

        if (DEFAULT_SLEEP_MS > 0) await sleep(DEFAULT_SLEEP_MS);
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

module.exports = { pullNhlPlayerShotsProps };
