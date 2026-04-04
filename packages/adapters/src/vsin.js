'use strict';

/**
 * VSiN public betting-splits adapter
 *
 * STATUS (2026-04-03): CONFIRMED via live capture
 * ---------------------------------------------------------------------------
 * Source:  data.vsin.com/betting-splits/?source=DK  (public money, all bettors)
 *          data.vsin.com/betting-splits/?source=CIRCA  (sharp money)
 *
 * Data format: Server-side rendered HTML table. No JSON API exists.
 * Update cadence: Page updates every 5 minutes per VSiN site copy.
 *
 * HTML structure (confirmed 2026-04-03):
 *   - 2 <tr> rows per game, each row has data-gamecode="YYYYMMDD{SPORT}{ID}"
 *   - Row 1 (away): contains .sp-act-history button
 *   - Row 2 (home): contains .sp-act-count button
 *   - 11 <td> cells per row:
 *       [0] action cell  [1] team cell
 *       [2] spread_line  [3] spread_bets%  [4] spread_handle%
 *       [5] total_line   [6] total_bets%   [7] total_handle%
 *       [8] ml_line      [9] ml_bets%      [10] ml_handle%
 *
 * Source selection:
 *   source='DK'     → DraftKings public (all bettors, high volume)
 *   source='CIRCA'  → Circa Sports (sharp/professional money)
 *
 * Design principles:
 *   1. Parse-from-HTML only — no JSON endpoint to hit
 *   2. Per-game object with away/home rows and three market splits
 *   3. Hard validation gates — pct sums must be within tolerance band
 *   4. NEVER silently substitute one market's data for another
 *   5. SOURCE_BLOCKED returned as structured status, never thrown
 *   6. Gamecode includes sport slug for downstream filtering
 */

const { resolveTeamVariant } = require('@cheddar-logic/data/src/normalize');

// ─── Constants ───────────────────────────────────────────────────────────────

const VSIN_BASE = 'https://data.vsin.com/betting-splits/';

/** Valid source identifiers */
const VALID_SOURCES = ['DK', 'CIRCA'];

/**
 * Pct-sum tolerance band.
 * VSiN displays whole-number percentages. Allow [96, 104] for rounding drift.
 */
const PCT_SUM_MIN = 96;
const PCT_SUM_MAX = 104;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Strip HTML tags and HTML entities (like &#9650; arrows), trim whitespace.
 * Returns the first numeric/sign token found, or null.
 */
function stripHtml(html) {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim();
}

/**
 * Parse a percentage string like "59%" or "41% " into a float.
 * Returns null for missing/non-numeric values.
 */
function parsePct(text) {
  if (!text) return null;
  const str = String(text).trim();
  // Reject values that start with a minus — percentages are never negative
  if (str.startsWith('-')) return null;
  const clean = str.replace(/[^0-9.]/g, '');
  if (!clean) return null;
  const n = parseFloat(clean);
  if (!isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/**
 * Parse a betting line like "+3.5", "-170", "233.5" into a float.
 * Returns null for missing values.
 */
function parseLine(text) {
  if (!text) return null;
  const clean = String(text).replace(/[^0-9+\-.]/g, '');
  if (!clean) return null;
  const n = parseFloat(clean);
  return isFinite(n) ? n : null;
}

/**
 * Extract text content from one badge cell: the first <span class="sp-badge...">
 */
function extractBadgeText(cellHtml) {
  if (!cellHtml) return null;
  const m = cellHtml.match(/class="sp-badge[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  if (!m) return null;
  return stripHtml(m[1]);
}

/**
 * Extract all <td> cells from a <tr> innerHTML.
 * Returns array of raw cell HTML strings.
 */
function extractCells(rowHtml) {
  const matches = rowHtml.match(/<td[\s\S]*?<\/td>/g) || [];
  return matches;
}

/**
 * Determine if a row is the away row (contains sp-act-history button).
 * Row 1 = away team, Row 2 = home team.
 */
function isAwayRow(rowHtml) {
  return rowHtml.includes('sp-act-history');
}

/**
 * Extract team name from team cell HTML.
 */
function extractTeamName(rowHtml) {
  const m = rowHtml.match(/class="sp-team-link"[^>]*>([^<]+)<\/a>/);
  return m ? m[1].trim() : null;
}

/**
 * Extract gamecode from a row.
 */
function extractGamecode(rowHtml) {
  const m = rowHtml.match(/data-gamecode="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Validate that two percentage values plausibly sum to ~100.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validatePctSum(a, b, label) {
  if (a == null && b == null) return { valid: true };
  if (a == null || b == null) {
    const present = a != null ? a : b;
    return {
      valid: false,
      reason: `${label}: asymmetric pcts — one side null, other is ${present}`,
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
 * Build a canonical market split object from two rows (away row + home row) for
 * a specific market type.
 *
 * Column layout per team row (cells 2..10, after action and team cells):
 *   away_row: [spread_line, spread_bets%, spread_handle%, total_line, total_bets%, total_handle%, ml_line, ml_bets%, ml_handle%]
 *   home_row: [spread_line, spread_bets%, spread_handle%, total_line, total_bets%, total_handle%, ml_line, ml_bets%, ml_handle%]
 *
 * @param {'SPREAD'|'TOTAL'|'ML'} marketType
 * @param {string[]} awayCells - td cell htmls for away row (index 0 = action, 1 = team, ...)
 * @param {string[]} homeCells - td cell htmls for home row
 * @param {string} source - 'DK' or 'CIRCA'
 * @returns {object} market split (valid: true|false)
 */
function buildMarketSplit(marketType, awayCells, homeCells, source) {
  // Market-specific cell offsets (after the 2 fixed cells: action, team)
  // Cells are: [2]=spread_line [3]=spread_bets [4]=spread_handle
  //            [5]=total_line  [6]=total_bets  [7]=total_handle
  //            [8]=ml_line     [9]=ml_bets     [10]=ml_handle
  const OFFSETS = {
    SPREAD: { line: 2, bets: 3, handle: 4 },
    TOTAL:  { line: 5, bets: 6, handle: 7 },
    ML:     { line: 8, bets: 9, handle: 10 },
  };

  const off = OFFSETS[marketType];
  const selectionScope = marketType === 'TOTAL' ? 'OVER_UNDER' : 'HOME_AWAY';

  // For TOTAL: away row bets% = over, home row bets% = under
  // For SPREAD/ML: away row bets% = away, home row bets% = home
  const awayBetsText  = extractBadgeText(awayCells[off.bets]);
  const homeBetsText  = extractBadgeText(homeCells[off.bets]);
  const awayHandleText = extractBadgeText(awayCells[off.handle]);
  const homeHandleText = extractBadgeText(homeCells[off.handle]);

  // Lines — both rows should show the same magnitude (opposite signs for spread/ml)
  // Use the away row's line as canonical (consistent with our side-A=away convention)
  const awayLineText = extractBadgeText(awayCells[off.line]);
  const homeLineText = extractBadgeText(homeCells[off.line]);

  const awayBetsPct   = parsePct(awayBetsText);
  const homeBetsPct   = parsePct(homeBetsText);
  const awayHandlePct = parsePct(awayHandleText);
  const homeHandlePct = parsePct(homeHandleText);

  const betsCheck   = validatePctSum(awayBetsPct, homeBetsPct,   `${marketType}.bets`);
  const handleCheck = validatePctSum(awayHandlePct, homeHandlePct, `${marketType}.handle`);

  if (!betsCheck.valid || !handleCheck.valid) {
    const reasons = [betsCheck.reason, handleCheck.reason].filter(Boolean).join('; ');
    return {
      marketType,
      selectionScope,
      valid: false,
      invalidReason: `INVALID_INPUT: ${reasons}`,
      source,
    };
  }

  // Line parsing
  let line = null;
  if (marketType === 'TOTAL') {
    // Both rows show the same total line value
    line = parseLine(awayLineText);
    if (line == null) line = parseLine(homeLineText);
    if (line == null) {
      return {
        marketType, selectionScope, valid: false,
        invalidReason: 'INVALID_INPUT: TOTAL market missing line',
        source,
      };
    }
  } else if (marketType === 'SPREAD') {
    // Use the away team spread line (e.g. +3.5)
    line = parseLine(awayLineText);
    if (line == null) {
      return {
        marketType, selectionScope, valid: false,
        invalidReason: 'INVALID_INPUT: SPREAD market missing line',
        source,
      };
    }
  } else {
    // ML — away team ML price (e.g. +142)
    line = parseLine(awayLineText);
    // ML line missing is OK (data gap, not invalid) — don't gate on it
  }

  // For TOTAL: away row = over, home row = under
  // For SPREAD/ML: away row = away team %, home row = home team %
  return {
    marketType,
    selectionScope,
    valid: true,
    // Primary fields used by the model
    away_or_over_bets_pct:    awayBetsPct,
    home_or_under_bets_pct:   homeBetsPct,
    away_or_over_handle_pct:  awayHandlePct,
    home_or_under_handle_pct: homeHandlePct,
    // Aliased for compatibility with odds_snapshots column names
    public_bets_pct_away:   marketType !== 'TOTAL' ? awayBetsPct   : null,
    public_bets_pct_home:   marketType !== 'TOTAL' ? homeBetsPct   : null,
    public_handle_pct_away: marketType !== 'TOTAL' ? awayHandlePct  : null,
    public_handle_pct_home: marketType !== 'TOTAL' ? homeHandlePct  : null,
    // Over/under aliases for TOTAL
    over_bets_pct:   marketType === 'TOTAL' ? awayBetsPct   : null,
    under_bets_pct:  marketType === 'TOTAL' ? homeBetsPct   : null,
    over_handle_pct: marketType === 'TOTAL' ? awayHandlePct  : null,
    under_handle_pct: marketType === 'TOTAL' ? homeHandlePct : null,
    line,
    away_line: parseLine(awayLineText),
    home_line: parseLine(homeLineText),
    source,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch betting splits HTML from VSiN for a given source.
 *
 * @param {object} options
 * @param {string} options.source - 'DK' (public) or 'CIRCA' (sharp)
 * @returns {Promise<{ html: string, sourceStatus: string }>}
 *   sourceStatus:
 *     'OK'             - page fetched, html has content
 *     'SOURCE_BLOCKED' - 403/404
 *     'FETCH_ERROR'    - network failure
 *     'BAD_SOURCE'     - invalid source param (not DK/CIRCA)
 */
async function fetchSplitsHtml({ source }) {
  if (!VALID_SOURCES.includes(source)) {
    return {
      html: '',
      sourceStatus: 'BAD_SOURCE',
      error: `Unknown source "${source}". Valid values: ${VALID_SOURCES.join(', ')}`,
    };
  }

  const url = `${VSIN_BASE}?source=${encodeURIComponent(source)}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,*/*' },
    });
  } catch (err) {
    console.warn(`[VSiN] fetch error for source=${source}: ${err.message}`);
    return { html: '', sourceStatus: 'FETCH_ERROR', error: err.message };
  }

  if (!res.ok) {
    const sourceStatus =
      res.status === 403 || res.status === 404 ? 'SOURCE_BLOCKED' : 'FETCH_ERROR';
    console.warn(`[VSiN] HTTP ${res.status} for source=${source} -> ${sourceStatus}`);
    return { html: '', sourceStatus };
  }

  const html = await res.text();
  return { html, sourceStatus: 'OK' };
}

/**
 * Parse a VSiN betting-splits HTML page into structured game splits.
 *
 * @param {string} html   - Raw HTML from fetchSplitsHtml()
 * @param {string} source - 'DK' or 'CIRCA' (attached to each market split)
 * @returns {object[]} Array of game objects:
 * {
 *   gamecode: string,        // e.g. "20260403NBA00083"
 *   sport: string,           // e.g. "NBA"
 *   awayTeam: string|null,
 *   homeTeam: string|null,
 *   markets: MarketSplit[],  // up to 3 entries: SPREAD, TOTAL, ML
 * }
 *
 * MarketSplit (valid=true):
 * {
 *   marketType: 'SPREAD'|'TOTAL'|'ML',
 *   selectionScope: 'HOME_AWAY'|'OVER_UNDER',
 *   valid: true,
 *   away_or_over_bets_pct: number|null,
 *   home_or_under_bets_pct: number|null,
 *   away_or_over_handle_pct: number|null,
 *   home_or_under_handle_pct: number|null,
 *   public_bets_pct_away: number|null,    // ML/SPREAD only
 *   public_bets_pct_home: number|null,
 *   public_handle_pct_away: number|null,
 *   public_handle_pct_home: number|null,
 *   over_bets_pct: number|null,           // TOTAL only
 *   under_bets_pct: number|null,
 *   over_handle_pct: number|null,
 *   under_handle_pct: number|null,
 *   line: number|null,
 *   away_line: number|null,
 *   home_line: number|null,
 *   source: string,
 * }
 *
 * MarketSplit (valid=false): { marketType, selectionScope, valid: false, invalidReason, source }
 *
 * CALLER CONTRACT:
 *   markets.filter(m => m.valid)  — safe to use downstream
 *   markets.filter(m => !m.valid) — inspect invalidReason for diagnostics
 */
function parseSplitsHtml(html, source) {
  if (!html || typeof html !== 'string') return [];

  // Extract all <tr> rows containing data-gamecode
  const allRows = html.match(/<tr[\s\S]*?<\/tr>/g) || [];
  const gcRows = allRows.filter((r) => r.includes('data-gamecode'));

  // Group by gamecode — expect exactly 2 rows per game
  const byGamecode = new Map();
  for (const row of gcRows) {
    const gc = extractGamecode(row);
    if (!gc) continue;
    if (!byGamecode.has(gc)) byGamecode.set(gc, []);
    byGamecode.get(gc).push(row);
  }

  const games = [];

  for (const [gamecode, rows] of byGamecode.entries()) {
    if (rows.length !== 2) {
      console.warn(`[VSiN] gamecode ${gamecode}: expected 2 rows, got ${rows.length} — skipping`);
      continue;
    }

    // Determine away/home ordering
    const [rowA, rowB] = rows;
    const awayRow = isAwayRow(rowA) ? rowA : rowB;
    const homeRow = isAwayRow(rowA) ? rowB : rowA;

    const awayTeam = extractTeamName(awayRow);
    const homeTeam = extractTeamName(homeRow);

    const awayCells = extractCells(awayRow);
    const homeCells = extractCells(homeRow);

    // Need at least 11 cells (action, team, + 9 data cells)
    if (awayCells.length < 11 || homeCells.length < 11) {
      console.warn(
        `[VSiN] gamecode ${gamecode}: insufficient cells ` +
          `(away=${awayCells.length}, home=${homeCells.length}) — skipping`,
      );
      continue;
    }

    // Extract sport from gamecode: "20260403NBA00083" -> "NBA"
    const sportMatch = gamecode.match(/^\d{8}([A-Z]+)/);
    const sport = sportMatch ? sportMatch[1] : 'UNKNOWN';

    const markets = ['SPREAD', 'TOTAL', 'ML'].map((marketType) =>
      buildMarketSplit(marketType, awayCells, homeCells, source),
    );

    // Log invalid markets (retained for caller inspection)
    for (const m of markets) {
      if (!m.valid) {
        console.warn(
          `[VSiN] invalid market in ${gamecode}: ${m.marketType} — ${m.invalidReason}`,
        );
      }
    }

    games.push({ gamecode, sport, awayTeam, homeTeam, markets });
  }

  return games;
}

/**
 * Match parsed VSiN games to known game IDs via fuzzy team-name resolution.
 *
 * @param {object[]} parsedGames - Output of parseSplitsHtml()
 * @param {object[]} knownGames  - Array of { gameId, homeTeam, awayTeam }
 * @returns {{ gameId: string, game: object }[]} Matched entries only; unmatched emit console.warn.
 */
function matchSplitsToGameId(parsedGames, knownGames) {
  if (!Array.isArray(parsedGames) || !Array.isArray(knownGames)) return [];

  function canonicalKey(teamName) {
    if (!teamName) return '';
    const result = resolveTeamVariant(teamName, 'VSiN.matchSplitsToGameId');
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
  for (const game of parsedGames) {
    const homeKey = canonicalKey(game.homeTeam);
    const awayKey = canonicalKey(game.awayTeam);
    const gameId = knownIndex.get(`${homeKey}|${awayKey}`);
    if (!gameId) {
      console.warn(
        `[VSiN] matchSplitsToGameId: unmatched — ` +
          `away="${game.awayTeam}" home="${game.homeTeam}" (${game.gamecode})`,
      );
      continue;
    }
    matched.push({ gameId, game });
  }
  return matched;
}

module.exports = {
  fetchSplitsHtml,
  parseSplitsHtml,
  matchSplitsToGameId,
  // Exported for testing
  _parsePct: parsePct,
  _parseLine: parseLine,
  _validatePctSum: validatePctSum,
  _extractBadgeText: extractBadgeText,
  _extractCells: extractCells,
  _isAwayRow: isAwayRow,
  _extractTeamName: extractTeamName,
  _extractGamecode: extractGamecode,
  _buildMarketSplit: buildMarketSplit,
  _VALID_SOURCES: VALID_SOURCES,
};
