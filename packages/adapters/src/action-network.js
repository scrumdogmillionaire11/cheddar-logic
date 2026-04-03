'use strict';

/**
 * ActionNetwork public betting-splits adapter
 *
 * Fetches and normalises public bet % / handle % / ticket % data from
 * ActionNetwork's unofficial public endpoint:
 *   https://api.actionnetwork.com/web/v1/game?league={SPORT}&date={YYYYMMDD}
 *
 * No authentication required; a browser User-Agent header avoids 403s.
 *
 * Field-name mapping note:
 *   ActionNetwork response shape was validated against the live API on
 *   2026-04-03. If the API changes its field names, update the pick() calls
 *   in extractBetPct() / extractHandlePct() / extractTicketPct() below and
 *   add a comment noting the date of the change.
 *
 * Known ActionNetwork response shape (as of 2026-04-03):
 *   {
 *     games: [{
 *       id: 12345,
 *       home_team: { full_name: "Boston Celtics", abbr: "BOS" },
 *       away_team: { full_name: "Golden State Warriors", abbr: "GSW" },
 *       start_time: "2026-03-29T00:00:00",
 *       bets: [
 *         { bet_type: "spread", home_bets: 60, away_bets: 40,
 *           home_handle: 55, away_handle: 45,
 *           home_tickets: 60, away_tickets: 40 }
 *       ]
 *     }]
 *   }
 *
 * Field aliases are tried in order so the normaliser is robust to minor
 * API schema changes.
 */

const { resolveTeamVariant } = require('@cheddar-logic/data/src/normalize');

// ─── Constants ──────────────────────────────────────────────────────────────

const ACTION_NETWORK_BASE = 'https://api.actionnetwork.com/web/v1/game';

/** Map our sport codes to ActionNetwork league strings */
const SPORT_TO_LEAGUE = {
  NFL: 'NFL',
  NBA: 'NBA',
  NHL: 'NHL',
  MLB: 'MLB',
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Return the first non-null value found at any of the given keys on obj.
 * Returns null (never undefined) when nothing matches.
 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null) return v;
  }
  return null;
}

/**
 * Coerce a value to a float 0–100 or null.
 * - Numeric values are returned as-is (assumed already 0–100 per ActionNetwork).
 * - Non-finite or out-of-range values become null so callers never see NaN.
 */
function toFloatPct(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

/**
 * Extract bet % home/away from an ActionNetwork game object.
 *
 * ActionNetwork nests percentages inside a `bets` array keyed by bet_type
 * (e.g. "money_line", "spread", "total").  We prefer "money_line" when present
 * and fall back to whichever entry exists first.
 *
 * Known field aliases (API observed 2026-04-03):
 *   home_bets, home_bets_pct, home_bets_%
 *   away_bets, away_bets_pct, away_bets_%
 */
function extractBetPct(game) {
  const bets = game.bets || game.bet_percentages || [];
  if (!Array.isArray(bets) || bets.length === 0) {
    // Some responses have a flat structure
    const homeRaw = pick(game, [
      'home_bets_pct', 'home_bets_%', 'home_bets', 'publicBetsPctHome',
    ]);
    const awayRaw = pick(game, [
      'away_bets_pct', 'away_bets_%', 'away_bets', 'publicBetsPctAway',
    ]);
    return {
      publicBetsPctHome: toFloatPct(homeRaw),
      publicBetsPctAway: toFloatPct(awayRaw),
    };
  }

  // Prefer money_line entry; fall back to first available
  const entry =
    bets.find((b) => b.bet_type === 'money_line') ||
    bets.find((b) => b.bet_type === 'moneyline') ||
    bets[0];

  const homeRaw = pick(entry, ['home_bets', 'home_bets_pct', 'home_bets_%']);
  const awayRaw = pick(entry, ['away_bets', 'away_bets_pct', 'away_bets_%']);
  return {
    publicBetsPctHome: toFloatPct(homeRaw),
    publicBetsPctAway: toFloatPct(awayRaw),
  };
}

/**
 * Extract handle % home/away.
 * Known field aliases: home_handle, home_handle_pct, home_handle_%
 */
function extractHandlePct(game) {
  const bets = game.bets || game.bet_percentages || [];
  if (!Array.isArray(bets) || bets.length === 0) {
    const homeRaw = pick(game, [
      'home_handle_pct', 'home_handle_%', 'home_handle', 'publicHandlePctHome',
    ]);
    const awayRaw = pick(game, [
      'away_handle_pct', 'away_handle_%', 'away_handle', 'publicHandlePctAway',
    ]);
    return {
      publicHandlePctHome: toFloatPct(homeRaw),
      publicHandlePctAway: toFloatPct(awayRaw),
    };
  }

  const entry =
    bets.find((b) => b.bet_type === 'money_line') ||
    bets.find((b) => b.bet_type === 'moneyline') ||
    bets[0];

  const homeRaw = pick(entry, ['home_handle', 'home_handle_pct', 'home_handle_%']);
  const awayRaw = pick(entry, ['away_handle', 'away_handle_pct', 'away_handle_%']);
  return {
    publicHandlePctHome: toFloatPct(homeRaw),
    publicHandlePctAway: toFloatPct(awayRaw),
  };
}

/**
 * Extract ticket % home/away.
 * Known field aliases: home_tickets, home_tickets_pct, home_tickets_%
 */
function extractTicketPct(game) {
  const bets = game.bets || game.bet_percentages || [];
  if (!Array.isArray(bets) || bets.length === 0) {
    const homeRaw = pick(game, [
      'home_tickets_pct', 'home_tickets_%', 'home_tickets', 'publicTicketsPctHome',
    ]);
    const awayRaw = pick(game, [
      'away_tickets_pct', 'away_tickets_%', 'away_tickets', 'publicTicketsPctAway',
    ]);
    return {
      publicTicketsPctHome: toFloatPct(homeRaw),
      publicTicketsPctAway: toFloatPct(awayRaw),
    };
  }

  const entry =
    bets.find((b) => b.bet_type === 'money_line') ||
    bets.find((b) => b.bet_type === 'moneyline') ||
    bets[0];

  const homeRaw = pick(entry, ['home_tickets', 'home_tickets_pct', 'home_tickets_%']);
  const awayRaw = pick(entry, ['away_tickets', 'away_tickets_pct', 'away_tickets_%']);
  return {
    publicTicketsPctHome: toFloatPct(homeRaw),
    publicTicketsPctAway: toFloatPct(awayRaw),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch public betting splits for a given sport + date from ActionNetwork.
 *
 * @param {object} options
 * @param {string} options.sport  - One of: NFL, NBA, NHL, MLB
 * @param {string} options.date   - Date in YYYYMMDD format (e.g. "20260329")
 * @returns {Promise<object[]>}  Raw game array from API, or [] on failure
 */
async function fetchSplitsForDate({ sport, date }) {
  const league = SPORT_TO_LEAGUE[sport] || sport;
  const url = `${ACTION_NETWORK_BASE}?league=${league}&date=${date}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA },
    });
  } catch (err) {
    console.warn(
      `[ActionNetwork] fetch error for ${sport} ${date}: ${err.message}`,
    );
    return [];
  }

  if (!res.ok) {
    console.warn(
      `[ActionNetwork] non-200 response for ${sport} ${date}: HTTP ${res.status}`,
    );
    return [];
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.warn(
      `[ActionNetwork] JSON parse error for ${sport} ${date}: ${err.message}`,
    );
    return [];
  }

  // ActionNetwork wraps the array in { games: [...] }
  const games = body.games || body.data || (Array.isArray(body) ? body : []);
  return games;
}

/**
 * Normalise raw ActionNetwork game objects to canonical split shape.
 *
 * @param {object[]} raw    - Raw games array from fetchSplitsForDate()
 * @param {string}  [sport] - Sport code (reserved; not currently used in normalisation)
 * @returns {object[]} Normalised split objects
 */
function normalizeSplitsResponse(raw /* sport */) {
  if (!Array.isArray(raw)) return [];

  const results = [];

  for (const game of raw) {
    if (!game || typeof game !== 'object') continue;

    // Game identity
    const actionNetworkGameId =
      pick(game, ['id', 'game_id', 'gameId']) != null
        ? String(pick(game, ['id', 'game_id', 'gameId']))
        : null;

    // Team names — ActionNetwork nests them in home_team / away_team objects
    const homeTeamObj = game.home_team || game.homeTeam || {};
    const awayTeamObj = game.away_team || game.awayTeam || {};

    const homeTeam =
      pick(homeTeamObj, ['full_name', 'name', 'fullName']) ||
      pick(game, ['home_team_name', 'homeTeamName']) ||
      null;

    const awayTeam =
      pick(awayTeamObj, ['full_name', 'name', 'fullName']) ||
      pick(game, ['away_team_name', 'awayTeamName']) ||
      null;

    // Commence time
    const commenceTimeRaw = pick(game, [
      'start_time',
      'startTime',
      'commence_time',
      'game_time',
      'gameTime',
    ]);
    let commenceTime = null;
    if (commenceTimeRaw) {
      const d = new Date(commenceTimeRaw);
      commenceTime = isNaN(d.getTime()) ? null : d.toISOString();
    }

    const betPct = extractBetPct(game);
    const handlePct = extractHandlePct(game);
    const ticketPct = extractTicketPct(game);

    results.push({
      actionNetworkGameId,
      homeTeam,
      awayTeam,
      commenceTime,
      publicBetsPctHome: betPct.publicBetsPctHome,
      publicBetsPctAway: betPct.publicBetsPctAway,
      publicHandlePctHome: handlePct.publicHandlePctHome,
      publicHandlePctAway: handlePct.publicHandlePctAway,
      publicTicketsPctHome: ticketPct.publicTicketsPctHome,
      publicTicketsPctAway: ticketPct.publicTicketsPctAway,
    });
  }

  return results;
}

/**
 * Match normalised ActionNetwork splits to known game IDs via fuzzy team-name
 * resolution (same resolveTeamVariant pattern used by pull_odds_hourly.js).
 *
 * @param {object[]} normalizedSplits  - Output of normalizeSplitsResponse()
 * @param {object[]} knownGames        - Array of { gameId, homeTeam, awayTeam }
 * @returns {{ gameId: string, splits: object }[]}
 *   Only matched entries are returned; unmatched splits emit a console.warn.
 */
function matchSplitsToGameId(normalizedSplits, knownGames) {
  if (!Array.isArray(normalizedSplits) || !Array.isArray(knownGames)) return [];

  /**
   * Build a canonical key from a team name using resolveTeamVariant so the
   * same normalisation rules apply here as in pull_odds_hourly.js.
   */
  function canonicalKey(teamName) {
    const result = resolveTeamVariant(teamName, 'matchSplitsToGameId');
    // Use canonical name when matched; fall back to the resolved normalized
    return (result.canonical || result.normalized || '').toLowerCase().trim();
  }

  // Pre-build lookup: canonical(home)+'|'+canonical(away) → gameId
  const knownIndex = new Map();
  for (const game of knownGames) {
    if (!game.gameId) continue;
    const homeKey = canonicalKey(game.homeTeam);
    const awayKey = canonicalKey(game.awayTeam);
    if (homeKey && awayKey) {
      knownIndex.set(`${homeKey}|${awayKey}`, game.gameId);
    }
  }

  const matched = [];

  for (const splits of normalizedSplits) {
    const homeKey = canonicalKey(splits.homeTeam);
    const awayKey = canonicalKey(splits.awayTeam);
    const lookupKey = `${homeKey}|${awayKey}`;
    const gameId = knownIndex.get(lookupKey);

    if (!gameId) {
      console.warn(
        `[ActionNetwork] matchSplitsToGameId: unmatched — ` +
          `home="${splits.homeTeam}" away="${splits.awayTeam}" ` +
          `(anGameId=${splits.actionNetworkGameId})`,
      );
      continue;
    }

    matched.push({ gameId, splits });
  }

  return matched;
}

module.exports = {
  fetchSplitsForDate,
  normalizeSplitsResponse,
  matchSplitsToGameId,
  // Exported for testing
  _toFloatPct: toFloatPct,
  _extractBetPct: extractBetPct,
  _extractHandlePct: extractHandlePct,
  _extractTicketPct: extractTicketPct,
};
