'use strict';

const fs = require('fs');
const path = require('path');
const {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} = require('../packages/data/src/db.js');
const { resolveDatabasePath } = require('../packages/data/src/db-path.js');
const {
  resolveThresholdProfile,
} = require('../packages/models/src/decision-pipeline-v2-edge-config.js');
const edgeCalculator = require('../packages/models/src/edge-calculator.js');

const REPORT_PATH = path.resolve(
  __dirname,
  '../docs/runbooks/nba-totals-calibration-2026-03.md',
);
const SAMPLE_LIMIT = 100;
const CURRENT_SIGMA = 14;
const MIN_SAMPLE_FOR_RECOMMENDATION = 30;
const MODEL_BIAS_THRESHOLD = 2.0;
const SIGMA_DELTA_FRACTION_THRESHOLD = 0.15;
const THRESHOLD_DELTA_FRACTION_THRESHOLD = 0.15;
const DRY_RUN = process.argv.includes('--dry-run');

function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function formatNumber(value, decimals = 3) {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'n/a';
}

function formatPct(value, decimals = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : 'n/a';
}

function formatUnits(value, decimals = 2) {
  return Number.isFinite(value) ? `${value.toFixed(decimals)}u` : 'n/a';
}

function formatRecord({ wins, losses, pushes }) {
  return `${wins}-${losses}-${pushes}`;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function mae(values) {
  return mean(values.map((value) => Math.abs(value)));
}

function rmse(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const mse = mean(values.map((value) => value * value));
  return Number.isFinite(mse) ? Math.sqrt(mse) : null;
}

function normalizeSelection(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized === 'OVER' || normalized === 'UNDER' ? normalized : null;
}

function resolvePayloadPrice(payload, selection) {
  if (!payload || !selection) return null;

  const paths =
    selection === 'OVER'
      ? [
          payload.price,
          payload.market_context?.wager?.called_price,
          payload.pricing_trace?.called_price,
          payload.odds_context?.total_price_over,
          payload.market?.total_price_over,
        ]
      : [
          payload.price,
          payload.market_context?.wager?.called_price,
          payload.pricing_trace?.called_price,
          payload.odds_context?.total_price_under,
          payload.market?.total_price_under,
        ];

  for (const candidate of paths) {
    const parsed = toNumber(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveProjectedTotal(payload) {
  const candidates = [
    payload?.projection?.total,
    payload?.market_context?.projection?.total,
    payload?.projection?.projected_total,
  ];
  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveEdgePct(payload) {
  const candidates = [payload?.edge_pct, payload?.edge];
  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveRow(row, droppedReasonCounts) {
  const payload = parseJsonObject(row.payload_data);
  const projectedTotal = resolveProjectedTotal(payload);
  if (!Number.isFinite(projectedTotal)) {
    droppedReasonCounts.missing_projection = (droppedReasonCounts.missing_projection || 0) + 1;
    return null;
  }

  const selection = normalizeSelection(row.selection)
    || normalizeSelection(payload?.selection?.side)
    || normalizeSelection(payload?.prediction);
  if (!selection) {
    droppedReasonCounts.missing_selection = (droppedReasonCounts.missing_selection || 0) + 1;
    return null;
  }

  const line = toNumber(row.line, toNumber(payload?.line));
  if (!Number.isFinite(line)) {
    droppedReasonCounts.missing_line = (droppedReasonCounts.missing_line || 0) + 1;
    return null;
  }

  const price = toNumber(row.locked_price, resolvePayloadPrice(payload, selection));
  if (!Number.isFinite(price)) {
    droppedReasonCounts.missing_price = (droppedReasonCounts.missing_price || 0) + 1;
    return null;
  }

  const actualTotal = Number.isFinite(toNumber(row.final_score_home))
    && Number.isFinite(toNumber(row.final_score_away))
    ? toNumber(row.final_score_home) + toNumber(row.final_score_away)
    : null;
  if (!Number.isFinite(actualTotal)) {
    droppedReasonCounts.missing_final_score = (droppedReasonCounts.missing_final_score || 0) + 1;
    return null;
  }

  const resultToken = String(row.result || '').trim().toLowerCase();
  const result =
    resultToken === 'win' || resultToken === 'loss' || resultToken === 'push'
      ? resultToken
      : null;

  return {
    cardId: row.card_id,
    gameId: row.game_id,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    projectedTotal,
    selection,
    line,
    price,
    edgePct: resolveEdgePct(payload),
    actualTotal,
    result,
  };
}

function createRecordAccumulator() {
  return {
    sampleSize: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    stakeDecisions: 0,
    units: 0,
    biases: [],
    absErrors: [],
    edges: [],
  };
}

function addRowToAccumulator(accumulator, row) {
  accumulator.sampleSize += 1;
  accumulator.biases.push(row.bias);
  accumulator.absErrors.push(Math.abs(row.bias));
  if (Number.isFinite(row.edgePct)) accumulator.edges.push(row.edgePct);

  if (row.result === 'win') {
    accumulator.wins += 1;
    accumulator.stakeDecisions += 1;
    accumulator.units += row.price > 0 ? row.price / 100 : 100 / Math.abs(row.price);
  } else if (row.result === 'loss') {
    accumulator.losses += 1;
    accumulator.stakeDecisions += 1;
    accumulator.units -= 1;
  } else if (row.result === 'push') {
    accumulator.pushes += 1;
  }
}

function finalizeAccumulator(accumulator) {
  return {
    sampleSize: accumulator.sampleSize,
    wins: accumulator.wins,
    losses: accumulator.losses,
    pushes: accumulator.pushes,
    winRate:
      accumulator.stakeDecisions > 0
        ? accumulator.wins / accumulator.stakeDecisions
        : null,
    roi:
      accumulator.sampleSize > 0
        ? accumulator.units / accumulator.sampleSize
        : null,
    units: round(accumulator.units, 3),
    meanBias: round(mean(accumulator.biases), 3),
    mae: round(mean(accumulator.absErrors), 3),
    avgEdge: round(mean(accumulator.edges), 4),
  };
}

function bucketForEdge(edgePct) {
  if (!Number.isFinite(edgePct)) return 'missing';
  const absoluteEdge = Math.abs(edgePct);
  if (absoluteEdge < 0.01) return '<1%';
  if (absoluteEdge < 0.02) return '1-2%';
  if (absoluteEdge < 0.04) return '2-4%';
  return '4%+';
}

function buildSideSplits(rows) {
  const splits = new Map([
    ['OVER', createRecordAccumulator()],
    ['UNDER', createRecordAccumulator()],
  ]);

  for (const row of rows) {
    addRowToAccumulator(splits.get(row.selection), row);
  }

  return Array.from(splits.entries()).map(([selection, accumulator]) => ({
    selection,
    ...finalizeAccumulator(accumulator),
  }));
}

function buildEdgeBuckets(rows) {
  const orderedLabels = ['<1%', '1-2%', '2-4%', '4%+'];
  const buckets = new Map(orderedLabels.map((label) => [label, createRecordAccumulator()]));

  for (const row of rows) {
    const label = bucketForEdge(row.edgePct);
    if (label === 'missing') continue;
    addRowToAccumulator(buckets.get(label), row);
  }

  return orderedLabels.map((label) => ({
    bucket: label,
    ...finalizeAccumulator(buckets.get(label)),
  }));
}

function classifyStatus(edgePct, thresholds) {
  if (!Number.isFinite(edgePct)) return 'PASS';
  if (edgePct >= thresholds.edge.play_edge_min) return 'PLAY';
  if (edgePct >= thresholds.edge.lean_edge_min) return 'LEAN';
  return 'PASS';
}

function buildSigmaSensitivity(rows, empiricalSigma, thresholds) {
  const current = {
    label: 'current_sigma_14',
    sigma: CURRENT_SIGMA,
    pFairValues: [],
    edgeValues: [],
    playCount: 0,
    leanOrBetterCount: 0,
  };
  const empirical = {
    label: 'empirical_sigma',
    sigma: empiricalSigma,
    pFairValues: [],
    edgeValues: [],
    playCount: 0,
    leanOrBetterCount: 0,
  };

  let changedThresholdClassifications = 0;

  for (const row of rows) {
    const currentResult = edgeCalculator.computeTotalEdge({
      projectionTotal: row.projectedTotal,
      totalLine: row.line,
      totalPriceOver: row.selection === 'OVER' ? row.price : null,
      totalPriceUnder: row.selection === 'UNDER' ? row.price : null,
      sigmaTotal: CURRENT_SIGMA,
      isPredictionOver: row.selection === 'OVER',
    });
    const empiricalResult = edgeCalculator.computeTotalEdge({
      projectionTotal: row.projectedTotal,
      totalLine: row.line,
      totalPriceOver: row.selection === 'OVER' ? row.price : null,
      totalPriceUnder: row.selection === 'UNDER' ? row.price : null,
      sigmaTotal: empiricalSigma,
      isPredictionOver: row.selection === 'OVER',
    });

    if (Number.isFinite(currentResult?.p_fair)) current.pFairValues.push(currentResult.p_fair);
    if (Number.isFinite(currentResult?.edge)) current.edgeValues.push(currentResult.edge);
    if (Number.isFinite(empiricalResult?.p_fair)) empirical.pFairValues.push(empiricalResult.p_fair);
    if (Number.isFinite(empiricalResult?.edge)) empirical.edgeValues.push(empiricalResult.edge);

    const currentStatus = classifyStatus(currentResult?.edge, thresholds);
    const empiricalStatus = classifyStatus(empiricalResult?.edge, thresholds);

    if (currentStatus === 'PLAY') current.playCount += 1;
    if (currentStatus === 'PLAY' || currentStatus === 'LEAN') current.leanOrBetterCount += 1;
    if (empiricalStatus === 'PLAY') empirical.playCount += 1;
    if (empiricalStatus === 'PLAY' || empiricalStatus === 'LEAN') empirical.leanOrBetterCount += 1;
    if (currentStatus !== empiricalStatus) changedThresholdClassifications += 1;
  }

  return {
    current: {
      ...current,
      avgPFair: round(mean(current.pFairValues), 4),
      avgEdge: round(mean(current.edgeValues), 4),
    },
    empirical: {
      ...empirical,
      avgPFair: round(mean(empirical.pFairValues), 4),
      avgEdge: round(mean(empirical.edgeValues), 4),
    },
    changedThresholdClassifications,
    changedThresholdFraction:
      rows.length > 0 ? changedThresholdClassifications / rows.length : 0,
  };
}

function determineRecommendation({ usableRows, meanBiasValue, empiricalSigma, sigmaSensitivity }) {
  if (usableRows < MIN_SAMPLE_FOR_RECOMMENDATION) {
    return {
      recommendation: 'insufficient sample',
      rationale: `Usable sample ${usableRows} is below minimum ${MIN_SAMPLE_FOR_RECOMMENDATION}.`,
    };
  }

  if (Math.abs(meanBiasValue) >= MODEL_BIAS_THRESHOLD) {
    return {
      recommendation: 'model biased',
      rationale: `Absolute mean bias ${formatNumber(Math.abs(meanBiasValue), 3)} meets or exceeds ${MODEL_BIAS_THRESHOLD.toFixed(1)} points.`,
    };
  }

  const sigmaDiffFraction = Math.abs(empiricalSigma - CURRENT_SIGMA) / CURRENT_SIGMA;
  if (
    sigmaDiffFraction >= SIGMA_DELTA_FRACTION_THRESHOLD &&
    sigmaSensitivity.changedThresholdFraction >= THRESHOLD_DELTA_FRACTION_THRESHOLD
  ) {
    return {
      recommendation: 'sigma/plumbing issue',
      rationale:
        `Empirical sigma differs from ${CURRENT_SIGMA} by ${formatPct(sigmaDiffFraction, 1)} ` +
        `and threshold classification changes on ${formatPct(sigmaSensitivity.changedThresholdFraction, 1)} of usable rows.`,
    };
  }

  return {
    recommendation: 'thresholds too loose',
    rationale:
      'Bias is below the model-repair threshold and sigma sensitivity does not justify holding the issue at plumbing.',
  };
}

function buildDecisionImpact(recommendation) {
  if (recommendation === 'thresholds too loose') {
    return {
      gate: 'Proceed',
      note: 'WI-0589 may proceed because the diagnostic points to threshold aggression rather than projection repair or sigma plumbing.',
    };
  }
  return {
    gate: 'Hold',
    note: 'WI-0589 remains blocked until the model-bias or sigma-sensitivity issue is resolved, or the sample grows large enough.',
  };
}

function buildReport({
  dbPath,
  matchedRows,
  usableRows,
  droppedReasonCounts,
  window,
  overall,
  sideSplits,
  edgeBuckets,
  empiricalSigma,
  sigmaSource,
  sigmaGamesSampled,
  sigmaSensitivity,
  thresholds,
  recommendation,
  recommendationRationale,
  decisionImpact,
}) {
  const generatedAt = new Date().toISOString();
  const droppedRows = matchedRows - usableRows;

  const sideRows = sideSplits
    .map(
      (row) =>
        `| ${row.selection} | ${row.sampleSize} | ${formatRecord(row)} | ${formatPct(row.winRate, 1)} | ${formatUnits(row.units)} | ${formatPct(row.roi, 1)} | ${formatNumber(row.meanBias, 2)} | ${formatNumber(row.mae, 2)} | ${formatPct(row.avgEdge, 2)} |`,
    )
    .join('\n');

  const edgeRows = edgeBuckets
    .map(
      (row) =>
        `| ${row.bucket} | ${row.sampleSize} | ${formatRecord(row)} | ${formatPct(row.winRate, 1)} | ${formatUnits(row.units)} | ${formatPct(row.roi, 1)} | ${formatNumber(row.meanBias, 2)} |`,
    )
    .join('\n');

  const droppedLines =
    Object.keys(droppedReasonCounts).length === 0
      ? '- none'
      : Object.entries(droppedReasonCounts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([reason, count]) => `- ${reason}: ${count}`)
          .join('\n');

  return `# NBA Totals Calibration Diagnostic — March 2026

**Generated:** ${generatedAt}
**DB:** ${dbPath}
**Sample window:** ${window.start || 'n/a'} -> ${window.end || 'n/a'}

## Summary

| Metric | Value |
|--------|-------|
| Settled rows matched | ${matchedRows} |
| Usable rows analyzed | ${usableRows} |
| Dropped rows | ${droppedRows} |
| Mean bias (projected_total - actual_total) | ${formatNumber(overall.meanBias, 3)} |
| Median bias (projected_total - actual_total) | ${formatNumber(overall.medianBias, 3)} |
| MAE | ${formatNumber(overall.mae, 3)} |
| RMSE | ${formatNumber(overall.rmse, 3)} |
| Current sigma | ${CURRENT_SIGMA.toFixed(1)} |
| Empirical sigma | ${formatNumber(empiricalSigma, 3)} |
| Sigma source | ${sigmaSource} |
| Sigma games sampled | ${sigmaGamesSampled != null ? sigmaGamesSampled : 'n/a'} |

## Data Quality

${droppedLines}

## Over/Under Split

| Side | Rows | W-L-P | Win Rate | Units | ROI | Mean Bias | MAE | Avg Edge |
|------|------|-------|----------|-------|-----|-----------|-----|----------|
${sideRows}

## Edge Buckets

| Edge Bucket | Rows | W-L-P | Win Rate | Units | ROI | Mean Bias |
|-------------|------|-------|----------|-------|-----|-----------|
${edgeRows}

## Sigma Sensitivity

Current thresholds use NBA TOTAL support ${formatNumber(thresholds.support.lean, 3)}/${formatNumber(thresholds.support.play, 3)} and edge ${formatPct(thresholds.edge.lean_edge_min, 1)}/${formatPct(thresholds.edge.play_edge_min, 1)} for LEAN/PLAY.

| Mapping | Sigma | Avg p_fair | Avg Edge | LEAN+ Count | PLAY Count |
|---------|-------|------------|----------|-------------|------------|
| ${sigmaSensitivity.current.label} | ${formatNumber(sigmaSensitivity.current.sigma, 3)} | ${formatNumber(sigmaSensitivity.current.avgPFair, 4)} | ${formatPct(sigmaSensitivity.current.avgEdge, 2)} | ${sigmaSensitivity.current.leanOrBetterCount} | ${sigmaSensitivity.current.playCount} |
| ${sigmaSensitivity.empirical.label} | ${formatNumber(sigmaSensitivity.empirical.sigma, 3)} | ${formatNumber(sigmaSensitivity.empirical.avgPFair, 4)} | ${formatPct(sigmaSensitivity.empirical.avgEdge, 2)} | ${sigmaSensitivity.empirical.leanOrBetterCount} | ${sigmaSensitivity.empirical.playCount} |

Threshold classification changed on ${sigmaSensitivity.changedThresholdClassifications}/${usableRows} rows (${formatPct(sigmaSensitivity.changedThresholdFraction, 1)}).

## Recommendation

Final recommendation: ${recommendation}

${recommendationRationale}

## Decision Impact

WI-0589 gate: ${decisionImpact.gate}

${decisionImpact.note}

## Methodology

- Source rows: latest ${SAMPLE_LIMIT} settled nba-totals-call rows by card_results.settled_at DESC, or all available if fewer.
- Tables: card_payloads + card_results + game_results.
- Filters: cp.sport='nba', cp.card_type='nba-totals-call', cr.status='settled', cr.market_type='TOTAL', gr.status='final'.
- Field priority:
  - projected total: payload.projection.total -> payload.market_context.projection.total -> payload.projection.projected_total
  - selection: card_results.selection -> payload.selection.side -> payload.prediction
  - line: card_results.line -> payload.line
  - price: card_results.locked_price -> pick-side payload price
  - edge: payload.edge_pct -> payload.edge
  - actual total: game_results.final_score_home + game_results.final_score_away
- Pushes stay in sample counts and ROI denominator, but are excluded from win-rate denominators and count as 0.0 units.
`;
}

async function main() {
  const db = getDatabaseReadOnly();

  try {
    const rows = db.prepare(`
      SELECT
        cp.id AS card_id,
        cp.game_id,
        cp.created_at,
        cp.payload_data,
        cr.selection,
        cr.line,
        cr.locked_price,
        cr.result,
        cr.settled_at,
        gr.final_score_home,
        gr.final_score_away
      FROM card_payloads cp
      INNER JOIN card_results cr ON cr.card_id = cp.id
      INNER JOIN game_results gr ON gr.game_id = cp.game_id
      WHERE cp.sport = 'nba'
        AND cp.card_type = 'nba-totals-call'
        AND LOWER(COALESCE(cr.status, '')) = 'settled'
        AND UPPER(COALESCE(cr.market_type, '')) = 'TOTAL'
        AND LOWER(COALESCE(gr.status, '')) = 'final'
      ORDER BY datetime(cr.settled_at) DESC
      LIMIT ?
    `).all(SAMPLE_LIMIT);

    const matchedRows = rows.length;
    const droppedReasonCounts = {};
    const usable = [];

    for (const row of rows) {
      const resolved = resolveRow(row, droppedReasonCounts);
      if (!resolved) continue;
      usable.push({
        ...resolved,
        bias: resolved.projectedTotal - resolved.actualTotal,
      });
    }

    const thresholds = resolveThresholdProfile({ sport: 'NBA', marketType: 'TOTAL' });
    const sigmaFromHistory = edgeCalculator.computeSigmaFromHistory({
      sport: 'NBA',
      db,
    });
    const empiricalSigma = Number.isFinite(toNumber(sigmaFromHistory?.total))
      ? toNumber(sigmaFromHistory.total)
      : CURRENT_SIGMA;

    const overall = {
      meanBias: round(mean(usable.map((row) => row.bias)), 3),
      medianBias: round(median(usable.map((row) => row.bias)), 3),
      mae: round(mae(usable.map((row) => row.bias)), 3),
      rmse: round(rmse(usable.map((row) => row.bias)), 3),
    };

    const sideSplits = buildSideSplits(usable);
    const edgeBuckets = buildEdgeBuckets(usable);
    const sigmaSensitivity = buildSigmaSensitivity(usable, empiricalSigma, thresholds);
    const { recommendation, rationale } = determineRecommendation({
      usableRows: usable.length,
      meanBiasValue: overall.meanBias || 0,
      empiricalSigma,
      sigmaSensitivity,
    });
    const decisionImpact = buildDecisionImpact(recommendation);
    const window = {
      start: rows.length > 0 ? rows[rows.length - 1].settled_at : null,
      end: rows.length > 0 ? rows[0].settled_at : null,
    };
    const resolvedDb = resolveDatabasePath();

    if (DRY_RUN) {
      console.log('[calibrate_nba_totals] --dry-run mode');
      console.log(`  matched_rows: ${matchedRows}`);
      console.log(`  usable_rows: ${usable.length}`);
      console.log(`  sample_window: ${window.start || 'n/a'} -> ${window.end || 'n/a'}`);
      console.log(`  report_path: ${REPORT_PATH}`);
      return;
    }

    const report = buildReport({
      dbPath: resolvedDb.dbPath,
      matchedRows,
      usableRows: usable.length,
      droppedReasonCounts,
      window,
      overall,
      sideSplits,
      edgeBuckets,
      empiricalSigma,
      sigmaSource: sigmaFromHistory?.sigma_source || 'fallback',
      sigmaGamesSampled: sigmaFromHistory?.games_sampled ?? null,
      sigmaSensitivity,
      thresholds,
      recommendation,
      recommendationRationale: rationale,
      decisionImpact,
    });

    fs.writeFileSync(REPORT_PATH, report, 'utf8');

    console.log('[calibrate_nba_totals] Run complete');
    console.log(`  matched_rows: ${matchedRows}`);
    console.log(`  usable_rows: ${usable.length}`);
    console.log(`  current_sigma: ${CURRENT_SIGMA.toFixed(1)}`);
    console.log(`  empirical_sigma: ${formatNumber(empiricalSigma, 3)}`);
    console.log(`  recommendation: ${recommendation}`);
    console.log(`  report_path: ${REPORT_PATH}`);
  } finally {
    closeReadOnlyInstance(db);
  }
}

main().catch((error) => {
  console.error('[calibrate_nba_totals] ERROR:', error.message);
  process.exit(1);
});
