'use strict';

const { upsertPlayerBlkRates } = require('@cheddar-logic/data');
const { deriveNhlSeasonKey } = require('./pull_moneypuck_blk_rates');

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((header) => header.trim().replace(/^"|"$/g, ''));
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < rawLine.length; j += 1) {
      const ch = rawLine[j];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }

    values.push(current.trim());
    if (values.length < headers.length) continue;

    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] !== undefined ? values[index] : '';
    });
    rows.push(row);
  }

  return rows;
}

function getFirstValue(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function toRatePer60(countRaw, toiRaw) {
  const count = Number.parseFloat(countRaw);
  const toi = Number.parseFloat(toiRaw);
  if (!Number.isFinite(count) || !Number.isFinite(toi) || toi <= 0) return null;
  return (count / toi) * 60;
}

function normalizeSplitRows(rows = []) {
  const normalized = new Map();

  for (const row of rows) {
    const playerId = getFirstValue(row, ['PlayerID', 'Player Id', 'player_id']);
    if (!playerId) continue;

    const playerName = getFirstValue(row, ['Player', 'player_name']);
    const team = getFirstValue(row, ['Team', 'team']);

    const evRate = toRatePer60(
      getFirstValue(row, ['EV BLK', 'EVBLK', 'EV Blocks', 'EV_BLOCKS']),
      getFirstValue(row, ['EV TOI', 'EVTOI', 'EV_TOI']),
    );
    const pkRate = toRatePer60(
      getFirstValue(row, ['PK BLK', 'PKBLK', 'PK Blocks', 'PK_BLOCKS']),
      getFirstValue(row, ['PK TOI', 'PKTOI', 'PK_TOI']),
    );
    const pkToiPerGame = (() => {
      const value = Number.parseFloat(
        getFirstValue(row, ['PK TOI', 'PKTOI', 'PK_TOI']),
      );
      return Number.isFinite(value) && value > 0 ? value : null;
    })();

    normalized.set(playerId, {
      nhlPlayerId: playerId,
      playerName: playerName || null,
      team: team || null,
      evRate,
      pkRate,
      pkToiPerGame,
    });
  }

  return normalized;
}

async function fetchCsv(url, fetchImpl = fetch) {
  if (!url) {
    throw new Error('fetchCsv requires a URL');
  }
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    throw new Error(`NST fetch failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function ingestNstBlkRates({
  season = process.env.NHL_CURRENT_SEASON || deriveNhlSeasonKey(),
  seasonUrl = process.env.NHL_BLK_NST_SEASON_CSV_URL,
  l10Url = process.env.NHL_BLK_NST_L10_CSV_URL,
  l5Url = process.env.NHL_BLK_NST_L5_CSV_URL,
  fetchImpl = fetch,
} = {}) {
  if (!seasonUrl || !l10Url || !l5Url) {
    console.warn('[ingest_nst_blk_rates] WARN: NHL_BLK_NST_SEASON_CSV_URL / L10 / L5 not set — skipping ingest. Set env vars to enable automated block-rate refresh.');
    return { inserted: 0, skipped: 0, error: 'missing_urls' };
  }

  const [seasonCsv, l10Csv, l5Csv] = await Promise.all([
    fetchCsv(seasonUrl, fetchImpl),
    fetchCsv(l10Url, fetchImpl),
    fetchCsv(l5Url, fetchImpl),
  ]);

  const seasonRows = normalizeSplitRows(parseCsv(seasonCsv));
  const l10Rows = normalizeSplitRows(parseCsv(l10Csv));
  const l5Rows = normalizeSplitRows(parseCsv(l5Csv));

  const allPlayerIds = new Set([
    ...seasonRows.keys(),
    ...l10Rows.keys(),
    ...l5Rows.keys(),
  ]);

  let inserted = 0;
  for (const playerId of allPlayerIds) {
    const seasonRow = seasonRows.get(playerId) || {};
    const l10Row = l10Rows.get(playerId) || {};
    const l5Row = l5Rows.get(playerId) || {};

    upsertPlayerBlkRates({
      nhlPlayerId: playerId,
      playerName: seasonRow.playerName || l10Row.playerName || l5Row.playerName || null,
      team: seasonRow.team || l10Row.team || l5Row.team || null,
      season,
      evBlocksSeasonPer60: seasonRow.evRate ?? null,
      evBlocksL10Per60: l10Row.evRate ?? null,
      evBlocksL5Per60: l5Row.evRate ?? null,
      pkBlocksSeasonPer60: seasonRow.pkRate ?? null,
      pkBlocksL10Per60: l10Row.pkRate ?? null,
      pkBlocksL5Per60: l5Row.pkRate ?? null,
      pkToiPerGame:
        seasonRow.pkToiPerGame ?? l10Row.pkToiPerGame ?? l5Row.pkToiPerGame ?? null,
      source: 'nst',
    });
    inserted += 1;
  }

  return { inserted, skipped: 0 };
}

if (require.main === module) {
  ingestNstBlkRates()
    .then((result) => {
      console.log(`[ingest_nst_blk_rates] Result: ${JSON.stringify(result)}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[ingest_nst_blk_rates] Fatal: ${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  ingestNstBlkRates,
  parseCsv,
  normalizeSplitRows,
  fetchCsv,
};
