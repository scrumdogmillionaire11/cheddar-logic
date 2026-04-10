/**
 * Dr. Claire — Model Health & Performance Report
 *
 * Generates a comprehensive diagnostics snapshot across all active sports.
 * Follows the assess-overall-health.md task spec from _bmad/core/tasks/.
 *
 * Usage:
 *   node src/jobs/dr_claire_health_report.js
 *   node src/jobs/dr_claire_health_report.js --days=14
 *   node src/jobs/dr_claire_health_report.js --sport=nba
 *   node src/jobs/dr_claire_health_report.js --json
 */

'use strict';

require('dotenv').config();

const { getDatabaseReadOnly, closeReadOnlyInstance } = require('@cheddar-logic/data');

const LOOKBACK_DAYS = Number(process.env.HEALTH_LOOKBACK_DAYS || 30);
const SPORTS = ['nba', 'nhl', 'mlb', 'ncaam', 'nfl'];

// Status thresholds per assess-overall-health.md
const HEALTHY_HIT_RATE = 0.52;
const DEGRADED_HIT_RATE_MIN = 0.45;
const STALE_MINUTES = 90;
const MODEL_FRESHNESS_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { json: false, sport: null, days: LOOKBACK_DAYS };
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--days=')) { opts.days = Number(arg.split('=')[1]); continue; }
    if (arg.startsWith('--sport=')) { opts.sport = arg.split('=')[1].toLowerCase(); continue; }
  }
  return opts;
}

function statusIcon(status) {
  return { healthy: '✅', degraded: '⚠️ ', stale: '🚨', critical: '❌', 'no-data': '⬜' }[status] ?? '❓';
}

function assignStatus(hitRate, lastUpdatedMs, modelIsOk = null) {
  const staleMs = STALE_MINUTES * 60 * 1000;
  if (modelIsOk === false) return 'stale';
  if (modelIsOk === null && (!lastUpdatedMs || (Date.now() - lastUpdatedMs) > staleMs)) return 'stale';
  if (hitRate === null) return 'no-data';
  if (hitRate >= HEALTHY_HIT_RATE) return 'healthy';
  if (hitRate >= DEGRADED_HIT_RATE_MIN) return 'degraded';
  return 'critical';
}

function computeStreak(outcomes) {
  if (!outcomes.length) return 'none';
  const cur = outcomes[0];
  let count = 1;
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] === cur) count++;
    else break;
  }
  return `${cur.toUpperCase()}${count}`;
}

function getHitRate(wins, losses) {
  const total = wins + losses;
  return total === 0 ? null : wins / total;
}

function runSportHealthQuery(db, sport, lookbackDays) {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // Settled results in window — deduplicated to one row per unique market
  // (game_id + card_type + recommended_bet_type). Multiple identical cards from
  // the same game/market are correlated, so counting each inflates all metrics.
  const rawCount = db.prepare(`
    SELECT COUNT(*) as n FROM card_results
    WHERE sport = ? AND status = 'settled' AND settled_at >= ? AND is_primary = 1
  `).get(sport, cutoff)?.n ?? 0;

  const results = db.prepare(`
    SELECT result, AVG(pnl_units) as pnl_units, MAX(settled_at) as settled_at
    FROM card_results
    WHERE sport = ? AND status = 'settled' AND settled_at >= ? AND is_primary = 1
    GROUP BY game_id, card_type, recommended_bet_type
    ORDER BY settled_at DESC
  `).all(sport, cutoff);

  const dupRatio = results.length > 0 ? (rawCount / results.length).toFixed(1) : '1.0';

  const wins = results.filter(r => r.result === 'win').length;
  const losses = results.filter(r => r.result === 'loss').length;
  const pushes = results.filter(r => r.result === 'push').length;
  const total = wins + losses + pushes;
  const hitRate = getHitRate(wins, losses);
  const netUnits = results.reduce((s, r) => s + (r.pnl_units ?? 0), 0);
  // ROI % — only meaningful with adequate sample size (>=10 settled)
  const roiPct = (wins + losses) >= 10 ? (netUnits / (wins + losses)) * 100 : null;

  // Recent streak from last 20 settled outcomes
  const outcomes = results.slice(0, 20).map(r => r.result).filter(r => r === 'win' || r === 'loss');
  const streak = computeStreak(outcomes);

  // Last 10 hit rate
  const last10 = results.slice(0, 10);
  const last10Wins = last10.filter(r => r.result === 'win').length;
  const last10Losses = last10.filter(r => r.result === 'loss').length;
  const last10HitRate = getHitRate(last10Wins, last10Losses);

  // Most recent card for staleness check
  const latestCard = db.prepare(`
    SELECT created_at FROM card_payloads
    WHERE sport = ? ORDER BY created_at DESC LIMIT 1
  `).get(sport);

  const modelHealthRow = db.prepare(`
    SELECT status, created_at FROM pipeline_health
    WHERE LOWER(phase) = LOWER(?) AND check_name = 'model_freshness'
    ORDER BY created_at DESC LIMIT 1
  `).get(sport);

  const lastUpdatedMs = latestCard ? new Date(latestCard.created_at).getTime() : null;
  const lastUpdatedAgo = lastUpdatedMs
    ? formatAge(lastUpdatedMs)
    : 'never';
  const modelFreshMs = modelHealthRow ? new Date(modelHealthRow.created_at).getTime() : null;
  const hasFreshModelHealth = Number.isFinite(modelFreshMs)
    && (Date.now() - modelFreshMs) < MODEL_FRESHNESS_MAX_AGE_MS;
  const modelIsOk = hasFreshModelHealth
    ? modelHealthRow?.status === 'ok'
    : null;

  // Model output confidence (last 30 days)
  const modelConf = db.prepare(`
    SELECT AVG(confidence) as avg_conf, MAX(predicted_at) as last_run
    FROM model_outputs
    WHERE sport = ? AND predicted_at >= ?
  `).get(sport.toUpperCase(), cutoff);

  const avgConfidence = modelConf?.avg_conf ?? null;
  const lastModelRun = modelConf?.last_run ?? null;

  // Degradation signals
  const degradationSignals = [];
  if (total > 10 && last10HitRate !== null && hitRate !== null) {
    if (hitRate - last10HitRate > 0.15) {
      degradationSignals.push(`Recent regression: last-10 hit rate (${pct(last10HitRate)}) dropped ${pct(hitRate - last10HitRate)} below 30-day avg`);
    }
  }
  if (roiPct !== null && roiPct < -5) {
    degradationSignals.push(`Negative ROI: ${roiPct.toFixed(1)}%`);
  }
  if (lastUpdatedMs && (Date.now() - lastUpdatedMs) > 6 * 60 * 60 * 1000) {
    degradationSignals.push(`No card payloads in 6+ hours (last: ${lastUpdatedAgo})`);
  }

  const status = assignStatus(hitRate, lastUpdatedMs, modelIsOk);

  return {
    status,
    hitRate,
    totalPredictions: total,
    wins, losses, pushes,
    netUnits,
    roiPct,
    rawCardCount: rawCount,
    dupRatio,
    avgConfidence,
    streak,
    last10HitRate,
    lastUpdated: latestCard?.created_at ?? null,
    lastUpdatedAgo,
    lastModelRun,
    degradationSignals,
  };
}

function getPipelineSummary(db) {
  // Get latest status per (phase, check_name)
  const rows = db.prepare(`
    SELECT phase, check_name, status, reason, created_at
    FROM pipeline_health
    WHERE created_at >= datetime('now', '-2 hours')
    ORDER BY created_at DESC
  `).all();

  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.phase}::${row.check_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }
  return deduped;
}

function pct(val) {
  if (val === null || val === undefined) return 'N/A';
  return `${(val * 100).toFixed(1)}%`;
}

function formatAge(ms) {
  const ageMs = Date.now() - ms;
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function printTextReport(data, opts) {
  const { generatedAt, lookbackDays, overallStatus, sports, pipeline } = data;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       🏥  Dr. Claire — Model Health & Performance Report     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Generated:    ${new Date(generatedAt).toLocaleString()}`);
  console.log(`  Window:       Last ${lookbackDays} days`);
  console.log(`  Overall:      ${statusIcon(overallStatus)} ${overallStatus.toUpperCase()}`);
  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('  SPORT-BY-SPORT DIAGNOSTICS');
  console.log('──────────────────────────────────────────────────────────────');

  for (const [sport, s] of Object.entries(sports)) {
    const icon = statusIcon(s.status);
    const hrStr = s.hitRate !== null ? pct(s.hitRate) : 'N/A';
    const l10Str = s.last10HitRate !== null ? pct(s.last10HitRate) : 'N/A';
    const netStr = s.totalPredictions > 0
      ? `${s.netUnits >= 0 ? '+' : ''}${s.netUnits.toFixed(2)}u net`
      : null;
    const roiStr = s.roiPct !== null
      ? `${s.roiPct >= 0 ? '+' : ''}${s.roiPct.toFixed(1)}% ROI`
      : s.totalPredictions > 0 && s.totalPredictions < 10
        ? `(n=${s.totalPredictions} — too small for ROI)`
        : 'N/A';
    const confStr = s.avgConfidence !== null ? s.avgConfidence.toFixed(3) : 'N/A';

    console.log('');
    console.log(`  ${icon} ${sport.toUpperCase().padEnd(6)}  Status: ${s.status.toUpperCase()}`);
    console.log(`     Hit Rate:    ${hrStr}  (last-10: ${l10Str})   Streak: ${s.streak}`);
    const pnlParts = [netStr, roiStr].filter(Boolean);
    const dupNote = Number(s.dupRatio) > 1.5 ? `  ⚠️  ${s.rawCardCount} raw cards (${s.dupRatio}x dup)` : '';
    console.log(`     Record:      ${s.wins}W ${s.losses}L ${s.pushes}P  (${s.totalPredictions} unique markets${dupNote})`);
    console.log(`     P&L:         ${pnlParts.join('  ')}`);
    console.log(`     Avg Conf:    ${confStr}   Last card: ${s.lastUpdatedAgo}`);

    if (s.degradationSignals.length > 0) {
      console.log(`     ⚠️  Signals:`);
      for (const sig of s.degradationSignals) {
        console.log(`        • ${sig}`);
      }
    }
  }

  // Pipeline health section
  if (pipeline.length > 0) {
    console.log('');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('  PIPELINE HEALTH (last 2h)');
    console.log('──────────────────────────────────────────────────────────────');
    for (const row of pipeline) {
      const icon = row.status === 'ok' ? '✅' : row.status === 'warning' ? '⚠️ ' : '❌';
      const age = formatAge(new Date(row.created_at).getTime());
      console.log(`  ${icon} [${row.phase}] ${row.check_name.padEnd(28)} ${row.status.toUpperCase().padEnd(8)} ${age}`);
      if (row.reason && row.status !== 'ok') {
        console.log(`       └─ ${row.reason}`);
      }
    }
  } else {
    console.log('');
    console.log('  ℹ️  Pipeline health: no entries in last 2h (watchdog may be off)');
  }

  // Recommendations
  const criticalSports = Object.entries(sports).filter(([, s]) => s.status === 'critical');
  const degradedSports = Object.entries(sports).filter(([, s]) => s.status === 'degraded');
  const staleSports = Object.entries(sports).filter(([, s]) => s.status === 'stale');
  const failedPipeline = pipeline.filter(p => p.status === 'failed');

  if (criticalSports.length || degradedSports.length || staleSports.length || failedPipeline.length) {
    console.log('');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('  RECOMMENDED ACTIONS');
    console.log('──────────────────────────────────────────────────────────────');
    let priority = 1;
    for (const [sport] of criticalSports) {
      console.log(`  P${priority++}. ❌ ${sport.toUpperCase()} CRITICAL — review model inputs, recent settlement accuracy`);
    }
    for (const [sport] of staleSports) {
      console.log(`  P${priority++}. 🚨 ${sport.toUpperCase()} STALE — check scheduler, pull-odds, and card generation jobs`);
    }
    for (const [sport] of degradedSports) {
      console.log(`  P${priority++}. ⚠️  ${sport.toUpperCase()} DEGRADED — monitor closely, consider edge review`);
    }
    for (const p of failedPipeline) {
      console.log(`  P${priority++}. ❌ Pipeline [${p.phase}] ${p.check_name} FAILED — ${p.reason ?? 'see logs'}`);
    }
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Dr. Claire diagnostic complete. Stay healthy out there. 🏥');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
}

async function main() {
  const opts = parseArgs();
  const lookbackDays = opts.days;
  const sportsToRun = opts.sport ? [opts.sport] : SPORTS;

  let db;
  try {
    db = getDatabaseReadOnly();
  } catch (err) {
    console.error(`[dr_claire] Failed to connect to database: ${err.message}`);
    process.exit(1);
  }

  try {
    const sportResults = {};
    for (const sport of sportsToRun) {
      sportResults[sport] = runSportHealthQuery(db, sport, lookbackDays);
    }

    const pipeline = getPipelineSummary(db);

    // Overall status: worst of all sports
    const statusRank = { critical: 0, stale: 1, degraded: 2, healthy: 3, 'no-data': 4 };
    const allStatuses = Object.values(sportResults).map(s => s.status);
    const overallStatus = allStatuses.reduce((worst, cur) => {
      return (statusRank[cur] ?? 99) < (statusRank[worst] ?? 99) ? cur : worst;
    }, 'healthy');

    const report = {
      generatedAt: new Date().toISOString(),
      lookbackDays,
      overallStatus,
      sports: sportResults,
      pipeline,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printTextReport(report, opts);
    }
  } finally {
    closeReadOnlyInstance();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[dr_claire] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  assignStatus,
  runSportHealthQuery,
};
