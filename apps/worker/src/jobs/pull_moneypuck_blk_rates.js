'use strict';

/**
 * pull_moneypuck_blk_rates — MoneyPuck season-summary BLK rates ingest.
 *
 * Fetches the current-season MoneyPuck skaters season summary CSV, extracts
 * per-situation (EV = 5on5, PK = 4on5) blocked-shot counts and ice time, and
 * upserts into player_blk_rates.  L10/L5 rolling-window rates are computed
 * directly from player_blk_logs already in the DB.
 *
 * This job is an automated alternative / supplement to pull_nst_blk_rates
 * that requires no env-var configuration — the CSV URL is derived from the
 * calendar date.
 *
 * MoneyPuck URL pattern (confirmed from data.htm directory listing):
 *   https://moneypuck.com/moneypuck/playerData/seasonSummary/{startYear}/regular/skaters.csv
 *   Updated nightly.  startYear = season-start calendar year (e.g. 2025 for 2025-26).
 *
 * Blocked-shot column aliases (defensive blocks by the player):
 *   MoneyPuck normalises CSV headers to camelCase; we try multiple potential
 *   names and fall back to DB-aggregated totals from player_blk_logs when none
 *   are found.  EV/PK TOI proportions from the CSV are preserved in both paths.
 *
 * Scheduled weekly (Monday 09:00 ET) in schedulers/player-props.js.
 */

require('dotenv').config();

const https = require('https');
const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertPlayerBlkRates,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const JOB_NAME = 'pull_moneypuck_blk_rates';

// ─── Season helpers ────────────────────────────────────────────────────────────

/**
 * Derive the MoneyPuck season start year.
 * NHL season starts in October; MoneyPuck rolls over in September.
 * Matches buildSkaterCsvCandidates logic in moneypuck.js.
 *
 * @param {Date} [now]
 * @returns {number}  e.g. 2025 for the 2025-26 season
 */
function deriveSeasonStartYear(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based; Sep = 8
  return month >= 8 ? year : year - 1;
}

/**
 * Derive the NHL season key used in player_blk_rates (e.g. "20252026").
 *
 * @param {Date} [now]
 * @returns {string}
 */
function deriveNhlSeasonKey(now = new Date()) {
  const start = deriveSeasonStartYear(now);
  return `${start}${start + 1}`;
}

/**
 * Build the MoneyPuck season-summary skaters CSV URL for a given start year.
 *
 * @param {number} startYear
 * @returns {string}
 */
function buildMoneyPuckSkatersCsvUrl(startYear) {
  return `https://moneypuck.com/moneypuck/playerData/seasonSummary/${startYear}/regular/skaters.csv`;
}

// ─── HTTP fetch ────────────────────────────────────────────────────────────────

/**
 * Minimal HTTPS GET returning full response body.
 * Mirrors fetchUrl in moneypuck.js (not exported there).
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/csv,text/plain,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: 'https://moneypuck.com/data.htm',
        Origin: 'https://moneypuck.com',
      },
    };
    https
      .get(url, options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `MoneyPuck CSV fetch failed (${res.statusCode}) for ${url}`,
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

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of objects with lower-cased header keys.
 * Handles quoted fields with embedded commas.
 *
 * @param {string} csvText
 * @returns {Array<Record<string,string>>}
 */
function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // MoneyPuck uses camelCase headers — normalise to lowercase for case-insensitive lookup
  const headers = lines[0]
    .split(',')
    .map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const ch of raw) {
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
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Return the first non-empty value from a row using a list of lowercase aliases.
 *
 * @param {Record<string,string>} row
 * @param {string[]} aliases — already lower-cased
 * @returns {string|null}
 */
function getCol(row, aliases) {
  for (const alias of aliases) {
    const v = row[alias];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return null;
}

function toFloat(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function ratePer60(count, icetimeSeconds) {
  if (
    !Number.isFinite(count) ||
    !Number.isFinite(icetimeSeconds) ||
    icetimeSeconds <= 0
  ) {
    return null;
  }
  const toiMinutes = icetimeSeconds / 60;
  return (count / toiMinutes) * 60;
}

// Potential column names for "shots physically blocked by this defender".
// MoneyPuck CSV headers are camelCase; all candidates are pre-lowercased for getCol.
const BLK_BLOCKED_ALIASES = [
  'shotsblockedbyplayer',
  'i_f_shotsblocked',
  'shotsblocked',
  'i_f_blocked',
  'i_f_blockedshots',
  'blocked',
  'blockedshots',
];

/**
 * Parse the MoneyPuck skaters CSV into a per-player map, aggregating EV (5on5)
 * and PK (4on5) rows.
 *
 * @param {string} csvText
 * @returns {{ playerMap: Map<string, object>, blkColumnFound: boolean }}
 *
 * playerMap entry shape:
 *   {
 *     name: string|null,
 *     team: string|null,
 *     gamesPlayed: number|null,
 *     ev: { blk: number|null, icetimeSeconds: number|null },
 *     pk: { blk: number|null, icetimeSeconds: number|null },
 *   }
 */
function parseSkatersBySituation(csvText) {
  const rows = parseCsv(csvText);
  let blkColumnFound = false;
  const playerMap = new Map();

  for (const row of rows) {
    const situation = (row['situation'] || '').trim().toLowerCase();
    if (situation !== '5on5' && situation !== '4on5') continue;

    const playerId = getCol(row, ['playerid', 'player_id', 'id']);
    if (!playerId) continue;

    const icetimeRaw = getCol(row, ['icetime']);
    const gamesPlayedRaw = getCol(row, ['games_played', 'gamesplayed']);
    const blkRaw = getCol(row, BLK_BLOCKED_ALIASES);

    if (blkRaw !== null) blkColumnFound = true;

    const icetimeSeconds = toFloat(icetimeRaw);
    const gamesPlayed = toFloat(gamesPlayedRaw);
    const blk = toFloat(blkRaw);

    if (!playerMap.has(playerId)) {
      playerMap.set(playerId, {
        name: getCol(row, ['name', 'player_name', 'playername']) || null,
        team: (row['team'] || '').trim() || null,
        gamesPlayed,
        ev: { blk: null, icetimeSeconds: null },
        pk: { blk: null, icetimeSeconds: null },
      });
    } else {
      const entry = playerMap.get(playerId);
      if (!entry.gamesPlayed && gamesPlayed) entry.gamesPlayed = gamesPlayed;
    }

    const entry = playerMap.get(playerId);
    if (situation === '5on5') {
      entry.ev = { blk, icetimeSeconds };
    } else {
      entry.pk = { blk, icetimeSeconds };
    }
  }

  return { playerMap, blkColumnFound };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Aggregate the last N games from player_blk_logs for one player.
 * Returns blocks-per-60 minutes (all-situation) or null if insufficient data.
 *
 * @param {object} db
 * @param {string} playerId
 * @param {number} nWindow
 * @returns {number|null}
 */
function computeLogRate(db, playerId, nWindow) {
  const rows = db
    .prepare(
      `SELECT blocked_shots, toi_minutes
       FROM player_blk_logs
       WHERE player_id = ? AND toi_minutes > 0
       ORDER BY game_date DESC
       LIMIT ?`,
    )
    .all(String(playerId), nWindow);

  if (!rows || rows.length === 0) return null;

  const totalBlocks = rows.reduce((s, r) => s + (r.blocked_shots || 0), 0);
  const totalToi = rows.reduce((s, r) => s + (r.toi_minutes || 0), 0);
  if (!totalToi || totalToi <= 0) return null;

  return (totalBlocks / totalToi) * 60;
}

/**
 * Season-aggregate blocks-per-60 from player_blk_logs (all situations).
 * Used as a fallback when the MoneyPuck CSV does not include a recognised
 * individual-blocks column.
 *
 * @param {object} db
 * @param {string} playerId
 * @returns {number|null}
 */
function computeSeasonLogRate(db, playerId) {
  const row = db
    .prepare(
      `SELECT SUM(blocked_shots) AS total_blk, SUM(toi_minutes) AS total_toi
       FROM player_blk_logs
       WHERE player_id = ? AND toi_minutes > 0`,
    )
    .get(String(playerId));

  if (!row || !row.total_toi || row.total_toi <= 0) return null;
  return ((row.total_blk || 0) / row.total_toi) * 60;
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

/**
 * Fetch and parse the MoneyPuck season summary CSV.
 * Exposed for unit testing — does not touch the DB.
 *
 * @param {object} [opts]
 * @param {number} [opts.startYear]   override detected season start year
 * @param {Date}   [opts.now]
 * @returns {Promise<{playerMap: Map, blkColumnFound: boolean, resolvedSeason: string, csvUrl: string}>}
 */
async function ingestMoneyPuckBlkRates({ startYear = null, now = new Date() } = {}) {
  const resolvedStartYear = startYear ?? deriveSeasonStartYear(now);
  const resolvedSeason = process.env.NHL_CURRENT_SEASON || deriveNhlSeasonKey(now);
  const csvUrl = buildMoneyPuckSkatersCsvUrl(resolvedStartYear);

  console.log(`[${JOB_NAME}] Fetching ${csvUrl}`);
  const csvText = await fetchUrl(csvUrl);

  if (!csvText || csvText.length < 100) {
    throw new Error(
      `MoneyPuck skaters CSV appears empty or missing (${csvText?.length ?? 0} bytes) — ${csvUrl}`,
    );
  }
  const bodyPreview = csvText.slice(0, 2000).toLowerCase();
  if (bodyPreview.includes('just a moment') || bodyPreview.includes('cf_chl')) {
    throw new Error(
      'MoneyPuck returned a Cloudflare challenge page — CSV temporarily unavailable',
    );
  }

  const { playerMap, blkColumnFound } = parseSkatersBySituation(csvText);

  if (!blkColumnFound) {
    console.warn(
      `[${JOB_NAME}] WARN: no recognised individual-blocks column found in MoneyPuck CSV ` +
        `(tried: ${BLK_BLOCKED_ALIASES.join(', ')}). ` +
        `Season-level rates will fall back to player_blk_logs DB aggregation; ` +
        `EV/PK split uses TOI proportions from the CSV.`,
    );
  }

  console.log(
    `[${JOB_NAME}] Parsed ${playerMap.size} players ` +
      `(season=${resolvedStartYear}, blkColumnFound=${blkColumnFound})`,
  );

  return { playerMap, blkColumnFound, resolvedSeason, csvUrl };
}

// ─── Main job ─────────────────────────────────────────────────────────────────

/**
 * Automated MoneyPuck BLK rates ingest job.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.jobKey]  scheduler-supplied idempotency key
 * @param {boolean} [opts.dryRun] if true, skip network fetch and DB writes
 * @returns {Promise<{success: boolean, inserted?: number, blkColumnFound?: boolean, error?: string}>}
 */
async function pullMoneyPuckBlkRates({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDbSafe(async (db) => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] Skipping — already ran for key ${jobKey}`);
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[${JOB_NAME}] DRY_RUN — would fetch MoneyPuck BLK season summary CSV`);
      return { success: true, dryRun: true };
    }

    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      const { playerMap, blkColumnFound, resolvedSeason } = await ingestMoneyPuckBlkRates();

      let inserted = 0;

      for (const [playerId, entry] of playerMap) {
        const evIce = entry.ev.icetimeSeconds;
        const pkIce = entry.pk.icetimeSeconds;
        const { gamesPlayed } = entry;

        // ── Season rates ─────────────────────────────────────────────────
        // Primary: MoneyPuck per-situation blocks / TOI.
        // Fallback (blkColumnFound=false): DB season aggregation split by
        // EV/PK TOI proportion from the CSV.
        let evSeasonRate = null;
        let pkSeasonRate = null;

        if (blkColumnFound) {
          evSeasonRate = ratePer60(entry.ev.blk, evIce);
          pkSeasonRate = ratePer60(entry.pk.blk, pkIce);
        } else {
          const dbSeasonRate = computeSeasonLogRate(db, playerId);
          if (
            dbSeasonRate !== null &&
            Number.isFinite(evIce) &&
            Number.isFinite(pkIce) &&
            evIce + pkIce > 0
          ) {
            const totalTrackedIce = evIce + pkIce;
            evSeasonRate = dbSeasonRate * (evIce / totalTrackedIce);
            pkSeasonRate = dbSeasonRate * (pkIce / totalTrackedIce);
          } else {
            evSeasonRate = dbSeasonRate; // total rate; PK unknown
            pkSeasonRate = null;
          }
        }

        // ── Rolling-window rates from player_blk_logs ───────────────────
        // player_blk_logs carries no per-situation split, so L10/L5 rates
        // are all-situation totals used as a proxy for both ev_* and pk_*
        // rolling columns — acknowledged approximation for V1.
        const l10Rate = computeLogRate(db, playerId, 10);
        const l5Rate = computeLogRate(db, playerId, 5);

        // ── PK TOI per game ─────────────────────────────────────────────
        const pkToiPerGame =
          Number.isFinite(pkIce) && Number.isFinite(gamesPlayed) && gamesPlayed > 0
            ? pkIce / 60 / gamesPlayed
            : null;

        upsertPlayerBlkRates({
          nhlPlayerId: playerId,
          playerName: entry.name || null,
          team: entry.team || null,
          season: resolvedSeason,
          evBlocksSeasonPer60: evSeasonRate,
          evBlocksL10Per60: l10Rate,
          evBlocksL5Per60: l5Rate,
          pkBlocksSeasonPer60: pkSeasonRate,
          pkBlocksL10Per60: l10Rate,
          pkBlocksL5Per60: l5Rate,
          pkToiPerGame,
          source: 'moneypuck',
        });

        inserted += 1;
      }

      console.log(
        `[${JOB_NAME}] Upserted ${inserted} players ` +
          `(season=${resolvedSeason}, blkColumnFound=${blkColumnFound})`,
      );

      markJobRunSuccess(jobRunId);
      return { success: true, jobRunId, inserted, blkColumnFound };
    } catch (err) {
      console.error(`[${JOB_NAME}] Failed: ${err.message}`);
      try {
        markJobRunFailure(jobRunId, err.message);
      } catch (_dbErr) {
        // ignore secondary failure
      }
      return { success: false, error: err.message };
    }
  });
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (require.main === module) {
  pullMoneyPuckBlkRates()
    .then((result) => {
      console.log(`[${JOB_NAME}] Result: ${JSON.stringify(result)}`);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(`[${JOB_NAME}] Fatal: ${err.message}`);
      process.exit(1);
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  pullMoneyPuckBlkRates,
  ingestMoneyPuckBlkRates,
  parseSkatersBySituation,
  computeLogRate,
  computeSeasonLogRate,
  deriveSeasonStartYear,
  deriveNhlSeasonKey,
  buildMoneyPuckSkatersCsvUrl,
};
