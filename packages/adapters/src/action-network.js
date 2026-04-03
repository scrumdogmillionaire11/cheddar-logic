'use strict';

/**
 * ActionNetwork public betting-splits adapter
 *
 * STATUS (2026-04-03): schema hypothesis — runtime blocked
 * ---------------------------------------------------------------------------
 * The endpoint https://api.actionnetwork.com/web/v1/game?league={SPORT}&date={YYYYMMDD}
 * is reachable from a browser but returns 404 from server/datacenter IPs via
 * Cloudfront. Direct worker access is not currently viable.
 *
 * The response shape assumed below is a HYPOTHESIS based on community
 * references and public documentation. It has NOT been confirmed against a
 * real captured browser fixture. Until WI-0668 delivers preserved raw JSON
 * fixtures, treat this schema as provisional and do NOT use this adapter in
 * production paths.
 *
 * Design principles:
 *   1. Per-market normalisation — each bets[] entry parsed independently
 *   2. No cross-market fallback — missing ML row -> null ML splits, never
 *      "first available"
 *   3. Hard validation gates — pct sums, explicit market key required,
 *      line required for SPREAD/TOTAL
 *   4. INVALID_INPUT on bad sums or missing required line; never silent fill
 *   5. SOURCE_BLOCKED returned as structured status, not an exception
 *   6. Public splits are informational only (alerts, not signal)
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

/**
 * Explicit market key mapping.
 * Only keys present here are accepted — any other bet_type is silently skipped.
 * No default/fallback row. No "first available" substitution.
 *
 * WARNING: aliases are hypothetical — validate against WI-0668 fixture.
 */
const MARKET_KEY_MAP = {
  money_line: 'ML',
  moneyline: 'ML',
  spread: 'SPREAD',
  point_spread: 'SPREAD',
  total: 'TOTAL',
  game_total: 'TOTAL',
};

/**
 * Pct-sum tolerance band.
 *
 * ActionNetwork serves whole-number percentages (e.g. 60/40, 55/45). The
 * sum of two rounded integers can legally reach 99 or 101 without any data
 * problem. We allow [96, 104] to cover:
 *
 *   - Normal rounding from whole-number display (±2 each side)
 *   - Stale partial updates where one side has updated and the other hasn't yet
 *     (observed in community captures; gaps close within seconds)
 *
 * We do NOT allow anything beyond 104 because that suggests a real bad-data
 * condition (scale problem, duplicate field read, or two different markets
 * accidentally merged). Asymmetric sums (one side null) are always invalid
 * regardless of this band — they indicate ambiguous side-order, not rounding.
 *
 * If WI-0759 fixture capture shows ActionNetwork routinely emits larger gaps,
 * update this band and document the fixture date that justified the change.
 */
const PCT_SUM_MIN = 96;
const PCT_SUM_MAX = 104;

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
 * Coerce value to float in [0, 100] or null.
 * Never returns NaN, Infinity, or a value outside the valid percentage range.
 */
function toFloatPct(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/**
 * Validate that a pair of percentages plausibly sums to ~100.
 *
 * - Both null:         valid   (informational gap, not bad data)
 * - One null, present: invalid (asymmetric — side order ambiguous)
 * - Both present:      must sum within [PCT_SUM_MIN, PCT_SUM_MAX]
 *
 * @returns {{ valid: boolean, reason?: string }}
 */
function validatePctSum(a, b, label) {
  if (a == null && b == null) return { valid: true };
  if (a == null || b == null) {
    const present = a != null ? a : b;
    return {
      valid: false,
      reason: `${label}: asymmetric — one side null, other is ${present}`,
    };
  }
  const sum = a + b;
  if (sum < PCT_SUM_MIN || sum > PCT_SUM_MAX) {
    return {
      valid: false,
      reason: `${label}: sum ${sum.toFixed(1)} outside [${PCT_SUM_MIN}, ${PCT_SUM_MAX}]`,
    };
  }
  return { valid: true };
}

/**
 * Parse one entry from the `bets` array into a canonical per-market object.
 *
 * - Returns null for unrecognised market keys (silently dropped; no substitution).
 * - Returns { valid: false, invalidReason } for recognised-but-bad data.
 * - Returns { valid: true, ...fields } on success.
 *
 * NOTE: field aliases are hypothetical — update after WI-0668 fixture capture.
 *
 * @param {object} entry - One element from game.bets[]
 * @returns {object|null}
 */
function parseMarketEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const sourceMarketKey = entry.bet_type;
  const marketType = MARKET_KEY_MAP[sourceMarketKey];
  if (!marketType) return null; // unrecognised — skip, no substitution

  const isTotal = marketType === 'TOTAL';
  const selectionScope = isTotal ? 'OVER_UNDER' : 'HOME_AWAY';

  // Side A = home (ML/SPREAD) or over (TOTAL)
  // Side B = away (ML/SPREAD) or under (TOTAL)
  // NOTE: over/under field names are assumed; update with fixture proof.
  const betsPctA = isTotal
    ? toFloatPct(pick(entry, ['over_bets', 'over_bets_pct', 'over_bets_%']))
    : toFloatPct(pick(entry, ['home_bets', 'home_bets_pct', 'home_bets_%']));
  const betsPctB = isTotal
    ? toFloatPct(pick(entry, ['under_bets', 'under_bets_pct', 'under_bets_%']))
    : toFloatPct(pick(entry, ['away_bets', 'away_bets_pct', 'away_bets_%']));

  const handlePctA = isTotal
    ? toFloatPct(pick(entry, ['over_handle', 'over_handle_pct', 'over_handle_%']))
    : toFloatPct(pick(entry, ['home_handle', 'home_handle_pct', 'home_handle_%']));
  const handlePctB = isTotal
    ? toFloatPct(pick(entry, ['under_handle', 'under_handle_pct', 'under_handle_%']))
    : toFloatPct(pick(entry, ['away_handle', 'away_handle_pct', 'away_handle_%']));

  const ticketsPctA = isTotal
    ? toFloatPct(pick(entry, ['over_tickets', 'over_tickets_pct', 'over_tickets_%']))
    : toFloatPct(pick(entry, ['home_tickets', 'home_tickets_pct', 'home_tickets_%']));
  const ticketsPctB = isTotal
    ? toFloatPct(pick(entry, ['under_tickets', 'under_tickets_pct', 'under_tickets_%']))
    : toFloatPct(pick(entry, ['away_tickets', 'away_tickets_pct', 'away_tickets_%']));

  const lineRaw = pick(entry, [
    'total', 'spread', 'line', 'current_line', 'current_spread', 'current_total',
  ]);
  const line = lineRaw != null ? parseFloat(lineRaw) : null;

  // Hard gate: pct sums must be valid
  const betsCheck = validatePctSum(betsPctA, betsPctB, `${sourceMarketKey}.bets`);
  const handleCheck = validatePctSum(handlePctA, handlePctB, `${sourceMarketKey}.handle`);
  if (!betsCheck.valid || !handleCheck.valid) {
    const reasons = [betsCheck.reason, handleCheck.reason].filter(Boolean).join('; ');
    return {
      marketType, selectionScope, valid: false,
      invalidReason: `INVALID_INPUT: ${reasons}`,
      source: 'ACTION_NETWORK', sourceMarketKey,
    };
  }

  // Hard gate: SPREAD and TOTAL require a line
  if ((marketType === 'SPREAD' || marketType === 'TOTAL') && line == null) {
    return {
      marketType, selectionScope, valid: false,
      invalidReason: `INVALID_INPUT: ${marketType} market missing required line`,
      source: 'ACTION_NETWORK', sourceMarketKey,
    };
  }

  return {
    marketType,
    selectionScope,
    valid: true,
    home_or_over_bets_pct: betsPctA,
    away_or_under_bets_pct: betsPctB,
    home_or_over_handle_pct: handlePctA,
    away_or_under_handle_pct: handlePctB,
    home_or_over_tickets_pct: ticketsPctA,
    away_or_under_tickets_pct: ticketsPctB,
    line: (marketType === 'SPREAD' || marketType === 'TOTAL') ? line : null,
    source: 'ACTION_NETWORK',
    sourceMarketKey,
  };
}

// extractBetPct / extractHandlePct / extractTicketPct removed.
// All field extraction is now handled per-market in parseMarketEntry() above.

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch public betting splits for a given sport + date from ActionNetwork.
 *
 * @param {object} options
 * @param {string} options.sport  - One of: NFL, NBA, NHL, MLB
 * @param {string} options.date   - Date in YYYYMMDD format (e.g. "20260329")
 * @returns {Promise<{ games: object[], sourceStatus: string }>}
 *   sourceStatus values:
 *     'OK'             - response received, games array populated
 *     'SOURCE_BLOCKED' - 403/404 from server runtime (expected behavior)
 *     'FETCH_ERROR'    - network failure
 *     'PARSE_ERROR'    - response was not valid JSON
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
    console.warn(`[ActionNetwork] fetch error for ${sport} ${date}: ${err.message}`);
    return { games: [], sourceStatus: 'FETCH_ERROR' };
  }

  if (!res.ok) {
    const sourceStatus =
      res.status === 403 || res.status === 404 ? 'SOURCE_BLOCKED' : 'FETCH_ERROR';
    console.warn(
      `[ActionNetwork] HTTP ${res.status} for ${sport} ${date} -> ${sourceStatus}`,
    );
    return { games: [], sourceStatus };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.warn(`[ActionNetwork] JSON parse error for ${sport} ${date}: ${err.message}`);
    return { games: [], sourceStatus: 'PARSE_ERROR' };
  }

  const games = body.games || body.data || (Array.isArray(body) ? body : []);
  return { games, sourceStatus: 'OK' };
}

/**
 * Normalise raw ActionNetwork game objects to per-market canonical split shape.
 *
 * Each returned game object:
 * {
 *   actionNetworkGameId: string|null,
 *   homeTeam: string|null,
 *   awayTeam: string|null,
 *   commenceTime: string|null,   // ISO 8601 UTC
 *   markets: MarketSplit[],      // one entry per recognised bet_type in bets[]
 * }
 *
 * MarketSplit (valid):
 * {
 *   marketType: 'ML'|'SPREAD'|'TOTAL',
 *   selectionScope: 'HOME_AWAY'|'OVER_UNDER',
 *   valid: true,
 *   home_or_over_bets_pct:     number|null,
 *   away_or_under_bets_pct:    number|null,
 *   home_or_over_handle_pct:   number|null,
 *   away_or_under_handle_pct:  number|null,
 *   home_or_over_tickets_pct:  number|null,
 *   away_or_under_tickets_pct: number|null,
 *   line: number|null,     // null for ML; required (never null) for SPREAD/TOTAL
 *   source: 'ACTION_NETWORK',
 *   sourceMarketKey: string,
 * }
 *
 * MarketSplit (invalid — bad sums, missing line, asymmetric sides, etc.):
 * {
 *   marketType, selectionScope,
 *   valid: false,
 *   invalidReason: string,  // starts with 'INVALID_INPUT:'
 *   source: 'ACTION_NETWORK',
 *   sourceMarketKey: string,
 * }
 *
 * NOTE: schema hypothesis — not yet validated against real browser fixture.
 *
 * @param {object[]} raw - games array from fetchSplitsForDate().games
 * @returns {object[]}
 */
function normalizeSplitsResponse(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((game) => game && typeof game === 'object')
    .map((game) => {
      const actionNetworkGameId =
        pick(game, ['id', 'game_id', 'gameId']) != null
          ? String(pick(game, ['id', 'game_id', 'gameId']))
          : null;

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

      const commenceTimeRaw = pick(game, [
        'start_time', 'startTime', 'commence_time', 'game_time', 'gameTime',
      ]);
      let commenceTime = null;
      if (commenceTimeRaw) {
        const d = new Date(commenceTimeRaw);
        commenceTime = isNaN(d.getTime()) ? null : d.toISOString();
      }

      // Per-market normalisation — no cross-market fallback whatsoever
      const betsArray = Array.isArray(game.bets) ? game.bets : [];
      const markets = betsArray
        .map(parseMarketEntry)
        .filter(Boolean); // null = unrecognised key, silently dropped

      // Surface invalid markets in logs so runtime failures are observable
      // (invalid entries are retained in markets[] so callers see them; warn here)
      for (const m of markets) {
        if (!m.valid) {
          console.warn(
            `[ActionNetwork] invalid market in game ${actionNetworkGameId || '?'}: ` +
              `${m.sourceMarketKey} — ${m.invalidReason}`,
          );
        }
      }

      return { actionNetworkGameId, homeTeam, awayTeam, commenceTime, markets };
    });
}

/**
 * Match normalised ActionNetwork splits to known game IDs via fuzzy team-name
 * resolution (same resolveTeamVariant pattern used by pull_odds_hourly.js).
 *
 * @param {object[]} normalizedGames - Output of normalizeSplitsResponse()
 * @param {object[]} knownGames      - Array of { gameId, homeTeam, awayTeam }
 * @returns {{ gameId: string, game: object }[]}
 *   Only matched entries are returned; unmatched games emit a console.warn.
 */
function matchSplitsToGameId(normalizedGames, knownGames) {
  if (!Array.isArray(normalizedGames) || !Array.isArray(knownGames)) return [];

  function canonicalKey(teamName) {
    const result = resolveTeamVariant(teamName, 'matchSplitsToGameId');
    return (result.canonical || result.normalized || '').toLowerCase().trim();
  }

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
  for (const game of normalizedGames) {
    const homeKey = canonicalKey(game.homeTeam);
    const awayKey = canonicalKey(game.awayTeam);
    const gameId = knownIndex.get(`${homeKey}|${awayKey}`);
    if (!gameId) {
      console.warn(
        `[ActionNetwork] matchSplitsToGameId: unmatched — ` +
          `home="${game.homeTeam}" away="${game.awayTeam}" ` +
          `(anId=${game.actionNetworkGameId})`,
      );
      continue;
    }
    matched.push({ gameId, game });
  }
  return matched;
}

module.exports = {
  fetchSplitsForDate,
  normalizeSplitsResponse,
  matchSplitsToGameId,
  // Exported for testing
  _toFloatPct: toFloatPct,
  _validatePctSum: validatePctSum,
  _parseMarketEntry: parseMarketEntry,
  _MARKET_KEY_MAP: MARKET_KEY_MAP,
};
