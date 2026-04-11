'use strict';

require('dotenv').config();

const { withDb, getDatabase } = require('@cheddar-logic/data');

const LOOKBACK_DAYS = 30;

function formatPct(value) {
  if (value == null) return '     —';
  return `${(value * 100).toFixed(1).padStart(5)}%`;
}

async function runSanityCheck() {
  await withDb(async () => {
    const db = getDatabase();

    const rows = db
      .prepare(
        `SELECT play_date, potd_fired, viable_count, top_edge_pct, stake_pct_of_bankroll
         FROM potd_daily_stats
         ORDER BY play_date DESC
         LIMIT ?`,
      )
      .all(LOOKBACK_DAYS);

    if (rows.length === 0) {
      console.log('No potd_daily_stats rows found (table empty — no runs recorded yet).');
      return;
    }

    // Header
    console.log('');
    console.log('POTD Sanity Check — last 30 days');
    console.log('─'.repeat(58));
    console.log(
      'play_date'.padEnd(12) +
      'fired'.padEnd(7) +
      'viable'.padEnd(8) +
      'top_edge'.padEnd(10) +
      'stake_pct',
    );
    console.log('─'.repeat(58));

    for (const row of rows) {
      console.log(
        String(row.play_date).padEnd(12) +
        String(row.potd_fired).padEnd(7) +
        String(row.viable_count ?? '—').padEnd(8) +
        formatPct(row.top_edge_pct).padEnd(10) +
        formatPct(row.stake_pct_of_bankroll),
      );
    }

    console.log('─'.repeat(58));

    // Summary row
    const total = rows.length;
    const fired = rows.filter(r => r.potd_fired === 1);
    const fireRate = total > 0 ? fired.length / total : 0;

    const avgEdge =
      fired.length > 0
        ? fired.reduce((sum, r) => sum + (r.top_edge_pct ?? 0), 0) / fired.length
        : null;

    const avgStake =
      fired.length > 0
        ? fired.reduce((sum, r) => sum + (r.stake_pct_of_bankroll ?? 0), 0) / fired.length
        : null;

    console.log(
      `fire_rate: ${(fireRate * 100).toFixed(1)}% (${fired.length}/${total})` +
      `   avg_edge_when_fired: ${avgEdge != null ? formatPct(avgEdge).trim() : '—'}` +
      `   avg_stake_when_fired: ${avgStake != null ? formatPct(avgStake).trim() : '—'}`,
    );
    console.log('');
  });
}

runSanityCheck().catch(err => {
  console.error('[potd-sanity-check] Error:', err.message);
  process.exit(1);
});
