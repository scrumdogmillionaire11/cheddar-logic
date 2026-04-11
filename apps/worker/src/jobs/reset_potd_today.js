/**
 * Reset POTD Play for a Given Date
 *
 * Removes the potd_plays row, associated card_payload, and bankroll entry for
 * a given date so the scheduler can re-run the POTD engine and produce a fresh
 * pick with the current signal engine.
 *
 * Per ADR-0002: this script is a DB writer and must be run while the worker is
 * stopped (or at least not mid-cycle). The production DB lock must be free.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   node apps/worker/src/jobs/reset_potd_today.js
 *   node apps/worker/src/jobs/reset_potd_today.js --dry-run
 *   node apps/worker/src/jobs/reset_potd_today.js --date 2026-04-11
 *   node apps/worker/src/jobs/reset_potd_today.js --date 2026-04-11 --dry-run
 */

'use strict';

require('dotenv').config();

const { withDb, getDatabase } = require('@cheddar-logic/data');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const dateIdx = args.indexOf('--date');
const playDate =
  dateIdx !== -1 && args[dateIdx + 1]
    ? args[dateIdx + 1]
    : new Date().toISOString().slice(0, 10); // today YYYY-MM-DD

// Derived IDs matching buildPotdIds(playDate) in run_potd_engine.js:
const playId = `potd-play-${playDate}`;
const cardId = `potd-card-${playDate}`;
// potd_bankroll row for the play: id='potd-bankroll-play-YYYY-MM-DD', play_id='potd-play-YYYY-MM-DD'

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  console.log(`\n[reset_potd_today] ${isDryRun ? '[DRY RUN] ' : ''}date=${playDate}`);
  console.log(`  play_id:  ${playId}`);
  console.log(`  card_id:  ${cardId}\n`);

  return withDb(async () => {
    const db = getDatabase();

    // ------------------------------------------------------------------
    // 1. Read — confirm what exists before touching anything
    // ------------------------------------------------------------------
    const play = db
      .prepare(
        `SELECT id, play_date, selection, confidence_label, result FROM potd_plays WHERE play_date = ? LIMIT 1`,
      )
      .get(playDate);

    const card = db
      .prepare(`SELECT id, created_at FROM card_payloads WHERE id = ? LIMIT 1`)
      .get(cardId);

    // potd_bankroll may use either the canonical play_id or the potd_plays.id as FK
    const bankrollRow = db
      .prepare(`SELECT id, play_id, amount_change FROM potd_bankroll WHERE play_id = ? LIMIT 1`)
      .get(playId);

    console.log('Found records:');
    console.log(`  potd_plays:    ${play ? JSON.stringify(play) : 'NONE'}`);
    console.log(`  card_payloads: ${card ? JSON.stringify(card) : 'NONE'}`);
    console.log(`  potd_bankroll: ${bankrollRow ? JSON.stringify(bankrollRow) : 'NONE'}`);

    if (!play && !card && !bankrollRow) {
      console.log('\nNothing to clean up — no records found for this date.');
      return { success: true };
    }

    if (isDryRun) {
      console.log('\n[DRY RUN] No changes made. Remove --dry-run to apply.');
      return { success: true };
    }

    // ------------------------------------------------------------------
    // 2. Delete — wrapped in a transaction for atomicity.
    //    Order: card_results → potd_bankroll → potd_plays → card_payloads
    //    (card_results has FK → card_payloads; potd_bankroll has FK → potd_plays.id)
    // ------------------------------------------------------------------
    const deleteAll = db.transaction(() => {
      let deleted = 0;

      // card_results references card_payloads — must go first
      if (card) {
        const r = db.prepare(`DELETE FROM card_results WHERE card_id = ?`).run(cardId);
        if (r.changes > 0) {
          console.log(`  DELETED card_results (card_id=${cardId}): ${r.changes} row(s)`);
          deleted += r.changes;
        }
      }

      if (bankrollRow) {
        const r = db.prepare(`DELETE FROM potd_bankroll WHERE play_id = ?`).run(playId);
        console.log(`  DELETED potd_bankroll (play_id=${playId}): ${r.changes} row(s)`);
        deleted += r.changes;
      }

      if (play) {
        const r = db.prepare(`DELETE FROM potd_plays WHERE play_date = ?`).run(playDate);
        console.log(`  DELETED potd_plays (play_date=${playDate}): ${r.changes} row(s)`);
        deleted += r.changes;
      }

      if (card) {
        const r = db.prepare(`DELETE FROM card_payloads WHERE id = ?`).run(cardId);
        console.log(`  DELETED card_payloads (id=${cardId}): ${r.changes} row(s)`);
        deleted += r.changes;
      }

      return deleted;
    });

    const totalDeleted = deleteAll();

    console.log(`\nDone. ${totalDeleted} total row(s) removed.`);
    console.log(
      'The scheduler will re-run runPotdEngine on its next tick within the 12–4 PM ET window,\n' +
        'or trigger it directly via the scheduler mechanism.',
    );

    return { success: true };
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  run()
    .then((result) => process.exit(result?.success ? 0 : 1))
    .catch((err) => {
      console.error('[reset_potd_today] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run };
