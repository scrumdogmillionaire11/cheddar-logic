"use strict";

module.exports = require("../../../packages/data/src/team-metrics");
  'Dayton':                { id: 2065, abbr: 'DAY' },
  'Dayton Flyers':         { id: 2065, abbr: 'DAY' },
  'Princeton':             { id: 163,  abbr: 'PRIN' },
  'Princeton Tigers':      { id: 163,  abbr: 'PRIN' }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Neutral fallback returned when team is unknown or ESPN fails */
function neutral() {
  return {
    avgPoints: null,
    avgPointsAllowed: null,
    netRating: null,
    restDays: null,
    form: 'Unknown',
    pace: null,
    rank: null,
    record: null
  };
}

/**
 * Compute metrics from an array of completed game objects.
 * @param {Array} games
 * @param {string} sport - 'NHL' | 'NBA' | 'NCAAM'
 * @returns {object}
 */
function computeMetricsFromGames(games, sport) {
  if (!games || games.length === 0) return neutral();
  const scored = games.filter(g => g.pointsFor !== null && g.pointsAgainst !== null);
  if (scored.length === 0) return neutral();

  const avgPoints = scored.reduce((s, g) => s + g.pointsFor, 0) / scored.length;
  const avgPointsAllowed = scored.reduce((s, g) => s + g.pointsAgainst, 0) / scored.length;
  const netRating = avgPoints - avgPointsAllowed;
  const form = games.slice(-5).map(g => g.result).join('');

  // restDays: days since the most recent completed game
  const mostRecent = games[games.length - 1];
  const daysSince = mostRecent
    ? Math.floor((Date.now() - new Date(mostRecent.date).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // pace: NBA/NCAAM rough possession proxy (null for NHL)
  const pace = (sport === 'NBA' || sport === 'NCAAM')
    ? parseFloat((avgPoints * 0.92).toFixed(1))
    : null;

  return {
    avgPoints,
    avgPointsAllowed,
    netRating,
    restDays: daysSince,
    form,
    pace,
    rank: null,
    record: null
  };
}

/**
 * Look up a team entry from the given mapping table using case-insensitive matching.
 * @param {string} teamName
 * @param {object} table
 * @returns {object|null} { id, abbr } or null
 */
function lookupTeam(teamName, table) {
  if (!teamName) return null;
  const normalized = teamName.trim().toLowerCase();
  // Exact key match first
  for (const [key, val] of Object.entries(table)) {
    if (key.toLowerCase() === normalized) return val;
  }
  // Partial match fallback (team name is contained in key or vice versa)
  for (const [key, val] of Object.entries(table)) {
    const k = key.toLowerCase();
    if (k.includes(normalized) || normalized.includes(k)) return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetch ESPN-derived team metrics for a given team name and sport.
 * Returns neutral fallback on any error or unknown team.
 *
 * @param {string} teamName - Full team name from odds API (e.g. "Boston Bruins")
 * @param {string} sport - 'NHL' | 'NBA' | 'NCAAM'
 * @returns {Promise<object>} Metrics object
 */
async function getTeamMetrics(teamName, sport) {
  try {
    // Select table and ESPN league path
    let table;
    let espnLeague;
    if (sport === 'NHL') {
      table = NHL_TEAMS;
      espnLeague = 'hockey/nhl';
    } else if (sport === 'NBA') {
      table = NBA_TEAMS;
      espnLeague = 'basketball/nba';
    } else if (sport === 'NCAAM') {
      table = NCAAM_TEAMS;
      espnLeague = 'basketball/mens-college-basketball';
    } else {
      console.warn(`[TeamMetrics] Unknown sport: ${sport}`);
      return neutral();
    }

    const teamEntry = lookupTeam(teamName, table);
    if (!teamEntry) {
      console.warn(`[TeamMetrics] Unknown team: "${teamName}" (sport: ${sport})`);
      return neutral();
    }

    // Small delay to avoid ESPN rate limiting
    await new Promise(r => setTimeout(r, 200));

    // Fetch schedule and team info concurrently
    const [games, teamInfo] = await Promise.all([
      fetchTeamSchedule(espnLeague, teamEntry.id, 5),
      fetchTeamInfo(espnLeague, teamEntry.id)
    ]);

    if ((!games || games.length === 0) && !teamInfo) {
      console.warn(`[TeamMetrics] ESPN returned no data for "${teamName}" (id: ${teamEntry.id})`);
      return neutral();
    }

    // Compute metrics from schedule
    const metrics = computeMetricsFromGames(games || [], sport);

    // Merge rank and record from teamInfo
    if (teamInfo) {
      metrics.rank = teamInfo.rank;
      metrics.record = teamInfo.record;
    }

    return metrics;
  } catch (err) {
    console.warn(`[TeamMetrics] Error fetching metrics for "${teamName}": ${err.message}`);
    return neutral();
  }
}

module.exports = { getTeamMetrics };
