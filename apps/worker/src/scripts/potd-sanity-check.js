'use strict';

require('dotenv').config();

const { withDb, getDatabase } = require('@cheddar-logic/data');
const { confidenceThreshold } = require('../jobs/potd/signal-engine');

const LOOKBACK_DAYS = 30;
const DEFAULT_MIN_EDGE_PCT = Number(process.env.POTD_MIN_EDGE || 0.02);
const DEFAULT_SOFT_SCORE_FLOOR = Number(process.env.POTD_MIN_TOTAL_SCORE || 0.30);
const DEFAULT_DYNAMIC_LIMIT = Number(process.env.POTD_SHADOW_DYNAMIC_LIMIT || 10);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  if (!isFiniteNumber(value)) return null;
  return Number(value.toFixed(digits));
}

function formatPct(value) {
  if (value == null) return '     —';
  return `${(value * 100).toFixed(1).padStart(5)}%`;
}

function formatPctInline(value) {
  if (!isFiniteNumber(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function formatScore(value) {
  if (!isFiniteNumber(value)) return 'n/a';
  return value.toFixed(3);
}

function percentile(values, pct) {
  const numbers = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0];
  const index = (numbers.length - 1) * pct;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return numbers[lower];
  const weight = index - lower;
  return numbers[lower] + ((numbers[upper] - numbers[lower]) * weight);
}

function summarizeValues(values) {
  const numbers = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return { count: 0, min: null, p25: null, median: null, p75: null, max: null };
  }
  return {
    count: numbers.length,
    min: round(numbers[0]),
    p25: round(percentile(numbers, 0.25)),
    median: round(percentile(numbers, 0.5)),
    p75: round(percentile(numbers, 0.75)),
    max: round(numbers[numbers.length - 1]),
  };
}

function summarizeCandidateDistribution(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return {
    count: rows.length,
    edgePct: summarizeValues(rows.map((row) => row.edgePct)),
    totalScore: summarizeValues(rows.map((row) => row.totalScore)),
  };
}

function getEligibilityThresholds({
  minEdgePct = DEFAULT_MIN_EDGE_PCT,
  softScoreFloor = DEFAULT_SOFT_SCORE_FLOOR,
} = {}) {
  const strictScoreFloor = confidenceThreshold('HIGH');
  const eliteScoreFloor = confidenceThreshold('ELITE');
  return {
    minEdgePct,
    softScoreFloor,
    strictScoreFloor,
    strongScoreFloor: round((strictScoreFloor + eliteScoreFloor) / 2),
    eliteScoreFloor,
  };
}

function dynamicEdgeFloorForScore(totalScore, thresholds = getEligibilityThresholds()) {
  if (!isFiniteNumber(totalScore)) return null;
  const minEdgePct = thresholds.minEdgePct;
  if (totalScore >= thresholds.eliteScoreFloor) return round(minEdgePct * 0.25);
  if (totalScore >= thresholds.strongScoreFloor) return round(minEdgePct * 0.5);
  if (totalScore >= thresholds.strictScoreFloor) return round(minEdgePct * 0.75);
  return minEdgePct;
}

function normalizeCandidate(row, source) {
  return {
    source,
    playDate: row.play_date,
    rank: row.nominee_rank ?? null,
    sport: row.sport ?? null,
    marketType: row.market_type ?? null,
    selectionLabel: row.selection_label ?? null,
    homeTeam: row.home_team ?? null,
    awayTeam: row.away_team ?? null,
    gameId: row.game_id ?? null,
    edgePct: toNumber(row.edge_pct),
    totalScore: toNumber(row.total_score),
    confidenceLabel: row.confidence_label ?? null,
    price: row.price ?? null,
    line: row.line ?? null,
  };
}

function classifyCandidate(candidate, thresholds) {
  const edgePct = candidate.edgePct;
  const totalScore = candidate.totalScore;
  const dynamicFloor = dynamicEdgeFloorForScore(totalScore, thresholds);
  const hasEdgeAndScore = isFiniteNumber(edgePct) && isFiniteNumber(totalScore);
  const strictEligible =
    hasEdgeAndScore &&
    edgePct >= thresholds.minEdgePct &&
    totalScore >= thresholds.strictScoreFloor;
  const softEligible =
    hasEdgeAndScore &&
    edgePct > 0 &&
    totalScore >= thresholds.softScoreFloor;
  const dynamicEligible =
    hasEdgeAndScore &&
    edgePct > 0 &&
    totalScore >= thresholds.strictScoreFloor &&
    edgePct >= dynamicFloor;

  return {
    ...candidate,
    dynamicFloor,
    strictEligible,
    softEligible,
    dynamicEligible,
    dynamicShadowOnly: dynamicEligible && !strictEligible,
  };
}

function summarizeEligibility(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return {
    total: rows.length,
    strictEligible: rows.filter((row) => row.strictEligible).length,
    softEligible: rows.filter((row) => row.softEligible).length,
    dynamicEligible: rows.filter((row) => row.dynamicEligible).length,
    dynamicShadowOnly: rows.filter((row) => row.dynamicShadowOnly).length,
  };
}

function sortCandidatesForReport(a, b) {
  if (a.playDate !== b.playDate) return a.playDate < b.playDate ? 1 : -1;
  if (a.dynamicShadowOnly !== b.dynamicShadowOnly) return a.dynamicShadowOnly ? -1 : 1;
  if ((b.totalScore ?? -Infinity) !== (a.totalScore ?? -Infinity)) {
    return (b.totalScore ?? -Infinity) - (a.totalScore ?? -Infinity);
  }
  if ((b.edgePct ?? -Infinity) !== (a.edgePct ?? -Infinity)) {
    return (b.edgePct ?? -Infinity) - (a.edgePct ?? -Infinity);
  }
  const keyA = `${a.sport || ''}:${a.gameId || ''}:${a.marketType || ''}:${a.selectionLabel || ''}`;
  const keyB = `${b.sport || ''}:${b.gameId || ''}:${b.marketType || ''}:${b.selectionLabel || ''}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function buildShadowEligibilityReport({
  nomineeRows = [],
  shadowRows = [],
  thresholds: thresholdOverrides = {},
  dynamicLimit = DEFAULT_DYNAMIC_LIMIT,
} = {}) {
  const thresholds = getEligibilityThresholds(thresholdOverrides);
  const nominees = nomineeRows
    .map((row) => normalizeCandidate(row, 'nominee'))
    .map((row) => classifyCandidate(row, thresholds));
  const shadowCandidates = shadowRows
    .map((row) => normalizeCandidate(row, 'shadow'))
    .map((row) => classifyCandidate(row, thresholds));
  const allCandidates = nominees.concat(shadowCandidates);
  const latestDate = allCandidates
    .map((row) => row.playDate)
    .filter(Boolean)
    .sort()
    .pop() || null;
  const currentCandidates = latestDate
    ? allCandidates.filter((row) => row.playDate === latestDate)
    : [];
  const dynamicFloorCandidates = allCandidates
    .filter((row) => row.dynamicEligible)
    .sort(sortCandidatesForReport)
    .slice(0, dynamicLimit);

  return {
    thresholds,
    latestDate,
    current: summarizeEligibility(currentCandidates),
    nominees: {
      summary: summarizeEligibility(nominees),
      distribution: summarizeCandidateDistribution(nominees),
    },
    shadow: {
      summary: summarizeEligibility(shadowCandidates),
      distribution: summarizeCandidateDistribution(shadowCandidates),
    },
    all: {
      summary: summarizeEligibility(allCandidates),
      distribution: summarizeCandidateDistribution(allCandidates),
    },
    dynamicFloorCandidates,
  };
}

function formatDistribution(label, distribution) {
  const edge = distribution.edgePct;
  const score = distribution.totalScore;
  return [
    `${label}: count=${distribution.count}`,
    `edge[min/p25/med/p75/max]=${formatPctInline(edge.min)}/${formatPctInline(edge.p25)}/${formatPctInline(edge.median)}/${formatPctInline(edge.p75)}/${formatPctInline(edge.max)}`,
    `score[min/p25/med/p75/max]=${formatScore(score.min)}/${formatScore(score.p25)}/${formatScore(score.median)}/${formatScore(score.p75)}/${formatScore(score.max)}`,
  ].join('   ');
}

function formatEligibilitySummary(label, summary) {
  return `${label.padEnd(9)} rows=${String(summary.total).padStart(3)}  strict=${String(summary.strictEligible).padStart(3)}  soft=${String(summary.softEligible).padStart(3)}  dynamic=${String(summary.dynamicEligible).padStart(3)}  dynamic_only=${String(summary.dynamicShadowOnly).padStart(3)}`;
}

function formatShadowEligibilityReport(report) {
  const lines = [];
  lines.push('');
  lines.push('POTD Shadow Eligibility Report');
  lines.push('─'.repeat(82));
  if (!report.latestDate) {
    lines.push('No POTD nominee or shadow candidate rows found for eligibility analysis.');
    lines.push('');
    return lines;
  }

  const t = report.thresholds;
  lines.push(
    `latest_date=${report.latestDate}  strict=edge>=${formatPctInline(t.minEdgePct)} & score>=${formatScore(t.strictScoreFloor)}  soft=edge>0 & score>=${formatScore(t.softScoreFloor)}`,
  );
  lines.push(
    `dynamic_floor: score>=${formatScore(t.eliteScoreFloor)} => edge>=${formatPctInline(t.minEdgePct * 0.25)}, ` +
      `score>=${formatScore(t.strongScoreFloor)} => edge>=${formatPctInline(t.minEdgePct * 0.5)}, ` +
      `score>=${formatScore(t.strictScoreFloor)} => edge>=${formatPctInline(t.minEdgePct * 0.75)}`,
  );
  lines.push('');
  lines.push('Eligibility counts');
  lines.push(formatEligibilitySummary('current', report.current));
  lines.push(formatEligibilitySummary('nominees', report.nominees.summary));
  lines.push(formatEligibilitySummary('shadow', report.shadow.summary));
  lines.push(formatEligibilitySummary('all', report.all.summary));
  lines.push('');
  lines.push('Nominee score/edge distribution');
  lines.push(formatDistribution('nominees', report.nominees.distribution));
  if (report.shadow.distribution.count > 0) {
    lines.push(formatDistribution('shadow', report.shadow.distribution));
  }
  lines.push('');
  lines.push('Score-based dynamic floor candidates');
  if (report.dynamicFloorCandidates.length === 0) {
    lines.push('No persisted candidates qualify under the dynamic floor.');
  } else {
    lines.push(
      'date'.padEnd(12) +
        'src'.padEnd(9) +
        'sport'.padEnd(7) +
        'market'.padEnd(11) +
        'edge'.padEnd(10) +
        'score'.padEnd(8) +
        'floor'.padEnd(10) +
        'selection',
    );
    for (const row of report.dynamicFloorCandidates) {
      const source = row.dynamicShadowOnly ? `${row.source}*` : row.source;
      lines.push(
        String(row.playDate || '').padEnd(12) +
          source.padEnd(9) +
          String(row.sport || '').padEnd(7) +
          String(row.marketType || '').padEnd(11) +
          formatPctInline(row.edgePct).padEnd(10) +
          formatScore(row.totalScore).padEnd(8) +
          formatPctInline(row.dynamicFloor).padEnd(10) +
          String(row.selectionLabel || ''),
      );
    }
    lines.push('* dynamic_only: qualifies under dynamic floor but not current strict edge floor');
  }
  lines.push('─'.repeat(82));
  lines.push('');
  return lines;
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName),
  );
}

function loadDailyRows(db, lookbackDays = LOOKBACK_DAYS) {
  if (!tableExists(db, 'potd_daily_stats')) return [];
  return db
    .prepare(
      `SELECT play_date, potd_fired, viable_count, top_edge_pct, stake_pct_of_bankroll
       FROM potd_daily_stats
       ORDER BY play_date DESC
       LIMIT ?`,
    )
    .all(lookbackDays);
}

function loadNomineeRows(db, lookbackDays = LOOKBACK_DAYS) {
  if (!tableExists(db, 'potd_nominees')) return [];
  return db
    .prepare(
      `WITH recent_dates AS (
         SELECT DISTINCT play_date
         FROM potd_nominees
         ORDER BY play_date DESC
         LIMIT ?
       )
       SELECT play_date, nominee_rank, sport, game_id, home_team, away_team,
              market_type, selection_label, line, price, edge_pct, total_score,
              confidence_label
       FROM potd_nominees
       WHERE play_date IN (SELECT play_date FROM recent_dates)
       ORDER BY play_date DESC, nominee_rank ASC`,
    )
    .all(lookbackDays);
}

function loadShadowRows(db, lookbackDays = LOOKBACK_DAYS) {
  if (!tableExists(db, 'potd_shadow_candidates')) return [];
  return db
    .prepare(
      `WITH recent_dates AS (
         SELECT DISTINCT play_date
         FROM potd_shadow_candidates
         ORDER BY play_date DESC
         LIMIT ?
       )
       SELECT play_date, sport, game_id, home_team, away_team,
              market_type, selection_label, line, price, edge_pct, total_score
       FROM potd_shadow_candidates
       WHERE play_date IN (SELECT play_date FROM recent_dates)
       ORDER BY play_date DESC, total_score DESC, edge_pct DESC`,
    )
    .all(lookbackDays);
}

async function runSanityCheck() {
  await withDb(async () => {
    const db = getDatabase();
    const rows = loadDailyRows(db);

    if (rows.length === 0) {
      console.log('No potd_daily_stats rows found (table empty — no runs recorded yet).');
    } else {
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
    }

    const report = buildShadowEligibilityReport({
      nomineeRows: loadNomineeRows(db),
      shadowRows: loadShadowRows(db),
    });
    for (const line of formatShadowEligibilityReport(report)) {
      console.log(line);
    }
  });
}

if (require.main === module) {
  runSanityCheck().catch(err => {
    console.error('[potd-sanity-check] Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildShadowEligibilityReport,
  classifyCandidate,
  dynamicEdgeFloorForScore,
  formatShadowEligibilityReport,
  getEligibilityThresholds,
  loadDailyRows,
  loadNomineeRows,
  loadShadowRows,
  runSanityCheck,
  summarizeValues,
};
