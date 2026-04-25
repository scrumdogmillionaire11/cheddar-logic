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

const {
  getDatabase,
  getDatabaseReadOnly,
  closeDatabase,
  closeReadOnlyInstance,
} = require('@cheddar-logic/data');

const LOOKBACK_DAYS = Number(process.env.HEALTH_LOOKBACK_DAYS || 30);
const SPORTS = ['nba', 'nhl', 'mlb', 'ncaam', 'nfl'];

// Status thresholds per assess-overall-health.md
const HEALTHY_HIT_RATE = 0.52;
const DEGRADED_HIT_RATE_MIN = 0.45;
const STALE_MINUTES = 90;
const MODEL_FRESHNESS_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const POTD_RUN_STALE_MS = 36 * 60 * 60 * 1000;
const POTD_NEAR_MISS_STALE_MS = 48 * 60 * 60 * 1000;
const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { json: false, persist: false, sport: null, days: LOOKBACK_DAYS };
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--persist') { opts.persist = true; continue; }
    if (arg.startsWith('--days=')) { opts.days = Number(arg.split('=')[1]); continue; }
    if (arg.startsWith('--sport=')) { opts.sport = arg.split('=')[1].toLowerCase(); continue; }
  }
  return opts;
}

function floorToFiveMinuteBucketUtc(input = new Date()) {
  const date = new Date(input);
  const floored = new Date(date.getTime());
  floored.setUTCSeconds(0, 0);
  floored.setUTCMinutes(Math.floor(floored.getUTCMinutes() / 5) * 5);
  return floored.toISOString();
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

function getEtDateKey(date = new Date()) {
  return ET_DATE_FORMATTER.format(date);
}

function isTableAvailable(db, tableName) {
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
    ).get(tableName);
    return Boolean(row);
  } catch {
    return false;
  }
}

function safeGet(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxIso(...values) {
  let best = null;
  for (const value of values.filter(Boolean)) {
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > new Date(best).getTime()) best = value;
  }
  return best;
}

function buildPotdHealth(db, now = new Date()) {
  const today = getEtDateKey(now);
  const hasDailyStats = isTableAvailable(db, 'potd_daily_stats');
  const hasPlays = isTableAvailable(db, 'potd_plays');
  const hasNominees = isTableAvailable(db, 'potd_nominees');
  const hasShadowCandidates = isTableAvailable(db, 'potd_shadow_candidates');
  const hasShadowResults = isTableAvailable(db, 'potd_shadow_results');

  const latestDaily = hasDailyStats
    ? safeGet(db, `
        SELECT play_date, potd_fired, candidate_count, viable_count, created_at
        FROM potd_daily_stats
        ORDER BY created_at DESC, play_date DESC
        LIMIT 1
      `)
    : null;
  const todayDaily = hasDailyStats
    ? safeGet(db, `
        SELECT play_date, potd_fired, candidate_count, viable_count, created_at
        FROM potd_daily_stats
        WHERE play_date = ?
        LIMIT 1
      `, today)
    : null;
  const todayPlay = hasPlays
    ? safeGet(db, `
        SELECT play_date, posted_at, created_at
        FROM potd_plays
        WHERE play_date = ?
        ORDER BY posted_at DESC, created_at DESC
        LIMIT 1
      `, today)
    : null;
  const latestPlay = hasPlays
    ? safeGet(db, `
        SELECT play_date, posted_at, created_at
        FROM potd_plays
        ORDER BY posted_at DESC, created_at DESC
        LIMIT 1
      `)
    : null;
  const todayNomineeCount = hasNominees
    ? safeGet(db, 'SELECT COUNT(*) AS count FROM potd_nominees WHERE play_date = ?', today)?.count ?? 0
    : 0;
  const todayShadowCount = hasShadowCandidates
    ? safeGet(db, 'SELECT COUNT(*) AS count FROM potd_shadow_candidates WHERE play_date = ?', today)?.count ?? 0
    : 0;
  const shadowStatusRows = hasShadowResults
    ? safeAll(db, `
        SELECT status, result, COUNT(*) AS count
        FROM potd_shadow_results
        GROUP BY status, result
      `)
    : [];
  const latestShadowResult = hasShadowResults
    ? safeGet(db, `
        SELECT settled_at, updated_at, created_at
        FROM potd_shadow_results
        ORDER BY COALESCE(settled_at, updated_at, created_at) DESC
        LIMIT 1
      `)
    : null;

  const candidateCount = toNumber(todayDaily?.candidate_count) ?? todayNomineeCount + todayShadowCount;
  const viableCount = toNumber(todayDaily?.viable_count);
  const todayState = todayPlay || Number(todayDaily?.potd_fired) === 1
    ? 'fired'
    : todayDaily
      ? 'no-pick'
      : 'no-data';
  const lastRunAt = maxIso(
    latestDaily?.created_at,
    latestPlay?.posted_at,
    latestPlay?.created_at,
  );
  const lastRunAgeMs = lastRunAt ? now.getTime() - new Date(lastRunAt).getTime() : null;
  const nearMissLastSettledAt = maxIso(
    latestShadowResult?.settled_at,
    latestShadowResult?.updated_at,
    latestShadowResult?.created_at,
  );
  const nearMissAgeMs = nearMissLastSettledAt
    ? now.getTime() - new Date(nearMissLastSettledAt).getTime()
    : null;

  const nearMissCounts = {
    total: 0,
    pending: 0,
    settled: 0,
    win: 0,
    loss: 0,
    push: 0,
  };
  for (const row of shadowStatusRows) {
    const count = Number(row.count || 0);
    nearMissCounts.total += count;
    const status = String(row.status || '').toLowerCase();
    const result = String(row.result || '').toLowerCase();
    if (status === 'settled') nearMissCounts.settled += count;
    if (status === 'pending') nearMissCounts.pending += count;
    if (result === 'win') nearMissCounts.win += count;
    if (result === 'loss') nearMissCounts.loss += count;
    if (result === 'push') nearMissCounts.push += count;
  }

  const signals = [];
  let status = 'healthy';
  if (!lastRunAt) {
    status = 'no-data';
    signals.push('No POTD run history found');
  } else if (lastRunAgeMs !== null && lastRunAgeMs > POTD_RUN_STALE_MS) {
    status = 'stale';
    signals.push(`POTD run is stale: last run ${formatAge(new Date(lastRunAt).getTime())}`);
  }
  if (todayState === 'no-data') {
    if (status === 'healthy') status = 'degraded';
    signals.push('No POTD fired/no-pick state recorded for today');
  } else if (todayState === 'no-pick' && status === 'healthy') {
    status = 'degraded';
    signals.push('POTD recorded a no-pick state today');
  }
  if (candidateCount === 0) {
    if (status === 'healthy') status = 'degraded';
    signals.push('POTD candidate volume is zero today');
  }
  if (nearMissCounts.total === 0) {
    if (status === 'healthy') status = 'degraded';
    signals.push('No near-miss shadow settlement history found');
  } else if (nearMissAgeMs !== null && nearMissAgeMs > POTD_NEAR_MISS_STALE_MS) {
    if (status === 'healthy' || status === 'degraded') status = 'stale';
    signals.push(`Near-miss shadow settlement is stale: last update ${formatAge(new Date(nearMissLastSettledAt).getTime())}`);
  }

  return {
    status,
    last_run_at: lastRunAt,
    last_run_age: lastRunAt ? formatAge(new Date(lastRunAt).getTime()) : 'never',
    today_state: todayState,
    play_date: today,
    candidate_count: candidateCount,
    viable_count: viableCount,
    near_miss: {
      last_settled_at: nearMissLastSettledAt,
      last_settled_age: nearMissLastSettledAt
        ? formatAge(new Date(nearMissLastSettledAt).getTime())
        : 'never',
      counts: nearMissCounts,
    },
    signals,
  };
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
  const { generatedAt, lookbackDays, overallStatus, sports, pipeline, potd_health: potdHealth } = data;

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

  if (potdHealth) {
    console.log('');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('  POTD HEALTH');
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  ${statusIcon(potdHealth.status)} Status: ${String(potdHealth.status).toUpperCase()}`);
    console.log(`     Last run:      ${potdHealth.last_run_age || 'never'}`);
    console.log(`     Today state:   ${potdHealth.today_state || 'no-data'}`);
    console.log(`     Candidates:    ${potdHealth.candidate_count ?? 0} total${potdHealth.viable_count != null ? `, ${potdHealth.viable_count} viable` : ''}`);
    const nearMiss = potdHealth.near_miss || {};
    const nearMissCounts = nearMiss.counts || {};
    console.log(`     Near-miss:     ${nearMissCounts.settled ?? 0} settled, ${nearMissCounts.pending ?? 0} pending (last: ${nearMiss.last_settled_age || 'never'})`);
    if ((potdHealth.signals || []).length > 0) {
      console.log('     Signals:');
      for (const signal of potdHealth.signals) {
        console.log(`        • ${signal}`);
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

function buildDrClaireReport(opts = {}, deps = {}) {
  const lookbackDays = opts.days ?? LOOKBACK_DAYS;
  const sportsToRun = opts.sport ? [opts.sport] : SPORTS;
  const openReadOnlyDb = deps.openReadOnlyDb || getDatabaseReadOnly;
  const closeReadOnlyDb = deps.closeReadOnlyDb || closeReadOnlyInstance;
  let db = null;
  try {
    db = openReadOnlyDb();
  } catch (err) {
    console.error(`[dr_claire] Failed to connect to database: ${err.message}`);
    throw err;
  }

  try {
    const sportResults = {};
    for (const sport of sportsToRun) {
      sportResults[sport] = runSportHealthQuery(db, sport, lookbackDays);
    }

    const pipeline = getPipelineSummary(db);
    const potdHealth = buildPotdHealth(db);

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
      potd_health: potdHealth,
    };
    return report;
  } finally {
    closeReadOnlyDb(db);
  }
}

function persistModelHealthSnapshots(report, opts = {}, deps = {}) {
  if (!opts.persist) {
    return { persisted: false, rowCount: 0, runAt: null };
  }

  const openWriterDb = deps.openWriterDb || getDatabase;
  const closeWriterDb = deps.closeWriterDb || closeDatabase;
  const runAt = opts.runAt || floorToFiveMinuteBucketUtc(report.generatedAt);
  let db = null;
  let rowCount = 0;

  try {
    db = openWriterDb();
    const stmt = db.prepare(`
      INSERT INTO model_health_snapshots (
        sport,
        run_at,
        hit_rate,
        roi_units,
        roi_pct,
        total_unique,
        wins,
        losses,
        streak,
        last10_hit_rate,
        status,
        signals_json,
        lookback_days
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sport, run_at, lookback_days) DO UPDATE SET
        hit_rate = excluded.hit_rate,
        roi_units = excluded.roi_units,
        roi_pct = excluded.roi_pct,
        total_unique = excluded.total_unique,
        wins = excluded.wins,
        losses = excluded.losses,
        streak = excluded.streak,
        last10_hit_rate = excluded.last10_hit_rate,
        status = excluded.status,
        signals_json = excluded.signals_json,
        created_at = CURRENT_TIMESTAMP
    `);

    for (const [sport, snapshot] of Object.entries(report.sports || {})) {
      stmt.run(
        sport,
        runAt,
        snapshot.hitRate,
        snapshot.netUnits,
        snapshot.roiPct,
        snapshot.totalPredictions ?? 0,
        snapshot.wins ?? 0,
        snapshot.losses ?? 0,
        snapshot.streak ?? null,
        snapshot.last10HitRate,
        snapshot.status,
        JSON.stringify(snapshot.degradationSignals || []),
        opts.days ?? report.lookbackDays ?? LOOKBACK_DAYS,
      );
      rowCount += 1;
    }

    return { persisted: true, rowCount, runAt };
  } finally {
    if (db) closeWriterDb(db);
  }
}

async function runDrClaireHealthReport(opts = {}, deps = {}) {
  const resolvedOpts = {
    json: Boolean(opts.json),
    persist: Boolean(opts.persist),
    sport: opts.sport ?? null,
    days: opts.days ?? LOOKBACK_DAYS,
    runAt: opts.runAt ?? null,
  };
  const report = buildDrClaireReport(resolvedOpts, deps);
  const persistResult = persistModelHealthSnapshots(report, resolvedOpts, deps);

  if (resolvedOpts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report, resolvedOpts);
  }

  return { report, persistResult };
}

async function main() {
  await runDrClaireHealthReport(parseArgs());
}

if (require.main === module) {
  main().catch(err => {
    console.error('[dr_claire] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  assignStatus,
  buildPotdHealth,
  buildDrClaireReport,
  floorToFiveMinuteBucketUtc,
  parseArgs,
  persistModelHealthSnapshots,
  runSportHealthQuery,
  runDrClaireHealthReport,
};
