'use strict';
/**
 * Pull MLB Pitcher Strikeout Prop Lines
 *
 * Fetches `pitcher_strikeouts` O/U market lines from The Odds API per-event
 * player props endpoint for upcoming MLB games, stores into player_prop_lines.
 *
 * Endpoint: GET /v4/sports/baseball_mlb/events/{eventId}/odds
 *   ?markets=pitcher_strikeouts&regions=us&bookmakers=...
 *
 * Token cost: 1 token per event (only runs for games within HOURS_AHEAD window).
 *
 * Guard flag (default OFF — must opt-in):
 *   MLB_PITCHER_K_PROP_EVENTS_ENABLED=true   — enables pitcher_strikeouts pull
 *
 * Mode flag:
 *   PITCHER_KS_MODEL_MODE=ODDS_BACKED        — required for this pull to feed
 *                                              market evaluation in the K engine
 *   PITCHER_KS_MODEL_MODE=PROJECTION_ONLY    — pull is skipped; engine runs on
 *                                              projection inputs only
 *
 * Exit codes: 0 = success, 1 = failure
 *
 * WI-0597 scope: odds ingestion + dual-mode runtime wiring.
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
const SPORT_KEY = 'baseball_mlb';
const MARKET_KEY = 'pitcher_strikeouts';
/** propType stored in player_prop_lines */
const PROP_TYPE = 'pitcher_strikeouts';

const BOOKMAKERS = 'draftkings,fanduel,betmgm';
const HOURS_AHEAD = 36;
const DEFAULT_SLEEP_MS = Number(process.env.MLB_PITCHER_K_PROP_SLEEP_MS || 1000);
const JOB_NAME = 'pull-mlb-pitcher-strikeout-props';

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert decimal or American price to canonical American integer (or null). */
function normalizePriceToAmerican(rawPrice) {
  const numericPrice = Number(rawPrice);
  if (!Number.isFinite(numericPrice) || numericPrice === 0) return null;
  // Already American-format: value outside [-1, 1] and far from ±1
  if (numericPrice <= -100 || numericPrice >= 100) {
    return Math.trunc(numericPrice);
  }
  if (numericPrice <= 1) return null;
  // Decimal odds ≥ 2.0
  if (numericPrice >= 2) {
    return Math.round((numericPrice - 1) * 100);
  }
  // Decimal between 1 and 2 (e.g. 1.77 → -130)
  return Math.round(-100 / (numericPrice - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    throw new Error(`Odds API ${response.status} for ${url}`);
  }
  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Odds API fetch layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch list of upcoming MLB events from The Odds API.
 * Returns events commencing within HOURS_AHEAD hours.
 */
async function fetchMlbEvents(apiKey) {
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
 * Fetch pitcher_strikeouts prop lines for a single event.
 * @param {string} apiKey
 * @param {string} eventId
 */
async function fetchEventPropLines(apiKey, eventId) {
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events/${eventId}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${MARKET_KEY}&bookmakers=${BOOKMAKERS}&oddsFormat=american`;
  return fetchJson(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse pitcher_strikeouts prop lines from an Odds API event odds response.
 * One row per (pitcher_name × bookmaker × line) — retains ladders.
 *
 * @param {object} eventOdds  - Raw Odds API response for one event
 * @param {string} gameId     - Canonical internal game_id
 * @param {string} fetchedAt  - ISO timestamp of fetch
 * @returns {object[]} rows ready for upsertPlayerPropLine
 */
function parseEventPropLines(eventOdds, gameId, fetchedAt) {
  const rows = [];
  if (!eventOdds?.bookmakers) return rows;

  for (const bm of eventOdds.bookmakers) {
    for (const market of bm.markets || []) {
      if (market.key !== MARKET_KEY || !market.outcomes) continue;

      // Group outcomes by pitcher_name + point so same-book ladders remain
      // distinct rows (e.g. o6.5 and o7.5 for the same pitcher).
      const byPitcherLine = {};
      for (const outcome of market.outcomes) {
        // Odds API pitcher_strikeouts: description = pitcher name, name = Over/Under
        const pitcherName = outcome.description;
        const side = (outcome.name || '').toLowerCase();
        const line = Number(outcome.point);

        if (!pitcherName || (side !== 'over' && side !== 'under') || !Number.isFinite(line)) {
          continue;
        }

        const key = `${pitcherName.toLowerCase()}|${line}`;
        if (!byPitcherLine[key]) {
          byPitcherLine[key] = {
            pitcherName,
            line,
            overPrice: null,
            underPrice: null,
          };
        }
        const priceAmerican = normalizePriceToAmerican(outcome.price);
        if (side === 'over') {
          byPitcherLine[key].overPrice = priceAmerican;
        } else {
          byPitcherLine[key].underPrice = priceAmerican;
        }
      }

      for (const { pitcherName, line, overPrice, underPrice } of Object.values(byPitcherLine)) {
        rows.push({
          id: uuidV4(),
          sport: 'MLB',
          gameId,
          oddsEventId: eventOdds.id,
          playerName: pitcherName,
          propType: PROP_TYPE,
          period: 'full_game',
          line,
          overPrice,
          underPrice,
          bookmaker: bm.key,
          fetchedAt,
        });
      }
    }
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game-ID resolution (two-step: exact → prefix)
// Mirrors pull_nhl_player_shots_props.js strategy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve canonical game_id from an Odds API MLB event.
 * Step 1: exact normalized team name match within 1-hour window.
 * Step 2: 6-char prefix heuristic within 4-hour window.
 * Returns game_id string or null.
 *
 * @param {object} db   - better-sqlite3 DB handle
 * @param {object} event - Odds API event object {commence_time, home_team, away_team}
 * @returns {string|null}
 */
function resolveGameId(db, event) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const eventHome = norm(event.home_team);
  const eventAway = norm(event.away_team);

  // Step 1: exact match within ±3600s (wider than model runner's 900s to handle
  // scheduling drift between Odds API and MLB Stats API calendars)
  const exactCandidates = db.prepare(`
    SELECT game_id, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'mlb'
      AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 3600
    ORDER BY game_time_utc ASC
    LIMIT 20
  `).all(event.commence_time);

  for (const g of exactCandidates) {
    if (norm(g.home_team) === eventHome && norm(g.away_team) === eventAway) {
      return g.game_id;
    }
  }

  // Step 2: 6-char normalized prefix fallback (handles city-only vs full name)
  const prefixCandidates = db.prepare(`
    SELECT game_id, home_team, away_team
    FROM games
    WHERE LOWER(sport) = 'mlb'
      AND status = 'scheduled'
      AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 14400
    ORDER BY game_time_utc ASC
    LIMIT 10
  `).all(event.commence_time);

  for (const g of prefixCandidates) {
    const dbHome = norm(g.home_team);
    const dbAway = norm(g.away_team);
    const homeMatch =
      dbHome.includes(eventHome.slice(0, 6)) ||
      eventHome.includes(dbHome.slice(0, 6));
    const awayMatch =
      dbAway.includes(eventAway.slice(0, 6)) ||
      eventAway.includes(dbAway.slice(0, 6));
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

// ─────────────────────────────────────────────────────────────────────────────
// Main job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull MLB pitcher strikeout prop lines (pitcher_strikeouts) from The Odds API.
 *
 * Guard: MLB_PITCHER_K_PROP_EVENTS_ENABLED must be 'true' to run.
 * In PROJECTION_ONLY mode the engine does not need market lines — pull is skipped.
 *
 * @param {{ dryRun?: boolean, jobKey?: string }} [options]
 * @returns {Promise<{ success: boolean, insertedRows: number, errors: string[] }>}
 */
async function pullMlbPitcherStrikeoutProps({ dryRun = false, jobKey = null } = {}) {
  const isEnabled = process.env.MLB_PITCHER_K_PROP_EVENTS_ENABLED === 'true';
  const ksMode = process.env.PITCHER_KS_MODEL_MODE || null;
  const isOddsBacked = ksMode === 'ODDS_BACKED';

  if (!isEnabled && !dryRun) {
    console.log(
      `[${JOB_NAME}] Skipped — MLB_PITCHER_K_PROP_EVENTS_ENABLED is not 'true'. ` +
        `Set to 'true' together with PITCHER_KS_MODEL_MODE=ODDS_BACKED to activate.`,
    );
    return { success: true, insertedRows: 0, errors: [] };
  }

  if (!isOddsBacked && !dryRun) {
    console.log(
      `[${JOB_NAME}] Skipped — PITCHER_KS_MODEL_MODE is '${ksMode || '(unset)'}'. ` +
        `Pull only runs in ODDS_BACKED mode. Set PITCHER_KS_MODEL_MODE=ODDS_BACKED to activate.`,
    );
    return { success: true, insertedRows: 0, errors: [] };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error(`[${JOB_NAME}] ODDS_API_KEY not set — cannot pull prop lines.`);
    return { success: false, insertedRows: 0, errors: ['ODDS_API_KEY not set'] };
  }

  return withDb(async () => {
    const resolvedJobKey = jobKey || `${JOB_NAME}|${new Date().toISOString().slice(0, 16)}`;
    const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

    insertJobRun({
      id: jobRunId,
      jobName: JOB_NAME,
      jobKey: resolvedJobKey,
      startedAt: new Date().toISOString(),
    });

    const errors = [];
    let insertedRows = 0;

    try {
      console.log(`[${JOB_NAME}] Fetching MLB events (T+${HOURS_AHEAD}h window)...`);
      const events = dryRun ? [] : await fetchMlbEvents(apiKey);
      console.log(`[${JOB_NAME}] Found ${events.length} upcoming MLB events.`);

      const db = getDatabase();

      for (const event of events) {
        try {
          // Resolve canonical game_id from the games table
          const gameId = resolveGameId(db, event);
          if (!gameId) {
            console.warn(
              `[${JOB_NAME}] Could not resolve game_id for event ${event.id} ` +
                `(${event.away_team} @ ${event.home_team})`,
            );
            continue;
          }

          console.log(
            `[${JOB_NAME}] Fetching pitcher_strikeouts for ${event.away_team} @ ${event.home_team} → ${gameId}`,
          );
          const eventOdds = await fetchEventPropLines(apiKey, event.id);
          const fetchedAt = new Date().toISOString();
          const rows = parseEventPropLines(eventOdds, gameId, fetchedAt);

          if (rows.length === 0) {
            console.log(
              `[${JOB_NAME}] No pitcher_strikeouts lines returned for ${gameId} (market may be unavailable).`,
            );
          }

          for (const row of rows) {
            if (!dryRun) {
              upsertPlayerPropLine(row);
            }
            insertedRows++;
          }

          console.log(
            `[${JOB_NAME}] ${gameId}: ${rows.length} lines ingested (dryRun=${dryRun}).`,
          );

          if (events.length > 1) {
            await sleep(DEFAULT_SLEEP_MS);
          }
        } catch (eventErr) {
          const msg = `Event ${event.id} (${event.away_team} @ ${event.home_team}): ${eventErr.message}`;
          errors.push(msg);
          console.error(`[${JOB_NAME}] ${msg}`);
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(
        `[${JOB_NAME}] ✅ Done — ${insertedRows} prop lines ingested, ${errors.length} errors.`,
      );
      return { success: true, insertedRows, errors };
    } catch (err) {
      markJobRunFailure(jobRunId, err.message);
      console.error(`[${JOB_NAME}] ❌ Job failed: ${err.message}`);
      return { success: false, insertedRows, errors: [err.message, ...errors] };
    }
  });
}

// CLI execution
if (require.main === module) {
  pullMlbPitcherStrikeoutProps()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = {
  pullMlbPitcherStrikeoutProps,
  parseEventPropLines,
  resolveGameId,
};
