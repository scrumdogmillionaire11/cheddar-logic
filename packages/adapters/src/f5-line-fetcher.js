/**
 * WI-0913 Spike: Non-prod best-effort F5 line fetcher
 * 
 * Fetches MLB F5 total lines from VSIN betting-splits page.
 * Used during model runs to inject real market lines into card payloads.
 * 
 * Spike scope: single source (VSIN), no retry, fail-closed on error.
 * Production use is deferred pending legal/ToS review.
 */

const fetch = require('node-fetch');

const VSIN_BETTING_SPLITS_BASE = 'https://data.vsin.com/mlb/betting-splits/';
const SPIKE_FETCH_TIMEOUT_MS = 5000;
const SPIKE_FETCH_JITTER_MS_MIN = 500;
const SPIKE_FETCH_JITTER_MS_MAX = 1000;

/**
 * Sleep with jitter to avoid thundering herd on spike fetches.
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
async function sleepWithJitter(minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Attempt to parse MLB game rows from VSIN betting-splits HTML.
 * 
 * Looks for patterns like:
 *   data-gamecode="20260411MLB00001"
 *   sp-badge-line="4.5" (F5 total)
 * 
 * Returns: { gameCodeToLine: { "20260411MLB00001": 4.5, ... } }
 * 
 * @param {string} html - Raw HTML response from VSIN page
 * @returns {{gameCodeToLine: Object<string, number>}}
 */
function parseVsinF5Lines(html) {
  const gameCodeToLine = {};
  
  if (!html || typeof html !== 'string') {
    return { gameCodeToLine };
  }

  // Match lines like: data-gamecode="20260411MLB00001" ... sp-badge-line="4.5"
  // or similar patterns that appear in row markup
  const rowPattern = /data-gamecode=['"]([^'"]+)['"][^>]*? (?:[^>]*?sp-badge-line=['"]([^'"]+)['"]|[^>]*)(?:[^>]*?first.5|[^>]*?f5|[^>]*?innings)/gi;
  
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const gameCode = match[1];
    const lineStr = match[2];
    
    if (gameCode && lineStr) {
      const line = parseFloat(lineStr);
      if (Number.isFinite(line) && line > 0 && line < 20) {
        gameCodeToLine[gameCode] = line;
      }
    }
  }

  // If direct pattern didn't match, try simpler heuristic:
  // Look for any sequence of game codes followed by F5-like line numbers
  if (Object.keys(gameCodeToLine).length === 0) {
    const gameCodePattern = /\b(202[0-9]{6}MLB\d+)\b/g;
    const linePattern = /['"]([0-9.]+)['"]\s*(?:f5|first.5|over|under)/gi;
    
    let codes = [];
    let codeMatch;
    const codesInHtml = [];
    
    while ((codeMatch = gameCodePattern.exec(html)) !== null) {
      codesInHtml.push({ code: codeMatch[1], index: codeMatch.index });
    }

    // For each code found, look for a line value nearby (within 500 chars)
    for (const codeInfo of codesInHtml) {
      const windowStart = Math.max(0, codeInfo.index - 100);
      const windowEnd = Math.min(html.length, codeInfo.index + 400);
      const window = html.substring(windowStart, windowEnd);
      
      // Try to extract a float that looks like an MLB total
      const lineMatch = /(['"][0-9.]{1,4}['"]|:([0-9.]{1,4}))/.exec(window);
      if (lineMatch) {
        const lineCandidate = parseFloat(lineMatch[1].replace(/['"]/g, '') || lineMatch[2]);
        if (Number.isFinite(lineCandidate) && lineCandidate > 0 && lineCandidate < 20) {
          gameCodeToLine[codeInfo.code] = lineCandidate;
        }
      }
    }
  }

  return { gameCodeToLine };
}

/**
 * Fetch F5 totals from VSIN betting-splits page.
 * 
 * Input: gameCode (e.g., "20260411MLB00001")
 * Output: { line: 4.5, source: 'vsin_spike', fetched_at: ISO8601, confidence: 0.95 }
 *         or { line: null, error: 'reason', fetched_at: ISO8601 } on failure
 * 
 * Non-prod spike: single request, no retry, fail-closed on network/parse error.
 * 
 * @param {string} gameCode - MLB game code (e.g., "20260411MLB00001")
 * @returns {Promise<{line: number | null, source: string, fetched_at: string, confidence?: number, error?: string}>}
 */
async function fetchF5LineFromVsin(gameCode) {
  const fetchedAt = new Date().toISOString();
  
  if (!gameCode || typeof gameCode !== 'string') {
    return {
      line: null,
      error: 'invalid_game_code',
      fetched_at: fetchedAt,
      source: 'vsin_spike',
    };
  }

  try {
    // Apply jitter before fetch to avoid thundering herd
    await sleepWithJitter(SPIKE_FETCH_JITTER_MS_MIN, SPIKE_FETCH_JITTER_MS_MAX);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SPIKE_FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(VSIN_BETTING_SPLITS_BASE, {
        method: 'GET',
        headers: {
          'User-Agent': 'cheddar-logic-spike/1.0 (experimental F5 line fetcher)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        timeout: SPIKE_FETCH_TIMEOUT_MS,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        line: null,
        error: `http_${response.status}`,
        fetched_at: fetchedAt,
        source: 'vsin_spike',
      };
    }

    const html = await response.text();
    const { gameCodeToLine } = parseVsinF5Lines(html);

    const line = gameCodeToLine[gameCode] ?? null;
    if (line === null) {
      console.log(`[SPIKE_FETCH_F5_LINE] ${gameCode} NOT_FOUND vsin_spike`);
      return {
        line: null,
        error: 'line_not_found_in_response',
        fetched_at: fetchedAt,
        source: 'vsin_spike',
      };
    }

    console.log(`[SPIKE_FETCH_F5_LINE] ${gameCode} ${line} vsin_spike`);
    return {
      line,
      source: 'vsin_spike',
      fetched_at: fetchedAt,
      confidence: 0.95, // High confidence for VSIN structured data
      game_code: gameCode,
    };
  } catch (err) {
    console.error(
      `[SPIKE_FETCH_F5_LINE_ERROR] ${gameCode}: ${err.message}`,
    );
    return {
      line: null,
      error: err.message || 'network_error',
      fetched_at: fetchedAt,
      source: 'vsin_spike',
    };
  }
}

module.exports = {
  fetchF5LineFromVsin,
  parseVsinF5Lines,
};
