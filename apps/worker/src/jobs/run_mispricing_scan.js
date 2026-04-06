'use strict';

/**
 * run_mispricing_scan.js
 *
 * Worker job: load recent odds snapshots from DB, run the book-to-book
 * mispricing scanner, and log candidate counts grouped by sport + market type.
 *
 * Usage (standalone):
 *   node apps/worker/src/jobs/run_mispricing_scan.js
 *
 * Scheduler registration is intentionally deferred — see WI-0811 coordination flag.
 */

require('dotenv').config();
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local'), override: false });

const { getOddsSnapshots } = require('@cheddar-logic/data');
const { scanForMispricing } = require('../../../../packages/models/src/mispricing-scanner');

const DEFAULT_SPORTS          = ['NBA', 'NHL', 'MLB', 'NFL'];
const DEFAULT_RECENCY_MINUTES = 30;

/**
 * Run book-to-book mispricing scan across all sports.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.sports]           - Sports to scan (default: NBA/NHL/MLB/NFL)
 * @param {number}   [opts.recencyMinutes]   - Snapshot recency window in minutes (default: 30)
 * @param {number}   [opts.minBooks]         - Minimum comparison books (default: 2)
 * @returns {Promise<{candidates: import('../../../packages/models/src/mispricing-scanner').MispricingCandidate[], counts: object}>}
 */
async function runMispricingScan(opts = {}) {
  const sports          = opts.sports          || DEFAULT_SPORTS;
  const recencyMinutes  = opts.recencyMinutes  ?? DEFAULT_RECENCY_MINUTES;
  const minBooks        = opts.minBooks        ?? undefined; // scanner uses its own default

  try {
    const sinceUtc = new Date(Date.now() - recencyMinutes * 60 * 1000).toISOString();

    // Collect snapshots across all sports
    const allSnapshots = [];
    for (const sport of sports) {
      try {
        const rows = getOddsSnapshots(sport, sinceUtc);
        allSnapshots.push(...rows);
      } catch (sportErr) {
        console.warn(`[MispricingScan] WARN: failed to load snapshots for ${sport}: ${sportErr.message}`);
      }
    }

    // Run the scanner
    const scanConfig = { recencyWindowMs: recencyMinutes * 60 * 1000 };
    if (minBooks !== undefined) scanConfig.minBooks = minBooks;

    const candidates = scanForMispricing(allSnapshots, scanConfig);

    if (candidates.length === 0) {
      console.log('[MispricingScan] No mispricing candidates found');
      return { candidates: [], counts: {} };
    }

    // Group counts by sport + market_type
    const counts = {};
    const gameSet = new Set();

    for (const c of candidates) {
      const key = `${c.sport}:${c.market_type}`;
      if (!counts[key]) {
        counts[key] = { sport: c.sport, market_type: c.market_type, total: 0, WATCH: 0, TRIGGER: 0 };
      }
      counts[key].total++;
      counts[key][c.threshold_class] = (counts[key][c.threshold_class] || 0) + 1;
      gameSet.add(c.game_id);
    }

    // Log per-group summary
    for (const entry of Object.values(counts)) {
      console.log(
        `[MispricingScan] ${entry.sport} ${entry.market_type}: ${entry.total} candidates` +
        ` (${entry.WATCH || 0} WATCH, ${entry.TRIGGER || 0} TRIGGER)`
      );
    }

    console.log(
      `[MispricingScan] Total candidates: ${candidates.length} across ${gameSet.size} games`
    );

    return { candidates, counts };
  } catch (err) {
    console.error(`[MispricingScan] ERROR: ${err.message}`);
    return { candidates: [], counts: {} };
  }
}

module.exports = { runMispricingScan };

// CLI entrypoint
if (require.main === module) {
  runMispricingScan().catch(console.error);
}
