'use strict';

/**
 * ingest_nst_pp_rates.js
 *
 * Ingests Natural Stat Trick (NST) PP shot rate data from a CSV export into
 * the player_pp_rates table. Derives pp_shots_per60 from SOG / PPTOI * 60.
 *
 * Usage:
 *   node ingest_nst_pp_rates.js --file path/to/nst.csv [--season 20242025]
 *
 * CSV expected columns (at minimum):
 *   Player, PlayerID, Team, GP, PPTOI (minutes), SOG (PP shots on goal)
 *
 * NST PlayerID is a numeric string matching NHL API player_id for skaters.
 * No NHL API ID translation required.
 */

const fs = require('fs');
const path = require('path');
const { getDatabase } = require('@cheddar-logic/data');

/**
 * Parse a minimal CSV string into an array of row objects keyed by header.
 * Handles quoted fields with commas inside.
 */
function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Parse header row — use simple split (NST headers don't contain commas inside quotes)
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    // Split respecting quoted fields
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < rawLine.length; j++) {
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
    headers.forEach((h, idx) => {
      row[h] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Ingest NST PP rate CSV into player_pp_rates table.
 *
 * @param {object} options
 * @param {string} options.filePath  - Absolute path to NST CSV file
 * @param {string} [options.season]  - Season string e.g. '20242025'
 * @returns {{ inserted: number, skipped: number }}
 */
function ingestNstPpRates({ filePath, season } = {}) {
  const resolvedSeason = season || process.env.NHL_CURRENT_SEASON || '20242025';

  if (!filePath) {
    throw new Error('ingestNstPpRates: --file argument is required');
  }

  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`ingestNstPpRates: file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf8');
  const rows = parseCsv(content);

  if (rows.length === 0) {
    console.log('[ingest_nst_pp_rates] No data rows found in CSV');
    return { inserted: 0, skipped: 0 };
  }

  const db = getDatabase();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO player_pp_rates
      (nhl_player_id, player_name, team, season, pp_shots_per60, pp_toi_per60, source, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, 'nst', datetime('now'))
  `);

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const playerId = (row['PlayerID'] || row['Player Id'] || row['player_id'] || '').trim();
    const playerName = (row['Player'] || row['player_name'] || '').trim();
    const team = (row['Team'] || row['team'] || '').trim();
    const ppToiRaw = row['PPTOI'] || row['PP TOI'] || row['pptoi'] || '';
    const sogRaw = row['SOG'] || row['PP SOG'] || row['pp_sog'] || row['Shots'] || '';

    const ppToi = parseFloat(ppToiRaw);
    const sog = parseFloat(sogRaw);

    if (!playerId) {
      console.debug(`[ingest_nst_pp_rates] Skipping row with no PlayerID: ${JSON.stringify(row)}`);
      skipped += 1;
      continue;
    }

    if (!Number.isFinite(ppToi) || ppToi <= 0) {
      console.debug(
        `[ingest_nst_pp_rates] Skipping ${playerName} (${playerId}): PPTOI=${ppToiRaw} (zero or invalid — non-PP player)`,
      );
      skipped += 1;
      continue;
    }

    if (!Number.isFinite(sog)) {
      console.debug(
        `[ingest_nst_pp_rates] Skipping ${playerName} (${playerId}): SOG=${sogRaw} (invalid)`,
      );
      skipped += 1;
      continue;
    }

    const ppShotsPer60 = (sog / ppToi) * 60;
    const ppToiPer60 = ppToi; // stored as raw minutes (per-game avg from NST)

    upsert.run(playerId, playerName, team, resolvedSeason, ppShotsPer60, ppToiPer60);
    inserted += 1;
  }

  console.log(
    `[ingest_nst_pp_rates] Done. Season=${resolvedSeason}. Inserted/updated: ${inserted}, Skipped: ${skipped}`,
  );

  return { inserted, skipped };
}

function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let season = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      filePath = args[i + 1];
      i += 1;
    } else if (args[i] === '--season' && args[i + 1]) {
      season = args[i + 1];
      i += 1;
    }
  }

  if (!filePath) {
    console.error('[ingest_nst_pp_rates] Usage: node ingest_nst_pp_rates.js --file path/to/nst.csv [--season 20242025]');
    process.exit(1);
  }

  try {
    const result = ingestNstPpRates({ filePath, season });
    console.log(`[ingest_nst_pp_rates] Result: ${JSON.stringify(result)}`);
    process.exit(0);
  } catch (err) {
    console.error(`[ingest_nst_pp_rates] Fatal: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { ingestNstPpRates, parseCsv };
