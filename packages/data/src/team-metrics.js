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

const { DateTime } = require('luxon');
const { fetchTeamSchedule, fetchTeamInfo, fetchScoreboardEvents } = require('./espn-client');
const { normalizeSportCode, resolveTeamVariant } = require('./normalize');
const { getTeamMetricsCache, upsertTeamMetricsCache } = require('./db');

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
  // Arizona/Utah relocated -- rebranded Utah HC → Utah Mammoth for 2025-26
  'Arizona Coyotes':        { id: 53, abbr: 'ARI' },
  'Utah Hockey Club':       { id: 53, abbr: 'UTA' },
  'Utah Mammoth':           { id: 53, abbr: 'UTA' }
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
 * 
 * ESPN Team ID Lookup Guide (WI-0326):
 * ----------------------------------------
 * To find missing team IDs:
 * 1. Visit https://www.espn.com/mens-college-basketball/teams
 * 2. Find the team and click through to their page
 * 3. Extract numeric ID from URL: espn.com/mens-college-basketball/team/_/id/{ID}/{slug}
 * 4. Verify abbreviation from ESPN's official display
 * 5. Add 2-3 name variations to handle odds API inconsistencies:
 *    - Full official name (e.g., "Oklahoma State Cowboys")
 *    - Abbreviated form (e.g., "Oklahoma St" or "Oklahoma St Cowboys")
 *    - Location only (e.g., "Oklahoma State")
 * 
 * Scoreboard Fallback: Teams playing in the next 7 days are auto-discovered
 * if they're not in this static table. The dynamic ID will be logged and can
 * be added here for permanent resolution.
 * 
 * Note: IDs marked with PLACEHOLDER_ prefix need verification via ESPN website.
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
  'Princeton Tigers':      { id: 163,  abbr: 'PRIN' },

  // --- Additional teams added WI-0326 to fix hidden games ---
  // Priority teams from user's reported issues (72 hidden NCAAM games)
  
  // George Washington Colonials
  'George Washington':             { id: 45, abbr: 'GW' },
  'GW':                            { id: 45, abbr: 'GW' },
  'GW Revolutionaries':            { id: 45, abbr: 'GW' },
  'George Washington Colonials':   { id: 45, abbr: 'GW' },
  
  // Loyola Chicago Ramblers
  'Loyola Chicago':                { id: 2350, abbr: 'LUC' },
  'Loyola (Chi)':                  { id: 2350, abbr: 'LUC' },
  'Loyola (Chi) Ramblers':         { id: 2350, abbr: 'LUC' },
  'Loyola Chicago Ramblers':       { id: 2350, abbr: 'LUC' },
  
  // Albany Great Danes
  'Albany':                        { id: 399, abbr: 'ALB' },
  'Albany Great Danes':            { id: 399, abbr: 'ALB' },
  
  // Long Beach State Beach
  'Long Beach State':              { id: 2116, abbr: 'LBSU' },
  'Long Beach St':                 { id: 2116, abbr: 'LBSU' },
  'Long Beach St 49ers':           { id: 2116, abbr: 'LBSU' },
  'Long Beach State Beach':        { id: 2116, abbr: 'LBSU' },
  
  // Oklahoma State Cowboys
  'Oklahoma State':                { id: 197, abbr: 'OKST' },
  'Oklahoma St':                   { id: 197, abbr: 'OKST' },
  'Oklahoma St Cowboys':           { id: 197, abbr: 'OKST' },
  'Oklahoma State Cowboys':        { id: 197, abbr: 'OKST' },
  
  // Appalachian State Mountaineers
  'Appalachian State':             { id: 2026, abbr: 'APP' },
  'Appalachian St':                { id: 2026, abbr: 'APP' },
  'Appalachian St Mountaineers':   { id: 2026, abbr: 'APP' },
  'Appalachian State Mountaineers':{ id: 2026, abbr: 'APP' },

  // Additional mid-major and smaller programs from normalize.js LOGGED_TEAM_VARIANTS
  
  // Alabama State
  'Alabama State':                 { id: 2010, abbr: 'ALST' },
  'Alabama St':                    { id: 2010, abbr: 'ALST' },
  'Alabama St Hornets':            { id: 2010, abbr: 'ALST' },
  'Alabama State Hornets':         { id: 2010, abbr: 'ALST' },
  
  // Air Force
  'Air Force':                     { id: 2005, abbr: 'AFA' },
  'Air Force Falcons':             { id: 2005, abbr: 'AFA' },
  
  // Arizona State
  'Arizona State':                 { id: 9, abbr: 'ASU' },
  'Arizona St':                    { id: 9, abbr: 'ASU' },
  'Arizona State Sun Devils':      { id: 9, abbr: 'ASU' },
  'Arizona St Sun Devils':         { id: 9, abbr: 'ASU' },
  
  // Boston College
  'Boston College':                { id: 103, abbr: 'BC' },
  'Boston College Eagles':         { id: 103, abbr: 'BC' },
  
  // Butler
  'Butler':                        { id: 2086, abbr: 'BUT' },
  'Butler Bulldogs':               { id: 2086, abbr: 'BUT' },
  
  // California
  'California':                    { id: 25, abbr: 'CAL' },
  'California Golden Bears':       { id: 25, abbr: 'CAL' },
  
  // Charlotte (49ers)
  'Charlotte':                     { id: 2429, abbr: 'CHAR' },
  'Charlotte 49ers':               { id: 2429, abbr: 'CHAR' },
  
  // Cincinnati
  'Cincinnati':                    { id: 2132, abbr: 'CIN' },
  'Cincinnati Bearcats':           { id: 2132, abbr: 'CIN' },
  
  // Colorado State
  'Colorado State':                { id: 36, abbr: 'CSU' },
  'Colorado St':                   { id: 36, abbr: 'CSU' },
  'Colorado State Rams':           { id: 36, abbr: 'CSU' },
  'Colorado St Rams':              { id: 36, abbr: 'CSU' },
  
  // Davidson
  'Davidson':                      { id: 2166, abbr: 'DAV' },
  'Davidson Wildcats':             { id: 2166, abbr: 'DAV' },
  
  // DePaul
  'DePaul':                        { id: 305, abbr: 'DEP' },
  'DePaul Blue Demons':            { id: 305, abbr: 'DEP' },
  
  // Florida State (add "St" variant)
  'Florida St':                    { id: 52, abbr: 'FSU' },
  'Florida St Seminoles':          { id: 52, abbr: 'FSU' },
  
  // Fresno State
  'Fresno State':                  { id: 278, abbr: 'FRES' },
  'Fresno St':                     { id: 278, abbr: 'FRES' },
  'Fresno State Bulldogs':         { id: 278, abbr: 'FRES' },
  'Fresno St Bulldogs':            { id: 278, abbr: 'FRES' },
  
  // Georgia Tech
  'Georgia Tech':                  { id: 59, abbr: 'GT' },
  'Georgia Tech Yellow Jackets':   { id: 59, abbr: 'GT' },
  
  // Grand Canyon
  'Grand Canyon':                  { id: 2253, abbr: 'GCU' },
  'Grand Canyon Antelopes':        { id: 2253, abbr: 'GCU' },
  
  // Kansas State
  'Kansas State':                  { id: 2306, abbr: 'KSU' },
  'Kansas St':                     { id: 2306, abbr: 'KSU' },
  'Kansas State Wildcats':         { id: 2306, abbr: 'KSU' },
  'Kansas St Wildcats':            { id: 2306, abbr: 'KSU' },
  
  // Kent State
  'Kent State':                    { id: 2309, abbr: 'KENT' },
  'Kent St':                       { id: 2309, abbr: 'KENT' },
  'Kent State Golden Flashes':     { id: 2309, abbr: 'KENT' },
  'Kent St Golden Flashes':        { id: 2309, abbr: 'KENT' },
  
  // La Salle
  'La Salle':                      { id: 2325, abbr: 'LAS' },
  'La Salle Explorers':            { id: 2325, abbr: 'LAS' },
  
  // Maryland
  'Maryland':                      { id: 120, abbr: 'MD' },
  'Maryland Terrapins':            { id: 120, abbr: 'MD' },
  
  // Mississippi State (add "St" variant)
  'Mississippi St':                { id: 344, abbr: 'MSST' },
  'Mississippi St Bulldogs':       { id: 344, abbr: 'MSST' },
  
  // Nebraska
  'Nebraska':                      { id: 158, abbr: 'NEB' },
  'Nebraska Cornhuskers':          { id: 158, abbr: 'NEB' },
  
  // Nevada
  'Nevada':                        { id: 2440, abbr: 'NEV' },
  'Nevada Wolf Pack':              { id: 2440, abbr: 'NEV' },
  
  // New Mexico
  'New Mexico':                    { id: 167, abbr: 'UNM' },
  'New Mexico Lobos':              { id: 167, abbr: 'UNM' },
  
  // Northwestern
  'Northwestern':                  { id: 77, abbr: 'NW' },
  'Northwestern Wildcats':         { id: 77, abbr: 'NW' },
  
  // Old Dominion
  'Old Dominion':                  { id: 295, abbr: 'ODU' },
  'Old Dominion Monarchs':         { id: 295, abbr: 'ODU' },
  
  // Ole Miss (Mississippi)
  'Ole Miss':                      { id: 145, abbr: 'MISS' },
  'Ole Miss Rebels':               { id: 145, abbr: 'MISS' },
  'Mississippi':                   { id: 145, abbr: 'MISS' },
  'Mississippi Rebels':            { id: 145, abbr: 'MISS' },
  
  // Penn State
  'Penn State':                    { id: 213, abbr: 'PSU' },
  'Penn St':                       { id: 213, abbr: 'PSU' },
  'Penn State Nittany Lions':      { id: 213, abbr: 'PSU' },
  'Penn St Nittany Lions':         { id: 213, abbr: 'PSU' },
  
  // Providence
  'Providence':                    { id: 2507, abbr: 'PROV' },
  'Providence Friars':             { id: 2507, abbr: 'PROV' },
  
  // Saint Joseph's
  "Saint Joseph's":                { id: 2603, abbr: 'SJU' },
  "Saint Joseph's Hawks":          { id: 2603, abbr: 'SJU' },
  "St. Joseph's":                  { id: 2603, abbr: 'SJU' },
  "St. Joseph's Hawks":            { id: 2603, abbr: 'SJU' },
  
  // Saint Louis
  'Saint Louis':                   { id: 139, abbr: 'SLU' },
  'Saint Louis Billikens':         { id: 139, abbr: 'SLU' },
  'St. Louis':                     { id: 139, abbr: 'SLU' },
  'St. Louis Billikens':           { id: 139, abbr: 'SLU' },
  
  // San Diego State (add "St" variant)
  'San Diego St':                  { id: 21, abbr: 'SDSU' },
  'San Diego St Aztecs':           { id: 21, abbr: 'SDSU' },
  
  // SMU (Southern Methodist)
  'SMU':                           { id: 2567, abbr: 'SMU' },
  'SMU Mustangs':                  { id: 2567, abbr: 'SMU' },
  'Southern Methodist':            { id: 2567, abbr: 'SMU' },
  
  // Stanford
  'Stanford':                      { id: 24, abbr: 'STAN' },
  'Stanford Cardinal':             { id: 24, abbr: 'STAN' },
  
  // UAB (Alabama Birmingham)
  'UAB':                           { id: 5, abbr: 'UAB' },
  'UAB Blazers':                   { id: 5, abbr: 'UAB' },
  
  // USC (Southern California)
  'USC':                           { id: 30, abbr: 'USC' },
  'USC Trojans':                   { id: 30, abbr: 'USC' },
  'Southern California':           { id: 30, abbr: 'USC' },
  
  // Utah
  'Utah':                          { id: 254, abbr: 'UTAH' },
  'Utah Utes':                     { id: 254, abbr: 'UTAH' },
  
  // Utah State
  'Utah State':                    { id: 328, abbr: 'USU' },
  'Utah St':                       { id: 328, abbr: 'USU' },
  'Utah State Aggies':             { id: 328, abbr: 'USU' },
  'Utah St Aggies':                { id: 328, abbr: 'USU' },
  
  // Vanderbilt
  'Vanderbilt':                    { id: 238, abbr: 'VAN' },
  'Vanderbilt Commodores':         { id: 238, abbr: 'VAN' },
  
  // Virginia Tech
  'Virginia Tech':                 { id: 259, abbr: 'VT' },
  'Virginia Tech Hokies':          { id: 259, abbr: 'VT' },
  
  // Washington
  'Washington':                    { id: 264, abbr: 'WASH' },
  'Washington Huskies':            { id: 264, abbr: 'WASH' },
  
  // Wyoming
  'Wyoming':                       { id: 2751, abbr: 'WYO' },
  'Wyoming Cowboys':               { id: 2751, abbr: 'WYO' },
  
  // Boise State
  'Boise State':                   { id: 68, abbr: 'BSU' },
  'Boise St':                      { id: 68, abbr: 'BSU' },
  'Boise State Broncos':           { id: 68, abbr: 'BSU' },
  'Boise St Broncos':              { id: 68, abbr: 'BSU' },
  
  // Mississippi State (add "Miss St" variant)
  'Miss St':                       { id: 344, abbr: 'MSST' },
  'Miss State':                    { id: 344, abbr: 'MSST' },
  
  // UNLV
  'UNLV':                          { id: 2439, abbr: 'UNLV' },
  'UNLV Rebels':                   { id: 2439, abbr: 'UNLV' },
  
  // Seton Hall
  'Seton Hall':                    { id: 2550, abbr: 'SETON' },
  'Seton Hall Pirates':            { id: 2550, abbr: 'SETON' },
  
  // Rhode Island
  'Rhode Island':                  { id: 227, abbr: 'URI' },
  'Rhode Island Rams':             { id: 227, abbr: 'URI' },
  
  // St. Bonaventure
  'St. Bonaventure':               { id: 179, abbr: 'BON' },
  'St. Bonaventure Bonnies':       { id: 179, abbr: 'BON' },
  'Saint Bonaventure':             { id: 179, abbr: 'BON' },
  
  // VCU (Virginia Commonwealth)
  'VCU':                           { id: 2670, abbr: 'VCU' },
  'VCU Rams':                      { id: 2670, abbr: 'VCU' },
  'Virginia Commonwealth':         { id: 2670, abbr: 'VCU' },
  
  // Wichita State
  'Wichita State':                 { id: 2724, abbr: 'WSU' },
  'Wichita St':                    { id: 2724, abbr: 'WSU' },
  'Wichita State Shockers':        { id: 2724, abbr: 'WSU' },
  'Wichita St Shockers':           { id: 2724, abbr: 'WSU' }
};

const SCOREBOARD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SCOREBOARD_EMPTY_CACHE_TTL_MS = 60 * 1000;
const SCOREBOARD_LOOKBACK_DAYS = Number.isFinite(Number(process.env.TEAM_METRICS_SCOREBOARD_LOOKBACK_DAYS))
  ? Number(process.env.TEAM_METRICS_SCOREBOARD_LOOKBACK_DAYS)
  : 3;
const SCOREBOARD_LOOKAHEAD_DAYS = Number.isFinite(Number(process.env.TEAM_METRICS_SCOREBOARD_LOOKAHEAD_DAYS))
  ? Number(process.env.TEAM_METRICS_SCOREBOARD_LOOKAHEAD_DAYS)
  : 4;
const RESOLVED_TEAM_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RESOLVED_TEAM_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

const resolvedTeamCache = new Map();
const scoreboardIndexCache = new Map();
const scoreboardIndexInFlight = new Map();

function logTeamMetricsEvent(event, payload) {
  try {
    console.log(`[TeamMetrics][${event}] ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[TeamMetrics][${event}]`);
  }
}

function coalesceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function ensureNhlMetricAliases(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;

  const avgGoalsFor = coalesceNumber(metrics.avgGoalsFor);
  const avgGoalsAgainst = coalesceNumber(metrics.avgGoalsAgainst);
  const avgPoints = coalesceNumber(metrics.avgPoints);
  const avgPointsAllowed = coalesceNumber(metrics.avgPointsAllowed);

  const normalized = { ...metrics };
  if (avgGoalsFor === null && avgPoints !== null) {
    normalized.avgGoalsFor = avgPoints;
  }
  if (avgGoalsAgainst === null && avgPointsAllowed !== null) {
    normalized.avgGoalsAgainst = avgPointsAllowed;
  }
  return normalized;
}

function isFiniteMetric(value) {
  return Number.isFinite(coalesceNumber(value));
}

function hasSufficientNumericMetricsForSport(metrics, sport) {
  if (!metrics || typeof metrics !== 'object') return false;
  if (sport === 'NHL') {
    return isFiniteMetric(metrics.avgGoalsFor) && isFiniteMetric(metrics.avgGoalsAgainst);
  }
  if (sport === 'NBA' || sport === 'NCAAM') {
    return isFiniteMetric(metrics.avgPoints) && isFiniteMetric(metrics.avgPointsAllowed);
  }
  return true;
}

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
  const normalizedSport = normalizeSportCode(
    typeof sport === 'string' ? sport : String(sport || ''),
    'computeMetricsFromGames'
  ) || String(sport || '').trim().toUpperCase();

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
  const pace = (normalizedSport === 'NBA' || normalizedSport === 'NCAAM')
    ? parseFloat((avgPoints * 0.92).toFixed(1))
    : null;

  const base = {
    avgPoints,
    avgPointsAllowed,
    netRating,
    restDays: daysSince,
    form,
    pace,
    rank: null,
    record: null
  };

  // NHL sport-specific aliases so NHL driver models can use domain-correct names
  if (normalizedSport === 'NHL') {
    base.avgGoalsFor = avgPoints;
    base.avgGoalsAgainst = avgPointsAllowed;
  }

  return base;
}

/**
 * Look up a team entry from the given mapping table using case-insensitive matching.
 * @param {string} teamName
 * @param {object} table
 * @returns {object|null} { id, abbr } or null
 */
function removeDiacritics(text) {
  if (!text || typeof text !== 'string') return '';
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeTeamKey(teamName) {
  const normalized = removeDiacritics(String(teamName || ''))
    .replace(/&/g, ' and ')
    .replace(/[.'\u2019]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const tokens = normalized.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'st' && i > 0) {
      tokens[i] = 'state';
    }
  }

  return tokens.join(' ');
}

function lookupTeam(teamName, table) {
  if (!teamName) return null;
  const normalized = normalizeTeamKey(teamName);
  // Exact key match first
  for (const [key, val] of Object.entries(table)) {
    if (normalizeTeamKey(key) === normalized) return val;
  }
  // Partial match fallback (team name is contained in key or vice versa)
  for (const [key, val] of Object.entries(table)) {
    const k = normalizeTeamKey(key);
    if (k.includes(normalized) || normalized.includes(k)) return val;
  }
  return null;
}

function toDateKeyUtc(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function addScoreboardAlias(index, alias, entry) {
  const key = normalizeTeamKey(alias);
  if (!key || index.has(key)) return;
  index.set(key, entry);
}

function teamEntryFromCompetitor(competitor) {
  const team = competitor?.team;
  if (!team?.id) return null;
  return {
    id: team.id,
    abbr: team.abbreviation || null
  };
}

function addTeamFromCompetitor(index, competitor) {
  const entry = teamEntryFromCompetitor(competitor);
  if (!entry) return;

  const team = competitor.team;
  addScoreboardAlias(index, team.displayName, entry);
  addScoreboardAlias(index, team.shortDisplayName, entry);
  if (team.location && team.name) {
    addScoreboardAlias(index, `${team.location} ${team.name}`, entry);
  }
}

async function buildScoreboardTeamIndex(sport, league) {
  const now = new Date();
  const dayKeys = [];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let offset = -SCOREBOARD_LOOKBACK_DAYS; offset <= SCOREBOARD_LOOKAHEAD_DAYS; offset += 1) {
    const d = new Date(base.getTime());
    d.setUTCDate(base.getUTCDate() + offset);
    dayKeys.push(toDateKeyUtc(d));
  }

  const options = sport === 'NCAAM' ? { groups: '50', limit: '1000' } : null;
  const index = new Map();

  for (const dayKey of dayKeys) {
    const events = await fetchScoreboardEvents(league, dayKey, options);
    for (const event of events || []) {
      const competitors = event?.competitions?.[0]?.competitors || [];
      for (const competitor of competitors) {
        addTeamFromCompetitor(index, competitor);
      }
    }
  }

  return index;
}

async function getScoreboardTeamIndex(sport, league) {
  const now = Date.now();
  const cached = scoreboardIndexCache.get(sport);
  if (cached && cached.expiresAt > now) {
    return cached.index;
  }

  if (scoreboardIndexInFlight.has(sport)) {
    return scoreboardIndexInFlight.get(sport);
  }

  const pending = (async () => {
    const index = await buildScoreboardTeamIndex(sport, league);
    if (index.size === 0) {
      logTeamMetricsEvent('SCOREBOARD_INDEX_EMPTY', {
        sport,
        league,
        lookbackDays: SCOREBOARD_LOOKBACK_DAYS,
        lookaheadDays: SCOREBOARD_LOOKAHEAD_DAYS,
      });
    }
    scoreboardIndexCache.set(sport, {
      index,
      // Empty index is usually a transient ESPN/network failure; retry quickly.
      expiresAt: Date.now() + (index.size > 0 ? SCOREBOARD_CACHE_TTL_MS : SCOREBOARD_EMPTY_CACHE_TTL_MS)
    });
    return index;
  })();

  scoreboardIndexInFlight.set(sport, pending);

  try {
    return await pending;
  } finally {
    scoreboardIndexInFlight.delete(sport);
  }
}

async function lookupTeamFromScoreboard(teamName, sport, league) {
  const normalized = normalizeTeamKey(teamName);
  if (!normalized) return null;

  const index = await getScoreboardTeamIndex(sport, league);
  if (!index || index.size === 0) return null;

  const direct = index.get(normalized);
  if (direct) return direct;

  if (sport === 'NHL') {
    const firstToken = normalized.split(' ')[0];
    if (!firstToken) return null;
    const matches = [];
    for (const [key, val] of index.entries()) {
      if (key.startsWith(`${firstToken} `)) {
        matches.push(val);
      }
    }
    const unique = new Map(matches.map(m => [String(m.id), m]));
    if (unique.size === 1) {
      return Array.from(unique.values())[0];
    }
  }

  return null;
}

async function resolveTeamEntry(teamName, sport, table, league, options = {}) {
  if (!teamName) return { entry: null, resolution: { status: 'missing_name' } };

  const strictVariantMatch = options.strictVariantMatch !== false;
  const variantResolution = resolveTeamVariant(teamName, `resolveTeamEntry:${sport}`);

  if (strictVariantMatch && !variantResolution.matched) {
    const fallbackEntry = await lookupTeamFromScoreboard(
      teamName,
      sport,
      league,
    );
    if (fallbackEntry) {
      table[teamName] = fallbackEntry;
      logTeamMetricsEvent('TEAM_RESOLVED_SCOREBOARD_UNMAPPED_VARIANT', {
        sport,
        inputTeamName: teamName,
        normalizedTeamName: variantResolution.normalized,
        canonicalTeamName: variantResolution.canonical,
        resolvedTeamId: fallbackEntry.id,
        resolvedTeamAbbr: fallbackEntry.abbr || null,
      });
      return {
        entry: fallbackEntry,
        resolution: {
          status: 'resolved_unmapped_variant',
          inputTeamName: teamName,
          normalizedTeamName: variantResolution.normalized,
          canonicalTeamName: variantResolution.canonical,
        },
      };
    }
    return {
      entry: null,
      resolution: {
        status: 'variant_unmapped',
        inputTeamName: teamName,
        normalizedTeamName: variantResolution.normalized,
        canonicalTeamName: variantResolution.canonical,
      }
    };
  }

  const lookupTeamName = variantResolution.matched
    ? variantResolution.canonical
    : teamName;

  const cacheKey = `${sport}:${normalizeTeamKey(lookupTeamName)}`;
  const now = Date.now();
  const cached = resolvedTeamCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      entry: cached.value,
      resolution: {
        status: 'resolved_cached',
        inputTeamName: teamName,
        normalizedTeamName: variantResolution.normalized,
        canonicalTeamName: variantResolution.canonical,
      }
    };
  }
  if (cached) {
    resolvedTeamCache.delete(cacheKey);
  }

  let entry = lookupTeam(lookupTeamName, table);
  const scoreboardEntry = await lookupTeamFromScoreboard(lookupTeamName, sport, league);
  if (!entry && scoreboardEntry) {
    entry = scoreboardEntry;
    table[lookupTeamName] = entry;
    logTeamMetricsEvent('TEAM_RESOLVED_SCOREBOARD_FALLBACK', {
      sport,
      inputTeamName: teamName,
      lookupTeamName,
      normalizedTeamName: variantResolution.normalized,
      canonicalTeamName: variantResolution.canonical,
      resolvedTeamId: entry.id,
      resolvedTeamAbbr: entry.abbr || null,
    });
  }

  if (sport === 'NHL' && entry && scoreboardEntry) {
    const staticId = entry?.id != null ? String(entry.id) : null;
    const scoreboardId = scoreboardEntry?.id != null ? String(scoreboardEntry.id) : null;
    if (staticId && scoreboardId && staticId !== scoreboardId) {
      entry = scoreboardEntry;
      table[lookupTeamName] = scoreboardEntry;
      logTeamMetricsEvent('TEAM_RESOLVED_SCOREBOARD_OVERRIDE_STALE_STATIC_ID', {
        sport,
        inputTeamName: teamName,
        lookupTeamName,
        staticId,
        scoreboardId,
        normalizedTeamName: variantResolution.normalized,
        canonicalTeamName: variantResolution.canonical,
      });
    }
  }

  resolvedTeamCache.set(cacheKey, {
    value: entry || null,
    expiresAt: Date.now() + (entry ? RESOLVED_TEAM_CACHE_TTL_MS : RESOLVED_TEAM_NEGATIVE_CACHE_TTL_MS)
  });
  return {
    entry: entry || null,
    resolution: {
      status: entry ? 'resolved' : 'unresolved',
      inputTeamName: teamName,
      normalizedTeamName: variantResolution.normalized,
      canonicalTeamName: variantResolution.canonical,
    }
  };
}

function selectTeamTable(sport) {
  const normalizedSport = normalizeSportCode(
    typeof sport === 'string' ? sport : String(sport || ''),
    'selectTeamTable'
  ) || String(sport || '').trim().toUpperCase();

  if (normalizedSport === 'NHL') return { table: NHL_TEAMS, league: 'hockey/nhl' };
  if (normalizedSport === 'NBA') return { table: NBA_TEAMS, league: 'basketball/nba' };
  if (normalizedSport === 'NCAAM') return { table: NCAAM_TEAMS, league: 'basketball/mens-college-basketball' };
  return { table: null, league: null };
}

/**
 * Fetch ESPN-derived team metrics for a given team name and sport.
 * Returns neutral fallback on any error or unknown team.
 *
 * @param {string} teamName - Full team name from odds API (e.g. "Boston Bruins")
 * @param {string} sport - 'NHL' | 'NBA' | 'NCAAM'
 * @returns {Promise<object>} Metrics object
 */
async function getTeamMetrics(teamName, sport) {
  const snapshot = await getTeamMetricsWithGames(teamName, sport, { includeGames: false });
  return snapshot.metrics;
}

/**
 * Fetch ESPN-derived team metrics and optional schedule info.
 * Returns neutral fallback on any error or unknown team.
 *
 * @param {string} teamName - Full team name from odds API (e.g. "Boston Bruins")
 * @param {string} sport - 'NHL' | 'NBA' | 'NCAAM'
 * @param {object} options
 * @param {boolean} [options.includeGames=false]
 * @param {number} [options.limit=5]
 * @returns {Promise<{metrics: object, teamInfo: object|null, games: Array}>}
 */
async function getTeamMetricsWithGames(teamName, sport, options = {}) {
  const includeGames = options.includeGames === true;
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  const strictVariantMatch = options.strictVariantMatch !== false;
  const skipCache = options.skipCache === true;
  const normalizedSport = normalizeSportCode(
    typeof sport === 'string' ? sport : String(sport || ''),
    'getTeamMetricsWithGames'
  ) || String(sport || '').trim().toUpperCase();

  // Check daily DB cache first (unless skipCache=true)
  if (!skipCache) {
    try {
      const nowEt = DateTime.now().setZone('America/New_York');
      const cacheDate = nowEt.toISODate();
      const cached = getTeamMetricsCache(normalizedSport, teamName, cacheDate);
      
      if (cached && cached.status === 'ok') {
        const cachedMetrics = normalizedSport === 'NHL'
          ? ensureNhlMetricAliases(cached.metrics || neutral())
          : (cached.metrics || neutral());
        if (hasSufficientNumericMetricsForSport(cachedMetrics, normalizedSport)) {
          return {
            metrics: cachedMetrics,
            teamInfo: cached.teamInfo || null,
            games: includeGames && cached.recentGames ? cached.recentGames : [],
            resolution: {
              ...cached.resolution,
              cached: true,
              cacheDate: cached.cacheDate,
              fetchedAt: cached.fetchedAt
            }
          };
        }
        logTeamMetricsEvent('TEAM_METRICS_CACHE_INSUFFICIENT_NUMERIC', {
          sport: normalizedSport,
          inputTeamName: teamName,
          cacheDate: cached.cacheDate,
        });
      }
    } catch (cacheErr) {
      console.warn(`[TeamMetrics] Cache lookup failed for "${teamName}": ${cacheErr.message}`);
      // Fall through to live fetch on cache error
    }
  }

  try {
    const { table, league } = selectTeamTable(normalizedSport);
    if (!table || !league) {
      console.warn(`[TeamMetrics] Unknown sport: ${sport}`);
      return {
        metrics: neutral(),
        teamInfo: null,
        games: [],
        resolution: { status: 'unknown_sport', sport: normalizedSport }
      };
    }

    const { entry: teamEntry, resolution } = await resolveTeamEntry(
      teamName,
      normalizedSport,
      table,
      league,
      { strictVariantMatch }
    );
    if (!teamEntry) {
      const reason = resolution?.status || 'unknown_team';
      console.warn(`[TeamMetrics] Unknown team: "${teamName}" (sport: ${normalizedSport}, reason: ${reason})`);
      logTeamMetricsEvent('TEAM_METRICS_NULL', {
        sport: normalizedSport,
        inputTeamName: teamName,
        reason,
        resolution,
      });
      return {
        metrics: neutral(),
        teamInfo: null,
        games: [],
        resolution: {
          ...resolution,
          sport: normalizedSport,
        }
      };
    }

    // Small delay to avoid ESPN rate limiting
    await new Promise(r => setTimeout(r, 200));

    let [games, teamInfo] = await Promise.all([
      fetchTeamSchedule(league, teamEntry.id, limit),
      fetchTeamInfo(league, teamEntry.id)
    ]);

    // Existing static map entries can drift. If ESPN returns nothing, retry with scoreboard ID.
    if ((!games || games.length === 0) && !teamInfo) {
      const fallbackEntry = await lookupTeamFromScoreboard(teamName, normalizedSport, league);
      const fallbackId = fallbackEntry?.id != null ? String(fallbackEntry.id) : null;
      const currentId = teamEntry?.id != null ? String(teamEntry.id) : null;
      if (fallbackEntry && fallbackId && fallbackId !== currentId) {
        [games, teamInfo] = await Promise.all([
          fetchTeamSchedule(league, fallbackEntry.id, limit),
          fetchTeamInfo(league, fallbackEntry.id)
        ]);
        if ((games && games.length > 0) || teamInfo) {
          const cacheKey = `${normalizedSport}:${normalizeTeamKey(teamName)}`;
          table[teamName] = fallbackEntry;
          resolvedTeamCache.set(cacheKey, {
            value: fallbackEntry,
            expiresAt: Date.now() + RESOLVED_TEAM_CACHE_TTL_MS
          });
          logTeamMetricsEvent('TEAM_RERESOLVED_AFTER_EMPTY_ESPN', {
            sport: normalizedSport,
            inputTeamName: teamName,
            priorTeamId: teamEntry.id,
            scoreboardTeamId: fallbackEntry.id,
          });
        }
      }
    }

    if ((!games || games.length === 0) && !teamInfo) {
      console.warn(`[TeamMetrics] ESPN returned no data for "${teamName}" (id: ${teamEntry.id})`);
      logTeamMetricsEvent('TEAM_METRICS_NULL', {
        sport: normalizedSport,
        inputTeamName: teamName,
        reason: 'espn_no_data',
        teamId: teamEntry.id,
        resolution,
      });
      return {
        metrics: neutral(),
        teamInfo: null,
        games: [],
        resolution: {
          ...resolution,
          sport: normalizedSport,
          status: 'espn_no_data',
          teamId: teamEntry.id,
        }
      };
    }

    const metrics = computeMetricsFromGames(games || [], normalizedSport);
    const normalizedMetrics = normalizedSport === 'NHL'
      ? ensureNhlMetricAliases(metrics)
      : metrics;

    if (teamInfo) {
      normalizedMetrics.rank = teamInfo.rank;
      normalizedMetrics.record = teamInfo.record;
    }

    if (!hasSufficientNumericMetricsForSport(normalizedMetrics, normalizedSport)) {
      logTeamMetricsEvent('TEAM_METRICS_INSUFFICIENT_NUMERIC', {
        sport: normalizedSport,
        inputTeamName: teamName,
        teamId: teamEntry.id,
        resolution,
      });
      return {
        metrics: normalizedMetrics,
        teamInfo: teamInfo || null,
        games: includeGames ? (games || []) : [],
        resolution: {
          ...resolution,
          sport: normalizedSport,
          teamId: teamEntry.id,
          status: 'insufficient_numeric_metrics',
        }
      };
    }

    const finalResolution = {
      ...resolution,
      sport: normalizedSport,
      teamId: teamEntry.id,
      status: 'ok'
    };

    // Write successful fetch to cache (best-effort, don't fail on cache write error)
    if (!skipCache) {
      try {
        const nowEt = DateTime.now().setZone('America/New_York');
        const cacheDate = nowEt.toISODate();
        upsertTeamMetricsCache({
          sport: normalizedSport,
          teamName: teamName,
          cacheDate: cacheDate,
          status: 'ok',
          metrics: normalizedMetrics,
          teamInfo: teamInfo,
          recentGames: games || [],
          resolution: finalResolution
        });
      } catch (cacheWriteErr) {
        console.warn(`[TeamMetrics] Cache write failed for "${teamName}": ${cacheWriteErr.message}`);
      }
    }

    return {
      metrics: normalizedMetrics,
      teamInfo: teamInfo || null,
      games: includeGames ? (games || []) : [],
      resolution: finalResolution
    };
  } catch (err) {
    console.warn(`[TeamMetrics] Error fetching metrics for "${teamName}": ${err.message}`);
    logTeamMetricsEvent('TEAM_METRICS_ERROR', {
      sport: normalizedSport,
      inputTeamName: teamName,
      message: err.message,
    });
    return {
      metrics: neutral(),
      teamInfo: null,
      games: [],
      resolution: {
        status: 'error',
        sport: normalizedSport,
        inputTeamName: teamName,
        message: err.message,
      }
    };
  }
}

module.exports = {
  getTeamMetrics,
  getTeamMetricsWithGames,
  computeMetricsFromGames
};
