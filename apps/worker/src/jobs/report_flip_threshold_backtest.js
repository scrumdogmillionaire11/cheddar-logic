'use strict';

require('dotenv').config();

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
  resolveDatabasePath,
} = require('@cheddar-logic/data');

const DEFAULT_WINDOW_DAYS = 120;
const MIN_GRADED_CHANGED_EVENTS = 3;

const PROFILES = Object.freeze([
  {
    id: 'baseline',
    label: 'Baseline',
    edgeUpgradeMin: 0.5,
    notes: 'Current baseline profile from WI-0539/WI-0536.',
  },
  {
    id: 'moderate',
    label: 'Moderate',
    edgeUpgradeMin: 0.25,
    notes: 'Counterfactual moderate profile.',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    edgeUpgradeMin: 0.1,
    notes: 'Counterfactual aggressive profile.',
  },
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    help: false,
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
    if (arg.startsWith('--days=')) {
      options.days = parsePositiveInteger(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--days') {
      options.days = parsePositiveInteger(argv[index + 1]);
      index += 1;
      continue;
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

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeParseJsonObject(value) {
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

function parseDecisionKey(decisionKey) {
  const parts = String(decisionKey || '').split('|');
  if (parts.length < 5) {
    return {
      sport: '',
      gameId: '',
      market: 'unknown',
      period: 'full_game',
      sideFamily: 'unknown',
    };
  }

  const sport = parts[0] || '';
  const sideFamily = parts[parts.length - 1] || 'unknown';
  const period = parts[parts.length - 2] || 'full_game';
  const market = parts[parts.length - 3] || 'unknown';
  const gameId = parts.slice(1, parts.length - 3).join('|');

  return { sport, gameId, market, period, sideFamily };
}

function readFirstPeriodScores(metadata) {
  if (!metadata || typeof metadata !== 'object') return { home: null, away: null };

  const verification =
    metadata.firstPeriodVerification &&
    typeof metadata.firstPeriodVerification === 'object'
      ? metadata.firstPeriodVerification
      : null;
  if (verification && verification.isComplete === false) {
    return { home: null, away: null };
  }

  const fromCamel = metadata.firstPeriodScores;
  if (fromCamel && typeof fromCamel === 'object') {
    const home = Number(fromCamel.home);
    const away = Number(fromCamel.away);
    if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  }

  const fromSnake = metadata.first_period_scores;
  if (fromSnake && typeof fromSnake === 'object') {
    const home = Number(fromSnake.home);
    const away = Number(fromSnake.away);
    if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  }

  return { home: null, away: null };
}

function evaluateOutcomeForSelection({ market, period, side, line, gameResult }) {
  if (!gameResult) return null;

  const normalizedMarket = String(market || '').toLowerCase();
  const normalizedPeriod = String(period || '').toLowerCase();
  const normalizedSide = toUpperToken(side);
  const usingFirstPeriod =
    normalizedPeriod === '1p' || normalizedMarket === 'first_period';

  const homeScore = usingFirstPeriod
    ? gameResult.firstPeriodHome
    : gameResult.finalScoreHome;
  const awayScore = usingFirstPeriod
    ? gameResult.firstPeriodAway
    : gameResult.finalScoreAway;

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;

  if (normalizedMarket === 'moneyline') {
    if (normalizedSide === 'HOME') {
      if (homeScore > awayScore) return 'win';
      if (homeScore < awayScore) return 'loss';
      return 'push';
    }
    if (normalizedSide === 'AWAY') {
      if (awayScore > homeScore) return 'win';
      if (awayScore < homeScore) return 'loss';
      return 'push';
    }
    return null;
  }

  if (normalizedMarket === 'spread' || normalizedMarket === 'puckline') {
    if (!Number.isFinite(line)) return null;

    if (normalizedSide === 'HOME') {
      const diff = homeScore + line - awayScore;
      if (diff > 0) return 'win';
      if (diff < 0) return 'loss';
      return 'push';
    }
    if (normalizedSide === 'AWAY') {
      const diff = awayScore + line - homeScore;
      if (diff > 0) return 'win';
      if (diff < 0) return 'loss';
      return 'push';
    }
    return null;
  }

  if (normalizedMarket === 'total' || normalizedMarket === 'first_period') {
    if (!Number.isFinite(line)) return null;

    const total = homeScore + awayScore;
    if (normalizedSide === 'OVER') {
      if (total > line) return 'win';
      if (total < line) return 'loss';
      return 'push';
    }
    if (normalizedSide === 'UNDER') {
      if (total < line) return 'win';
      if (total > line) return 'loss';
      return 'push';
    }
    return null;
  }

  return null;
}

function computePnlUnits(result, odds) {
  if (result === 'push') return 0;
  if (result === 'loss') return -1;
  if (result !== 'win') return null;
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

function buildGameResultMap(db) {
  const rows = db
    .prepare(
      `
      SELECT game_id, final_score_home, final_score_away, metadata
      FROM game_results
      WHERE status = 'final'
    `,
    )
    .all();

  const byGameId = new Map();
  for (const row of rows) {
    const metadata = safeParseJsonObject(row.metadata);
    const firstPeriodScores = readFirstPeriodScores(metadata);

    byGameId.set(String(row.game_id || ''), {
      finalScoreHome: toNumberOrNull(row.final_score_home),
      finalScoreAway: toNumberOrNull(row.final_score_away),
      firstPeriodHome: toNumberOrNull(firstPeriodScores.home),
      firstPeriodAway: toNumberOrNull(firstPeriodScores.away),
    });
  }

  return byGameId;
}

function listEvents(db, days) {
  return db
    .prepare(
      `
      SELECT
        id,
        ts,
        decision_key,
        action,
        reason_code,
        prev_side,
        prev_line,
        prev_price,
        cand_side,
        cand_line,
        cand_price,
        edge_delta
      FROM decision_events
      WHERE datetime(ts) >= datetime('now', ?)
      ORDER BY datetime(ts) ASC, id ASC
    `,
    )
    .all(`-${days} days`);
}

function isSideChangeEvent(event) {
  const prevSide = toUpperToken(event.prev_side);
  const candSide = toUpperToken(event.cand_side);
  if (!prevSide || !candSide) return false;
  return prevSide !== candSide;
}

function baselineAllows(event) {
  return String(event.action || '').toUpperCase() === 'FLIP_ALLOWED';
}

function profileAllows(event, profileThreshold) {
  if (baselineAllows(event)) return true;

  const blocked = String(event.action || '').toUpperCase() === 'FLIP_BLOCKED';
  const edgeTooSmall = String(event.reason_code || '').toUpperCase() === 'EDGE_TOO_SMALL';
  const edgeDelta = Number(event.edge_delta);

  if (!blocked || !edgeTooSmall || !Number.isFinite(edgeDelta)) return false;
  return edgeDelta >= profileThreshold;
}

function gradeConvertedEvent(event, gameResultById) {
  const key = parseDecisionKey(event.decision_key);
  const gameResult = gameResultById.get(key.gameId);
  if (!gameResult) return null;

  const baselineOutcome = evaluateOutcomeForSelection({
    market: key.market,
    period: key.period,
    side: toUpperToken(event.prev_side),
    line: toNumberOrNull(event.prev_line),
    gameResult,
  });
  const candidateOutcome = evaluateOutcomeForSelection({
    market: key.market,
    period: key.period,
    side: toUpperToken(event.cand_side),
    line: toNumberOrNull(event.cand_line),
    gameResult,
  });

  if (!baselineOutcome || !candidateOutcome) return null;

  const baselineUnitsRaw = computePnlUnits(
    baselineOutcome,
    toNumberOrNull(event.prev_price),
  );
  const candidateUnitsRaw = computePnlUnits(
    candidateOutcome,
    toNumberOrNull(event.cand_price),
  );

  return {
    baselineOutcome,
    candidateOutcome,
    baselineUnits: Number.isFinite(baselineUnitsRaw) ? baselineUnitsRaw : 0,
    candidateUnits: Number.isFinite(candidateUnitsRaw) ? candidateUnitsRaw : 0,
  };
}

function emptyQualityProxy() {
  return {
    graded_changed_events: 0,
    candidate: {
      win: 0,
      loss: 0,
      push: 0,
      units: 0,
    },
    baseline: {
      win: 0,
      loss: 0,
      push: 0,
      units: 0,
    },
    delta_units: 0,
    candidate_win_rate: null,
  };
}

function applyOutcomeCounts(bucket, outcome) {
  if (outcome === 'win') bucket.win += 1;
  if (outcome === 'loss') bucket.loss += 1;
  if (outcome === 'push') bucket.push += 1;
}

function evaluateProfile(profile, events, gameResultById) {
  let flipCount = 0;
  let blockedCount = 0;
  let convertedFromEdgeTooSmall = 0;
  const quality = emptyQualityProxy();

  for (const event of events) {
    if (!isSideChangeEvent(event)) continue;

    const allow = profileAllows(event, profile.edgeUpgradeMin);
    if (allow) {
      flipCount += 1;
    } else {
      blockedCount += 1;
    }

    const conversion =
      !baselineAllows(event) &&
      allow &&
      String(event.reason_code || '').toUpperCase() === 'EDGE_TOO_SMALL';

    if (!conversion) continue;

    convertedFromEdgeTooSmall += 1;

    const graded = gradeConvertedEvent(event, gameResultById);
    if (!graded) continue;

    quality.graded_changed_events += 1;

    applyOutcomeCounts(quality.candidate, graded.candidateOutcome);
    applyOutcomeCounts(quality.baseline, graded.baselineOutcome);

    quality.candidate.units += graded.candidateUnits;
    quality.baseline.units += graded.baselineUnits;
  }

  quality.candidate.units = round(quality.candidate.units) || 0;
  quality.baseline.units = round(quality.baseline.units) || 0;
  quality.delta_units = round(quality.candidate.units - quality.baseline.units) || 0;
  if (quality.graded_changed_events > 0) {
    quality.candidate_win_rate = round(
      quality.candidate.win / quality.graded_changed_events,
    );
  }

  return {
    profile: {
      id: profile.id,
      label: profile.label,
      edge_upgrade_min: profile.edgeUpgradeMin,
      notes: profile.notes,
    },
    flip_count: flipCount,
    blocked_count: blockedCount,
    converted_from_edge_too_small: convertedFromEdgeTooSmall,
    quality_proxy: quality,
  };
}

function pickSelectedProfile(profileReports) {
  const baseline =
    profileReports.find((report) => report.profile.id === 'baseline') ||
    profileReports[0];

  const eligible = profileReports.filter((report) => {
    if (report.profile.id === 'baseline') return true;
    return report.quality_proxy.graded_changed_events >= MIN_GRADED_CHANGED_EVENTS;
  });

  const eligibleNonBaseline = eligible
    .filter((report) => report.profile.id !== 'baseline')
    .map((report) => report.profile.id);

  if (eligibleNonBaseline.length === 0) {
    return {
      selected_profile: baseline.profile.id,
      reason_code: 'INSUFFICIENT_SAMPLE',
      method: 'delta_units_with_min_graded_changed_events_gate',
      rationale:
        'No non-baseline profile met graded_changed_events gate; keep baseline.',
      sample_gate: {
        min_graded_changed_events: MIN_GRADED_CHANGED_EVENTS,
        eligible_nonbaseline_profiles: [],
        gate_met: false,
      },
    };
  }

  const ranked = [...eligible].sort((a, b) => {
    const deltaDiff = b.quality_proxy.delta_units - a.quality_proxy.delta_units;
    if (deltaDiff !== 0) return deltaDiff;

    const aWin = Number.isFinite(a.quality_proxy.candidate_win_rate)
      ? a.quality_proxy.candidate_win_rate
      : -Infinity;
    const bWin = Number.isFinite(b.quality_proxy.candidate_win_rate)
      ? b.quality_proxy.candidate_win_rate
      : -Infinity;
    const winDiff = bWin - aWin;
    if (winDiff !== 0) return winDiff;

    const flipDiff = a.flip_count - b.flip_count;
    if (flipDiff !== 0) return flipDiff;

    if (a.profile.id === 'baseline') return -1;
    if (b.profile.id === 'baseline') return 1;
    return 0;
  });

  const winner = ranked[0];
  const runnerUp = ranked[1] || winner;

  return {
    selected_profile: winner.profile.id,
    reason_code: 'QUALITY_MAX_DELTA_UNITS',
    method: 'delta_units_then_candidate_win_rate_then_lower_flip_count_then_baseline',
    rationale:
      `Selected ${winner.profile.id} by delta_units=${winner.quality_proxy.delta_units} ` +
      `vs ${runnerUp.profile.id} delta_units=${runnerUp.quality_proxy.delta_units}.`,
    sample_gate: {
      min_graded_changed_events: MIN_GRADED_CHANGED_EVENTS,
      eligible_nonbaseline_profiles: eligibleNonBaseline,
      gate_met: true,
    },
  };
}

function formatProfileLine(report) {
  const q = report.quality_proxy;
  return [
    `${report.profile.id} (EDGE_UPGRADE_MIN=${report.profile.edge_upgrade_min})`,
    `flip_count=${report.flip_count}`,
    `blocked_count=${report.blocked_count}`,
    `converted_from_edge_too_small=${report.converted_from_edge_too_small}`,
    `graded_changed_events=${q.graded_changed_events}`,
    `candidate_win_rate=${Number.isFinite(q.candidate_win_rate) ? q.candidate_win_rate : 'n/a'}`,
    `delta_units=${q.delta_units}`,
  ].join(' | ');
}

function formatReport(report) {
  const lines = [];
  lines.push('Flip threshold historical backtest report');
  lines.push('');
  lines.push(`Window: last ${report.window_days} days`);
  lines.push(`Event rows: ${report.dataset.event_count}`);
  lines.push(`Side-change events: ${report.dataset.side_change_event_count}`);
  lines.push(`Final game results available: ${report.dataset.final_game_results}`);
  lines.push('');
  lines.push('Profiles');
  for (const profile of report.profiles) {
    lines.push(`- ${formatProfileLine(profile)}`);
  }
  lines.push('');
  lines.push('Selection');
  lines.push(`- selected_profile=${report.selection.selected_profile}`);
  lines.push(`- reason_code=${report.selection.reason_code}`);
  lines.push(`- method=${report.selection.method}`);
  lines.push(`- rationale=${report.selection.rationale}`);
  lines.push(
    `- sample_gate=${report.selection.sample_gate.min_graded_changed_events} (met=${report.selection.sample_gate.gate_met})`,
  );

  return lines.join('\n');
}

async function generateFlipThresholdBacktestReport({ days = DEFAULT_WINDOW_DAYS } = {}) {
  const db = getDatabaseReadOnly();

  try {
    const events = listEvents(db, days);
    const sideChangeEvents = events.filter(isSideChangeEvent);
    const gameResultById = buildGameResultMap(db);
    const profiles = PROFILES.map((profile) =>
      evaluateProfile(profile, sideChangeEvents, gameResultById),
    );
    const selection = pickSelectedProfile(profiles);

    return {
      generated_at: new Date().toISOString(),
      db_path: resolveDatabasePath(),
      window_days: days,
      dataset: {
        event_count: events.length,
        side_change_event_count: sideChangeEvents.length,
        final_game_results: gameResultById.size,
      },
      profiles,
      selection,
    };
  } finally {
    closeReadOnlyInstance();
  }
}

function printHelp() {
  console.log(
    `Flip threshold historical backtest\n\nOptions:\n  --json          Print machine-readable JSON\n  --days <N>      Rolling window in days (default ${DEFAULT_WINDOW_DAYS})\n  --help          Show this help\n`,
  );
}

if (require.main === module) {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  generateFlipThresholdBacktestReport({ days: options.days })
    .then((report) => {
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatReport(report));
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('[FlipThresholdBacktest] Failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  MIN_GRADED_CHANGED_EVENTS,
  PROFILES,
  formatReport,
  generateFlipThresholdBacktestReport,
  parseArgs,
  __private: {
    buildGameResultMap,
    computePnlUnits,
    evaluateOutcomeForSelection,
    evaluateProfile,
    isSideChangeEvent,
    parseDecisionKey,
    parsePositiveInteger,
    pickSelectedProfile,
    readFirstPeriodScores,
    safeParseJsonObject,
  },
};
