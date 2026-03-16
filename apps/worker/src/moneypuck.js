/**
 * MoneyPuck ingestion helpers (HTML tables)
 *
 * Fetches team, goalie, power, and injury data from MoneyPuck pages,
 * parses tables into structured objects, and exposes an enrichment helper
 * for NHL odds snapshots.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const MONEYPUCK_URLS = {
  teams: 'https://moneypuck.com/teams.htm',
  goalies: 'https://moneypuck.com/goalies.htm',
  stats: 'https://moneypuck.com/stats.htm',
  injuries: 'https://moneypuck.com/injuries.htm',
  injuriesCsv:
    'https://moneypuck.com/moneypuck/playerData/playerNews/current_injuries.csv',
  power: 'https://moneypuck.com/power.htm',
};

const ROTOWIRE_URLS = {
  projectedGoalies:
    'https://www.rotowire.com/hockey/tables/projected-goalies.php?date=',
};

const NHL_ABBR_TO_CANONICAL = {
  ANA: 'Anaheim Ducks',
  ARI: 'Arizona Coyotes',
  BOS: 'Boston Bruins',
  BUF: 'Buffalo Sabres',
  CAR: 'Carolina Hurricanes',
  CBJ: 'Columbus Blue Jackets',
  CGY: 'Calgary Flames',
  CHI: 'Chicago Blackhawks',
  COL: 'Colorado Avalanche',
  DAL: 'Dallas Stars',
  DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers',
  FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings',
  MIN: 'Minnesota Wild',
  MTL: 'Montreal Canadiens',
  NJD: 'New Jersey Devils',
  NSH: 'Nashville Predators',
  NYI: 'New York Islanders',
  NYR: 'New York Rangers',
  OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers',
  PIT: 'Pittsburgh Penguins',
  SEA: 'Seattle Kraken',
  SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues',
  TBL: 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs',
  UTA: 'Utah Hockey Club',
  VAN: 'Vancouver Canucks',
  VGK: 'Vegas Golden Knights',
  WPG: 'Winnipeg Jets',
  WSH: 'Washington Capitals',
};

const DEFAULT_CACHE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'output',
  'moneypuck-cache.json',
);
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
let memoryCache = null;
const SKATER_IMPACT_MIN = 0.5;
const SKATER_IMPACT_MAX = 2.5;

function hasGoalieData(snapshot) {
  return Boolean(
    snapshot &&
    ((snapshot.goalies && Object.keys(snapshot.goalies).length > 0) ||
      (snapshot.rotowire_goalies &&
        Object.keys(snapshot.rotowire_goalies).length > 0) ||
      (snapshot.rotowire_goalies_by_date &&
        Object.keys(snapshot.rotowire_goalies_by_date).length > 0)),
  );
}

const NHL_CANONICAL_TEAMS = [
  'Anaheim Ducks',
  'Boston Bruins',
  'Buffalo Sabres',
  'Calgary Flames',
  'Carolina Hurricanes',
  'Chicago Blackhawks',
  'Colorado Avalanche',
  'Columbus Blue Jackets',
  'Dallas Stars',
  'Detroit Red Wings',
  'Edmonton Oilers',
  'Florida Panthers',
  'Los Angeles Kings',
  'Minnesota Wild',
  'Montreal Canadiens',
  'Nashville Predators',
  'New Jersey Devils',
  'New York Islanders',
  'New York Rangers',
  'Ottawa Senators',
  'Philadelphia Flyers',
  'Pittsburgh Penguins',
  'San Jose Sharks',
  'Seattle Kraken',
  'St. Louis Blues',
  'Tampa Bay Lightning',
  'Toronto Maple Leafs',
  'Vancouver Canucks',
  'Vegas Golden Knights',
  'Washington Capitals',
  'Winnipeg Jets',
  'Arizona Coyotes',
  'Utah Hockey Club',
];

const TEAM_ALIASES = {
  'montreal canadiens': 'Montreal Canadiens',
  montreal: 'Montreal Canadiens',
  'st louis blues': 'St. Louis Blues',
  'st. louis blues': 'St. Louis Blues',
  'utah mammoth': 'Utah Hockey Club',
  'utah hc': 'Utah Hockey Club',
  'utah hockey club': 'Utah Hockey Club',
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/csv,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: 'https://moneypuck.com/injuries.htm',
        Origin: 'https://moneypuck.com',
      },
    };
    https
      .get(url, options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `MoneyPuck request failed (${res.statusCode}) for ${url}`,
            ),
          );
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function isCloudflareChallengeBody(body) {
  if (!body || typeof body !== 'string') return false;
  const sample = body.slice(0, 2000).toLowerCase();
  return (
    sample.includes('just a moment') ||
    sample.includes('cf_chl') ||
    sample.includes('enable javascript and cookies')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUrlWithRetries(
  url,
  { attempts = 3, retryMs = 1200, requireNonChallenge = false } = {},
) {
  let lastBody = '';
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const body = await fetchUrl(url);
      lastBody = body;
      if (!requireNonChallenge || !isCloudflareChallengeBody(body)) {
        return body;
      }
      lastErr = new Error(`Cloudflare challenge content for ${url}`);
    } catch (err) {
      lastErr = err;
    }

    if (attempt < attempts) {
      await sleep(retryMs * attempt);
    }
  }

  if (requireNonChallenge && lastBody) {
    return lastBody;
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

function removeDiacritics(text) {
  if (!text || typeof text !== 'string') return '';
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeTeamKey(name) {
  if (!name) return '';
  const cleaned = removeDiacritics(String(name))
    .replace(/[.'\u2019]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return cleaned;
}

const TEAM_KEY_TO_CANONICAL = NHL_CANONICAL_TEAMS.reduce((acc, team) => {
  acc[normalizeTeamKey(team)] = team;
  return acc;
}, {});

function canonicalizeTeamName(name) {
  const key = normalizeTeamKey(name);
  if (!key) return null;
  if (TEAM_ALIASES[key]) return TEAM_ALIASES[key];
  if (TEAM_KEY_TO_CANONICAL[key]) return TEAM_KEY_TO_CANONICAL[key];
  return name.trim();
}

function normalizePlayerNameForLookup(name) {
  if (!name || typeof name !== 'string') return '';
  return removeDiacritics(name)
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPlayerLookupKeys(name) {
  const normalized = normalizePlayerNameForLookup(name);
  if (!normalized) return [];
  const keys = new Set([normalized, normalized.replace(/\s+/g, '')]);
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length >= 2) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    keys.add(`${first.charAt(0)} ${last}`);
    keys.add(`${first.charAt(0)}${last}`);
  }
  return Array.from(keys);
}

function normalizeHeader(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseNumber(value) {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(/[%\s,]/g, '')
    .trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function tableHeaders($, $table) {
  const headers = [];
  $table
    .find('tr')
    .first()
    .find('th, td')
    .each((_, cell) => {
      headers.push(normalizeHeader($(cell).text()));
    });
  return headers;
}

function tableRows($, $table) {
  const headers = tableHeaders($, $table);
  const rows = [];
  $table
    .find('tr')
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find('th, td');
      if (!cells.length) return;
      const entry = {};
      cells.each((idx, cell) => {
        const key = headers[idx] || `col_${idx}`;
        entry[key] = $(cell).text().replace(/\s+/g, ' ').trim();
      });
      if (Object.keys(entry).length > 0) rows.push(entry);
    });
  return rows;
}

function findTable($, headerCandidates) {
  const tables = $('table');
  for (const table of tables.toArray()) {
    const $table = $(table);
    const headers = tableHeaders($, $table);
    const headerSet = new Set(headers);
    const matches = headerCandidates.some((candidate) =>
      headerSet.has(candidate),
    );
    if (matches) return $table;
  }
  return null;
}

function parseTeamStats(html) {
  const $ = cheerio.load(html);
  const table = findTable($, ['team', 'xgf%', 'xgf', 'pdo', 'pp%', 'pk%']);
  if (!table) return {};

  const rows = tableRows($, table);
  const teams = {};
  rows.forEach((row) => {
    const teamName = row.team || row['team name'] || row['club'] || null;
    if (!teamName) return;
    const canonical = canonicalizeTeamName(teamName);
    const xgf = parseNumber(row['xgf%'] ?? row['xgf'] ?? row['xgf% (5v5)']);
    const pdo = parseNumber(row['pdo'] ?? row['pdo%']);
    const pp = parseNumber(row['pp%'] ?? row['pp']);
    const pk = parseNumber(row['pk%'] ?? row['pk']);

    if (!canonical) return;
    teams[canonical] = {
      xgf_pct: xgf,
      pdo,
      pp_pct: pp,
      pk_pct: pk,
    };
  });
  return teams;
}

function parsePowerStats(html) {
  const $ = cheerio.load(html);
  const table = findTable($, ['team', 'pp%', 'pk%', 'power']);
  if (!table) return {};

  const rows = tableRows($, table);
  const teams = {};
  rows.forEach((row) => {
    const teamName = row.team || row['team name'] || row['club'] || null;
    if (!teamName) return;
    const canonical = canonicalizeTeamName(teamName);
    const pp = parseNumber(row['pp%'] ?? row['pp']);
    const pk = parseNumber(row['pk%'] ?? row['pk']);
    const power = parseNumber(row['power'] ?? row['power%']);

    if (!canonical) return;
    teams[canonical] = {
      pp_pct: pp,
      pk_pct: pk,
      power_index: power,
    };
  });
  return teams;
}

function parseGoalies(html) {
  const $ = cheerio.load(html);
  const table = findTable($, ['goalie', 'gsax', 'gsax/60']);
  if (!table) return {};

  const rows = tableRows($, table);
  const goaliesByTeam = {};
  rows.forEach((row) => {
    const teamName = row.team || row['team name'] || row['club'] || null;
    const gsax = parseNumber(
      row['gsax'] ?? row['gsax/60'] ?? row['gsax (total)'],
    );
    if (!teamName || gsax === null) return;
    const canonical = canonicalizeTeamName(teamName);
    if (!canonical) return;

    const existing = goaliesByTeam[canonical];
    if (!existing || gsax > existing.gsax) {
      goaliesByTeam[canonical] = {
        gsax,
        source: 'moneypuck',
      };
    }
  });
  return goaliesByTeam;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  cells.push(current);
  return cells;
}

function parseGoaliesCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') return {};

  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return {};

  const headers = parseCsvLine(lines[0]).map((header) =>
    normalizeHeader(header),
  );
  const teamIdx = headers.indexOf('team');
  const situationIdx = headers.indexOf('situation');
  const xGoalsIdx = headers.indexOf('xgoals');
  const goalsIdx = headers.indexOf('goals');

  if (teamIdx < 0 || situationIdx < 0 || xGoalsIdx < 0 || goalsIdx < 0) {
    return {};
  }

  const goaliesByTeam = {};

  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const situation = String(row[situationIdx] || '')
      .trim()
      .toLowerCase();
    if (situation !== 'all') continue;

    const teamAbbr = String(row[teamIdx] || '')
      .trim()
      .toUpperCase();
    const canonical =
      NHL_ABBR_TO_CANONICAL[teamAbbr] || canonicalizeTeamName(teamAbbr);
    if (!canonical) continue;

    const xGoals = parseNumber(row[xGoalsIdx]);
    const goals = parseNumber(row[goalsIdx]);
    if (xGoals === null || goals === null) continue;

    const gsax = xGoals - goals;
    const existing = goaliesByTeam[canonical];
    if (!existing || gsax > existing.gsax) {
      goaliesByTeam[canonical] = {
        gsax,
        source: 'moneypuck-csv',
      };
    }
  }

  return goaliesByTeam;
}

function parseSkatersCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') {
    return { league_avg_toi_per_game: null, by_team: {} };
  }

  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { league_avg_toi_per_game: null, by_team: {} };
  }

  const headers = parseCsvLine(lines[0]).map((header) =>
    normalizeHeader(header),
  );
  const playerIdx = headers.indexOf('name');
  const teamIdx = headers.indexOf('team');
  const situationIdx = headers.indexOf('situation');
  const gamesPlayedIdx = headers.indexOf('games_played');
  const icetimeIdx = headers.indexOf('icetime');
  const pointsIdx = headers.indexOf('i_f_points');
  const xGoalsForIdx =
    headers.indexOf('onice_xgoalsfor') >= 0
      ? headers.indexOf('onice_xgoalsfor')
      : headers.indexOf('onice_f_xgoals');

  if (
    playerIdx < 0 ||
    teamIdx < 0 ||
    situationIdx < 0 ||
    gamesPlayedIdx < 0 ||
    icetimeIdx < 0
  ) {
    return { league_avg_toi_per_game: null, by_team: {} };
  }

  const playerRows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const situation = String(row[situationIdx] || '')
      .trim()
      .toLowerCase();
    if (situation !== 'all') continue;

    const player = String(row[playerIdx] || '').trim();
    const teamAbbr = String(row[teamIdx] || '')
      .trim()
      .toUpperCase();
    const canonicalTeam =
      NHL_ABBR_TO_CANONICAL[teamAbbr] || canonicalizeTeamName(teamAbbr);
    const gamesPlayed = parseNumber(row[gamesPlayedIdx]);
    const iceTime = parseNumber(row[icetimeIdx]);
    if (!player || !canonicalTeam || gamesPlayed === null || gamesPlayed <= 0) {
      continue;
    }
    if (iceTime === null || iceTime <= 0) continue;

    const points = pointsIdx >= 0 ? parseNumber(row[pointsIdx]) : null;
    const onIceXGoalsFor = xGoalsForIdx >= 0 ? parseNumber(row[xGoalsForIdx]) : null;

    const toiPerGame = iceTime / gamesPlayed;
    if (!Number.isFinite(toiPerGame) || toiPerGame <= 0) continue;

    playerRows.push({
      player,
      team: canonicalTeam,
      toi_per_game: toiPerGame,
      points_per_game:
        points !== null && Number.isFinite(points / gamesPlayed)
          ? points / gamesPlayed
          : null,
      onice_xgf_for_per_game:
        onIceXGoalsFor !== null && Number.isFinite(onIceXGoalsFor / gamesPlayed)
          ? onIceXGoalsFor / gamesPlayed
          : null,
    });
  }

  const validToi = playerRows.map((row) => row.toi_per_game).filter(Number.isFinite);
  const leagueAvgToiPerGame =
    validToi.length > 0
      ? validToi.reduce((sum, toi) => sum + toi, 0) / validToi.length
      : null;

  const byTeam = {};
  for (const playerRow of playerRows) {
    const impact =
      leagueAvgToiPerGame && leagueAvgToiPerGame > 0
        ? Math.min(
            SKATER_IMPACT_MAX,
            Math.max(SKATER_IMPACT_MIN, playerRow.toi_per_game / leagueAvgToiPerGame),
          )
        : 1;
    const teamBucket = byTeam[playerRow.team] || {};
    for (const key of buildPlayerLookupKeys(playerRow.player)) {
      teamBucket[key] = {
        player: playerRow.player,
        toi_per_game: Number(playerRow.toi_per_game.toFixed(3)),
        points_per_game:
          playerRow.points_per_game === null
            ? null
            : Number(playerRow.points_per_game.toFixed(3)),
        onice_xgf_for_per_game:
          playerRow.onice_xgf_for_per_game === null
            ? null
            : Number(playerRow.onice_xgf_for_per_game.toFixed(3)),
        impact: Number(impact.toFixed(3)),
      };
    }
    byTeam[playerRow.team] = teamBucket;
  }

  return {
    league_avg_toi_per_game:
      leagueAvgToiPerGame === null ? null : Number(leagueAvgToiPerGame.toFixed(3)),
    by_team: byTeam,
  };
}

function buildGoalieCsvCandidates(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const seasonStartYear = month >= 6 ? year : year - 1;
  const seasons = [...new Set([seasonStartYear, seasonStartYear - 1, year])];

  return seasons.map(
    (season) =>
      `https://moneypuck.com/moneypuck/playerData/seasonSummary/${season}/regular/goalies.csv`,
  );
}

function buildSkaterCsvCandidates(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const seasonStartYear = month >= 6 ? year : year - 1;
  const seasons = [...new Set([seasonStartYear, seasonStartYear - 1, year])];

  return seasons.map(
    (season) =>
      `https://moneypuck.com/moneypuck/playerData/seasonSummary/${season}/regular/skaters.csv`,
  );
}

async function fetchGoaliesCsv() {
  const candidates = buildGoalieCsvCandidates();

  for (const url of candidates) {
    try {
      const csv = await fetchUrl(url);
      if (csv && csv.includes('team') && csv.includes('xGoals')) {
        return csv;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchSkatersCsv() {
  const candidates = buildSkaterCsvCandidates();

  for (const url of candidates) {
    try {
      const csv = await fetchUrl(url);
      if (csv && csv.includes('team') && csv.includes('games_played')) {
        return csv;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function formatDateYYYYMMDD(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateYYYYMMDDLocal(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateYYYYMMDDEastern(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function normalizeRotowireGoalieStatus(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase();
  if (!token) return null;
  
  // Goalie status semantics (must be preserved throughout pipeline):
  // CONFIRMED = officially announced on game-day rosters (lock in status, don't downgrade)
  // EXPECTED = projected/likely but not yet officially confirmed (subject to change)
  // UNKNOWN = uncertain or undecided (no confirmation from sources)
  
  if (token === 'CONFIRMED' || token === 'STARTING' || token === 'OFFICIAL') {
    return 'CONFIRMED';
  }
  if (token === 'EXPECTED' || token === 'LIKELY' || token === 'PROJECTED') {
    return 'EXPECTED';
  }
  if (token === 'UNKNOWN' || token === 'UNCONFIRMED' || token === 'TBD') {
    return 'UNKNOWN';
  }
  return null;
}

function goalieStatusPriority(status) {
  if (status === 'CONFIRMED') return 3;
  if (status === 'EXPECTED') return 2;
  if (status === 'UNKNOWN') return 1;
  return 0;
}

function mergeRotowireGoalieEntry(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingPriority = goalieStatusPriority(existing.status);
  const incomingPriority = goalieStatusPriority(incoming.status);

  if (incomingPriority > existingPriority) {
    return incoming;
  }
  if (incomingPriority < existingPriority) {
    return existing;
  }

  return {
    ...existing,
    name: existing.name || incoming.name || null,
    status: existing.status || incoming.status || null,
  };
}

function parseRotowireGoalies(payload) {
  if (!Array.isArray(payload)) return {};
  const goaliesByTeam = {};

  for (const row of payload) {
    const homeAbbr = String(row?.hometeam || '')
      .trim()
      .toUpperCase();
    const awayAbbr = String(row?.visitteam || '')
      .trim()
      .toUpperCase();

    const homeTeam =
      NHL_ABBR_TO_CANONICAL[homeAbbr] || canonicalizeTeamName(homeAbbr);
    const awayTeam =
      NHL_ABBR_TO_CANONICAL[awayAbbr] || canonicalizeTeamName(awayAbbr);

    if (homeTeam) {
      const incoming = {
        name: row?.homePlayer || null,
        status: normalizeRotowireGoalieStatus(row?.homeStatus) || 'UNKNOWN',
        source: 'rotowire',
      };
      goaliesByTeam[homeTeam] = mergeRotowireGoalieEntry(
        goaliesByTeam[homeTeam],
        incoming,
      );
    }

    if (awayTeam) {
      const incoming = {
        name: row?.visitPlayer || null,
        status: normalizeRotowireGoalieStatus(row?.visitStatus) || 'UNKNOWN',
        source: 'rotowire',
      };
      goaliesByTeam[awayTeam] = mergeRotowireGoalieEntry(
        goaliesByTeam[awayTeam],
        incoming,
      );
    }
  }

  return goaliesByTeam;
}

async function fetchRotowireGoaliesSnapshot(now = new Date()) {
  const includeRawRecords =
    now && typeof now === 'object' && !Array.isArray(now) && 'includeRawRecords' in now
      ? now.includeRawRecords === true
      : false;
  const nowDate =
    now && typeof now === 'object' && !Array.isArray(now) && 'now' in now
      ? new Date(now.now)
      : now;

  const yesterday = new Date(nowDate);
  const today = new Date(nowDate);
  const tomorrow = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dates = [
    formatDateYYYYMMDDLocal(yesterday),
    formatDateYYYYMMDDLocal(today),
    formatDateYYYYMMDDLocal(tomorrow),
  ];

  const merged = {};
  const byDate = {};
  const rawByDate = {};

  for (const date of dates) {
    try {
      const body = await fetchUrl(`${ROTOWIRE_URLS.projectedGoalies}${date}`);
      const parsed = JSON.parse(body);
      if (includeRawRecords) {
        rawByDate[date] = Array.isArray(parsed) ? parsed : [];
      }
      const mapped = parseRotowireGoalies(parsed);
      byDate[date] = mapped;
      for (const [team, goalie] of Object.entries(mapped)) {
        merged[team] = mergeRotowireGoalieEntry(merged[team], goalie);
      }
    } catch {
      continue;
    }
  }

  return {
    teams: merged,
    byDate,
    ...(includeRawRecords ? { rawByDate } : {}),
  };
}

function shiftUtcDays(date, days) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function buildRotowireDateWindowKeys(gameTimeUtc) {
  const baseTime = gameTimeUtc ? new Date(gameTimeUtc) : new Date();
  const resolvedBase = Number.isNaN(baseTime.getTime()) ? new Date() : baseTime;
  const keys = [
    formatDateYYYYMMDDEastern(resolvedBase),
    formatDateYYYYMMDDEastern(shiftUtcDays(resolvedBase, -1)),
    formatDateYYYYMMDDEastern(shiftUtcDays(resolvedBase, 1)),
  ];
  return Array.from(new Set(keys));
}

function resolveRotowireGoalieForGameDetailed(snapshot, teamName, gameTimeUtc) {
  if (!snapshot || !teamName) return {};
  const dateWindowKeys = buildRotowireDateWindowKeys(gameTimeUtc);
  const primaryDateKey = dateWindowKeys[0] || null;
  const diagnostics = {
    team: teamName,
    game_time_utc: gameTimeUtc || null,
    primary_date_key: primaryDateKey,
    alternate_date_keys_checked: dateWindowKeys.slice(1),
    raw_source_date_key_used: null,
    checked_date_keys: [...dateWindowKeys],
    resolution_path: null,
    fallback_reason_codes: [],
  };

  let resolvedByDate = null;
  let resolvedDateKey = null;
  for (const key of dateWindowKeys) {
    const byDateEntry = snapshot.rotowire_goalies_by_date?.[key]?.[teamName];
    if (byDateEntry) {
      resolvedByDate = byDateEntry;
      resolvedDateKey = key;
      break;
    }
  }

  if (resolvedByDate) {
    diagnostics.raw_source_date_key_used = resolvedDateKey;
    diagnostics.resolution_path =
      resolvedDateKey === primaryDateKey
        ? 'DATE_EXACT'
        : 'DATE_ADJACENT_FALLBACK';
    return {
      goalie: resolvedByDate,
      diagnostics,
    };
  }

  const teamFallback = snapshot.rotowire_goalies?.[teamName] || null;
  if (teamFallback) {
    diagnostics.resolution_path = 'TEAM_FALLBACK';
    diagnostics.fallback_reason_codes.push('ROTOWIRE_DATE_WINDOW_MISS');
    return {
      goalie: teamFallback,
      diagnostics,
    };
  }

  diagnostics.resolution_path = 'SOURCE_MISS';
  diagnostics.fallback_reason_codes.push('ROTOWIRE_DATE_WINDOW_MISS');
  diagnostics.fallback_reason_codes.push('ROTOWIRE_SOURCE_MISS');
  return {
    goalie: {},
    diagnostics,
  };
}

function resolveRotowireGoalieForGame(snapshot, teamName, gameTimeUtc) {
  const resolved = resolveRotowireGoalieForGameDetailed(
    snapshot,
    teamName,
    gameTimeUtc,
  );
  return resolved.goalie || {};
}

function mergeMarkerList(existingMarkers, newMarkers) {
  const merged = new Set([
    ...(Array.isArray(existingMarkers) ? existingMarkers : []),
    ...(Array.isArray(newMarkers) ? newMarkers : []),
  ]);
  return Array.from(merged);
}

function parseInjuries(html) {
  const $ = cheerio.load(html);
  const table = findTable($, ['team', 'player', 'status']);
  if (!table) return {};

  const rows = tableRows($, table);
  const injuries = {};
  rows.forEach((row) => {
    const teamName = row.team || row['team name'] || null;
    const player = row.player || row['name'] || null;
    if (!teamName || !player) return;
    const canonical = canonicalizeTeamName(teamName);
    if (!canonical) return;
    if (!injuries[canonical]) injuries[canonical] = [];
    injuries[canonical].push({
      player,
      status: row.status || row['injury status'] || null,
      detail: row.details || row.note || null,
    });
  });
  return injuries;
}

function parseInjuriesCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') return {};

  const trimmed = csvText.trim();
  if (!trimmed || /just a moment|cf_chl|enable javascript and cookies/i.test(trimmed)) {
    return {};
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return {};

  const headers = parseCsvLine(lines[0]).map((header) => normalizeHeader(header));
  const playerNameIdx = headers.indexOf('playername');
  const teamCodeIdx = headers.indexOf('teamcode');
  const injuryDescriptionIdx = headers.indexOf('yahooinjurydescription');
  const injuryStatusIdx = headers.indexOf('playerinjurystatus');

  if (playerNameIdx < 0 || teamCodeIdx < 0) return {};

  const injuries = {};
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const player = row[playerNameIdx] ? String(row[playerNameIdx]).trim() : '';
    const teamCode = row[teamCodeIdx] ? String(row[teamCodeIdx]).trim().toUpperCase() : '';
    if (!player || !teamCode) continue;

    const canonical = NHL_ABBR_TO_CANONICAL[teamCode] || canonicalizeTeamName(teamCode);
    if (!canonical) continue;

    const statusCodeRaw = injuryStatusIdx >= 0 ? String(row[injuryStatusIdx] || '').trim() : '';
    const detailRaw = injuryDescriptionIdx >= 0 ? String(row[injuryDescriptionIdx] || '').trim() : '';
    const mappedStatus =
      statusCodeRaw === 'IR-NR'
        ? 'IR'
        : statusCodeRaw === 'IR-LT'
          ? 'IR -LT'
          : statusCodeRaw;

    if (!injuries[canonical]) injuries[canonical] = [];
    injuries[canonical].push({
      player,
      status: mappedStatus || null,
      detail: detailRaw || null,
    });
  }

  return injuries;
}

function mergeTeamStats(base, updates) {
  const merged = { ...base };
  for (const [team, data] of Object.entries(updates || {})) {
    merged[team] = {
      ...(merged[team] || {}),
      ...data,
    };
  }
  return merged;
}

async function fetchMoneyPuckSnapshot({
  cachePath = DEFAULT_CACHE_PATH,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (memoryCache) {
    const cachedAt = new Date(memoryCache?.fetched_at || 0).getTime();
    if (
      cachedAt &&
      Date.now() - cachedAt < ttlMs &&
      hasGoalieData(memoryCache)
    ) {
      return memoryCache;
    }
  }

  if (cachePath) {
    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const cachedAt = new Date(cached?.fetched_at || 0).getTime();
        if (
          cachedAt &&
          Date.now() - cachedAt < ttlMs &&
          hasGoalieData(cached)
        ) {
          memoryCache = cached;
          return cached;
        }
      }
    } catch (err) {
      console.warn(`[MoneyPuck] Failed to read cache: ${err.message}`);
    }
  }

  let teamsHtml;
  let goaliesHtml;
  let goaliesCsv;
  let skatersCsv;
  let rotowireGoalies;
  let statsHtml;
  let injuriesHtml;
  let powerHtml;

  try {
    [
      teamsHtml,
      goaliesHtml,
      goaliesCsv,
      skatersCsv,
      rotowireGoalies,
      statsHtml,
      injuriesHtml,
      powerHtml,
    ] = await Promise.all([
      fetchUrl(MONEYPUCK_URLS.teams),
      fetchUrl(MONEYPUCK_URLS.goalies),
      fetchGoaliesCsv(),
      fetchSkatersCsv(),
      fetchRotowireGoaliesSnapshot(),
      fetchUrl(MONEYPUCK_URLS.stats),
      fetchUrl(MONEYPUCK_URLS.injuries),
      fetchUrl(MONEYPUCK_URLS.power),
    ]);
  } catch (err) {
    console.warn(`[MoneyPuck] Fetch failed: ${err.message}`);
    const fallback = {
      fetched_at: new Date().toISOString(),
      teams: {},
      goalies: {},
      injuries: {},
      error: err.message,
    };
    memoryCache = fallback;
    return fallback;
  }

  const baseTeams = parseTeamStats(teamsHtml);
  const statsTeams = parseTeamStats(statsHtml);
  const powerTeams = parsePowerStats(powerHtml);

  const teams = mergeTeamStats(
    mergeTeamStats(baseTeams, statsTeams),
    powerTeams,
  );
  const parsedGoaliesFromHtml = parseGoalies(goaliesHtml);
  const goalies =
    Object.keys(parsedGoaliesFromHtml).length > 0
      ? parsedGoaliesFromHtml
      : parseGoaliesCsv(goaliesCsv);
  const skaters = parseSkatersCsv(skatersCsv);
  let injuriesCsv = '';
  try {
    injuriesCsv = await fetchUrlWithRetries(MONEYPUCK_URLS.injuriesCsv, {
      attempts: 4,
      retryMs: 1500,
      requireNonChallenge: true,
    });
  } catch (err) {
    console.warn(`[MoneyPuck] Injuries CSV fetch failed: ${err.message}`);
  }
  const injuriesFromCsv = parseInjuriesCsv(injuriesCsv);
  const injuries =
    Object.keys(injuriesFromCsv).length > 0
      ? injuriesFromCsv
      : parseInjuries(injuriesHtml);

  const snapshot = {
    fetched_at: new Date().toISOString(),
    teams,
    goalies,
    skaters,
    rotowire_goalies: rotowireGoalies?.teams || {},
    rotowire_goalies_by_date: rotowireGoalies?.byDate || {},
    injuries,
  };

  memoryCache = snapshot;

  if (cachePath) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmpPath, cachePath);
    } catch (err) {
      console.warn(`[MoneyPuck] Failed to write cache: ${err.message}`);
    }
  }

  return snapshot;
}

function mergeRawData(rawData, payload) {
  const merged = { ...(rawData || {}) };
  merged.moneypuck = {
    ...(merged.moneypuck || {}),
    ...payload,
  };
  return merged;
}

async function enrichOddsSnapshotWithMoneyPuck(oddsSnapshot, options = {}) {
  if (!oddsSnapshot?.home_team || !oddsSnapshot?.away_team) return oddsSnapshot;

  let rawData = {};
  if (oddsSnapshot.raw_data) {
    try {
      rawData =
        typeof oddsSnapshot.raw_data === 'string'
          ? JSON.parse(oddsSnapshot.raw_data)
          : oddsSnapshot.raw_data;
    } catch {
      rawData = {};
    }
  }

  const snapshot =
    options.snapshot || (await fetchMoneyPuckSnapshot(options));
  const homeTeam = canonicalizeTeamName(oddsSnapshot.home_team);
  const awayTeam = canonicalizeTeamName(oddsSnapshot.away_team);

  const homeStats = snapshot.teams?.[homeTeam] || {};
  const awayStats = snapshot.teams?.[awayTeam] || {};
  const homeGoalie = snapshot.goalies?.[homeTeam] || {};
  const awayGoalie = snapshot.goalies?.[awayTeam] || {};
  const homeRotowireResolution = resolveRotowireGoalieForGameDetailed(
    snapshot,
    homeTeam,
    oddsSnapshot.game_time_utc,
  );
  const awayRotowireResolution = resolveRotowireGoalieForGameDetailed(
    snapshot,
    awayTeam,
    oddsSnapshot.game_time_utc,
  );
  const homeRotowireGoalie = homeRotowireResolution.goalie || {};
  const awayRotowireGoalie = awayRotowireResolution.goalie || {};
  const homeInjuries = snapshot.injuries?.[homeTeam] || [];
  const awayInjuries = snapshot.injuries?.[awayTeam] || [];
  const homeSkaterImpacts = snapshot.skaters?.by_team?.[homeTeam] || {};
  const awaySkaterImpacts = snapshot.skaters?.by_team?.[awayTeam] || {};
  const leagueAvgToiPerGame = snapshot.skaters?.league_avg_toi_per_game ?? null;

  const homeGoalieStatus =
    normalizeRotowireGoalieStatus(homeRotowireGoalie.status) ??
    normalizeRotowireGoalieStatus(rawData.goalie?.home?.status) ??
    normalizeRotowireGoalieStatus(rawData.goalie_home_status) ??
    null;
  const awayGoalieStatus =
    normalizeRotowireGoalieStatus(awayRotowireGoalie.status) ??
    normalizeRotowireGoalieStatus(rawData.goalie?.away?.status) ??
    normalizeRotowireGoalieStatus(rawData.goalie_away_status) ??
    null;

  const homeGoalieName =
    homeRotowireGoalie.name ?? rawData.goalie?.home?.name ?? null;
  const awayGoalieName =
    awayRotowireGoalie.name ?? rawData.goalie?.away?.name ?? null;
  const homeSourceMarkers = mergeMarkerList(
    rawData.goalie?.home?.source_markers,
    homeRotowireResolution.diagnostics?.fallback_reason_codes,
  );
  const awaySourceMarkers = mergeMarkerList(
    rawData.goalie?.away?.source_markers,
    awayRotowireResolution.diagnostics?.fallback_reason_codes,
  );

  const enrichedRaw = {
    ...rawData,
    teams: {
      ...(rawData.teams || {}),
      home: {
        ...(rawData.teams?.home || {}),
        xgf_pct: homeStats.xgf_pct ?? rawData.teams?.home?.xgf_pct ?? null,
        pdo: homeStats.pdo ?? rawData.teams?.home?.pdo ?? null,
      },
      away: {
        ...(rawData.teams?.away || {}),
        xgf_pct: awayStats.xgf_pct ?? rawData.teams?.away?.xgf_pct ?? null,
        pdo: awayStats.pdo ?? rawData.teams?.away?.pdo ?? null,
      },
    },
    special_teams: {
      ...(rawData.special_teams || {}),
      home: {
        ...(rawData.special_teams?.home || {}),
        pp_pct: homeStats.pp_pct ?? rawData.special_teams?.home?.pp_pct ?? null,
        pk_pct: homeStats.pk_pct ?? rawData.special_teams?.home?.pk_pct ?? null,
      },
      away: {
        ...(rawData.special_teams?.away || {}),
        pp_pct: awayStats.pp_pct ?? rawData.special_teams?.away?.pp_pct ?? null,
        pk_pct: awayStats.pk_pct ?? rawData.special_teams?.away?.pk_pct ?? null,
      },
    },
    goalie: {
      ...(rawData.goalie || {}),
      home: {
        ...(rawData.goalie?.home || {}),
        gsax: homeGoalie.gsax ?? rawData.goalie?.home?.gsax ?? null,
        name: homeGoalieName,
        status: homeGoalieStatus,
        source_markers: homeSourceMarkers,
      },
      away: {
        ...(rawData.goalie?.away || {}),
        gsax: awayGoalie.gsax ?? rawData.goalie?.away?.gsax ?? null,
        name: awayGoalieName,
        status: awayGoalieStatus,
        source_markers: awaySourceMarkers,
      },
    },
    goalie_home_gsax: homeGoalie.gsax ?? rawData.goalie_home_gsax ?? null,
    goalie_away_gsax: awayGoalie.gsax ?? rawData.goalie_away_gsax ?? null,
    goalie_home_status: homeGoalieStatus,
    goalie_away_status: awayGoalieStatus,
    goalie_home_source_markers: homeSourceMarkers,
    goalie_away_source_markers: awaySourceMarkers,
    rotowire_resolution: {
      ...(rawData.rotowire_resolution || {}),
      home: homeRotowireResolution.diagnostics,
      away: awayRotowireResolution.diagnostics,
    },
    xgf_home_pct: homeStats.xgf_pct ?? rawData.xgf_home_pct ?? null,
    xgf_away_pct: awayStats.xgf_pct ?? rawData.xgf_away_pct ?? null,
    pdo_home: homeStats.pdo ?? rawData.pdo_home ?? null,
    pdo_away: awayStats.pdo ?? rawData.pdo_away ?? null,
    pp_home_pct: homeStats.pp_pct ?? rawData.pp_home_pct ?? null,
    pk_home_pct: homeStats.pk_pct ?? rawData.pk_home_pct ?? null,
    pp_away_pct: awayStats.pp_pct ?? rawData.pp_away_pct ?? null,
    pk_away_pct: awayStats.pk_pct ?? rawData.pk_away_pct ?? null,
    injury_status: {
      ...(rawData.injury_status || {}),
      home: homeInjuries,
      away: awayInjuries,
    },
    injury_impact: {
      ...(rawData.injury_impact || {}),
      home: {
        ...((rawData.injury_impact && rawData.injury_impact.home) || {}),
        league_avg_toi_per_game: leagueAvgToiPerGame,
        players: homeSkaterImpacts,
      },
      away: {
        ...((rawData.injury_impact && rawData.injury_impact.away) || {}),
        league_avg_toi_per_game: leagueAvgToiPerGame,
        players: awaySkaterImpacts,
      },
    },
  };

  const enriched = {
    ...oddsSnapshot,
    raw_data: mergeRawData(enrichedRaw, {
      fetched_at: snapshot.fetched_at,
      source: 'moneypuck',
      team_keys: {
        home: homeTeam,
        away: awayTeam,
      },
    }),
  };

  if (typeof oddsSnapshot.raw_data === 'string') {
    enriched.raw_data = JSON.stringify(enriched.raw_data);
  }

  return enriched;
}

module.exports = {
  fetchMoneyPuckSnapshot,
  fetchRotowireGoaliesSnapshot,
  enrichOddsSnapshotWithMoneyPuck,
  normalizeRotowireGoalieStatus,
  resolveRotowireGoalieForGameDetailed,
  resolveRotowireGoalieForGame,
};
