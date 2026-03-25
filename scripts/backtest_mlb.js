#!/usr/bin/env node
'use strict';
/**
 * MLB Model Backtest
 *
 * Replays the JS MLB model against settled card_results.
 * Uses computePitcherStatsAsOf() for true walk-forward simulation.
 *
 * Usage:
 *   node scripts/backtest_mlb.js
 *   node scripts/backtest_mlb.js --sport mlb --days 60
 *   node scripts/backtest_mlb.js --min-conf 7
 */

// dotenv is not available at repo root — rely on CHEDDAR_DB_PATH being set in
// the calling environment (shell, systemd unit, or sourced .env file).
// To load env from file before running: set -a; source .env; set +a; node scripts/backtest_mlb.js
const { getDatabase, withDb } = require('../packages/data');
const { computePitcherStatsAsOf, projectStrikeouts } = require('../apps/worker/src/models/mlb-model');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 365, minConf: 1, market: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i+1]) { args.days = parseInt(argv[++i], 10); }
    if (argv[i] === '--min-conf' && argv[i+1]) { args.minConf = parseInt(argv[++i], 10); }
    if (argv[i] === '--market' && argv[i+1]) { args.market = argv[++i]; }
  }
  return args;
}

function confidenceBucket(conf) {
  if (conf >= 9) return 'HIGH (9-10)';
  if (conf >= 8) return 'HIGH (8-10)';
  if (conf >= 7) return 'MED (7-8)';
  return 'LOW (<7)';
}

async function main() {
  const args = parseArgs();

  await withDb(() => {
    const db = getDatabase();

    // Load settled MLB strikeout cards with game_date and pitcher data
    // card_payloads.payload_data has the prediction, odds_snapshot has raw_data
    // card_results has status (won/lost/push) and result
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - args.days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const settledCards = db.prepare(`
      SELECT
        cr.card_id,
        cr.game_id,
        cr.status,
        cr.result,
        cr.settled_at,
        cp.payload_data,
        os.raw_data,
        os.captured_at,
        g.game_time_utc
      FROM card_results cr
      JOIN card_payloads cp ON cr.card_id = cp.id
      JOIN games g ON cr.game_id = g.game_id
      LEFT JOIN odds_snapshots os ON os.game_id = cr.game_id
      WHERE cr.sport = 'MLB'
        AND cr.status IN ('won', 'lost', 'push')
        AND date(cr.settled_at) >= ?
      ORDER BY cr.settled_at DESC
    `).all(cutoffStr);

    if (settledCards.length === 0) {
      console.log('No settled MLB cards found. Run the model for a few weeks first.');
      console.log(`Checked from: ${cutoffStr}`);
      process.exit(0);
    }

    // Group by confidence tier
    const tiers = {};
    let total = 0, replayed = 0, skipped = 0;

    for (const card of settledCards) {
      total++;
      const payload = (() => {
        try { return typeof card.payload_data === 'string' ? JSON.parse(card.payload_data) : card.payload_data; }
        catch { return {}; }
      })();
      const raw = (() => {
        try { return typeof card.raw_data === 'string' ? JSON.parse(card.raw_data) : (card.raw_data ?? {}); }
        catch { return {}; }
      })();

      const mlb = raw?.mlb ?? {};
      const gameDate = (card.game_time_utc ?? card.settled_at ?? '').slice(0, 10);
      if (!gameDate) { skipped++; continue; }

      // Re-run strikeout projection with as_of_date stats if pitcher ID available
      const homePitcherId = mlb?.home_pitcher?.mlb_id ?? null;
      const line = mlb?.strikeout_lines?.home ?? payload?.market?.total ?? null;

      if (!line) { skipped++; continue; }

      let pitcherStats = mlb?.home_pitcher ?? null;
      if (homePitcherId) {
        pitcherStats = computePitcherStatsAsOf(homePitcherId, gameDate, db) ?? pitcherStats;
      }
      if (!pitcherStats?.k_per_9) { skipped++; continue; }

      const result = projectStrikeouts(pitcherStats, line, {
        wind_mph: mlb?.wind_mph ?? null,
        temp_f: mlb?.temp_f ?? null,
      });
      if (!result || result.prediction === 'PASS') { skipped++; continue; }

      const conf = result.confidence;
      const bucket = confidenceBucket(conf);
      if (!tiers[bucket]) tiers[bucket] = { wins: 0, losses: 0, pushes: 0 };

      const outcome = card.result ?? card.status;
      if (outcome === 'won') tiers[bucket].wins++;
      else if (outcome === 'lost') tiers[bucket].losses++;
      else if (outcome === 'push') tiers[bucket].pushes++;

      replayed++;
    }

    // Print report
    console.log('\n========================================');
    console.log('  MLB Strikeout Model Backtest Report');
    console.log('========================================');
    console.log(`Period: Last ${args.days} days (from ${cutoffStr})`);
    console.log(`Cards: ${total} settled, ${replayed} replayed, ${skipped} skipped\n`);

    if (replayed === 0) {
      console.log('Not enough data yet. Need settled MLB strikeout cards.');
      return;
    }

    const allTiers = ['HIGH (9-10)', 'HIGH (8-10)', 'MED (7-8)', 'LOW (<7)'];
    console.log('Confidence Tier | W    | L    | P  | Win Rate');
    console.log('----------------|------|------|----|---------');
    for (const tier of allTiers) {
      const t = tiers[tier];
      if (!t) continue;
      const total = t.wins + t.losses + t.pushes;
      const winRate = total > 0 ? ((t.wins / total) * 100).toFixed(1) : 'N/A';
      console.log(`${tier.padEnd(16)}| ${String(t.wins).padEnd(5)}| ${String(t.losses).padEnd(5)}| ${String(t.pushes).padEnd(3)}| ${winRate}%`);
    }
    console.log('\nTarget: HIGH (8-10) >= 80% win rate per spec backtest');
  });
}

main().catch(err => {
  console.error('Backtest error:', err.message);
  process.exit(1);
});
