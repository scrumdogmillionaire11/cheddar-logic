'use strict';
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
const SOCCER_LEAGUE_KEYS = [
  'soccer_epl',
  'soccer_usa_mls',
  'soccer_uefa_champs_league',
];
const SOCCER_TIER1_PROP_MARKETS = {
  player_shots: { canonicalMarket: 'player_shots', propType: 'player_shots' },
  to_score_or_assist: {
    canonicalMarket: 'to_score_or_assist',
    propType: 'to_score_or_assist',
  },
};
const PROP_MARKET_KEYS = Object.keys(SOCCER_TIER1_PROP_MARKETS);
const BOOKMAKERS = 'betmgm,draftkings,fanduel,williamhill_us,espnbet';
const HOURS_AHEAD = 36;
const DEFAULT_SLEEP_MS = Number(process.env.SOCCER_PROP_SLEEP_MS || 1000);
const JOB_NAME = 'pull_soccer_player_props';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizePlayerName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeOutcomeSide(outcomeName) {
  const normalized = String(outcomeName || '').trim().toLowerCase();
  if (normalized === 'over' || normalized === 'yes') return 'over';
  if (normalized === 'under' || normalized === 'no') return 'under';
  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    const error = new Error(`Odds API ${response.status} for ${url}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchSoccerEvents(apiKey, leagueKey) {
  const url = `${ODDS_API_BASE}/sports/${leagueKey}/events?apiKey=${apiKey}`;
  const events = await fetchJson(url);
  const nowMs = Date.now();
  const cutoffMs = nowMs + HOURS_AHEAD * 60 * 60 * 1000;

  return (Array.isArray(events) ? events : []).filter((event) => {
    const eventMs = new Date(event.commence_time).getTime();
    return Number.isFinite(eventMs) && eventMs > nowMs && eventMs <= cutoffMs;
  });
}

async function fetchSoccerEventPropLines(apiKey, leagueKey, eventId, marketKey) {
  const url =
    `${ODDS_API_BASE}/sports/${leagueKey}/events/${eventId}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${marketKey}&bookmakers=${BOOKMAKERS}`;
  return fetchJson(url);
}

function resolveSoccerGameId(database, event) {
  const byEventId = database
    .prepare(
      `
      SELECT game_id
      FROM games
      WHERE LOWER(sport) = 'soccer' AND game_id = ?
      LIMIT 1
    `,
    )
    .get(event.id);
  if (byEventId?.game_id) return byEventId.game_id;

  const candidates = database
    .prepare(
      `
      SELECT game_id, home_team, away_team
      FROM games
      WHERE LOWER(sport) = 'soccer'
        AND ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) < 14400
      ORDER BY ABS(strftime('%s', game_time_utc) - strftime('%s', ?)) ASC
      LIMIT 10
    `,
    )
    .all(event.commence_time, event.commence_time);

  const normalizeTeam = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const eventHome = normalizeTeam(event.home_team);
  const eventAway = normalizeTeam(event.away_team);

  for (const candidate of candidates) {
    const dbHome = normalizeTeam(candidate.home_team);
    const dbAway = normalizeTeam(candidate.away_team);
    const homeMatch = dbHome.includes(eventHome.slice(0, 4)) || eventHome.includes(dbHome.slice(0, 4));
    const awayMatch = dbAway.includes(eventAway.slice(0, 4)) || eventAway.includes(dbAway.slice(0, 4));
    if (homeMatch && awayMatch) return candidate.game_id;
  }

  return null;
}

function parseEventPropLines(eventOdds, gameId, marketKey, fetchedAt) {
  const marketConfig = SOCCER_TIER1_PROP_MARKETS[marketKey];
  if (!marketConfig) return [];

  const rows = [];
  const bookmakers = Array.isArray(eventOdds?.bookmakers) ? eventOdds.bookmakers : [];

  for (const bookmaker of bookmakers) {
    const market = (bookmaker.markets || []).find((entry) => entry.key === marketKey);
    if (!market?.outcomes || !Array.isArray(market.outcomes)) continue;

    const groupedByPlayer = new Map();
    for (const outcome of market.outcomes) {
      const playerName = normalizePlayerName(outcome.description || outcome.name);
      if (!playerName) continue;

      const side = normalizeOutcomeSide(outcome.name);
      if (!side) continue;

      const existing = groupedByPlayer.get(playerName) || {
        line: null,
        overPrice: null,
        underPrice: null,
      };

      const lineValue = Number.isFinite(outcome.point)
        ? outcome.point
        : (side === 'over' || side === 'under')
          ? 0.5
          : null;
      if (lineValue !== null && existing.line === null) {
        existing.line = lineValue;
      }

      if (side === 'over') {
        existing.overPrice = Number.isFinite(outcome.price) ? outcome.price : null;
      }
      if (side === 'under') {
        existing.underPrice = Number.isFinite(outcome.price) ? outcome.price : null;
      }

      groupedByPlayer.set(playerName, existing);
    }

    for (const [playerName, values] of groupedByPlayer.entries()) {
      if (!Number.isFinite(values.line)) continue;
      rows.push({
        id: `soccer-prop-${gameId}-${marketConfig.propType}-${playerName.replace(/\s+/g, '-').toLowerCase()}-${bookmaker.key}-${uuidV4().slice(0, 6)}`,
        sport: 'SOCCER',
        gameId,
        oddsEventId: eventOdds?.id || null,
        playerName,
        propType: marketConfig.propType,
        period: 'full_game',
        line: values.line,
        overPrice: values.overPrice,
        underPrice: values.underPrice,
        bookmaker: bookmaker.key,
        fetchedAt,
      });
    }
  }

  return rows;
}

async function pullSoccerPlayerProps({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  const enabled = process.env.SOCCER_PROP_EVENTS_ENABLED === 'true';
  if (!enabled && !dryRun) {
    console.log(`[${JOB_NAME}] Skipped — set SOCCER_PROP_EVENTS_ENABLED=true to enable`);
    return { success: true, skipped: true, reason: 'not_enabled' };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error(`[${JOB_NAME}] ODDS_API_KEY not set`);
    return { success: false, error: 'ODDS_API_KEY not set' };
  }

  if (dryRun) {
    console.log(`[${JOB_NAME}] DRY_RUN — would fetch soccer event props`);
    return { success: true, dryRun: true };
  }

  return withDb(async () => {
    const database = getDatabase();
    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      let eventsProcessed = 0;
      let linesInserted = 0;

      for (const leagueKey of SOCCER_LEAGUE_KEYS) {
        let leagueEvents = [];
        try {
          leagueEvents = await fetchSoccerEvents(apiKey, leagueKey);
        } catch (leagueError) {
          console.error(`[${JOB_NAME}] ${leagueKey} events failed: ${leagueError.message}`);
          continue;
        }

        for (const event of leagueEvents) {
          const gameId = resolveSoccerGameId(database, event);
          if (!gameId) {
            console.warn(
              `[${JOB_NAME}] Could not resolve game_id for ${leagueKey}/${event.id} (${event.away_team} @ ${event.home_team})`,
            );
            continue;
          }

          let eventRowCount = 0;
          for (const marketKey of PROP_MARKET_KEYS) {
            try {
              const eventOdds = await fetchSoccerEventPropLines(
                apiKey,
                leagueKey,
                event.id,
                marketKey,
              );
              const parsedRows = parseEventPropLines(
                eventOdds,
                gameId,
                marketKey,
                new Date().toISOString(),
              );
              parsedRows.forEach((row) => {
                upsertPlayerPropLine(row);
                linesInserted += 1;
                eventRowCount += 1;
              });
            } catch (marketError) {
              if (marketError?.status === 422) {
                console.warn(
                  `[${JOB_NAME}] ${leagueKey}/${event.id}/${marketKey} skipped: unsupported market for this event/bookmaker set (422)`,
                );
                continue;
              }
              console.error(
                `[${JOB_NAME}] ${leagueKey}/${event.id}/${marketKey} failed: ${marketError.message}`,
              );
            }

            if (DEFAULT_SLEEP_MS > 0) {
              await sleep(DEFAULT_SLEEP_MS);
            }
          }

          eventsProcessed += 1;
          console.log(
            `[${JOB_NAME}] ${leagueKey} ${event.away_team} @ ${event.home_team}: ${eventRowCount} Tier-1 prop lines`,
          );
        }
      }

      markJobRunSuccess(jobRunId, { eventsProcessed, linesInserted });
      console.log(`[${JOB_NAME}] Done: ${eventsProcessed} events, ${linesInserted} lines`);
      return { success: true, eventsProcessed, linesInserted };
    } catch (error) {
      console.error(`[${JOB_NAME}] Job failed: ${error.message}`);
      try {
        markJobRunFailure(jobRunId, { error: error.message });
      } catch {}
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullSoccerPlayerProps({ dryRun })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  pullSoccerPlayerProps,
  parseEventPropLines,
  normalizeOutcomeSide,
  normalizePlayerName,
};
