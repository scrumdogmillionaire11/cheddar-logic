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
  const data = await espnGet(`${espnLeague}/teams/${teamId}/schedule`);
  if (!data || !data.events) return [];
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

module.exports = { espnGet, fetchTeamSchedule, fetchTeamInfo };
