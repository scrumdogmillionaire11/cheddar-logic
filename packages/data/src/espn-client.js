/**
 * ESPN Public API Client
 *
 * Thin HTTP wrapper using Node's built-in https module (no axios).
 * No API key required -- ESPN public scoreboard/teams endpoints.
 *
 * All functions return null on 404, timeout, or parse error (never throw).
 */

'use strict';

const https = require('https');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const COMMON_BASE = 'https://site.web.api.espn.com/apis/common/v3/sports';

/**
 * Make a GET request to the ESPN public API.
 * Returns parsed JSON or null on error/404/timeout.
 * @param {string} path - e.g. "hockey/nhl/teams/1/schedule"
 * @returns {Promise<object|null>}
 */
async function espnGet(path) {
  return new Promise((resolve) => {
    const url = `${BASE}/${path}`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchJsonUrl(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function normalizeEspnInjuryStatus(rawStatus) {
  const s = String(rawStatus || '').trim().toLowerCase();
  if (s === 'out') return 'OUT';
  if (s === 'doubtful') return 'DOUBTFUL';
  if (s === 'day-to-day') return 'DTD';
  if (s === 'questionable') return 'QUESTIONABLE';
  if (s === 'probable') return 'PROBABLE';
  if (!s) return null;
  return s.toUpperCase();
}

function extractPlayerIdFromAthleteLinks(athlete, injuryId) {
  const hrefs = Array.isArray(athlete?.links) ? athlete.links.map((link) => link?.href).filter(Boolean) : [];
  for (const href of hrefs) {
    const match = String(href).match(/\/id\/(\d+)\//);
    if (match) return String(match[1]);
  }
  const fallback = Number(injuryId);
  return Number.isFinite(fallback) ? String(fallback) : null;
}

function normalizeGameLogLabels(labels) {
  return Array.isArray(labels)
    ? labels.map((label) => String(label || '').trim().toUpperCase())
    : [];
}

function statsRowToObject(labels, stats) {
  const normalizedLabels = normalizeGameLogLabels(labels);
  const out = {};
  if (!Array.isArray(stats)) return out;
  for (let i = 0; i < normalizedLabels.length && i < stats.length; i += 1) {
    out[normalizedLabels[i]] = stats[i];
  }
  return out;
}

function coalesceFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseGameLogStartedValue(row) {
  const started = row?.GS ?? row?.STARTS ?? row?.STARTED ?? row?.START;
  if (started === true) return true;
  if (started === false) return false;
  const parsed = Number(started);
  if (Number.isFinite(parsed)) return parsed > 0;
  const normalized = String(started || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['y', 'yes', 'true', 'started'].includes(normalized);
}

function extractPlayerGameLogSummary(gamelogPayload, options = {}) {
  if (!gamelogPayload || typeof gamelogPayload !== 'object') return null;
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  const labels = Array.isArray(gamelogPayload.labels) ? gamelogPayload.labels : [];

  const eventStatsById = new Map();

  if (Array.isArray(gamelogPayload.seasonTypes)) {
    for (const seasonType of gamelogPayload.seasonTypes) {
      const categories = Array.isArray(seasonType?.categories) ? seasonType.categories : [];
      for (const category of categories) {
        if (String(category?.type || '').trim().toLowerCase() === 'total') continue;
        const events = Array.isArray(category?.events) ? category.events : [];
        for (const event of events) {
          const eventId = String(event?.eventId || event?.id || '').trim();
          if (!eventId || eventStatsById.has(eventId) || !Array.isArray(event?.stats)) continue;
          eventStatsById.set(eventId, event.stats);
        }
      }
    }
  }

  if (eventStatsById.size === 0 && gamelogPayload.events && typeof gamelogPayload.events === 'object') {
    for (const [eventId, eventData] of Object.entries(gamelogPayload.events)) {
      if (!eventId || eventStatsById.has(String(eventId))) continue;
      if (Array.isArray(eventData?.stats)) {
        eventStatsById.set(String(eventId), eventData.stats);
      }
    }
  }

  const recentEventIds = [];
  const eventEntries = gamelogPayload.events && typeof gamelogPayload.events === 'object'
    ? Object.entries(gamelogPayload.events).map(([eventId, eventData]) => ({
        eventId: String(eventId),
        eventData,
      }))
    : [];

  if (eventEntries.length > 0) {
    eventEntries.sort((a, b) => {
      const aDate = new Date(a.eventData?.date || a.eventData?.gameDate || a.eventData?.startDate || 0).getTime();
      const bDate = new Date(b.eventData?.date || b.eventData?.gameDate || b.eventData?.startDate || 0).getTime();
      const aDateValid = Number.isFinite(aDate) && aDate > 0;
      const bDateValid = Number.isFinite(bDate) && bDate > 0;
      if (aDateValid && bDateValid && aDate !== bDate) return aDate - bDate;
      if (aDateValid && !bDateValid) return 1;
      if (!aDateValid && bDateValid) return -1;
      const aNum = Number(a.eventId);
      const bNum = Number(b.eventId);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
      return String(a.eventId).localeCompare(String(b.eventId));
    });
    for (const entry of eventEntries.slice(-limit)) {
      recentEventIds.push(entry.eventId);
    }
  } else {
    recentEventIds.push(...Array.from(eventStatsById.keys()).slice(-limit));
  }

  const rows = [];
  for (const eventId of recentEventIds) {
    const stats = eventStatsById.get(String(eventId));
    if (!Array.isArray(stats)) continue;
    rows.push(statsRowToObject(labels, stats));
  }

  if (rows.length === 0) return null;

  const points = rows.map((row) => coalesceFiniteNumber(row.PTS, row.POINTS)).filter((value) => value !== null);
  if (points.length === 0) return null;

  const starts = rows.reduce((count, row) => count + (parseGameLogStartedValue(row) ? 1 : 0), 0);
  const averagePoints = points.reduce((sum, value) => sum + value, 0) / points.length;

  return {
    avgPointsLast5: Number(averagePoints.toFixed(2)),
    startsLast5: starts,
    gamesConsidered: rows.length,
  };
}

async function fetchNbaInjuries() {
  return espnGet('basketball/nba/injuries');
}

async function fetchNbaPlayerGameLog(playerId, seasonYear, seasonType = 2) {
  if (!playerId) return null;
  const params = new URLSearchParams();
  if (seasonYear != null) params.set('season', String(seasonYear));
  if (seasonType != null) params.set('seasontype', String(seasonType));
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';
  const url = `${COMMON_BASE}/basketball/nba/athletes/${playerId}/gamelog${suffix}`;
  return fetchJsonUrl(url);
}

/**
 * Fetch last N completed games from a team's schedule.
 * @param {string} espnLeague - e.g. "hockey/nhl"
 * @param {string|number} teamId - ESPN team ID
 * @param {number} [limit=5]
 * @returns {Promise<Array>} Array of completed game objects (date, isHome, pointsFor, pointsAgainst, result)
 */
/**
 * Parse a competitor score from ESPN API response.
 * ESPN returns scores as strings ("3"), numbers (3), or objects ({value: 3}).
 * @param {*} score
 * @returns {number|null}
 */
function parseScore(score) {
  if (score == null) return null;
  if (typeof score === 'number') return score;
  if (typeof score === 'string') {
    const n = Number(score);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof score === 'object' && 'value' in score) return score.value ?? null;
  return null;
}

async function fetchTeamSchedule(espnLeague, teamId, limit = 5) {
  const basePath = `${espnLeague}/teams/${teamId}/schedule`;
  let data = await espnGet(basePath);
  if (!data || !data.events) return [];

  // ESPN's NCAAM default schedule endpoint can return only upcoming games,
  // which leaves no completed events for metric computation. Fall back to
  // regular-season schedule if needed.
  const needsNcaamFallback =
    String(espnLeague || '').includes('mens-college-basketball');
  const hasCompletedGames = Array.isArray(data.events)
    ? data.events.some((event) =>
        Boolean(event?.competitions?.[0]?.status?.type?.completed),
      )
    : false;

  if (needsNcaamFallback && !hasCompletedGames) {
    const fallbackData = await espnGet(`${basePath}?seasontype=2`);
    if (fallbackData && Array.isArray(fallbackData.events)) {
      data = fallbackData;
    }
  }

  const now = new Date();
  return data.events
    .filter(e => new Date(e.date) < now && e.competitions?.[0]?.status?.type?.completed)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-limit)
    .map(e => {
      const comp = e.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      const isHome = String(home?.team?.id) === String(teamId);
      const mine = isHome ? home : away;
      const opp = isHome ? away : home;
      return {
        date: e.date,
        isHome,
        pointsFor: parseScore(mine?.score),
        pointsAgainst: parseScore(opp?.score),
        result: mine?.winner ? 'W' : 'L'
      };
    });
}

/**
 * Fetch team info (ranking, record).
 * @param {string} espnLeague
 * @param {string|number} teamId
 * @returns {Promise<object|null>}
 */
async function fetchTeamInfo(espnLeague, teamId) {
  const data = await espnGet(`${espnLeague}/teams/${teamId}`);
  if (!data || !data.team) return null;
  const team = data.team;
  const overall = team.record?.items?.find(r => r.type === 'total');
  return {
    id: teamId,
    name: team.displayName,
    abbreviation: team.abbreviation,
    rank: team.rank ? parseInt(team.rank) : null,
    record: overall?.summary || null
  };
}

/**
 * Fetch team statistics payload.
 * @param {string} espnLeague
 * @param {string|number} teamId
 * @returns {Promise<object|null>}
 */
async function fetchTeamStatistics(espnLeague, teamId) {
  return espnGet(`${espnLeague}/teams/${teamId}/statistics`);
}

function normalizeStatLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parsePercentageNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= 0 && value <= 1) return Number((value * 100).toFixed(2));
    return value >= 0 && value <= 100 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/%/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  if (parsed >= 0 && parsed <= 1) return Number((parsed * 100).toFixed(2));
  return parsed >= 0 && parsed <= 100 ? parsed : null;
}

function collectStatisticEntries(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((item) => collectStatisticEntries(item, out));
    return out;
  }
  if (typeof node !== 'object') return out;

  const labelCandidates = [
    node.name,
    node.displayName,
    node.shortDisplayName,
    node.abbreviation,
    node.key,
    node.stat,
  ];
  const valueCandidates = [
    node.value,
    node.displayValue,
    node.percentage,
    node.percent,
    node.summary,
  ];

  const label = labelCandidates.find((candidate) => {
    return typeof candidate === 'string' && candidate.trim().length > 0;
  });
  const value = valueCandidates.find((candidate) => {
    if (candidate === null || candidate === undefined) return false;
    if (typeof candidate === 'string') return candidate.trim().length > 0;
    return true;
  });

  if (label !== undefined && value !== undefined) {
    out.push({ label: String(label), value });
  }

  Object.values(node).forEach((child) => {
    if (typeof child === 'object' && child !== null) {
      collectStatisticEntries(child, out);
    }
  });
  return out;
}

/**
 * Extract FT% from ESPN team statistics payload.
 * @param {object|null} statisticsPayload
 * @returns {{ freeThrowPct: number, field: string }|null}
 */
function extractFreeThrowPctFromStatisticsPayload(statisticsPayload) {
  if (!statisticsPayload || typeof statisticsPayload !== 'object') return null;

  const entries = collectStatisticEntries(statisticsPayload, []);
  const accepted = new Set([
    'freethrowpercentage',
    'freethrowpct',
    'ftpercentage',
    'ftpct',
    'ft',
  ]);

  for (const entry of entries) {
    const normalizedLabel = normalizeStatLabel(entry.label);
    if (!accepted.has(normalizedLabel)) continue;
    const freeThrowPct = parsePercentageNumber(entry.value);
    if (freeThrowPct === null) continue;
    return {
      freeThrowPct,
      field: entry.label,
    };
  }

  return null;
}

/**
 * Fetch scoreboard events for a league and optional date.
 * @param {string} espnLeague
 * @param {string|null} dateStr - YYYYMMDD or null for today
 * @param {object|null} options - Optional query params (e.g. { groups: '50', limit: '1000' })
 * @returns {Promise<Array>}
 */
async function fetchScoreboardEvents(espnLeague, dateStr = null, options = null) {
  const params = new URLSearchParams();
  if (dateStr) params.set('dates', dateStr);
  if (options && typeof options === 'object') {
    for (const [key, value] of Object.entries(options)) {
      if (value != null && value !== '') {
        params.set(String(key), String(value));
      }
    }
  }

  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';
  const data = await espnGet(`${espnLeague}/scoreboard${suffix}`);
  if (!data || !Array.isArray(data.events)) return [];
  return data.events;
}

module.exports = {
  espnGet,
  fetchJsonUrl,
  fetchTeamSchedule,
  fetchTeamInfo,
  fetchTeamStatistics,
  fetchScoreboardEvents,
  fetchNbaInjuries,
  fetchNbaPlayerGameLog,
  extractPlayerGameLogSummary,
  normalizeEspnInjuryStatus,
  extractPlayerIdFromAthleteLinks,
  extractFreeThrowPctFromStatisticsPayload,
};
