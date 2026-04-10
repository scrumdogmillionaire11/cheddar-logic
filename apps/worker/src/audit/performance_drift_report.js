'use strict';

require('dotenv').config();

const fs = require('fs');

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
} = require('@cheddar-logic/data');
const {
  collectProjectionAlerts,
  evaluateProjectionRows,
} = require('./projection_evaluator');

const DIMENSIONS = Object.freeze([
  'sport',
  'card_family',
  'card_mode',
  'execution_status',
  'model_version',
]);

const WINDOW_DEFS = Object.freeze([
  { name: 'last_50', size: 50, baselineName: 'previous_50' },
  { name: 'last_100', size: 100, baselineName: 'previous_100' },
  { name: 'last_200', size: 200, baselineName: 'previous_200' },
  { name: 'season_to_date', size: null, baselineName: null },
]);

const CALIBRATION_BUCKETS = Object.freeze([
  { label: '0.50-0.52', min: 0.5, max: 0.52 },
  { label: '0.52-0.54', min: 0.52, max: 0.54 },
  { label: '0.54-0.56', min: 0.54, max: 0.56 },
  { label: '0.56-0.58', min: 0.56, max: 0.58 },
  { label: '0.58+', min: 0.58, max: Number.POSITIVE_INFINITY },
]);

const VALID_CARD_MODES = new Set(['ODDS_BACKED', 'PROJECTION_ONLY']);
const VALID_EXECUTION_STATUSES = new Set([
  'EXECUTABLE',
  'PROJECTION_ONLY',
  'BLOCKED',
]);
const ALERT_SAMPLE_MIN = 50;
const CALIBRATION_BUCKET_MIN_SAMPLE = 10;
const EXECUTABLE_RATE_SPIKE_THRESHOLD = 0.6;
const PASS_RATE_COLLAPSE_THRESHOLD = 0.2;
const CALIBRATION_DIVERGENCE_THRESHOLD = 0.15;
const BLOCK_RATE_SHIFT_THRESHOLD = 0.1;
const SEVERITY_RANK = Object.freeze({ WARN: 1, HIGH: 2, CRITICAL: 3 });

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    all: false,
    help: false,
    output: null,
    sport: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--all') {
      options.all = true;
      continue;
    }

    if (arg.startsWith('--sport=')) {
      options.sport = toUpperToken(arg.split('=').slice(1).join('='));
      continue;
    }

    if (arg === '--sport') {
      options.sport = toUpperToken(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--output=')) {
      options.output = arg.split('=').slice(1).join('=').trim() || null;
      continue;
    }

    if (arg === '--output') {
      options.output = String(argv[index + 1] || '').trim() || null;
      index += 1;
    }
  }

  if (!options.all && !options.sport) {
    options.all = true;
  }

  return options;
}

function formatHelp() {
  return [
    'Usage:',
    '  node apps/worker/src/audit/performance_drift_report.js --sport NBA',
    '  node apps/worker/src/audit/performance_drift_report.js --all',
    '  node apps/worker/src/audit/performance_drift_report.js --all --output /tmp/drift_report.json',
  ].join('\n');
}

function toUpperToken(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function toLowerToken(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
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

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeMarketType(value) {
  const token = toUpperToken(value);
  if (!token) return null;
  if (token === 'ML') return 'MONEYLINE';
  if (token === 'PUCK_LINE') return 'PUCKLINE';
  return token;
}

function normalizePeriodToken(value) {
  const token = toUpperToken(value);
  if (!token) return 'FULL_GAME';
  if (token === 'FIRST_PERIOD' || token === 'FIRST_5_INNINGS' || token === '1ST_PERIOD' || token === '1P') {
    return '1P';
  }
  if (token === 'F5' || token === 'FIRST_5') return 'F5';
  return 'FULL_GAME';
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

function getPayloadValue(payload, path, fallback = null) {
  let current = payload;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return fallback;
    current = current[segment];
  }
  return current === undefined ? fallback : current;
}

function resolveOfficialStatus(payload) {
  const explicit = toUpperToken(
    getPayloadValue(payload, ['play', 'decision_v2', 'official_status']) ||
      getPayloadValue(payload, ['decision_v2', 'official_status']) ||
      payload?.official_status,
  );
  if (explicit === 'PLAY' || explicit === 'LEAN' || explicit === 'PASS') {
    return explicit;
  }

  const statusSignals = [
    payload?.classification,
    payload?.action,
    payload?.status,
    getPayloadValue(payload, ['play', 'classification']),
    getPayloadValue(payload, ['play', 'action']),
    getPayloadValue(payload, ['play', 'status']),
  ];

  for (const signal of statusSignals) {
    const token = toUpperToken(signal);
    if (token === 'BASE' || token === 'FIRE' || token === 'PLAY') return 'PLAY';
    if (token === 'LEAN' || token === 'WATCH' || token === 'HOLD') return 'LEAN';
    if (token === 'PASS') return 'PASS';
  }

  return 'PASS';
}

function deriveCardMode(payload) {
  const explicit = toUpperToken(
    getPayloadValue(payload, ['decision_basis_meta', 'decision_basis']) ||
      payload?.basis ||
      payload?.decision_basis,
  );
  if (VALID_CARD_MODES.has(explicit)) return explicit;

  const lineSource = toLowerToken(
    getPayloadValue(payload, ['decision_basis_meta', 'market_line_source']) ||
      getPayloadValue(payload, ['market_context', 'wager', 'line_source']) ||
      payload?.line_source,
  );

  if (
    lineSource === 'projection_floor' ||
    lineSource === 'synthetic' ||
    lineSource === 'synthetic_fallback'
  ) {
    return 'PROJECTION_ONLY';
  }

  return 'ODDS_BACKED';
}

function resolveExecutionStatus(payload, cardMode) {
  const explicit = toUpperToken(
    payload?.execution_status || getPayloadValue(payload, ['play', 'execution_status']),
  );
  if (VALID_EXECUTION_STATUSES.has(explicit)) return explicit;
  if (cardMode === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';

  const officialStatus = resolveOfficialStatus(payload);
  if (officialStatus === 'PASS') return 'BLOCKED';
  return 'EXECUTABLE';
}

function resolveActionable(payload, executionStatus, officialStatus) {
  const explicit = payload?.actionable;
  if (explicit === true || explicit === false) return explicit === true;
  const playExplicit = getPayloadValue(payload, ['play', 'actionable']);
  if (playExplicit === true || playExplicit === false) return playExplicit === true;
  if (executionStatus !== 'EXECUTABLE') return false;
  return officialStatus === 'PLAY' || officialStatus === 'LEAN';
}

function resolveModelVersion(payload) {
  return (
    payload?.model_version ||
    getPayloadValue(payload, ['play', 'model_version']) ||
    'UNKNOWN'
  );
}

function resolveMarketType(row, payload) {
  return normalizeMarketType(
    getPayloadValue(payload, ['play', 'market_type']) ||
      getPayloadValue(payload, ['market_context', 'market_type']) ||
      payload?.market_type ||
      row?.market_type,
  );
}

function resolvePeriod(row, payload) {
  return normalizePeriodToken(
    getPayloadValue(payload, ['play', 'period']) ||
      payload?.period ||
      payload?.time_period ||
      getPayloadValue(payload, ['market_context', 'period']) ||
      getPayloadValue(payload, ['market_context', 'wager', 'period']) ||
      getPayloadValue(payload, ['metadata', 'market_period_token']) ||
      row?.period,
  );
}

function deriveCardFamily(row, payload) {
  const sport = toUpperToken(payload?.sport || row?.sport) || 'UNKNOWN';
  const cardType = toLowerToken(row?.card_type || payload?.card_type) || '';
  const canonicalMarketKey = toLowerToken(
    getPayloadValue(payload, ['play', 'canonical_market_key']) ||
      payload?.canonical_market_key,
  );
  const propType = toLowerToken(
    getPayloadValue(payload, ['play', 'prop_type']) ||
      payload?.prop_type,
  );
  const marketType = resolveMarketType(row, payload);
  const period = resolvePeriod(row, payload);

  if (sport === 'NBA') {
    if (cardType.includes('spread') || marketType === 'SPREAD') return 'NBA_SPREAD';
    if (cardType.includes('moneyline') || marketType === 'MONEYLINE') return 'NBA_ML';
    return 'NBA_TOTAL';
  }

  if (sport === 'NHL') {
    if (
      canonicalMarketKey === 'player_blocked_shots' ||
      propType === 'blocked_shots' ||
      cardType === 'nhl-player-blk'
    ) {
      return 'NHL_PLAYER_BLOCKED_SHOTS';
    }

    if (
      propType === 'shots_on_goal' ||
      cardType.includes('player-shots')
    ) {
      return period === '1P' ? 'NHL_PLAYER_SHOTS_1P' : 'NHL_PLAYER_SHOTS';
    }

    if (cardType.includes('moneyline') || marketType === 'MONEYLINE') return 'NHL_ML';
    if (period === '1P') return 'NHL_1P_TOTAL';
    if (cardType.includes('spread') || marketType === 'SPREAD' || marketType === 'PUCKLINE') {
      return 'NHL_SPREAD';
    }
    return 'NHL_TOTAL';
  }

  if (sport === 'MLB') {
    if (canonicalMarketKey === 'pitcher_strikeouts' || cardType === 'mlb-pitcher-k') {
      return 'MLB_PITCHER_K';
    }
    if (cardType === 'mlb-f5-ml' || (marketType === 'MONEYLINE' && period === 'F5')) {
      return 'MLB_F5_ML';
    }
    if (cardType === 'mlb-f5' || (marketType === 'TOTAL' && period === 'F5')) {
      return 'MLB_F5_TOTAL';
    }
  }

  return `${sport}_${marketType || 'UNKNOWN'}`;
}

function extractReasonCodes(payload) {
  const candidates = [];
  const reasonArrays = [
    payload?.reason_codes,
    getPayloadValue(payload, ['play', 'reason_codes']),
    getPayloadValue(payload, ['decision_v2', 'price_reason_codes']),
    getPayloadValue(payload, ['play', 'decision_v2', 'price_reason_codes']),
  ];

  for (const reasonArray of reasonArrays) {
    if (!Array.isArray(reasonArray)) continue;
    for (const code of reasonArray) {
      const token = toUpperToken(code);
      if (token) candidates.push(token);
    }
  }

  const singletons = [
    getPayloadValue(payload, ['decision_v2', 'primary_reason_code']),
    getPayloadValue(payload, ['play', 'decision_v2', 'primary_reason_code']),
    payload?.pass_reason_code,
  ];

  for (const code of singletons) {
    const token = toUpperToken(code);
    if (token) candidates.push(token);
  }

  return Array.from(new Set(candidates)).sort();
}

function isBlockReasonCode(code) {
  const token = toUpperToken(code);
  if (!token) return false;
  if (token === 'EDGE_CLEAR' || token === 'LEAN_SIGNAL') return false;
  return (
    token.startsWith('BLOCKED_') ||
    token.startsWith('PASS_') ||
    token.startsWith('PROJECTION_') ||
    token.includes('NO_EDGE') ||
    token.includes('MISSING') ||
    token.includes('UNPRICED') ||
    token.includes('WATCHDOG')
  );
}

function normalizeResultToken(value) {
  const token = toUpperToken(value);
  if (token === 'WIN' || token === 'LOSS' || token === 'PUSH') return token;
  return null;
}

function normalizeRow(row) {
  const payload = parseJsonObject(row.payload_data) || {};
  const gameResultMetadata = parseJsonObject(row.game_result_metadata);
  const sport = toUpperToken(payload?.sport || row?.sport) || 'UNKNOWN';
  const cardMode = deriveCardMode(payload);
  const executionStatus = resolveExecutionStatus(payload, cardMode);
  const officialStatus = resolveOfficialStatus(payload);
  const actionable = resolveActionable(payload, executionStatus, officialStatus);
  const reasonCodes = extractReasonCodes(payload).filter(isBlockReasonCode);
  const settledAt = String(row.settled_at || '');
  const settledAtMs = Date.parse(settledAt);

  return {
    actionable,
    card_family: deriveCardFamily(row, payload),
    card_mode: cardMode,
    card_type: row.card_type || payload.card_type || null,
    clv_pct: toNumber(row.clv_pct),
    execution_status: executionStatus,
    final_score_away: toNumber(row.final_score_away),
    final_score_home: toNumber(row.final_score_home),
    game_result_metadata: gameResultMetadata,
    model_version: resolveModelVersion(payload),
    official_status: officialStatus,
    p_fair: firstFiniteNumber(
      payload?.p_fair,
      payload?.model_prob,
      getPayloadValue(payload, ['decision_v2', 'p_fair']),
      getPayloadValue(payload, ['play', 'decision_v2', 'p_fair']),
      getPayloadValue(payload, ['decision', 'p_fair']),
      getPayloadValue(payload, ['play', 'decision', 'p_fair']),
    ),
    payload,
    pnl_units: toNumber(row.pnl_units),
    reason_codes: reasonCodes,
    result: normalizeResultToken(row.result),
    settled_at: settledAt,
    settled_at_ms: Number.isFinite(settledAtMs) ? settledAtMs : 0,
    sport,
  };
}

function loadSettledRows({ db, sport = null }) {
  const hasClvLedger = tableExists(db, 'clv_ledger');
  const params = [];
  let sportSql = '';

  if (sport) {
    sportSql = `AND UPPER(COALESCE(cr.sport, '')) = ?`;
    params.push(toUpperToken(sport));
  }

  const clvByCardCte = hasClvLedger
    ? `
      WITH clv_by_card AS (
        SELECT
          card_id,
          AVG(clv_pct) AS clv_pct
        FROM clv_ledger
        WHERE closed_at IS NOT NULL
          AND clv_pct IS NOT NULL
        GROUP BY card_id
      )
    `
    : `
      WITH clv_by_card AS (
        SELECT NULL AS card_id, NULL AS clv_pct
        WHERE 0
      )
    `;

  const rows = db
    .prepare(
      `
      ${clvByCardCte}
      SELECT
        cr.card_id,
        cr.card_type,
        cr.market_type,
        cr.pnl_units,
        cr.result,
        cr.settled_at,
        cr.sport,
        cp.payload_data,
        clv_by_card.clv_pct,
        gr.final_score_home,
        gr.final_score_away,
        gr.metadata AS game_result_metadata
      FROM card_results cr
      INNER JOIN card_payloads cp ON cp.id = cr.card_id
      LEFT JOIN game_results gr ON gr.game_id = cr.game_id
      LEFT JOIN clv_by_card ON clv_by_card.card_id = cr.card_id
      WHERE LOWER(COALESCE(cr.status, '')) = 'settled'
        AND cr.settled_at IS NOT NULL
        ${sportSql}
      ORDER BY datetime(cr.settled_at) DESC, cr.id DESC
    `,
    )
    .all(...params);

  return rows.map(normalizeRow);
}

function buildWindowMetadata(definition, currentRows, baselineRows) {
  if (!definition.baselineName) {
    return {
      size: currentRows.length,
      baseline_window: null,
    };
  }

  return {
    size: definition.size,
    baseline_window: {
      name: definition.baselineName,
      sample_count: baselineRows.length,
      size: definition.size,
    },
  };
}

function buildCohortKey(row) {
  return [
    row.sport,
    row.card_family,
    row.card_mode,
    row.model_version,
  ].join('||');
}

function buildSegmentKey(row) {
  return [
    row.sport,
    row.card_family,
    row.card_mode,
    row.execution_status,
    row.model_version,
  ].join('||');
}

function buildModelVersionHistory(rows) {
  const familyMap = new Map();

  for (const row of rows) {
    const familyKey = [row.sport, row.card_family, row.card_mode].join('||');
    if (!familyMap.has(familyKey)) familyMap.set(familyKey, new Map());
    const versionMap = familyMap.get(familyKey);
    const currentMax = versionMap.get(row.model_version) || 0;
    versionMap.set(row.model_version, Math.max(currentMax, row.settled_at_ms));
  }

  const result = new Map();

  for (const [familyKey, versionMap] of familyMap.entries()) {
    const versions = Array.from(versionMap.entries())
      .sort((left, right) => {
        if (left[1] !== right[1]) return left[1] - right[1];
        return left[0].localeCompare(right[0]);
      });

    for (let index = 0; index < versions.length; index += 1) {
      const [modelVersion] = versions[index];
      const previousModelVersion = index > 0 ? versions[index - 1][0] : null;
      result.set(`${familyKey}||${modelVersion}`, previousModelVersion);
    }
  }

  return result;
}

function buildCohortStats(rows) {
  const cohorts = new Map();

  for (const row of rows) {
    const key = buildCohortKey(row);
    if (!cohorts.has(key)) {
      cohorts.set(key, {
        actionableCount: 0,
        executions: 0,
        leanCount: 0,
        passCount: 0,
        sampleCount: 0,
      });
    }

    const cohort = cohorts.get(key);
    cohort.sampleCount += 1;
    if (row.execution_status === 'EXECUTABLE') cohort.executions += 1;
    if (row.actionable) cohort.actionableCount += 1;
    if (row.official_status === 'LEAN') cohort.leanCount += 1;
    if (row.official_status === 'PASS') cohort.passCount += 1;
  }

  const finalized = new Map();
  for (const [key, cohort] of cohorts.entries()) {
    finalized.set(key, {
      actionable_sample_count: cohort.actionableCount,
      executable_rate:
        cohort.sampleCount > 0 ? round(cohort.executions / cohort.sampleCount) : null,
      lean_rate:
        cohort.sampleCount > 0 ? round(cohort.leanCount / cohort.sampleCount) : null,
      pass_rate:
        cohort.sampleCount > 0 ? round(cohort.passCount / cohort.sampleCount) : null,
      sample_count: cohort.sampleCount,
    });
  }

  return finalized;
}

function buildCalibrationBuckets(rows) {
  const buckets = CALIBRATION_BUCKETS.map((bucket) => ({
    count: 0,
    hit_rate: null,
    label: bucket.label,
    losses: 0,
    sufficient_sample: false,
    wins: 0,
  }));

  for (const row of rows) {
    if (!Number.isFinite(row.p_fair) || row.p_fair < 0.5) continue;
    if (row.result !== 'WIN' && row.result !== 'LOSS') continue;

    const bucketIndex = CALIBRATION_BUCKETS.findIndex((bucket) => {
      if (bucket.max === Number.POSITIVE_INFINITY) {
        return row.p_fair >= bucket.min;
      }
      return row.p_fair >= bucket.min && row.p_fair < bucket.max;
    });

    if (bucketIndex === -1) continue;
    const bucket = buckets[bucketIndex];
    bucket.count += 1;
    if (row.result === 'WIN') bucket.wins += 1;
    if (row.result === 'LOSS') bucket.losses += 1;
  }

  for (const bucket of buckets) {
    bucket.sufficient_sample = bucket.count >= CALIBRATION_BUCKET_MIN_SAMPLE;
    const decisions = bucket.wins + bucket.losses;
    bucket.hit_rate = decisions > 0 ? round(bucket.wins / decisions) : null;
    delete bucket.wins;
    delete bucket.losses;
  }

  return buckets;
}

function finalizeBlockRateByReason(reasonCounts, sampleCount) {
  const entries = Array.from(reasonCounts.entries())
    .filter((entry) => entry[1] > 0)
    .sort((left, right) => left[0].localeCompare(right[0]));

  const blockRateByReason = {};
  for (const [reasonCode, count] of entries) {
    blockRateByReason[reasonCode] = sampleCount > 0 ? round(count / sampleCount) : null;
  }

  return blockRateByReason;
}

function buildSegments(rows, previousModelVersions) {
  const segmentRows = new Map();
  const cohortStats = buildCohortStats(rows);

  for (const row of rows) {
    const key = buildSegmentKey(row);
    if (!segmentRows.has(key)) segmentRows.set(key, []);
    segmentRows.get(key).push(row);
  }

  const segments = [];

  for (const [key, groupedRows] of segmentRows.entries()) {
    const firstRow = groupedRows[0];
    const sampleCount = groupedRows.length;
    const metricRows =
      firstRow.execution_status === 'EXECUTABLE'
        ? groupedRows.filter((row) => row.actionable)
        : groupedRows;

    let wins = 0;
    let losses = 0;
    let pushes = 0;
    let pnlSum = 0;
    let roiAvailable = metricRows.length > 0;
    const reasonCounts = new Map();

    for (const row of metricRows) {
      if (row.result === 'WIN') wins += 1;
      else if (row.result === 'LOSS') losses += 1;
      else if (row.result === 'PUSH') pushes += 1;

      if (Number.isFinite(row.pnl_units)) {
        pnlSum += row.pnl_units;
      } else {
        roiAvailable = false;
      }
    }

    for (const row of groupedRows) {
      for (const reasonCode of row.reason_codes) {
        reasonCounts.set(reasonCode, (reasonCounts.get(reasonCode) || 0) + 1);
      }
    }

    const decisionCount = wins + losses;
    const cohortKey = buildCohortKey(firstRow);
    const cohort = cohortStats.get(cohortKey);
    const previousModelVersion = previousModelVersions.get(
      `${firstRow.sport}||${firstRow.card_family}||${firstRow.card_mode}||${firstRow.model_version}`,
    ) || null;

    const segment = {
      actionable_sample_count: groupedRows.filter((row) => row.actionable).length,
      block_rate_by_reason: finalizeBlockRateByReason(reasonCounts, sampleCount),
      calibration: {
        buckets: buildCalibrationBuckets(metricRows),
      },
      card_family: firstRow.card_family,
      card_mode: firstRow.card_mode,
      clv_available: groupedRows.some((row) => Number.isFinite(row.clv_pct)),
      executable_rate: cohort?.executable_rate ?? null,
      execution_status: firstRow.execution_status,
      hit_rate: decisionCount > 0 ? round(wins / decisionCount) : null,
      lean_rate: cohort?.lean_rate ?? null,
      losses,
      model_version: firstRow.model_version,
      pass_rate: cohort?.pass_rate ?? null,
      previous_model_version: previousModelVersion,
      pushes,
      roi:
        roiAvailable && metricRows.length > 0
          ? round(pnlSum / metricRows.length)
          : null,
      roi_available: roiAvailable && metricRows.length > 0,
      sample_count: sampleCount,
      sport: firstRow.sport,
      wins,
    };

    if (firstRow.card_mode === 'PROJECTION_ONLY') {
      segment.projection_metrics = evaluateProjectionRows(
        groupedRows,
        firstRow.card_family,
      );
    }

    segments.push(segment);
  }

  return segments.sort(compareSegments);
}

function compareSegments(left, right) {
  return (
    left.sport.localeCompare(right.sport) ||
    left.card_family.localeCompare(right.card_family) ||
    left.card_mode.localeCompare(right.card_mode) ||
    left.execution_status.localeCompare(right.execution_status) ||
    left.model_version.localeCompare(right.model_version)
  );
}

function buildSegmentIndex(segments) {
  return new Map(
    segments.map((segment) => [
      [
        segment.sport,
        segment.card_family,
        segment.card_mode,
        segment.execution_status,
        segment.model_version,
      ].join('||'),
      segment,
    ]),
  );
}

function buildCohortIndex(segments) {
  const index = new Map();
  for (const segment of segments) {
    const key = [
      segment.sport,
      segment.card_family,
      segment.card_mode,
      segment.model_version,
    ].join('||');

    if (!index.has(key)) {
      index.set(key, {
        card_family: segment.card_family,
        card_mode: segment.card_mode,
        executable_rate: segment.executable_rate,
        lean_rate: segment.lean_rate,
        model_version: segment.model_version,
        pass_rate: segment.pass_rate,
        previous_model_version: segment.previous_model_version,
        sample_count: segment.sample_count,
        sport: segment.sport,
      });
      continue;
    }

    const current = index.get(key);
    current.sample_count += segment.sample_count;
  }

  return index;
}

function calculateCalibrationDivergence(calibration) {
  const buckets = Array.isArray(calibration?.buckets) ? calibration.buckets : [];
  let maxDivergence = null;

  for (let index = 0; index < buckets.length - 1; index += 1) {
    const left = buckets[index];
    const right = buckets[index + 1];
    if (!left?.sufficient_sample || !right?.sufficient_sample) continue;
    if (!Number.isFinite(left.hit_rate) || !Number.isFinite(right.hit_rate)) continue;

    const divergence = Math.abs(left.hit_rate - right.hit_rate);
    if (maxDivergence === null || divergence > maxDivergence) {
      maxDivergence = divergence;
    }
  }

  return maxDivergence !== null ? round(maxDivergence) : null;
}

function collectWindowAlertCandidates(
  windowName,
  currentSegments,
  baselineSegments,
  options = {},
) {
  if (windowName === 'season_to_date') return [];
  if (
    Number.isFinite(options.requiredSize) &&
    options.currentSampleCount < options.requiredSize
  ) {
    return [];
  }

  const candidates = [];
  const currentSegmentIndex = buildSegmentIndex(currentSegments);
  const baselineSegmentIndex = buildSegmentIndex(baselineSegments);
  const currentCohortIndex = buildCohortIndex(currentSegments);
  const baselineCohortIndex = buildCohortIndex(baselineSegments);

  for (const cohort of currentCohortIndex.values()) {
    if (cohort.card_mode !== 'ODDS_BACKED') continue;
    if (cohort.sample_count < ALERT_SAMPLE_MIN) continue;

    const cohortKey = [
      cohort.sport,
      cohort.card_family,
      cohort.card_mode,
      cohort.model_version,
    ].join('||');
    const baselineCohort = baselineCohortIndex.get(cohortKey);

    if (
      Number.isFinite(cohort.executable_rate) &&
      cohort.executable_rate > EXECUTABLE_RATE_SPIKE_THRESHOLD
    ) {
      candidates.push({
        alert_type: 'EXECUTABLE_RATE_SPIKE',
        baseline_value: baselineCohort?.executable_rate ?? null,
        card_family: cohort.card_family,
        card_mode: cohort.card_mode,
        execution_status: 'EXECUTABLE',
        model_version: cohort.model_version,
        previous_model_version: cohort.previous_model_version,
        sample_count: cohort.sample_count,
        sport: cohort.sport,
        threshold: EXECUTABLE_RATE_SPIKE_THRESHOLD,
        value: cohort.executable_rate,
        window: windowName,
      });
    }

    if (
      Number.isFinite(cohort.pass_rate) &&
      cohort.pass_rate < PASS_RATE_COLLAPSE_THRESHOLD
    ) {
      candidates.push({
        alert_type: 'PASS_RATE_COLLAPSE',
        baseline_value: baselineCohort?.pass_rate ?? null,
        card_family: cohort.card_family,
        card_mode: cohort.card_mode,
        execution_status: 'BLOCKED',
        model_version: cohort.model_version,
        previous_model_version: cohort.previous_model_version,
        sample_count: cohort.sample_count,
        sport: cohort.sport,
        threshold: PASS_RATE_COLLAPSE_THRESHOLD,
        value: cohort.pass_rate,
        window: windowName,
      });
    }
  }

  for (const segment of currentSegmentIndex.values()) {
    if (segment.card_mode !== 'ODDS_BACKED') continue;
    if (segment.sample_count < ALERT_SAMPLE_MIN) continue;

    const divergence = calculateCalibrationDivergence(segment.calibration);
    if (
      Number.isFinite(divergence) &&
      divergence > CALIBRATION_DIVERGENCE_THRESHOLD
    ) {
      candidates.push({
        alert_type: 'CALIBRATION_DIVERGENCE',
        baseline_value: null,
        card_family: segment.card_family,
        card_mode: segment.card_mode,
        execution_status: segment.execution_status,
        model_version: segment.model_version,
        previous_model_version: segment.previous_model_version,
        sample_count: segment.sample_count,
        sport: segment.sport,
        threshold: CALIBRATION_DIVERGENCE_THRESHOLD,
        value: divergence,
        window: windowName,
      });
    }

    const baselineSegment = baselineSegmentIndex.get(
      [
        segment.sport,
        segment.card_family,
        segment.card_mode,
        segment.execution_status,
        segment.model_version,
      ].join('||'),
    );
    if (!baselineSegment) continue;

    const reasonCodes = new Set([
      ...Object.keys(segment.block_rate_by_reason || {}),
      ...Object.keys(baselineSegment.block_rate_by_reason || {}),
    ]);

    for (const reasonCode of Array.from(reasonCodes).sort()) {
      const currentValue = toNumber(segment.block_rate_by_reason?.[reasonCode], 0);
      const baselineValue = toNumber(
        baselineSegment.block_rate_by_reason?.[reasonCode],
        0,
      );
      const delta = currentValue - baselineValue;

      if (delta <= BLOCK_RATE_SHIFT_THRESHOLD) continue;

      candidates.push({
        alert_type: 'BLOCK_RATE_SHIFT',
        baseline_value: baselineValue,
        card_family: segment.card_family,
        card_mode: segment.card_mode,
        execution_status: segment.execution_status,
        model_version: segment.model_version,
        previous_model_version: segment.previous_model_version,
        reason_code: reasonCode,
        sample_count: segment.sample_count,
        sport: segment.sport,
        threshold: BLOCK_RATE_SHIFT_THRESHOLD,
        value: currentValue,
        window: windowName,
      });
    }
  }

  return candidates;
}

function decorateAlertSeverities(candidates) {
  const grouped = new Map();

  for (const candidate of candidates) {
    const groupKey = [
      candidate.alert_type,
      candidate.sport,
      candidate.card_family,
      candidate.card_mode,
      candidate.execution_status,
      candidate.model_version,
      candidate.reason_code || '',
    ].join('||');

    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(candidate);
  }

  const result = [];

  for (const group of grouped.values()) {
    const windows = new Set(group.map((candidate) => candidate.window));
    const has50 = windows.has('last_50');
    const has100 = windows.has('last_100');
    const has200 = windows.has('last_200');

    let severity = 'WARN';
    if (has50 && has100 && has200) {
      severity = 'CRITICAL';
    } else if (group[0].alert_type === 'CALIBRATION_DIVERGENCE') {
      severity = 'HIGH';
    } else if (has50 && has100) {
      severity = 'HIGH';
    }

    for (const candidate of group) {
      result.push({
        ...candidate,
        baseline_window:
          candidate.window === 'last_50'
            ? 'previous_50'
            : candidate.window === 'last_100'
              ? 'previous_100'
              : candidate.window === 'last_200'
                ? 'previous_200'
                : null,
        severity,
      });
    }
  }

  return result.sort(compareAlerts);
}

function compareAlerts(left, right) {
  return (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    left.alert_type.localeCompare(right.alert_type) ||
    left.sport.localeCompare(right.sport) ||
    left.card_family.localeCompare(right.card_family) ||
    left.card_mode.localeCompare(right.card_mode) ||
    left.execution_status.localeCompare(right.execution_status) ||
    left.model_version.localeCompare(right.model_version) ||
    left.window.localeCompare(right.window) ||
    String(left.reason_code || '').localeCompare(String(right.reason_code || ''))
  );
}

function buildPerformanceDriftReport(rows, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const sortedRows = [...rows].sort((left, right) => {
    if (left.settled_at_ms !== right.settled_at_ms) {
      return right.settled_at_ms - left.settled_at_ms;
    }
    return right.settled_at.localeCompare(left.settled_at);
  });

  const previousModelVersions = buildModelVersionHistory(sortedRows);
  const windows = {};
  const alertCandidates = [];
  const projectionAlerts = [];

  for (const definition of WINDOW_DEFS) {
    const currentRows =
      definition.size === null ? sortedRows : sortedRows.slice(0, definition.size);
    const baselineRows =
      definition.size === null ? [] : sortedRows.slice(definition.size, definition.size * 2);

    const currentSegments = buildSegments(currentRows, previousModelVersions);
    const baselineSegments = buildSegments(baselineRows, previousModelVersions);

    windows[definition.name] = {
      ...buildWindowMetadata(definition, currentRows, baselineRows),
      segments: currentSegments,
    };

    alertCandidates.push(
      ...collectWindowAlertCandidates(
        definition.name,
        currentSegments,
        baselineSegments,
        {
          currentSampleCount: currentRows.length,
          requiredSize: definition.size,
        },
      ),
    );

    for (const segment of currentSegments) {
      projectionAlerts.push(...collectProjectionAlerts(segment, definition.name));
    }
  }

  return {
    alerts: [
      ...decorateAlertSeverities(alertCandidates),
      ...projectionAlerts,
    ].sort(compareAlerts),
    dimensions: [...DIMENSIONS],
    generated_at: generatedAt,
    windows,
  };
}

function generatePerformanceDriftReport(options = {}) {
  const externalDb = options.db || null;
  const db = externalDb || getDatabaseReadOnly();

  try {
    const rows = loadSettledRows({
      db,
      sport: options.sport && !options.all ? options.sport : null,
    });
    return buildPerformanceDriftReport(rows, options);
  } finally {
    if (!externalDb) {
      closeReadOnlyInstance(db);
    }
  }
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);

  if (options.help) {
    stdout.write(`${formatHelp()}\n`);
    return 0;
  }

  try {
    const report = generatePerformanceDriftReport(options);
    const json = JSON.stringify(report, null, 2);

    if (options.output) {
      fs.writeFileSync(options.output, json, 'utf8');
    }

    stdout.write(`${json}\n`);
    return 0;
  } catch (error) {
    stderr.write(`[performance_drift_report] ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  buildPerformanceDriftReport,
  CALIBRATION_BUCKETS,
  deriveCardFamily,
  deriveCardMode,
  generatePerformanceDriftReport,
  loadSettledRows,
  parseArgs,
  runCli,
};
