'use strict';
/**
 * Pull NHL 1st-Period Total Odds
 *
 * Fetches totals_p1 (1st-period over/under) lines and prices from The Odds API
 * using the per-event endpoint, then patches the most-recent odds_snapshot for
 * each game with total_1p / total_1p_price_over / total_1p_price_under.
 *
 * The bulk /sports/{sport}/odds endpoint does NOT support period markets.
 * Per-event /events/{id}/odds is required — same pattern as pull_nhl_player_shots_props.
 *
 * Step 1: GET /v4/sports/icehockey_nhl/events  (1 token — get event IDs in window)
 * Step 2: GET /v4/sports/icehockey_nhl/events/{id}/odds?markets=totals_p1  (1 token/game)
 *
 * Token cost: 1 (events list) + N games in HOURS_AHEAD window ≈ 2–16 tokens/run.
 *
 * WI-0727: NHL 1P totals are projection-only. This job is hard-disabled to
 * prevent per-event Odds API token burn.
 *
 * Run model after this job to pick up real 1P lines:
 *   NHL_1P_FAIR_PROB_PHASE2=true enables the enhanced 1P probability calc.
 */
require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  withDb,
  patchOddsSnapshot1p,
  upsertQuotaLedger,
  getDatabase,
} = require('@cheddar-logic/data');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'icehockey_nhl';
const MARKET_1P = 'totals_p1';
const BOOKMAKERS = 'draftkings,fanduel,betmgm';
const HOURS_AHEAD = 36;
const JOB_NAME = 'pull-nhl-1p-odds';
/** Minimum ms between per-event API requests to avoid 429 rate limiting */
const REQUEST_DELAY_MS = 150;

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
 * Fetch upcoming NHL events (game list with IDs) within HOURS_AHEAD window.
 * Costs 1 token.
 */
async function fetchUpcomingNhlEvents(apiKey) {
  const cutoffIso = new Date(Date.now() + HOURS_AHEAD * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z'); // strip ms — Odds API requires YYYY-MM-DDTHH:MM:SSZ
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events` +
    `?apiKey=${apiKey}&dateFormat=iso&commenceTimeTo=${cutoffIso}`;
  console.log(`[${JOB_NAME}] Fetching upcoming NHL events (next ${HOURS_AHEAD}h window)`);
  const response = await fetchJsonWithHeaders(url);
  const now = Date.now();
  const events = (Array.isArray(response.data) ? response.data : []).filter(
    (e) => new Date(e.commence_time).getTime() > now,
  );
  return { events, remainingTokens: response.remainingTokens };
}

/**
 * Fetch 1P total odds for a single NHL event using the per-event endpoint.
 * Costs 1 token per event.
 */
async function fetchEvent1pOdds(apiKey, eventId) {
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events/${eventId}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${MARKET_1P}&bookmakers=${BOOKMAKERS}&oddsFormat=american`;
  return fetchJsonWithHeaders(url);
}

/**
 * Resolve game_id from the cheddar games table using Odds API event home/away teams.
 * Mirrors the pattern in pull_nhl_player_shots_props.js.
 */
function resolveGameId(db, event) {
  const homeTeam = event.home_team;
  const awayTeam = event.away_team;
  const commenceTime = event.commence_time;
  if (!homeTeam || !awayTeam || !commenceTime) return null;

  // Match by team names within ±4 hours of commence_time
  const gameDate = commenceTime.slice(0, 10); // YYYY-MM-DD
  const row = db
    .prepare(
      `SELECT game_id FROM games
        WHERE (home_team LIKE ? OR home_team LIKE ?)
          AND (away_team LIKE ? OR away_team LIKE ?)
          AND DATE(game_time_utc) = ?
        ORDER BY ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) ASC
        LIMIT 1`,
    )
    .get(
      `%${homeTeam}%`,
      `%${homeTeam.split(' ').pop()}%`,
      `%${awayTeam}%`,
      `%${awayTeam.split(' ').pop()}%`,
      gameDate,
      commenceTime,
    );
  return row?.game_id ?? null;
}

/**
 * Parse the first bookmaker's totals_p1 outcomes for the event.
 * Returns { line, overPrice, underPrice } or null if not found.
 */
function parse1pTotal(eventOdds) {
  if (!eventOdds?.bookmakers?.length) return null;

  for (const bm of eventOdds.bookmakers) {
    const market = (bm.markets || []).find((m) => m.key === MARKET_1P);
    if (!market?.outcomes?.length) continue;

    const overOutcome = market.outcomes.find(
      (o) => String(o.name).toUpperCase() === 'OVER',
    );
    const underOutcome = market.outcomes.find(
      (o) => String(o.name).toUpperCase() === 'UNDER',
    );
    if (!overOutcome && !underOutcome) continue;

    const line =
      Number.isFinite(overOutcome?.point) ? overOutcome.point
        : Number.isFinite(underOutcome?.point) ? underOutcome.point
          : null;
    const overPrice = Number.isFinite(overOutcome?.price) ? overOutcome.price : null;
    const underPrice = Number.isFinite(underOutcome?.price) ? underOutcome.price : null;

    if (line === null && overPrice === null && underPrice === null) continue;
    return { line, overPrice, underPrice, bookmaker: bm.key };
  }
  return null;
}

async function pullNhl1pOdds({ dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  if (process.env.APP_ENV === 'local') {
    console.log(`[${JOB_NAME}] Skipped — APP_ENV=local. 1P odds pulls must not hit the live API in dev.`);
    return { success: true, eventsProcessed: 0, gamesPatched: 0 };
  }

  console.log(`[${JOB_NAME}] Skipped — NHL 1P odds fetch is hard-disabled (projection-only lane)`);
  return { success: true, skipped: true, reason: 'projection_only_lane' };

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error(`[${JOB_NAME}] ODDS_API_KEY not set`);
    return { success: false, error: 'ODDS_API_KEY not set' };
  }

  if (dryRun) {
    console.log(`[${JOB_NAME}] DRY_RUN — would fetch NHL 1P totals for all upcoming events`);
    return { success: true, dryRun: true };
  }

  return withDb(async () => {
    const db = getDatabase();
    try {
      insertJobRun(JOB_NAME, jobRunId, null);

      // Step 1: event list (1 token)
      const { events, remainingTokens: eventsTokens } = await fetchUpcomingNhlEvents(apiKey);
      const updateQuota = (rt) => {
        if (rt == null) return;
        const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        try { upsertQuotaLedger({ provider: 'odds_api', period, tokens_remaining: rt, updated_by: jobRunId }); } catch {}
      };
      updateQuota(eventsTokens);

      if (events.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming NHL events in ${HOURS_AHEAD}h window`);
        markJobRunSuccess(jobRunId, { eventsProcessed: 0, gamesPatched: 0 });
        return { success: true, eventsProcessed: 0, gamesPatched: 0 };
      }
      console.log(`[${JOB_NAME}] Found ${events.length} upcoming NHL events, fetching 1P odds`);

      let eventsProcessed = 0;
      let gamesPatched = 0;
      let lastRemainingTokens = eventsTokens;

      // Step 2: per-event 1P odds fetch (1 token/event)
      for (const event of events) {
        const gameId = resolveGameId(db, event);
        if (!gameId) {
          console.warn(`[${JOB_NAME}] Could not resolve game_id for ${event.away_team} @ ${event.home_team}`);
          // Still throttle so subsequent requests don't 429
          await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
          continue;
        }

        try {
          const { data: eventOdds, remainingTokens: rt } = await fetchEvent1pOdds(apiKey, event.id);
          if (rt != null) { lastRemainingTokens = rt; updateQuota(rt); }

          const parsed = parse1pTotal(eventOdds);
          if (!parsed) {
            console.log(`[${JOB_NAME}] ${event.away_team} @ ${event.home_team}: no 1P total odds available`);
          } else {
            const changed = patchOddsSnapshot1p(gameId, {
              line: parsed.line,
              overPrice: parsed.overPrice,
              underPrice: parsed.underPrice,
            });
            if (changed > 0) {
              gamesPatched += 1;
              console.log(
                `[${JOB_NAME}] ${event.away_team} @ ${event.home_team}: 1P line=${parsed.line} ` +
                `over=${parsed.overPrice} under=${parsed.underPrice} (${parsed.bookmaker})`,
              );
            } else {
              console.warn(`[${JOB_NAME}] ${event.away_team} @ ${event.home_team}: no snapshot to patch (run pull_odds_hourly first)`);
            }
          }
          eventsProcessed += 1;
        } catch (err) {
          console.error(`[${JOB_NAME}] Event ${event.id} (${event.away_team} @ ${event.home_team}) failed: ${err.message}`);
        }

        // Throttle to stay within Odds API freq limit
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      }

      if (lastRemainingTokens != null) {
        console.log(`[${JOB_NAME}] Tokens remaining after all fetches: ${lastRemainingTokens}`);
      }

      markJobRunSuccess(jobRunId, { eventsProcessed, gamesPatched });
      console.log(`[${JOB_NAME}] Done: ${eventsProcessed} events processed, ${gamesPatched} snapshots patched`);
      return { success: true, eventsProcessed, gamesPatched };
    } catch (err) {
      console.error(`[${JOB_NAME}] Job failed:`, err.message);
      try { markJobRunFailure(jobRunId, { error: err.message }); } catch {}
      return { success: false, error: err.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullNhl1pOdds({ dryRun })
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { pullNhl1pOdds, parse1pTotal, resolveGameId };
