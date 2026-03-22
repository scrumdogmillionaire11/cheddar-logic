'use strict';

require('dotenv').config();

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
  initDb,
  resolveDatabasePath,
} = require('@cheddar-logic/data');
const { edgeCalculator, marginToWinProbability } = require('@cheddar-logic/models');

const DEFAULT_WINDOW_DAYS = 14;
const PROJECTION_MIN_SAMPLE = 100;
const CLV_MIN_SAMPLE = 150;
const PROJECTION_WIN_RATE_FLOOR = 0.48;
const CONFIDENCE_DRIFT_THRESHOLD = 0.03;
const CLV_MEAN_THRESHOLD = -0.02;
const CLV_P25_THRESHOLD = -0.05;
const MAX_DIAGNOSTIC_BUCKETS = 5;
const NHL_ML_BASELINE_SIGMA = 12;
const NHL_ML_DEFAULT_SELECTED_SIGMA = 2;
const NHL_ML_LOGLOSS_EPSILON = 1e-6;
const NHL_ML_RELIABILITY_BIN_RANGES = Object.freeze([
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0],
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    help: false,
    enforce: false,
    days: DEFAULT_WINDOW_DAYS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--enforce') {
      options.enforce = true;
      continue;
    }
    if (arg.startsWith('--days=')) {
      options.days = parsePositiveInteger(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--days') {
      options.days = parsePositiveInteger(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isFinite(options.days) || options.days <= 0) {
    options.days = DEFAULT_WINDOW_DAYS;
  }

  return options;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function tableExists(db, tableName) {
  const row = db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `,
    )
    .get(tableName);
  return Boolean(row?.name);
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toRounded(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
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

function clampProbability(value) {
  if (!Number.isFinite(value)) return null;
  if (value <= NHL_ML_LOGLOSS_EPSILON) return NHL_ML_LOGLOSS_EPSILON;
  if (value >= 1 - NHL_ML_LOGLOSS_EPSILON) return 1 - NHL_ML_LOGLOSS_EPSILON;
  return value;
}

function formatPct(value, decimals = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(decimals)}%`;
}

function checkStatus({ gateMet, breached }) {
  if (!gateMet) return 'INSUFFICIENT_DATA';
  return breached ? 'FAIL' : 'PASS';
}

function buildProjectionLedgerReport(db, windowDays) {
  const exists = tableExists(db, 'projection_perf_ledger');
  if (!exists) {
    return {
      table: 'projection_perf_ledger',
      tablePresent: false,
      sampleSize: 0,
      minSample: PROJECTION_MIN_SAMPLE,
      sampleGateMet: false,
      winRate: null,
      highWinRate: null,
      mediumWinRate: null,
      confidenceDrift: null,
      checks: {
        winRateFloor: {
          threshold: `>= ${formatPct(PROJECTION_WIN_RATE_FLOOR)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
        confidenceDrift: {
          threshold: `< ${formatPct(CONFIDENCE_DRIFT_THRESHOLD)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
      },
    };
  }

  const row = db
    .prepare(
      `
      WITH windowed AS (
        SELECT won, confidence
        FROM projection_perf_ledger
        WHERE settled_at IS NOT NULL
          AND datetime(settled_at) >= datetime('now', ?)
      )
      SELECT
        COUNT(*) AS sample_size,
        AVG(CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END) AS win_rate,
        SUM(CASE WHEN UPPER(COALESCE(confidence, '')) = 'HIGH' THEN 1 ELSE 0 END) AS high_sample,
        AVG(
          CASE
            WHEN UPPER(COALESCE(confidence, '')) = 'HIGH'
            THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END
            ELSE NULL
          END
        ) AS high_win_rate,
        SUM(CASE WHEN UPPER(COALESCE(confidence, '')) = 'MEDIUM' THEN 1 ELSE 0 END) AS medium_sample,
        AVG(
          CASE
            WHEN UPPER(COALESCE(confidence, '')) = 'MEDIUM'
            THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END
            ELSE NULL
          END
        ) AS medium_win_rate
      FROM windowed
    `,
    )
    .get(`-${windowDays} days`);

  const sampleSize = toNumber(row?.sample_size, 0);
  const highSample = toNumber(row?.high_sample, 0);
  const mediumSample = toNumber(row?.medium_sample, 0);
  const winRate = toNumber(row?.win_rate);
  const highWinRate = toNumber(row?.high_win_rate);
  const mediumWinRate = toNumber(row?.medium_win_rate);
  const sampleGateMet = sampleSize >= PROJECTION_MIN_SAMPLE;
  const confidencePairAvailable = highSample > 0 && mediumSample > 0;
  const confidenceDrift =
    Number.isFinite(mediumWinRate) && Number.isFinite(highWinRate)
      ? mediumWinRate - highWinRate
      : null;

  const winRateBreached = sampleGateMet && Number.isFinite(winRate)
    ? winRate < PROJECTION_WIN_RATE_FLOOR
    : false;
  const driftBreached =
    sampleGateMet && confidencePairAvailable && Number.isFinite(confidenceDrift)
      ? confidenceDrift >= CONFIDENCE_DRIFT_THRESHOLD
      : false;

  return {
    table: 'projection_perf_ledger',
    tablePresent: true,
    sampleSize,
    minSample: PROJECTION_MIN_SAMPLE,
    sampleGateMet,
    winRate: toRounded(winRate),
    highWinRate: toRounded(highWinRate),
    mediumWinRate: toRounded(mediumWinRate),
    confidenceDrift: toRounded(confidenceDrift),
    checks: {
      winRateFloor: {
        threshold: `>= ${formatPct(PROJECTION_WIN_RATE_FLOOR)}`,
        status: checkStatus({ gateMet: sampleGateMet, breached: winRateBreached }),
        breached: winRateBreached,
      },
      confidenceDrift: {
        threshold: `< ${formatPct(CONFIDENCE_DRIFT_THRESHOLD)}`,
        status: checkStatus({
          gateMet: sampleGateMet && confidencePairAvailable,
          breached: driftBreached,
        }),
        breached: driftBreached,
        details: {
          highSample,
          mediumSample,
        },
      },
    },
  };
}

function buildClvLedgerReport(db, windowDays) {
  const exists = tableExists(db, 'clv_ledger');
  if (!exists) {
    return {
      table: 'clv_ledger',
      tablePresent: false,
      sampleSize: 0,
      minSample: CLV_MIN_SAMPLE,
      sampleGateMet: false,
      meanClv: null,
      p25Clv: null,
      checks: {
        meanClv: {
          threshold: `> ${CLV_MEAN_THRESHOLD.toFixed(3)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
        tailRisk: {
          threshold: `> ${CLV_P25_THRESHOLD.toFixed(3)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
      },
    };
  }

  const row = db
    .prepare(
      `
      WITH windowed AS (
        SELECT clv_pct
        FROM clv_ledger
        WHERE closed_at IS NOT NULL
          AND clv_pct IS NOT NULL
          AND datetime(closed_at) >= datetime('now', ?)
      ), ranked AS (
        SELECT
          clv_pct,
          ROW_NUMBER() OVER (ORDER BY clv_pct ASC) AS rn,
          COUNT(*) OVER () AS total
        FROM windowed
      )
      SELECT
        (SELECT COUNT(*) FROM windowed) AS sample_size,
        (SELECT AVG(clv_pct) FROM windowed) AS mean_clv,
        (
          SELECT clv_pct
          FROM ranked
          WHERE rn = ((total + 3) / 4)
          LIMIT 1
        ) AS p25_clv
    `,
    )
    .get(`-${windowDays} days`);

  const sampleSize = toNumber(row?.sample_size, 0);
  const sampleGateMet = sampleSize >= CLV_MIN_SAMPLE;
  const meanClv = toNumber(row?.mean_clv);
  const p25Clv = toNumber(row?.p25_clv);

  const meanBreached = sampleGateMet && Number.isFinite(meanClv)
    ? meanClv <= CLV_MEAN_THRESHOLD
    : false;
  const tailBreached = sampleGateMet && Number.isFinite(p25Clv)
    ? p25Clv <= CLV_P25_THRESHOLD
    : false;

  return {
    table: 'clv_ledger',
    tablePresent: true,
    sampleSize,
    minSample: CLV_MIN_SAMPLE,
    sampleGateMet,
    meanClv: toRounded(meanClv),
    p25Clv: toRounded(p25Clv),
    checks: {
      meanClv: {
        threshold: `> ${CLV_MEAN_THRESHOLD.toFixed(3)}`,
        status: checkStatus({ gateMet: sampleGateMet, breached: meanBreached }),
        breached: meanBreached,
      },
      tailRisk: {
        threshold: `> ${CLV_P25_THRESHOLD.toFixed(3)}`,
        status: checkStatus({ gateMet: sampleGateMet, breached: tailBreached }),
        breached: tailBreached,
      },
    },
  };
}

function buildFetchDiagnostics(db, windowDays, projection, clv) {
  const recommendations = [];

  const projectionGaps =
    projection.tablePresent && projection.sampleGateMet === false
      ? db
          .prepare(
            `
            SELECT
              COALESCE(sport, 'UNKNOWN') AS sport,
              COALESCE(prop_type, 'UNKNOWN') AS prop_type,
              COALESCE(confidence, 'UNKNOWN') AS confidence,
              COUNT(*) AS unresolved_count
            FROM projection_perf_ledger
            WHERE settled_at IS NULL
              AND datetime(recorded_at) >= datetime('now', ?)
            GROUP BY sport, prop_type, confidence
            ORDER BY unresolved_count DESC, sport ASC, prop_type ASC, confidence ASC
            LIMIT ${MAX_DIAGNOSTIC_BUCKETS}
          `,
          )
          .all(`-${windowDays} days`)
          .map((row) => ({
            sport: row.sport,
            propType: row.prop_type,
            confidence: row.confidence,
            unresolvedCount: toNumber(row.unresolved_count, 0),
          }))
      : [];

  const clvGaps =
    clv.tablePresent && clv.sampleGateMet === false
      ? db
          .prepare(
            `
            SELECT
              COALESCE(sport, 'UNKNOWN') AS sport,
              COALESCE(market_type, 'UNKNOWN') AS market_type,
              COUNT(*) AS unresolved_count
            FROM clv_ledger
            WHERE closed_at IS NULL
              AND datetime(recorded_at) >= datetime('now', ?)
            GROUP BY sport, market_type
            ORDER BY unresolved_count DESC, sport ASC, market_type ASC
            LIMIT ${MAX_DIAGNOSTIC_BUCKETS}
          `,
          )
          .all(`-${windowDays} days`)
          .map((row) => ({
            sport: row.sport,
            marketType: row.market_type,
            unresolvedCount: toNumber(row.unresolved_count, 0),
          }))
      : [];

  const oddsCoverage = tableExists(db, 'odds_snapshots')
    ? db
        .prepare(
          `
          SELECT
            COALESCE(sport, 'UNKNOWN') AS sport,
            COUNT(*) AS snapshot_count,
            MAX(captured_at) AS last_captured_at
          FROM odds_snapshots
          WHERE datetime(captured_at) >= datetime('now', ?)
          GROUP BY sport
          ORDER BY snapshot_count ASC, sport ASC
          LIMIT ${MAX_DIAGNOSTIC_BUCKETS}
        `,
        )
        .all(`-${windowDays} days`)
        .map((row) => ({
          sport: row.sport,
          snapshotCount: toNumber(row.snapshot_count, 0),
          lastCapturedAt: row.last_captured_at || null,
        }))
    : [];

  if (!projection.sampleGateMet) {
    recommendations.push(
      projectionGaps.length > 0
        ? 'Increase settlement-result fetch cadence for projection buckets with highest unresolved counts before enforcing projection thresholds.'
        : 'Projection sample minimum not met; continue ingest + settlement cycles until at least 100 settled projection rows are available in the last 14 days.',
    );
  }
  if (!clv.sampleGateMet) {
    recommendations.push(
      clvGaps.length > 0
        ? 'Prioritize closing-odds fetch coverage for CLV buckets with unresolved entries so clv_pct can be closed and evaluated.'
        : 'CLV sample minimum not met; continue odds-backed settlement runs until at least 150 closed CLV rows are available in the last 14 days.',
    );
  }
  if (oddsCoverage.length > 0 && oddsCoverage[0].snapshotCount < 10) {
    recommendations.push(
      'Odds snapshot volume appears thin in at least one sport bucket; review pull-odds cadence and bookmaker coverage before enforcing strict gates.',
    );
  }

  return {
    projectionUnresolvedTopBuckets: projectionGaps,
    clvUnresolvedTopBuckets: clvGaps,
    oddsCoverageBySport: oddsCoverage,
    recommendations,
  };
}

function buildEdgeVerificationReport(db) {
  const exists = tableExists(db, 'tracking_stats');
  if (!exists) return { tablePresent: false, buckets: [] };

  const rows = db
    .prepare(
      `
      SELECT driver_key, sport, market_type,
             wins, losses, pushes, total_pnl_units, win_rate, avg_pnl_per_card
      FROM tracking_stats
      WHERE driver_key LIKE 'edge_verification:%'
      ORDER BY driver_key ASC, sport ASC, market_type ASC
    `,
    )
    .all();

  const buckets = rows.map((row) => ({
    driverKey: row.driver_key,
    verificationStatus: String(row.driver_key || '').replace('edge_verification:', ''),
    sport: row.sport,
    marketType: row.market_type,
    wins: toNumber(row.wins, 0),
    losses: toNumber(row.losses, 0),
    pushes: toNumber(row.pushes, 0),
    totalPnl: toRounded(toNumber(row.total_pnl_units)),
    winRate: toRounded(toNumber(row.win_rate)),
    avgPnlPerCard: toRounded(toNumber(row.avg_pnl_per_card)),
  }));

  return { tablePresent: true, buckets };
}

function buildReliabilityBinTemplate() {
  return NHL_ML_RELIABILITY_BIN_RANGES.map(([lower, upper], index) => ({
    bucket: `${lower.toFixed(1)}-${upper.toFixed(1)}`,
    lower,
    upper,
    inclusiveUpper: index === NHL_ML_RELIABILITY_BIN_RANGES.length - 1,
    sampleSize: 0,
    avgPredicted: null,
    actualWinRate: null,
    calibrationGap: null,
  }));
}

function resolveReliabilityBinIndex(probability) {
  for (let index = 0; index < NHL_ML_RELIABILITY_BIN_RANGES.length; index += 1) {
    const [lower, upper] = NHL_ML_RELIABILITY_BIN_RANGES[index];
    const isLast = index === NHL_ML_RELIABILITY_BIN_RANGES.length - 1;
    if (probability >= lower && (probability < upper || (isLast && probability <= upper))) {
      return index;
    }
  }
  return null;
}

function finalizeReliabilityBins(binTemplate, stateByIndex) {
  return binTemplate.map((bin, index) => {
    const state = stateByIndex[index];
    if (!state || state.count === 0) return bin;
    const avgPredicted = state.predictedSum / state.count;
    const actualWinRate = state.outcomeSum / state.count;
    return {
      ...bin,
      sampleSize: state.count,
      avgPredicted: toRounded(avgPredicted),
      actualWinRate: toRounded(actualWinRate),
      calibrationGap: toRounded(actualWinRate - avgPredicted),
    };
  });
}

function computeMappingMetrics(samples, probabilityKey) {
  const reliabilityBins = buildReliabilityBinTemplate();
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      brier: null,
      logLoss: null,
      reliabilityBins,
    };
  }

  let brierSum = 0;
  let logLossSum = 0;
  const binState = reliabilityBins.map(() => ({
    count: 0,
    predictedSum: 0,
    outcomeSum: 0,
  }));

  for (const sample of samples) {
    const outcome = sample.outcome;
    const probability = sample[probabilityKey];
    if (!Number.isFinite(outcome) || !Number.isFinite(probability)) {
      continue;
    }

    const clampedProbability = clampProbability(probability);
    if (!Number.isFinite(clampedProbability)) continue;
    const error = clampedProbability - outcome;
    brierSum += error * error;
    logLossSum += -(
      outcome * Math.log(clampedProbability) +
      (1 - outcome) * Math.log(1 - clampedProbability)
    );

    const binnedProbability = Math.max(0.5, Math.min(1, clampedProbability));
    const binIndex = resolveReliabilityBinIndex(binnedProbability);
    if (binIndex === null) continue;
    const state = binState[binIndex];
    state.count += 1;
    state.predictedSum += binnedProbability;
    state.outcomeSum += outcome;
  }

  return {
    brier: toRounded(brierSum / samples.length),
    logLoss: toRounded(logLossSum / samples.length),
    reliabilityBins: finalizeReliabilityBins(reliabilityBins, binState),
  };
}

function resolveProjectedMarginHome(payloadData) {
  return toNumber(
    payloadData?.projection?.margin_home ??
      payloadData?.market_context?.projection?.margin_home ??
      payloadData?.projection?.projected_margin ??
      payloadData?.market_context?.projection?.projected_margin ??
      payloadData?.all_markets?.ML?.projection?.projected_margin ??
      payloadData?.all_markets?.SPREAD?.projection?.projected_margin ??
      null,
  );
}

function resolveMoneylineSelection(rowSelection, payloadData) {
  const fromRow = toUpperToken(rowSelection);
  if (fromRow === 'HOME' || fromRow === 'AWAY') return fromRow;

  const fromPayload = toUpperToken(
    payloadData?.selection?.side ?? payloadData?.selection ?? payloadData?.prediction,
  );
  if (fromPayload === 'HOME' || fromPayload === 'AWAY') return fromPayload;
  return null;
}

function buildEmptyMappingStats(mappingKey, sigmaMargin) {
  return {
    mappingKey,
    sigmaMargin: toRounded(sigmaMargin, 3),
    brier: null,
    logLoss: null,
    reliabilityBins: buildReliabilityBinTemplate(),
  };
}

function buildNhlMoneylineCalibrationReport(db, windowDays, generatedAtIso) {
  const selectedSigmaRaw = toNumber(edgeCalculator.getSigmaDefaults('NHL')?.margin);
  const selectedSigma =
    Number.isFinite(selectedSigmaRaw) && selectedSigmaRaw > 0
      ? selectedSigmaRaw
      : NHL_ML_DEFAULT_SELECTED_SIGMA;
  const generatedAtMs = Date.parse(generatedAtIso);
  const nowMs = Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const sampleWindow = {
    days: windowDays,
    anchorField: 'settled_at',
    startUtc: new Date(nowMs - windowDays * dayMs).toISOString(),
    endUtc: new Date(nowMs).toISOString(),
  };
  const selectionRule = 'selected_improves_both_brier_and_log_loss';
  const baseline = buildEmptyMappingStats('legacy_sigma_12', NHL_ML_BASELINE_SIGMA);
  const selected = buildEmptyMappingStats('nhl_sigma_default', selectedSigma);
  const baseReport = {
    status: 'INSUFFICIENT_DATA',
    sampleWindow,
    sampleSize: 0,
    selectionRule,
    verdict: 'INSUFFICIENT_DATA',
    rationale: 'No eligible NHL moneyline settled outcomes found in the requested window.',
    mappings: {
      baseline,
      selected,
    },
    deltas: {
      brierSelectedMinusBaseline: null,
      logLossSelectedMinusBaseline: null,
    },
    dataQuality: {
      sourceRows: 0,
      usableRows: 0,
      droppedRows: 0,
      droppedReasonCounts: {},
    },
  };

  const hasCardResults = tableExists(db, 'card_results');
  const hasCardPayloads = tableExists(db, 'card_payloads');
  if (!hasCardResults || !hasCardPayloads) {
    return {
      ...baseReport,
      rationale:
        'Missing card_results/card_payloads table(s); cannot compute NHL moneyline calibration evidence.',
    };
  }

  const rows = db
    .prepare(
      `
      SELECT
        cr.selection,
        cr.result,
        cp.payload_data
      FROM card_results cr
      INNER JOIN card_payloads cp ON cp.id = cr.card_id
      WHERE LOWER(COALESCE(cr.sport, '')) = 'nhl'
        AND UPPER(COALESCE(cr.market_type, '')) = 'MONEYLINE'
        AND LOWER(COALESCE(cr.status, '')) = 'settled'
        AND LOWER(COALESCE(cr.result, '')) IN ('win', 'loss')
        AND cr.settled_at IS NOT NULL
        AND datetime(cr.settled_at) >= datetime('now', ?)
    `,
    )
    .all(`-${windowDays} days`);

  const droppedReasonCounts = {};
  const samples = [];
  for (const row of rows) {
    const payloadData = parseJsonObject(row.payload_data);
    const marginHome = resolveProjectedMarginHome(payloadData);
    if (!Number.isFinite(marginHome)) {
      droppedReasonCounts.missing_margin_home = (droppedReasonCounts.missing_margin_home || 0) + 1;
      continue;
    }

    const selection = resolveMoneylineSelection(row.selection, payloadData);
    if (!selection) {
      droppedReasonCounts.missing_selection = (droppedReasonCounts.missing_selection || 0) + 1;
      continue;
    }

    const outcomeToken = toUpperToken(row.result);
    const outcome = outcomeToken === 'WIN' ? 1 : outcomeToken === 'LOSS' ? 0 : null;
    if (!Number.isFinite(outcome)) {
      droppedReasonCounts.invalid_outcome = (droppedReasonCounts.invalid_outcome || 0) + 1;
      continue;
    }

    const selectedHomeProbability = clampProbability(
      marginToWinProbability(marginHome, selectedSigma),
    );
    const baselineHomeProbability = clampProbability(
      marginToWinProbability(marginHome, NHL_ML_BASELINE_SIGMA),
    );
    if (!Number.isFinite(selectedHomeProbability) || !Number.isFinite(baselineHomeProbability)) {
      droppedReasonCounts.invalid_probability = (droppedReasonCounts.invalid_probability || 0) + 1;
      continue;
    }

    const selectedProbability = clampProbability(
      selection === 'HOME' ? selectedHomeProbability : 1 - selectedHomeProbability,
    );
    const baselineProbability = clampProbability(
      selection === 'HOME' ? baselineHomeProbability : 1 - baselineHomeProbability,
    );
    if (!Number.isFinite(selectedProbability) || !Number.isFinite(baselineProbability)) {
      droppedReasonCounts.invalid_pick_probability =
        (droppedReasonCounts.invalid_pick_probability || 0) + 1;
      continue;
    }

    samples.push({
      outcome,
      selectedProbability,
      baselineProbability,
    });
  }

  if (samples.length === 0) {
    return {
      ...baseReport,
      dataQuality: {
        sourceRows: rows.length,
        usableRows: 0,
        droppedRows: rows.length,
        droppedReasonCounts,
      },
    };
  }

  const baselineMetrics = computeMappingMetrics(samples, 'baselineProbability');
  const selectedMetrics = computeMappingMetrics(samples, 'selectedProbability');
  const brierDelta =
    Number.isFinite(selectedMetrics.brier) && Number.isFinite(baselineMetrics.brier)
      ? selectedMetrics.brier - baselineMetrics.brier
      : null;
  const logLossDelta =
    Number.isFinite(selectedMetrics.logLoss) && Number.isFinite(baselineMetrics.logLoss)
      ? selectedMetrics.logLoss - baselineMetrics.logLoss
      : null;
  const selectedImprovesBrier = Number.isFinite(brierDelta) ? brierDelta < 0 : false;
  const selectedImprovesLogLoss = Number.isFinite(logLossDelta) ? logLossDelta < 0 : false;
  const verdict =
    selectedImprovesBrier && selectedImprovesLogLoss ? 'JUSTIFIED' : 'NOT_JUSTIFIED';
  const rationale =
    verdict === 'JUSTIFIED'
      ? 'Selected NHL sigma improves both Brier and log-loss versus legacy sigma=12.'
      : 'Selected NHL sigma does not improve both Brier and log-loss versus legacy sigma=12.';

  return {
    status: 'OK',
    sampleWindow,
    sampleSize: samples.length,
    selectionRule,
    verdict,
    rationale,
    mappings: {
      baseline: {
        ...baseline,
        brier: baselineMetrics.brier,
        logLoss: baselineMetrics.logLoss,
        reliabilityBins: baselineMetrics.reliabilityBins,
      },
      selected: {
        ...selected,
        brier: selectedMetrics.brier,
        logLoss: selectedMetrics.logLoss,
        reliabilityBins: selectedMetrics.reliabilityBins,
      },
    },
    deltas: {
      brierSelectedMinusBaseline: toRounded(brierDelta),
      logLossSelectedMinusBaseline: toRounded(logLossDelta),
    },
    dataQuality: {
      sourceRows: rows.length,
      usableRows: samples.length,
      droppedRows: rows.length - samples.length,
      droppedReasonCounts,
    },
  };
}

function collectChecks(projection, clv) {
  return [
    {
      name: 'projection_win_rate_floor',
      status: projection.checks.winRateFloor.status,
      breached: projection.checks.winRateFloor.breached,
    },
    {
      name: 'projection_confidence_drift',
      status: projection.checks.confidenceDrift.status,
      breached: projection.checks.confidenceDrift.breached,
    },
    {
      name: 'clv_mean_degradation',
      status: clv.checks.meanClv.status,
      breached: clv.checks.meanClv.breached,
    },
    {
      name: 'clv_tail_risk',
      status: clv.checks.tailRisk.status,
      breached: clv.checks.tailRisk.breached,
    },
  ];
}

function determineOverallStatus(checks) {
  const breaches = checks.filter((item) => item.status === 'FAIL' && item.breached);
  if (breaches.length > 0) return 'NO_GO';
  const insufficient = checks.filter((item) => item.status === 'INSUFFICIENT_DATA');
  if (insufficient.length > 0) return 'INSUFFICIENT_DATA';
  return 'GO';
}

function determineExitCode(report, enforce = false) {
  if (!enforce) return 0;
  return report.overallStatus === 'NO_GO' ? 1 : 0;
}

function formatCalibrationMetric(value) {
  return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

function formatReliabilityBinsInline(bins = []) {
  if (!Array.isArray(bins) || bins.length === 0) return 'none';
  return bins
    .map(
      (bin) =>
        `${bin.bucket}(n=${bin.sampleSize},pred=${formatCalibrationMetric(bin.avgPredicted)},win=${formatCalibrationMetric(bin.actualWinRate)},gap=${formatCalibrationMetric(bin.calibrationGap)})`,
    )
    .join(' | ');
}

async function generateTelemetryCalibrationReport({
  db = null,
  days = DEFAULT_WINDOW_DAYS,
} = {}) {
  const ownDb = !db;
  let reader = db;
  if (ownDb) {
    await initDb();
    reader = getDatabaseReadOnly();
  }

  try {
    const windowDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : DEFAULT_WINDOW_DAYS;
    const generatedAt = new Date().toISOString();
    const projection = buildProjectionLedgerReport(reader, windowDays);
    const clv = buildClvLedgerReport(reader, windowDays);
    const nhlMoneylineCalibration = buildNhlMoneylineCalibrationReport(
      reader,
      windowDays,
      generatedAt,
    );
    const edgeVerification = buildEdgeVerificationReport(reader);
    const checks = collectChecks(projection, clv);
    const diagnostics = buildFetchDiagnostics(reader, windowDays, projection, clv);
    const overallStatus = determineOverallStatus(checks);
    const dbResolution = resolveDatabasePath();

    return {
      generatedAt,
      database: {
        path: dbResolution.dbPath,
        source: dbResolution.source,
      },
      windowDays,
      thresholds: {
        projectionMinSample: PROJECTION_MIN_SAMPLE,
        projectionWinRateFloor: PROJECTION_WIN_RATE_FLOOR,
        projectionConfidenceDrift: CONFIDENCE_DRIFT_THRESHOLD,
        clvMinSample: CLV_MIN_SAMPLE,
        clvMeanThreshold: CLV_MEAN_THRESHOLD,
        clvP25Threshold: CLV_P25_THRESHOLD,
      },
      ledgers: {
        projection,
        clv,
      },
      nhlMoneylineCalibration,
      edgeVerification,
      checks,
      overallStatus,
      diagnostics,
    };
  } finally {
    if (ownDb && reader) {
      closeReadOnlyInstance(reader);
    }
  }
}

function formatTelemetryCalibrationReport(report, { enforce = false } = {}) {
  const lines = [];
  lines.push('[TelemetryCalibration] Report');
  lines.push(`DB: ${report.database.path} (${report.database.source})`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Window: last ${report.windowDays} day(s)`);
  lines.push(`Enforcement: ${enforce ? 'enabled' : 'disabled'}`);
  lines.push(`Overall status: ${report.overallStatus}`);
  lines.push('');

  lines.push('projection_perf_ledger');
  lines.push(
    `- sample: ${report.ledgers.projection.sampleSize}/${report.ledgers.projection.minSample} (gate ${report.ledgers.projection.sampleGateMet ? 'met' : 'not met'})`,
  );
  lines.push(
    `- win_rate: ${formatPct(report.ledgers.projection.winRate)} | threshold ${report.ledgers.projection.checks.winRateFloor.threshold} | ${report.ledgers.projection.checks.winRateFloor.status}`,
  );
  lines.push(
    `- high_vs_medium_drift: ${formatPct(report.ledgers.projection.confidenceDrift)} (HIGH ${formatPct(report.ledgers.projection.highWinRate)} vs MEDIUM ${formatPct(report.ledgers.projection.mediumWinRate)}) | threshold ${report.ledgers.projection.checks.confidenceDrift.threshold} | ${report.ledgers.projection.checks.confidenceDrift.status}`,
  );
  lines.push('');

  lines.push('clv_ledger');
  lines.push(
    `- sample: ${report.ledgers.clv.sampleSize}/${report.ledgers.clv.minSample} (gate ${report.ledgers.clv.sampleGateMet ? 'met' : 'not met'})`,
  );
  lines.push(
    `- mean_clv: ${Number.isFinite(report.ledgers.clv.meanClv) ? report.ledgers.clv.meanClv.toFixed(4) : 'n/a'} | threshold ${report.ledgers.clv.checks.meanClv.threshold} | ${report.ledgers.clv.checks.meanClv.status}`,
  );
  lines.push(
    `- p25_clv: ${Number.isFinite(report.ledgers.clv.p25Clv) ? report.ledgers.clv.p25Clv.toFixed(4) : 'n/a'} | threshold ${report.ledgers.clv.checks.tailRisk.threshold} | ${report.ledgers.clv.checks.tailRisk.status}`,
  );
  lines.push('');

  lines.push('nhl_moneyline_calibration');
  lines.push(
    `- status: ${report.nhlMoneylineCalibration.status} | sample: ${report.nhlMoneylineCalibration.sampleSize} | window: ${report.nhlMoneylineCalibration.sampleWindow.startUtc} -> ${report.nhlMoneylineCalibration.sampleWindow.endUtc} (${report.nhlMoneylineCalibration.sampleWindow.anchorField})`,
  );
  lines.push(
    `- baseline (${report.nhlMoneylineCalibration.mappings.baseline.mappingKey}, sigma=${report.nhlMoneylineCalibration.mappings.baseline.sigmaMargin}): brier ${formatCalibrationMetric(report.nhlMoneylineCalibration.mappings.baseline.brier)} | log_loss ${formatCalibrationMetric(report.nhlMoneylineCalibration.mappings.baseline.logLoss)}`,
  );
  lines.push(
    `- selected (${report.nhlMoneylineCalibration.mappings.selected.mappingKey}, sigma=${report.nhlMoneylineCalibration.mappings.selected.sigmaMargin}): brier ${formatCalibrationMetric(report.nhlMoneylineCalibration.mappings.selected.brier)} | log_loss ${formatCalibrationMetric(report.nhlMoneylineCalibration.mappings.selected.logLoss)}`,
  );
  lines.push(
    `- deltas (selected-baseline): brier ${formatCalibrationMetric(report.nhlMoneylineCalibration.deltas.brierSelectedMinusBaseline)} | log_loss ${formatCalibrationMetric(report.nhlMoneylineCalibration.deltas.logLossSelectedMinusBaseline)}`,
  );
  lines.push(
    `- verdict: ${report.nhlMoneylineCalibration.verdict} | rule ${report.nhlMoneylineCalibration.selectionRule}`,
  );
  lines.push(`- rationale: ${report.nhlMoneylineCalibration.rationale}`);
  lines.push(
    `- baseline_reliability_bins: ${formatReliabilityBinsInline(report.nhlMoneylineCalibration.mappings.baseline.reliabilityBins)}`,
  );
  lines.push(
    `- selected_reliability_bins: ${formatReliabilityBinsInline(report.nhlMoneylineCalibration.mappings.selected.reliabilityBins)}`,
  );
  lines.push('');

  lines.push('edge_verification_outcomes');
  if (!report.edgeVerification || !report.edgeVerification.tablePresent) {
    lines.push('- tracking_stats table missing');
  } else if (report.edgeVerification.buckets.length === 0) {
    lines.push('- no settled edge_verification plays yet');
  } else {
    for (const bucket of report.edgeVerification.buckets) {
      const total = bucket.wins + bucket.losses + bucket.pushes;
      lines.push(
        `- ${bucket.verificationStatus} | ${bucket.sport}/${bucket.marketType} | ${bucket.wins}W-${bucket.losses}L-${bucket.pushes}P (${total}) | win_rate ${formatPct(bucket.winRate)} | avg_pnl ${Number.isFinite(bucket.avgPnlPerCard) ? bucket.avgPnlPerCard.toFixed(3) : 'n/a'}`,
      );
    }
  }
  lines.push('');

  lines.push('learning_diagnostics');
  if (report.diagnostics.projectionUnresolvedTopBuckets.length === 0) {
    lines.push('- projection_unresolved: none');
  } else {
    lines.push('- projection_unresolved:');
    for (const bucket of report.diagnostics.projectionUnresolvedTopBuckets) {
      lines.push(
        `  - ${bucket.sport} | ${bucket.propType} | ${bucket.confidence} => ${bucket.unresolvedCount}`,
      );
    }
  }
  if (report.diagnostics.clvUnresolvedTopBuckets.length === 0) {
    lines.push('- clv_unresolved: none');
  } else {
    lines.push('- clv_unresolved:');
    for (const bucket of report.diagnostics.clvUnresolvedTopBuckets) {
      lines.push(
        `  - ${bucket.sport} | ${bucket.marketType} => ${bucket.unresolvedCount}`,
      );
    }
  }
  if (report.diagnostics.recommendations.length === 0) {
    lines.push('- recommendations: none');
  } else {
    lines.push('- recommendations:');
    for (const recommendation of report.diagnostics.recommendations) {
      lines.push(`  - ${recommendation}`);
    }
  }

  return lines.join('\n');
}

function printHelp() {
  console.log(`Telemetry calibration report\n\nOptions:\n  --enforce       Exit non-zero only when threshold breaches are detected\n  --json          Print machine-readable JSON\n  --days <N>      Rolling window in days (default ${DEFAULT_WINDOW_DAYS})\n  --help          Show this help\n`);
}

if (require.main === module) {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  generateTelemetryCalibrationReport({ days: options.days })
    .then((report) => {
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatTelemetryCalibrationReport(report, { enforce: options.enforce }));
      }
      process.exit(determineExitCode(report, options.enforce));
    })
    .catch((error) => {
      console.error('[TelemetryCalibration] Failed to generate report:', error.message);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  determineExitCode,
  formatTelemetryCalibrationReport,
  generateTelemetryCalibrationReport,
  parseArgs,
  __private: {
    buildEmptyMappingStats,
    buildClvLedgerReport,
    buildFetchDiagnostics,
    buildNhlMoneylineCalibrationReport,
    buildProjectionLedgerReport,
    buildReliabilityBinTemplate,
    checkStatus,
    collectChecks,
    computeMappingMetrics,
    clampProbability,
    determineOverallStatus,
    formatCalibrationMetric,
    formatPct,
    formatReliabilityBinsInline,
    parsePositiveInteger,
    parseJsonObject,
    resolveMoneylineSelection,
    resolveProjectedMarginHome,
    tableExists,
    toUpperToken,
    toRounded,
  },
};
