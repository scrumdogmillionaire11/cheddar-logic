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

function hasGoalieData(snapshot) {
  return Boolean(
    snapshot &&
    ((snapshot.goalies && Object.keys(snapshot.goalies).length > 0) ||
      (snapshot.rotowire_goalies &&
        Object.keys(snapshot.rotowire_goalies).length > 0)),
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
        'User-Agent': 'cheddar-logic/1.0 (+https://github.com/cheddar-logic)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
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

function normalizeRotowireGoalieStatus(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase();
  if (!token) return null;
  if (token === 'CONFIRMED') return 'CONFIRMED';
  if (token === 'EXPECTED' || token === 'LIKELY' || token === 'PROJECTED') {
    return 'UNKNOWN';
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
  const yesterday = new Date(now);
  const today = new Date(now);
  const tomorrow = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dates = [
    formatDateYYYYMMDDLocal(yesterday),
    formatDateYYYYMMDDLocal(today),
    formatDateYYYYMMDDLocal(tomorrow),
  ];

  const merged = {};

  for (const date of dates) {
    try {
      const body = await fetchUrl(`${ROTOWIRE_URLS.projectedGoalies}${date}`);
      const parsed = JSON.parse(body);
      const mapped = parseRotowireGoalies(parsed);
      for (const [team, goalie] of Object.entries(mapped)) {
        merged[team] = mergeRotowireGoalieEntry(merged[team], goalie);
      }
    } catch {
      continue;
    }
  }

  return merged;
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
  let rotowireGoalies;
  let statsHtml;
  let injuriesHtml;
  let powerHtml;

  try {
    [
      teamsHtml,
      goaliesHtml,
      goaliesCsv,
      rotowireGoalies,
      statsHtml,
      injuriesHtml,
      powerHtml,
    ] = await Promise.all([
      fetchUrl(MONEYPUCK_URLS.teams),
      fetchUrl(MONEYPUCK_URLS.goalies),
      fetchGoaliesCsv(),
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
  const injuries = parseInjuries(injuriesHtml);

  const snapshot = {
    fetched_at: new Date().toISOString(),
    teams,
    goalies,
    rotowire_goalies: rotowireGoalies || {},
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

  const snapshot = await fetchMoneyPuckSnapshot(options);
  const homeTeam = canonicalizeTeamName(oddsSnapshot.home_team);
  const awayTeam = canonicalizeTeamName(oddsSnapshot.away_team);

  const homeStats = snapshot.teams?.[homeTeam] || {};
  const awayStats = snapshot.teams?.[awayTeam] || {};
  const homeGoalie = snapshot.goalies?.[homeTeam] || {};
  const awayGoalie = snapshot.goalies?.[awayTeam] || {};
  const homeRotowireGoalie = snapshot.rotowire_goalies?.[homeTeam] || {};
  const awayRotowireGoalie = snapshot.rotowire_goalies?.[awayTeam] || {};
  const homeInjuries = snapshot.injuries?.[homeTeam] || [];
  const awayInjuries = snapshot.injuries?.[awayTeam] || [];

  const homeGoalieStatus =
    homeRotowireGoalie.status ??
    normalizeRotowireGoalieStatus(rawData.goalie?.home?.status) ??
    normalizeRotowireGoalieStatus(rawData.goalie_home_status) ??
    null;
  const awayGoalieStatus =
    awayRotowireGoalie.status ??
    normalizeRotowireGoalieStatus(rawData.goalie?.away?.status) ??
    normalizeRotowireGoalieStatus(rawData.goalie_away_status) ??
    null;

  const homeGoalieName =
    homeRotowireGoalie.name ?? rawData.goalie?.home?.name ?? null;
  const awayGoalieName =
    awayRotowireGoalie.name ?? rawData.goalie?.away?.name ?? null;

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
      },
      away: {
        ...(rawData.goalie?.away || {}),
        gsax: awayGoalie.gsax ?? rawData.goalie?.away?.gsax ?? null,
        name: awayGoalieName,
        status: awayGoalieStatus,
      },
    },
    goalie_home_gsax: homeGoalie.gsax ?? rawData.goalie_home_gsax ?? null,
    goalie_away_gsax: awayGoalie.gsax ?? rawData.goalie_away_gsax ?? null,
    goalie_home_status: homeGoalieStatus,
    goalie_away_status: awayGoalieStatus,
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
  enrichOddsSnapshotWithMoneyPuck,
};
