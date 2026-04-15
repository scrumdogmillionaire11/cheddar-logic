'use strict';

/**
 * Suppression Funnel Report — Phase 0 Observability
 *
 * Counts how many plays are dropped at each pipeline layer over the last 7 days
 * so we know which gates are the actual top suppressors before adjusting thresholds.
 *
 * Usage:
 *   node apps/worker/src/scripts/suppression-funnel-report.js
 *   node apps/worker/src/scripts/suppression-funnel-report.js --days 14
 *   node apps/worker/src/scripts/suppression-funnel-report.js --sport MLB
 *
 * Output: a ranked table of suppression by layer, sport, and reason code.
 */

require('dotenv').config();

const { getDatabase } = require('@cheddar-logic/data');
const { THRESHOLDS } = require('../calibration/calibration-gate');

const args = process.argv.slice(2);
const days = (() => {
  const idx = args.indexOf('--days');
  return idx >= 0 ? parseInt(args[idx + 1], 10) || 7 : 7;
})();
const sportFilter = (() => {
  const idx = args.indexOf('--sport');
  return idx >= 0 ? args[idx + 1]?.toLowerCase() : null;
})();

function run() {
  const db = getDatabase();
  const since = `datetime('now', '-${days} days')`;

  const sportWhere = sportFilter ? `AND sport = '${sportFilter}'` : '';

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION 1: Top-line card counts
  // ─────────────────────────────────────────────────────────────────────────
  const totalRow = db.prepare(`
    SELECT
      sport,
      COUNT(*) as total_cards,
      SUM(CASE WHEN json_extract(payload_data, '$.action') != 'PASS' THEN 1 ELSE 0 END) as surfaced,
      SUM(CASE WHEN json_extract(payload_data, '$.action') = 'PASS' THEN 1 ELSE 0 END) as suppressed
    FROM card_payloads
    WHERE created_at >= ${since}
      AND card_type NOT LIKE 'fpl%'
      ${sportWhere}
    GROUP BY sport
    ORDER BY total_cards DESC
  `).all();

  console.log('\n');
  console.log('='.repeat(72));
  console.log(`SUPPRESSION FUNNEL REPORT — last ${days} days${sportFilter ? ` — ${sportFilter}` : ''}`);
  console.log('='.repeat(72));

  console.log('\n── Section 1: Top-line card counts ──\n');
  console.log(fmt('Sport', 10) + fmt('Total', 10) + fmt('Surfaced', 12) + fmt('Suppressed', 12) + fmt('Suppress%', 10));
  console.log('-'.repeat(54));
  for (const row of totalRow) {
    const pct = row.total_cards > 0 ? ((row.suppressed / row.total_cards) * 100).toFixed(1) : '0.0';
    console.log(
      fmt(row.sport, 10) +
      fmt(row.total_cards, 10) +
      fmt(row.surfaced, 12) +
      fmt(row.suppressed, 12) +
      fmt(`${pct}%`, 10),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION 2: PASS reason code breakdown (worker-layer gate identity)
  // ─────────────────────────────────────────────────────────────────────────
  const reasonRows = db.prepare(`
    SELECT
      sport,
      json_extract(payload_data, '$.pass_reason_code') as reason_code,
      json_extract(payload_data, '$.decision_v2.canonical_envelope_v2.terminal_reason_family') as terminal_family,
      COUNT(*) as count
    FROM card_payloads
    WHERE created_at >= ${since}
      AND json_extract(payload_data, '$.action') = 'PASS'
      AND card_type NOT LIKE 'fpl%'
      ${sportWhere}
    GROUP BY sport, reason_code, terminal_family
    ORDER BY count DESC
    LIMIT 40
  `).all();

  console.log('\n── Section 2: Top PASS reason codes (last ' + days + ' days) ──\n');
  console.log(fmt('Sport', 8) + fmt('Count', 8) + fmt('Terminal Family', 28) + 'Reason Code');
  console.log('-'.repeat(90));
  for (const row of reasonRows) {
    console.log(
      fmt(row.sport || '?', 8) +
      fmt(row.count, 8) +
      fmt(row.terminal_family || '(none)', 28) +
      (row.reason_code || '(null)'),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION 3: DEGRADED wiring check
  // Plays with action=PASS where confidence is in [0.50, 0.60) — these are
  // the DEGRADED plays that get blocked at the execution gate's 0.60 floor.
  // If this count is high, the DEGRADED→0.55 cap + 0.60 floor wiring is
  // the primary suppressor for that sport.
  // ─────────────────────────────────────────────────────────────────────────
  const degradedRows = db.prepare(`
    SELECT
      sport,
      COUNT(*) as count,
      AVG(CAST(json_extract(payload_data, '$.confidence') AS REAL)) as avg_confidence,
      MIN(CAST(json_extract(payload_data, '$.confidence') AS REAL)) as min_confidence
    FROM card_payloads
    WHERE created_at >= ${since}
      AND json_extract(payload_data, '$.action') = 'PASS'
      AND CAST(json_extract(payload_data, '$.confidence') AS REAL) >= 0.50
      AND CAST(json_extract(payload_data, '$.confidence') AS REAL) < 0.60
      AND card_type NOT LIKE 'fpl%'
      ${sportWhere}
    GROUP BY sport
    ORDER BY count DESC
  `).all();

  console.log('\n── Section 3: DEGRADED wiring — PASS cards with confidence [0.50, 0.60) ──');
  console.log('   (These are blocked by execution-gate floor=0.60 despite DEGRADED cap=0.55)');
  console.log('   Lowering the floor to 0.55 would surface these as WATCH-tier.\n');
  if (degradedRows.length === 0) {
    console.log('   None found — DEGRADED wiring may not be the primary suppressor.');
  } else {
    console.log(fmt('Sport', 10) + fmt('Count', 10) + fmt('Avg Conf', 12) + fmt('Min Conf', 12));
    console.log('-'.repeat(44));
    for (const row of degradedRows) {
      console.log(
        fmt(row.sport, 10) +
        fmt(row.count, 10) +
        fmt((row.avg_confidence || 0).toFixed(3), 12) +
        fmt((row.min_confidence || 0).toFixed(3), 12),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION 4: Calibration kill switch state
  // ─────────────────────────────────────────────────────────────────────────
  const calibRows = db.prepare(`
    SELECT market, kill_switch_active, ece, n_samples, computed_at
    FROM calibration_reports
    WHERE id IN (
      SELECT MAX(id) FROM calibration_reports GROUP BY market
    )
    ORDER BY market
  `).all();

  console.log('\n── Section 4: Calibration kill switch state (most recent per market) ──\n');
  console.log(fmt('Market', 16) + fmt('Active?', 10) + fmt('ECE', 8) + fmt('N', 8) + fmt('Threshold N', 14) + 'Computed At');
  console.log('-'.repeat(80));
  for (const row of calibRows) {
    const threshold = THRESHOLDS[row.market];
    const threshN = threshold ? threshold.minSamples : '?';
    const active = Number(row.kill_switch_active) === 1 ? '*** YES ***' : 'no';
    const eceFmt = row.ece != null ? row.ece.toFixed(4) : 'n/a';
    console.log(
      fmt(row.market, 16) +
      fmt(active, 10) +
      fmt(eceFmt, 8) +
      fmt(row.n_samples ?? '?', 8) +
      fmt(String(threshN), 14) +
      (row.computed_at || ''),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION 5: MLB confidence distribution (how many cards fall in each band)
  // ─────────────────────────────────────────────────────────────────────────
  const mlbConfRows = db.prepare(`
    SELECT
      CASE
        WHEN CAST(json_extract(payload_data, '$.confidence') AS REAL) >= 0.80 THEN '>=0.80 (FIRE threshold)'
        WHEN CAST(json_extract(payload_data, '$.confidence') AS REAL) >= 0.70 THEN '0.70-0.79 (would FIRE at 7/10)'
        WHEN CAST(json_extract(payload_data, '$.confidence') AS REAL) >= 0.60 THEN '0.60-0.69 (WATCH)'
        WHEN CAST(json_extract(payload_data, '$.confidence') AS REAL) >= 0.50 THEN '0.50-0.59 (DEGRADED zone)'
        WHEN json_extract(payload_data, '$.confidence') IS NOT NULL THEN '<0.50'
        ELSE 'null'
      END as band,
      json_extract(payload_data, '$.action') as action,
      COUNT(*) as count
    FROM card_payloads
    WHERE created_at >= ${since}
      AND sport = 'mlb'
      AND card_type NOT LIKE 'fpl%'
    GROUP BY band, action
    ORDER BY band, action
  `).all();

  console.log('\n── Section 5: MLB confidence bands (action × band) ──');
  console.log('   Cards in 0.70-0.79 band with action=PASS would surface if MLB floor drops 8/10→7/10.\n');
  console.log(fmt('Band', 38) + fmt('Action', 10) + 'Count');
  console.log('-'.repeat(60));
  for (const row of mlbConfRows) {
    console.log(fmt(row.band, 38) + fmt(row.action || '?', 10) + row.count);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION 6: Daily surfaced card trend (last 7 days, non-PASS only)
  // ─────────────────────────────────────────────────────────────────────────
  const trendRows = db.prepare(`
    SELECT
      date(created_at) as day,
      sport,
      SUM(CASE WHEN json_extract(payload_data, '$.action') = 'FIRE' THEN 1 ELSE 0 END) as fire,
      SUM(CASE WHEN json_extract(payload_data, '$.action') = 'HOLD' THEN 1 ELSE 0 END) as hold,
      SUM(CASE WHEN json_extract(payload_data, '$.action') = 'PASS' THEN 1 ELSE 0 END) as pass_ct
    FROM card_payloads
    WHERE created_at >= ${since}
      AND card_type NOT LIKE 'fpl%'
      ${sportWhere}
    GROUP BY day, sport
    ORDER BY day DESC, sport
  `).all();

  console.log('\n── Section 6: Daily surfaced trend (FIRE / HOLD / PASS by sport) ──\n');
  console.log(fmt('Date', 14) + fmt('Sport', 8) + fmt('FIRE', 8) + fmt('HOLD', 8) + fmt('PASS', 8));
  console.log('-'.repeat(46));
  for (const row of trendRows) {
    console.log(
      fmt(row.day, 14) +
      fmt(row.sport, 8) +
      fmt(row.fire, 8) +
      fmt(row.hold, 8) +
      fmt(row.pass_ct, 8),
    );
  }

  console.log('\n' + '='.repeat(72));
  console.log('To investigate a specific reason code:');
  console.log("  SELECT payload_data FROM card_payloads WHERE json_extract(payload_data, '$.pass_reason_code') = 'YOUR_CODE' LIMIT 5;");
  console.log('='.repeat(72) + '\n');
}

function fmt(val, width) {
  const s = String(val ?? '');
  return s.length >= width ? s.slice(0, width - 1) + ' ' : s.padEnd(width);
}

try {
  run();
} catch (err) {
  console.error('Suppression funnel report failed:', err.message);
  process.exit(1);
}
