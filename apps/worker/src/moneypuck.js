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
  power: 'https://moneypuck.com/power.htm'
};

const DEFAULT_CACHE_PATH = path.join(__dirname, '..', '..', '..', 'data', 'output', 'moneypuck-cache.json');
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
let memoryCache = null;

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
  'Utah Hockey Club'
];

const TEAM_ALIASES = {
  'montreal canadiens': 'Montreal Canadiens',
  'montreal': 'Montreal Canadiens',
  'st louis blues': 'St. Louis Blues',
  'st. louis blues': 'St. Louis Blues',
  'utah mammoth': 'Utah Hockey Club',
  'utah hc': 'Utah Hockey Club',
  'utah hockey club': 'Utah Hockey Club'
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'cheddar-logic/1.0 (+https://github.com/cheddar-logic)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    };
    https
      .get(url, options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`MoneyPuck request failed (${res.statusCode}) for ${url}`));
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
  const cleaned = String(value).replace(/[%\s,]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function tableHeaders($, $table) {
  const headers = [];
  $table.find('tr').first().find('th, td').each((_, cell) => {
    headers.push(normalizeHeader($(cell).text()));
  });
  return headers;
}

function tableRows($, $table) {
  const headers = tableHeaders($, $table);
  const rows = [];
  $table.find('tr').slice(1).each((_, row) => {
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
    const matches = headerCandidates.some((candidate) => headerSet.has(candidate));
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
      pk_pct: pk
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
      power_index: power
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
    const gsax = parseNumber(row['gsax'] ?? row['gsax/60'] ?? row['gsax (total)']);
    if (!teamName || gsax === null) return;
    const canonical = canonicalizeTeamName(teamName);
    if (!canonical) return;

    const existing = goaliesByTeam[canonical];
    if (!existing || gsax > existing.gsax) {
      goaliesByTeam[canonical] = {
        gsax,
        source: 'moneypuck'
      };
    }
  });
  return goaliesByTeam;
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
      detail: row.details || row.note || null
    });
  });
  return injuries;
}

function mergeTeamStats(base, updates) {
  const merged = { ...base };
  for (const [team, data] of Object.entries(updates || {})) {
    merged[team] = {
      ...(merged[team] || {}),
      ...data
    };
  }
  return merged;
}

async function fetchMoneyPuckSnapshot({ cachePath = DEFAULT_CACHE_PATH, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (memoryCache) {
    const cachedAt = new Date(memoryCache?.fetched_at || 0).getTime();
    if (cachedAt && Date.now() - cachedAt < ttlMs) {
      return memoryCache;
    }
  }

  if (cachePath) {
    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const cachedAt = new Date(cached?.fetched_at || 0).getTime();
        if (cachedAt && Date.now() - cachedAt < ttlMs) {
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
  let statsHtml;
  let injuriesHtml;
  let powerHtml;

  try {
    [teamsHtml, goaliesHtml, statsHtml, injuriesHtml, powerHtml] = await Promise.all([
      fetchUrl(MONEYPUCK_URLS.teams),
      fetchUrl(MONEYPUCK_URLS.goalies),
      fetchUrl(MONEYPUCK_URLS.stats),
      fetchUrl(MONEYPUCK_URLS.injuries),
      fetchUrl(MONEYPUCK_URLS.power)
    ]);
  } catch (err) {
    console.warn(`[MoneyPuck] Fetch failed: ${err.message}`);
    const fallback = {
      fetched_at: new Date().toISOString(),
      teams: {},
      goalies: {},
      injuries: {},
      error: err.message
    };
    memoryCache = fallback;
    return fallback;
  }

  const baseTeams = parseTeamStats(teamsHtml);
  const statsTeams = parseTeamStats(statsHtml);
  const powerTeams = parsePowerStats(powerHtml);

  const teams = mergeTeamStats(mergeTeamStats(baseTeams, statsTeams), powerTeams);
  const goalies = parseGoalies(goaliesHtml);
  const injuries = parseInjuries(injuriesHtml);

  const snapshot = {
    fetched_at: new Date().toISOString(),
    teams,
    goalies,
    injuries
  };

  memoryCache = snapshot;

  if (cachePath) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(snapshot, null, 2));
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
    ...payload
  };
  return merged;
}

async function enrichOddsSnapshotWithMoneyPuck(oddsSnapshot, options = {}) {
  if (!oddsSnapshot?.home_team || !oddsSnapshot?.away_team) return oddsSnapshot;

  let rawData = {};
  if (oddsSnapshot.raw_data) {
    try {
      rawData = typeof oddsSnapshot.raw_data === 'string'
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
  const homeInjuries = snapshot.injuries?.[homeTeam] || [];
  const awayInjuries = snapshot.injuries?.[awayTeam] || [];

  const enrichedRaw = {
    ...rawData,
    teams: {
      ...(rawData.teams || {}),
      home: {
        ...(rawData.teams?.home || {}),
        xgf_pct: homeStats.xgf_pct ?? rawData.teams?.home?.xgf_pct ?? null,
        pdo: homeStats.pdo ?? rawData.teams?.home?.pdo ?? null
      },
      away: {
        ...(rawData.teams?.away || {}),
        xgf_pct: awayStats.xgf_pct ?? rawData.teams?.away?.xgf_pct ?? null,
        pdo: awayStats.pdo ?? rawData.teams?.away?.pdo ?? null
      }
    },
    special_teams: {
      ...(rawData.special_teams || {}),
      home: {
        ...(rawData.special_teams?.home || {}),
        pp_pct: homeStats.pp_pct ?? rawData.special_teams?.home?.pp_pct ?? null,
        pk_pct: homeStats.pk_pct ?? rawData.special_teams?.home?.pk_pct ?? null
      },
      away: {
        ...(rawData.special_teams?.away || {}),
        pp_pct: awayStats.pp_pct ?? rawData.special_teams?.away?.pp_pct ?? null,
        pk_pct: awayStats.pk_pct ?? rawData.special_teams?.away?.pk_pct ?? null
      }
    },
    goalie: {
      ...(rawData.goalie || {}),
      home: {
        ...(rawData.goalie?.home || {}),
        gsax: homeGoalie.gsax ?? rawData.goalie?.home?.gsax ?? null
      },
      away: {
        ...(rawData.goalie?.away || {}),
        gsax: awayGoalie.gsax ?? rawData.goalie?.away?.gsax ?? null
      }
    },
    goalie_home_gsax: homeGoalie.gsax ?? rawData.goalie_home_gsax ?? null,
    goalie_away_gsax: awayGoalie.gsax ?? rawData.goalie_away_gsax ?? null,
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
      away: awayInjuries
    }
  };

  const enriched = {
    ...oddsSnapshot,
    raw_data: mergeRawData(enrichedRaw, {
      fetched_at: snapshot.fetched_at,
      source: 'moneypuck',
      team_keys: {
        home: homeTeam,
        away: awayTeam
      }
    })
  };

  if (typeof oddsSnapshot.raw_data === 'string') {
    enriched.raw_data = JSON.stringify(enriched.raw_data);
  }

  return enriched;
}

module.exports = {
  fetchMoneyPuckSnapshot,
  enrichOddsSnapshotWithMoneyPuck
};
