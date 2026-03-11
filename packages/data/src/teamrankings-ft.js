'use strict';

const fs = require('fs');
const path = require('path');
const { resolveTeamVariant } = require('./normalize');

const DEFAULT_CSV_PATH = path.resolve(
  __dirname,
  '../../../data/input/teamrankings_ncaam_ft_pct.csv',
);
const DEFAULT_MAX_AGE_HOURS = 72;

const cacheState = {
  filePath: null,
  mtimeMs: null,
  loadedAt: null,
  maxSourceUpdatedAt: null,
  isStale: false,
  staleReason: null,
  rowsByNormalizedName: new Map(),
  rowsByLooseKey: new Map(),
  rows: [],
  error: null,
};

const warnedMessages = new Set();

function warnOnce(code, details) {
  const key = `${code}:${details}`;
  if (warnedMessages.has(key)) return;
  warnedMessages.add(key);
  console.warn(`[TeamRankingsFT][${code}] ${details}`);
}

function normalizeTeamKey(teamName) {
  const normalized = String(teamName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[.'\u2019]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const tokens = normalized.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'st' && i > 0) tokens[i] = 'state';
  }
  return tokens.join(' ');
}

function normalizeTeamKeyLoose(teamName) {
  const normalized = normalizeTeamKey(teamName);
  if (!normalized) return '';

  const tokenMap = {
    state: 'st',
    saint: 'st',
    northern: 'n',
    north: 'n',
    southern: 's',
    south: 's',
    eastern: 'e',
    east: 'e',
    western: 'w',
    west: 'w',
    central: 'c',
  };

  return normalized
    .split(' ')
    .filter(Boolean)
    .map((token) => tokenMap[token] || token)
    .join(' ');
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

function parseIso(value) {
  const iso = String(value || '').trim();
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

function resolveCsvPath() {
  const configured = String(process.env.TEAMRANKINGS_NCAAM_FT_CSV_PATH || '')
    .trim();
  if (!configured) return DEFAULT_CSV_PATH;
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function parseCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new Error('csv_empty');
  }

  const header = parseCsvLine(lines[0]).map((col) => col.toLowerCase());
  const idxTeam = header.indexOf('team_name');
  const idxFt = header.indexOf('ft_pct');
  const idxSeason = header.indexOf('season');
  const idxUpdated = header.indexOf('source_updated_at');

  if ([idxTeam, idxFt, idxSeason, idxUpdated].some((idx) => idx === -1)) {
    throw new Error(
      'csv_missing_required_columns(team_name,ft_pct,season,source_updated_at)',
    );
  }

  const rowsByNormalizedName = new Map();
  const rowsByLooseKey = new Map();
  const rows = [];
  let maxSourceUpdatedAt = null;
  const duplicateNames = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const teamName = String(cols[idxTeam] || '').trim();
    const ftRaw = String(cols[idxFt] || '').trim();
    const season = String(cols[idxSeason] || '').trim();
    const sourceUpdatedAt = parseIso(cols[idxUpdated]);

    if (!teamName) {
      throw new Error(`csv_invalid_team_name_at_line_${i + 1}`);
    }

    const ftPct = Number(ftRaw);
    if (!Number.isFinite(ftPct) || ftPct < 0 || ftPct > 100) {
      throw new Error(`csv_invalid_ft_pct_at_line_${i + 1}`);
    }

    const normalized = normalizeTeamKey(teamName);
    if (!normalized) {
      throw new Error(`csv_invalid_team_name_at_line_${i + 1}`);
    }
    if (rowsByNormalizedName.has(normalized)) {
      duplicateNames.push(teamName);
      continue;
    }

    const looseKey = normalizeTeamKeyLoose(teamName);
    const row = {
      teamName,
      ftPct,
      season: season || null,
      sourceUpdatedAt,
      normalizedKey: normalized,
      looseKey,
    };

    rowsByNormalizedName.set(normalized, row);
    rows.push(row);

    if (!rowsByLooseKey.has(looseKey)) {
      rowsByLooseKey.set(looseKey, []);
    }
    rowsByLooseKey.get(looseKey).push(row);

    if (sourceUpdatedAt && (!maxSourceUpdatedAt || sourceUpdatedAt > maxSourceUpdatedAt)) {
      maxSourceUpdatedAt = sourceUpdatedAt;
    }
  }

  if (duplicateNames.length > 0) {
    throw new Error(
      `csv_duplicate_team_name_normalized(${duplicateNames.join(',')})`,
    );
  }

  return {
    rowsByNormalizedName,
    rowsByLooseKey,
    rows,
    maxSourceUpdatedAt,
  };
}

function scoreKeyMatch(candidateKey, rowKey) {
  if (!candidateKey || !rowKey) return -1;
  const rowTokens = rowKey.split(' ').filter(Boolean).length;
  const candidateTokens = candidateKey.split(' ').filter(Boolean).length;
  if (candidateKey === rowKey) return 1000 + rowTokens * 50 + rowKey.length;
  if (candidateKey.startsWith(`${rowKey} `)) {
    return 500 + rowTokens * 50 + rowKey.length;
  }
  if (rowKey.startsWith(`${candidateKey} `)) {
    return 250 + candidateTokens * 50 + candidateKey.length;
  }
  return -1;
}

function resolveRowByCandidateNames(dataset, candidateNames) {
  const candidateKeys = new Set();

  for (const name of candidateNames) {
    const strictKey = normalizeTeamKey(name);
    if (strictKey) candidateKeys.add(strictKey);

    const looseKey = normalizeTeamKeyLoose(name);
    if (looseKey) candidateKeys.add(looseKey);
  }

  if (candidateKeys.size === 0) return null;

  // Exact strict-key match
  for (const key of candidateKeys) {
    const row = dataset.rowsByNormalizedName.get(key);
    if (row) return row;
  }

  // Exact loose-key match
  for (const key of candidateKeys) {
    const rowsForLooseKey = dataset.rowsByLooseKey.get(key);
    if (Array.isArray(rowsForLooseKey) && rowsForLooseKey.length > 0) {
      rowsForLooseKey.sort((a, b) => b.normalizedKey.length - a.normalizedKey.length);
      return rowsForLooseKey[0];
    }
  }

  // Fuzzy prefix match (best specificity wins)
  let bestMatch = null;
  for (const row of dataset.rows) {
    for (const candidateKey of candidateKeys) {
      const score = Math.max(
        scoreKeyMatch(candidateKey, row.normalizedKey),
        scoreKeyMatch(candidateKey, row.looseKey),
      );
      if (score < 0) continue;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { row, score };
      }
    }
  }

  return bestMatch ? bestMatch.row : null;
}

function computeStaleness(maxSourceUpdatedAt, fileStat) {
  const maxAgeHours = Number.isFinite(
    Number(process.env.TEAMRANKINGS_NCAAM_FT_MAX_AGE_HOURS),
  )
    ? Number(process.env.TEAMRANKINGS_NCAAM_FT_MAX_AGE_HOURS)
    : DEFAULT_MAX_AGE_HOURS;

  const freshnessIso =
    maxSourceUpdatedAt || new Date(fileStat.mtimeMs).toISOString();
  const freshnessMs = Date.parse(freshnessIso);
  if (Number.isNaN(freshnessMs)) {
    return {
      isStale: true,
      staleReason: 'invalid_source_updated_at',
    };
  }

  const ageHours = (Date.now() - freshnessMs) / (60 * 60 * 1000);
  if (ageHours > maxAgeHours) {
    return {
      isStale: true,
      staleReason: `source_data_too_old(${ageHours.toFixed(1)}h>${maxAgeHours}h)`,
    };
  }

  return {
    isStale: false,
    staleReason: null,
  };
}

function loadDatasetIfNeeded() {
  const filePath = resolveCsvPath();
  const previousPath = cacheState.filePath;
  cacheState.filePath = filePath;

  if (!fs.existsSync(filePath)) {
    cacheState.error = 'csv_missing';
    cacheState.rowsByNormalizedName = new Map();
    cacheState.rowsByLooseKey = new Map();
    cacheState.rows = [];
    cacheState.maxSourceUpdatedAt = null;
    cacheState.isStale = true;
    cacheState.staleReason = 'csv_missing';
    warnOnce('CSV_MISSING', `path=${filePath}`);
    return cacheState;
  }

  const fileStat = fs.statSync(filePath);
  const sameFile = previousPath === filePath;
  const unchanged = sameFile && cacheState.mtimeMs === fileStat.mtimeMs;
  if (unchanged && cacheState.loadedAt) return cacheState;

  try {
    const parsed = parseCsvFile(filePath);
    const staleness = computeStaleness(parsed.maxSourceUpdatedAt, fileStat);

    cacheState.mtimeMs = fileStat.mtimeMs;
    cacheState.loadedAt = new Date().toISOString();
    cacheState.maxSourceUpdatedAt = parsed.maxSourceUpdatedAt;
    cacheState.rowsByNormalizedName = parsed.rowsByNormalizedName;
    cacheState.rowsByLooseKey = parsed.rowsByLooseKey;
    cacheState.rows = parsed.rows;
    cacheState.isStale = staleness.isStale;
    cacheState.staleReason = staleness.staleReason;
    cacheState.error = null;

    if (cacheState.isStale) {
      warnOnce(
        'CSV_STALE',
        `path=${filePath} reason=${cacheState.staleReason}`,
      );
    }
  } catch (error) {
    cacheState.mtimeMs = fileStat.mtimeMs;
    cacheState.loadedAt = new Date().toISOString();
    cacheState.maxSourceUpdatedAt = null;
    cacheState.rowsByNormalizedName = new Map();
    cacheState.rowsByLooseKey = new Map();
    cacheState.rows = [];
    cacheState.isStale = true;
    cacheState.staleReason = 'csv_invalid';
    cacheState.error = error.message;
    warnOnce('CSV_INVALID', `path=${filePath} error=${error.message}`);
  }

  return cacheState;
}

/**
 * Look up FT% for a team from TeamRankings CSV fallback.
 * Returns null if file missing, stale, invalid, or team not found.
 *
 * @param {string} teamName
 * @returns {{freeThrowPct:number, source:string, season:string|null, sourceUpdatedAt:string|null}|null}
 */
function lookupTeamRankingsFreeThrowPct(teamName) {
  const dataset = loadDatasetIfNeeded();
  if (dataset.error || dataset.isStale) return null;
  if (!teamName) return null;

  const variant = resolveTeamVariant(teamName, 'teamrankings-ft');
  const candidateNames = [teamName];
  if (
    variant?.matched &&
    variant.canonical &&
    variant.canonical.toLowerCase() !== String(teamName).toLowerCase()
  ) {
    candidateNames.push(variant.canonical);
  }

  const row = resolveRowByCandidateNames(dataset, candidateNames);
  if (!row) return null;

  return {
    freeThrowPct: row.ftPct,
    source: 'teamrankings_csv',
    season: row.season,
    sourceUpdatedAt: row.sourceUpdatedAt,
  };
}

function getTeamRankingsFtDatasetStatus() {
  const dataset = loadDatasetIfNeeded();
  return {
    filePath: dataset.filePath,
    loadedAt: dataset.loadedAt,
    maxSourceUpdatedAt: dataset.maxSourceUpdatedAt,
    isStale: dataset.isStale,
    staleReason: dataset.staleReason,
    error: dataset.error,
    rows: dataset.rowsByNormalizedName.size,
  };
}

module.exports = {
  lookupTeamRankingsFreeThrowPct,
  getTeamRankingsFtDatasetStatus,
};
