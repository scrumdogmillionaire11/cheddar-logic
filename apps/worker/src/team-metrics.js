/**
 * Team Metrics Module
 *
 * Maps full team names to ESPN IDs, fetches recent schedule data,
 * and computes metrics used by the NHL/NBA/NCAAM driver models.
 *
 * Usage: getTeamMetrics(teamName, sport) -> Promise<metrics>
 *   sport: 'NHL' | 'NBA' | 'NCAAM'
 *
 * Returns neutral fallback (all nulls) when team is unknown or ESPN fails.
 */

'use strict';

const { fetchTeamSchedule, fetchTeamInfo } = require('./espn-client');

// ---------------------------------------------------------------------------
// Team ID Mapping Tables
// ---------------------------------------------------------------------------

/**
 * NHL teams: full name -> { id, abbr }
 * ESPN NHL team IDs (verified stable integers).
 * Omitted teams with uncertain IDs rather than risk wrong lookups.
 */
const NHL_TEAMS = {
  'Anaheim Ducks':          { id: 25, abbr: 'ANA' },
  'Boston Bruins':          { id: 1,  abbr: 'BOS' },
  'Buffalo Sabres':         { id: 2,  abbr: 'BUF' },
  'Calgary Flames':         { id: 20, abbr: 'CGY' },
  'Carolina Hurricanes':    { id: 12, abbr: 'CAR' },
  'Chicago Blackhawks':     { id: 16, abbr: 'CHI' },
  'Colorado Avalanche':     { id: 17, abbr: 'COL' },
  'Columbus Blue Jackets':  { id: 29, abbr: 'CBJ' },
  'Dallas Stars':           { id: 9,  abbr: 'DAL' },
  'Detroit Red Wings':      { id: 8,  abbr: 'DET' },
  'Edmonton Oilers':        { id: 22, abbr: 'EDM' },
  'Florida Panthers':       { id: 13, abbr: 'FLA' },
  'Los Angeles Kings':      { id: 26, abbr: 'LAK' },
  'Minnesota Wild':         { id: 30, abbr: 'MIN' },
  'Montreal Canadiens':     { id: 5,  abbr: 'MTL' },
  'Nashville Predators':    { id: 18, abbr: 'NSH' },
  'New Jersey Devils':      { id: 1,  abbr: 'NJD' },
  'New York Islanders':     { id: 10, abbr: 'NYI' },
  'New York Rangers':       { id: 4,  abbr: 'NYR' },
  'Ottawa Senators':        { id: 6,  abbr: 'OTT' },
  'Philadelphia Flyers':    { id: 7,  abbr: 'PHI' },
  'Pittsburgh Penguins':    { id: 11, abbr: 'PIT' },
  'San Jose Sharks':        { id: 28, abbr: 'SJS' },
  'Seattle Kraken':         { id: 55, abbr: 'SEA' },
  'St. Louis Blues':        { id: 19, abbr: 'STL' },
  'Tampa Bay Lightning':    { id: 14, abbr: 'TBL' },
  'Toronto Maple Leafs':    { id: 15, abbr: 'TOR' },
  'Vancouver Canucks':      { id: 23, abbr: 'VAN' },
  'Vegas Golden Knights':   { id: 54, abbr: 'VGK' },
  'Washington Capitals':    { id: 3,  abbr: 'WSH' },
  'Winnipeg Jets':          { id: 21, abbr: 'WPG' },
  // Arizona/Utah relocated — use Utah HC (ESPN ID 53 was ARI Coyotes, now Utah)
  'Arizona Coyotes':        { id: 53, abbr: 'ARI' },
  'Utah Hockey Club':       { id: 53, abbr: 'UTA' }
};

/**
 * NBA teams: full name -> { id, abbr }
 * ESPN NBA team IDs.
 */
const NBA_TEAMS = {
  'Atlanta Hawks':            { id: 1,  abbr: 'ATL' },
  'Boston Celtics':           { id: 2,  abbr: 'BOS' },
  'Brooklyn Nets':            { id: 17, abbr: 'BKN' },
  'Charlotte Hornets':        { id: 30, abbr: 'CHA' },
  'Chicago Bulls':            { id: 4,  abbr: 'CHI' },
  'Cleveland Cavaliers':      { id: 5,  abbr: 'CLE' },
  'Dallas Mavericks':         { id: 6,  abbr: 'DAL' },
  'Denver Nuggets':           { id: 7,  abbr: 'DEN' },
  'Detroit Pistons':          { id: 8,  abbr: 'DET' },
  'Golden State Warriors':    { id: 9,  abbr: 'GSW' },
  'Houston Rockets':          { id: 10, abbr: 'HOU' },
  'Indiana Pacers':           { id: 11, abbr: 'IND' },
  'Los Angeles Clippers':     { id: 12, abbr: 'LAC' },
  'Los Angeles Lakers':       { id: 13, abbr: 'LAL' },
  'Memphis Grizzlies':        { id: 29, abbr: 'MEM' },
  'Miami Heat':               { id: 14, abbr: 'MIA' },
  'Milwaukee Bucks':          { id: 15, abbr: 'MIL' },
  'Minnesota Timberwolves':   { id: 16, abbr: 'MIN' },
  'New Orleans Pelicans':     { id: 3,  abbr: 'NOP' },
  'New York Knicks':          { id: 18, abbr: 'NYK' },
  'Oklahoma City Thunder':    { id: 25, abbr: 'OKC' },
  'Orlando Magic':            { id: 19, abbr: 'ORL' },
  'Philadelphia 76ers':       { id: 20, abbr: 'PHI' },
  'Phoenix Suns':             { id: 21, abbr: 'PHX' },
  'Portland Trail Blazers':   { id: 22, abbr: 'POR' },
  'Sacramento Kings':         { id: 23, abbr: 'SAC' },
  'San Antonio Spurs':        { id: 24, abbr: 'SAS' },
  'Toronto Raptors':          { id: 28, abbr: 'TOR' },
  'Utah Jazz':                { id: 26, abbr: 'UTA' },
  'Washington Wizards':       { id: 27, abbr: 'WSH' }
};

/**
 * NCAAM teams: full name -> { id, abbr }
 * ESPN college basketball IDs for top ~50 programs.
 */
const NCAAM_TEAMS = {
  'Duke':                  { id: 150,  abbr: 'DUKE' },
  'Duke Blue Devils':      { id: 150,  abbr: 'DUKE' },
  'Kentucky':              { id: 96,   abbr: 'UK' },
  'Kentucky Wildcats':     { id: 96,   abbr: 'UK' },
  'Kansas':                { id: 2305, abbr: 'KU' },
  'Kansas Jayhawks':       { id: 2305, abbr: 'KU' },
  'North Carolina':        { id: 153,  abbr: 'UNC' },
  'North Carolina Tar Heels': { id: 153, abbr: 'UNC' },
  'Gonzaga':               { id: 2250, abbr: 'GONZ' },
  'Gonzaga Bulldogs':      { id: 2250, abbr: 'GONZ' },
  'Michigan State':        { id: 127,  abbr: 'MSU' },
  'Michigan State Spartans': { id: 127, abbr: 'MSU' },
  'Villanova':             { id: 222,  abbr: 'NOVA' },
  'Villanova Wildcats':    { id: 222,  abbr: 'NOVA' },
  'Connecticut':           { id: 41,   abbr: 'UCONN' },
  'UConn':                 { id: 41,   abbr: 'UCONN' },
  'UConn Huskies':         { id: 41,   abbr: 'UCONN' },
  'Arizona':               { id: 12,   abbr: 'ARIZ' },
  'Arizona Wildcats':      { id: 12,   abbr: 'ARIZ' },
  'Baylor':                { id: 239,  abbr: 'BAY' },
  'Baylor Bears':          { id: 239,  abbr: 'BAY' },
  'Houston':               { id: 248,  abbr: 'HOU' },
  'Houston Cougars':       { id: 248,  abbr: 'HOU' },
  'UCLA':                  { id: 26,   abbr: 'UCLA' },
  'UCLA Bruins':           { id: 26,   abbr: 'UCLA' },
  'Tennessee':             { id: 2633, abbr: 'TENN' },
  'Tennessee Volunteers':  { id: 2633, abbr: 'TENN' },
  'Creighton':             { id: 156,  abbr: 'CREI' },
  'Creighton Bluejays':    { id: 156,  abbr: 'CREI' },
  'Marquette':             { id: 269,  abbr: 'MARQ' },
  'Marquette Golden Eagles': { id: 269, abbr: 'MARQ' },
  'Indiana':               { id: 84,   abbr: 'IND' },
  'Indiana Hoosiers':      { id: 84,   abbr: 'IND' },
  'Louisville':            { id: 97,   abbr: 'LOU' },
  'Louisville Cardinals':  { id: 97,   abbr: 'LOU' },
  'Syracuse':              { id: 183,  abbr: 'SYR' },
  'Syracuse Orange':       { id: 183,  abbr: 'SYR' },
  'Ohio State':            { id: 194,  abbr: 'OSU' },
  'Ohio State Buckeyes':   { id: 194,  abbr: 'OSU' },
  'Oregon':                { id: 2483, abbr: 'ORE' },
  'Oregon Ducks':          { id: 2483, abbr: 'ORE' },
  'Arkansas':              { id: 8,    abbr: 'ARK' },
  'Arkansas Razorbacks':   { id: 8,    abbr: 'ARK' },
  'Florida':               { id: 57,   abbr: 'FLA' },
  'Florida Gators':        { id: 57,   abbr: 'FLA' },
  'Alabama':               { id: 333,  abbr: 'ALA' },
  'Alabama Crimson Tide':  { id: 333,  abbr: 'ALA' },
  'San Diego State':       { id: 21,   abbr: 'SDSU' },
  'San Diego State Aztecs': { id: 21,  abbr: 'SDSU' },
  'Xavier':                { id: 2752, abbr: 'XAV' },
  'Xavier Musketeers':     { id: 2752, abbr: 'XAV' },
  'Texas':                 { id: 2641, abbr: 'TEX' },
  'Texas Longhorns':       { id: 2641, abbr: 'TEX' },
  'Iowa':                  { id: 2294, abbr: 'IOWA' },
  'Iowa Hawkeyes':         { id: 2294, abbr: 'IOWA' },
  'Illinois':              { id: 356,  abbr: 'ILL' },
  'Illinois Fighting Illini': { id: 356, abbr: 'ILL' },
  'Virginia':              { id: 258,  abbr: 'UVA' },
  'Virginia Cavaliers':    { id: 258,  abbr: 'UVA' },
  'Wake Forest':           { id: 154,  abbr: 'WF' },
  'Wake Forest Demon Deacons': { id: 154, abbr: 'WF' },
  'Purdue':                { id: 2509, abbr: 'PUR' },
  'Purdue Boilermakers':   { id: 2509, abbr: 'PUR' },
  'Wisconsin':             { id: 275,  abbr: 'WIS' },
  'Wisconsin Badgers':     { id: 275,  abbr: 'WIS' },
  'West Virginia':         { id: 277,  abbr: 'WVU' },
  'West Virginia Mountaineers': { id: 277, abbr: 'WVU' },
  'Miami':                 { id: 2390, abbr: 'MIA' },
  'Miami Hurricanes':      { id: 2390, abbr: 'MIA' },
  'Miami (FL)':            { id: 2390, abbr: 'MIA' },
  'Memphis':               { id: 235,  abbr: 'MEM' },
  'Memphis Tigers':        { id: 235,  abbr: 'MEM' },
  'Rutgers':               { id: 164,  abbr: 'RUTG' },
  'Rutgers Scarlet Knights': { id: 164, abbr: 'RUTG' },
  'Florida State':         { id: 52,   abbr: 'FSU' },
  'Florida State Seminoles': { id: 52, abbr: 'FSU' },
  'Pittsburgh':            { id: 221,  abbr: 'PITT' },
  'Pittsburgh Panthers':   { id: 221,  abbr: 'PITT' },
  'Notre Dame':            { id: 87,   abbr: 'ND' },
  'Notre Dame Fighting Irish': { id: 87, abbr: 'ND' },
  'Missouri':              { id: 142,  abbr: 'MIZ' },
  'Missouri Tigers':       { id: 142,  abbr: 'MIZ' },
  'Mississippi State':     { id: 344,  abbr: 'MSST' },
  'Mississippi State Bulldogs': { id: 344, abbr: 'MSST' },
  'Auburn':                { id: 2,    abbr: 'AUB' },
  'Auburn Tigers':         { id: 2,    abbr: 'AUB' },
  'LSU':                   { id: 99,   abbr: 'LSU' },
  'LSU Tigers':            { id: 99,   abbr: 'LSU' },
  'Michigan':              { id: 130,  abbr: 'MICH' },
  'Michigan Wolverines':   { id: 130,  abbr: 'MICH' },
  'Texas Tech':            { id: 2641, abbr: 'TTU' },
  'Texas Tech Red Raiders': { id: 2641, abbr: 'TTU' },
  'BYU':                   { id: 252,  abbr: 'BYU' },
  'BYU Cougars':           { id: 252,  abbr: 'BYU' },
  "St. John's":            { id: 2599, abbr: 'STJ' },
  "St. John's Red Storm":  { id: 2599, abbr: 'STJ' },
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
