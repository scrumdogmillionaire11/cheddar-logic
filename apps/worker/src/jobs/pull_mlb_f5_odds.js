'use strict';
/**
 * Pull MLB F5 Total Odds (totals_1st_5_innings)
 *
 * Fetches `totals_1st_5_innings` market lines from The Odds API for all
 * upcoming MLB games, then patches the `total_f5`, `total_f5_price_over`, and
 * `total_f5_price_under` fields on the existing odds_snapshot rows.
 *
 * Why per-event, not bulk?
 *   The bulk /v4/sports/{sport}/odds endpoint returns 422 for period/prop markets.
 *   `totals_1st_5_innings` is a period market → per-event /events/{id}/odds required.
 *
 * Token cost: 1 (events list) + 1 per game = ~8 tokens for a typical daily slate.
 *
 * WI-0727: MLB F5 is a projection-only lane. This job is hard-disabled to
 * prevent per-event Odds API token burn. See docs/MARKET_REGISTRY.md.
 *
 * Exit codes: 0 = success, 1 = failure
 */
require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  patchOddsSnapshotF5,
  upsertQuotaLedger,
  withDb,
  getDatabase,
} = require('@cheddar-logic/data');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'baseball_mlb';
const MARKET_KEY = 'totals_1st_5_innings';
const BOOKMAKERS = 'draftkings,fanduel,betmgm';
const HOURS_AHEAD = 36;
const JOB_NAME = 'pull-mlb-f5-odds';

/** Bookmaker priority for best-execution line selection (lower = preferred). */
const BOOKMAKER_PRIORITY = { draftkings: 1, fanduel: 2, betmgm: 3 };

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJsonWithHeaders(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
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
 * Fetch upcoming MLB event list (1 token).
 * @param {string} apiKey
 */
async function fetchUpcomingMlbEvents(apiKey) {
  const cutoffIso = new Date(Date.now() + HOURS_AHEAD * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events` +
    `?apiKey=${apiKey}&dateFormat=iso&commenceTimeTo=${cutoffIso}`;
  console.log(`[${JOB_NAME}] Fetching upcoming MLB events (next ${HOURS_AHEAD}h window)`);
  const response = await fetchJsonWithHeaders(url);
  const now = Date.now();
  const events = (Array.isArray(response.data) ? response.data : []).filter(
    (e) => new Date(e.commence_time).getTime() > now,
  );
  return { events, remainingTokens: response.remainingTokens };
}

/**
 * Fetch totals_1st_5_innings odds for a single event (1 token).
 * @param {string} apiKey
 * @param {string} eventId
 */
async function fetchEventF5Odds(apiKey, eventId) {
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events/${eventId}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${MARKET_KEY}&bookmakers=${BOOKMAKERS}&oddsFormat=american`;
  return fetchJsonWithHeaders(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse totals_1st_5_innings from an Odds API event response.
 * Uses best-execution strategy: DraftKings > FanDuel > BetMGM.
 * Returns { line, overPrice, underPrice } or null if market not available.
 *
 * @param {object} eventOdds - Raw Odds API event response
 * @returns {{ line: number, overPrice: number|null, underPrice: number|null } | null}
 */
function parseF5TotalLine(eventOdds) {
  if (!eventOdds?.bookmakers?.length) return null;

  // Collect best candidate per bookmaker-priority
  let bestCandidate = null;
  let bestPriority = Infinity;

  for (const bm of eventOdds.bookmakers) {
    const priority = BOOKMAKER_PRIORITY[bm.key] ?? 99;
    if (priority >= bestPriority) continue; // already have a better source

    const market = (bm.markets || []).find((m) => m.key === MARKET_KEY);
    if (!market?.outcomes?.length) continue;

    let line = null;
    let overPrice = null;
    let underPrice = null;

    for (const outcome of market.outcomes) {
      const side = (outcome.name || '').toLowerCase();
      const point = typeof outcome.point === 'number' ? outcome.point : parseFloat(outcome.point);
      if (!Number.isFinite(point)) continue;

      if (side === 'over') {
        line = point; // both over/under share the same line
        overPrice = Number.isFinite(outcome.price) ? Math.trunc(outcome.price) : null;
      } else if (side === 'under') {
        underPrice = Number.isFinite(outcome.price) ? Math.trunc(outcome.price) : null;
      }
    }

    if (line !== null) {
      bestCandidate = { line, overPrice, underPrice, bookmaker: bm.key };
      bestPriority = priority;
    }
  }

  return bestCandidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game-ID resolution (mirrors pull_mlb_pitcher_strikeout_props.js)
// ─────────────────────────────────────────────────────────────────────────────

function resolveGameId(db, event) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const eventHome = norm(event.home_team);
  const eventAway = norm(event.away_team);

  // Step 1: exact match within ±3600s
  const exactCandidates = db
    .prepare(
      `SELECT game_id, home_team, away_team
       FROM games
       WHERE LOWER(sport) = 'mlb'
         AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 3600
       ORDER BY game_time_utc ASC
       LIMIT 20`,
    )
    .all(event.commence_time);

  for (const g of exactCandidates) {
    if (norm(g.home_team) === eventHome && norm(g.away_team) === eventAway) {
      return g.game_id;
    }
  }

  // Step 2: 6-char prefix fallback within 4h
  const prefixCandidates = db
    .prepare(
      `SELECT game_id, home_team, away_team
       FROM games
       WHERE LOWER(sport) = 'mlb'
         AND status = 'scheduled'
         AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 14400
       ORDER BY game_time_utc ASC
       LIMIT 10`,
    )
    .all(event.commence_time);

  for (const g of prefixCandidates) {
    const dbHome = norm(g.home_team);
    const dbAway = norm(g.away_team);
    const homeMatch = dbHome.includes(eventHome.slice(0, 6)) || eventHome.includes(dbHome.slice(0, 6));
    const awayMatch = dbAway.includes(eventAway.slice(0, 6)) || eventAway.includes(dbAway.slice(0, 6));
    if (homeMatch && awayMatch) {
      console.warn(
        `[${JOB_NAME}] resolveGameId: prefix fallback used for "${event.away_team} @ ${event.home_team}" → ${g.game_id}`,
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
 * Pull MLB F5 total odds (totals_1st_5_innings) and patch odds_snapshots.
 *
 * @param {{ dryRun?: boolean, jobKey?: string }} [options]
 * @returns {Promise<{ success: boolean, patchedRows: number, errors: string[] }>}
 */
async function pullMlbF5Odds({ dryRun = false, jobKey = null } = {}) {
  // WI-0727: MLB F5 is a projection-only lane. Odds fetching is hard-disabled
  // to prevent per-event Odds API token burn. Do not remove this guard without
  // a new work item that establishes a quota-safe featured-market strategy.
  console.log(`[${JOB_NAME}] Skipped — MLB F5 odds fetch is hard-disabled (projection-only lane)`);
  return { success: true, patchedRows: 0, errors: [], skipped: true, reason: 'projection_only_lane' };

  // eslint-disable-next-line no-unreachable
  if (process.env.APP_ENV === 'local') {
    console.log(`[${JOB_NAME}] Skipped — APP_ENV=local. API pulls must not run in dev.`);
    return { success: true, patchedRows: 0, errors: [] };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error(`[${JOB_NAME}] ODDS_API_KEY not set — cannot pull F5 odds.`);
    return { success: false, patchedRows: 0, errors: ['ODDS_API_KEY not set'] };
  }

  return withDb(async () => {
    const resolvedJobKey = jobKey || `${JOB_NAME}|${new Date().toISOString().slice(0, 16)}`;
    const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

    insertJobRun(JOB_NAME, jobRunId, resolvedJobKey);

    const errors = [];
    let patchedRows = 0;

    try {
      const { events, remainingTokens: eventsTokens } = dryRun
        ? { events: [], remainingTokens: null }
        : await fetchUpcomingMlbEvents(apiKey);

      if (eventsTokens != null) {
        const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        try {
          upsertQuotaLedger({ provider: 'odds_api', period, tokens_remaining: eventsTokens, updated_by: jobRunId });
        } catch (_) { /* quota_ledger table may not exist yet */ }
      }

      if (events.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming MLB events in ${HOURS_AHEAD}h window`);
        markJobRunSuccess(jobRunId);
        return { success: true, patchedRows: 0, errors: [] };
      }

      console.log(`[${JOB_NAME}] Found ${events.length} upcoming MLB events; fetching F5 totals per event`);

      const db = getDatabase();

      for (const event of events) {
        try {
          const gameId = resolveGameId(db, event);
          if (!gameId) {
            console.warn(`[${JOB_NAME}] Could not resolve game_id for ${event.away_team} @ ${event.home_team} — skipping`);
            continue;
          }

          const { data: eventOdds, remainingTokens: eventTokens } = dryRun
            ? { data: {}, remainingTokens: null }
            : await fetchEventF5Odds(apiKey, event.id);

          if (eventTokens != null) {
            const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
            try {
              upsertQuotaLedger({ provider: 'odds_api', period, tokens_remaining: eventTokens, updated_by: jobRunId });
            } catch (_) { /* quota_ledger table may not exist yet */ }
          }

          const f5 = parseF5TotalLine(eventOdds);

          if (!f5) {
            console.log(`[${JOB_NAME}] ${gameId}: no totals_1st_5_innings market available`);
            continue;
          }

          const changes = dryRun ? 1 : patchOddsSnapshotF5(gameId, {
            line: f5.line,
            overPrice: f5.overPrice,
            underPrice: f5.underPrice,
          });

          if (changes > 0) {
            patchedRows++;
            console.log(
              `[${JOB_NAME}] ${gameId}: patched F5 total — line=${f5.line} over=${f5.overPrice} under=${f5.underPrice} (source: ${f5.bookmaker}) [dryRun=${dryRun}]`,
            );
          } else {
            console.warn(`[${JOB_NAME}] ${gameId}: no odds_snapshot row found to patch — run pull_odds_hourly first`);
          }
        } catch (eventErr) {
          const msg = `Event ${event.id} (${event.away_team} @ ${event.home_team}): ${eventErr.message}`;
          errors.push(msg);
          console.error(`[${JOB_NAME}] ${msg}`);
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(`[${JOB_NAME}] ✅ Done — ${patchedRows} snapshots patched, ${errors.length} errors.`);
      return { success: true, patchedRows, errors };
    } catch (err) {
      markJobRunFailure(jobRunId, err.message);
      console.error(`[${JOB_NAME}] ❌ Job failed: ${err.message}`);
      return { success: false, patchedRows, errors: [err.message, ...errors] };
    }
  });
}

// CLI execution
if (require.main === module) {
  pullMlbF5Odds()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Uncaught error:', err);
      process.exit(1);
    });
}

module.exports = {
  pullMlbF5Odds,
  parseF5TotalLine,
  resolveGameId,
};
