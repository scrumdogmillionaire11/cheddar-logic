'use strict';

const fs = require('fs');
const path = require('path');

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
} = require('@cheddar-logic/data');

const DEFAULT_PRICE_BUFFER_MINUTES = 60;
const DEFAULT_MAX_EXCLUDED_RATE = 0.2;
const DEFAULT_LOOKBACK_DAYS = 90;

function toFiniteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIsoToMs(value) {
  if (!value || typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyPreGameSnapshot({
  snapshotTimeIso,
  eventStartIso,
  priceBufferMinutes = DEFAULT_PRICE_BUFFER_MINUTES,
}) {
  const snapshotMs = parseIsoToMs(snapshotTimeIso);
  const eventStartMs = parseIsoToMs(eventStartIso);
  const bufferMinutes = Math.max(0, toFiniteNumber(priceBufferMinutes, DEFAULT_PRICE_BUFFER_MINUTES));

  if (!Number.isFinite(eventStartMs)) {
    return {
      status: 'MISSING_EVENT_START',
      qualifying: false,
      snapshot_ms: snapshotMs,
      event_start_ms: eventStartMs,
      cutoff_ms: null,
    };
  }

  if (!Number.isFinite(snapshotMs)) {
    return {
      status: 'MISSING_SNAPSHOT_TIME',
      qualifying: false,
      snapshot_ms: snapshotMs,
      event_start_ms: eventStartMs,
      cutoff_ms: eventStartMs - bufferMinutes * 60 * 1000,
    };
  }

  const cutoffMs = eventStartMs - bufferMinutes * 60 * 1000;
  const qualifying = snapshotMs <= cutoffMs;

  return {
    status: qualifying ? 'QUALIFYING' : 'WITHIN_BUFFER_OR_POST_START',
    qualifying,
    snapshot_ms: snapshotMs,
    event_start_ms: eventStartMs,
    cutoff_ms: cutoffMs,
  };
}

function normalizeGameId(value) {
  const normalized = String(value || '').trim();
  return normalized.length > 0 ? normalized : 'UNKNOWN_GAME';
}

function buildClosingLineSubstitutionReport(
  rows,
  {
    maxExcludedRate = DEFAULT_MAX_EXCLUDED_RATE,
    priceBufferMinutes = DEFAULT_PRICE_BUFFER_MINUTES,
  } = {},
) {
  const games = new Map();
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeMaxExcludedRate = Math.min(
    1,
    Math.max(0, toFiniteNumber(maxExcludedRate, DEFAULT_MAX_EXCLUDED_RATE)),
  );
  const safeBufferMinutes = Math.max(
    0,
    toFiniteNumber(priceBufferMinutes, DEFAULT_PRICE_BUFFER_MINUTES),
  );

  for (const row of safeRows) {
    const gameId = normalizeGameId(row?.game_id);
    if (!games.has(gameId)) {
      games.set(gameId, {
        game_id: gameId,
        event_start_utc: row?.event_start_utc || null,
        qualifying_snapshot_count: 0,
        disqualified_snapshot_count: 0,
        snapshots_total: 0,
        statuses: {},
      });
    }

    const game = games.get(gameId);
    const classification = classifyPreGameSnapshot({
      snapshotTimeIso: row?.snapshot_time_utc,
      eventStartIso: row?.event_start_utc || game.event_start_utc,
      priceBufferMinutes: safeBufferMinutes,
    });
    const status = classification.status;

    game.event_start_utc = game.event_start_utc || row?.event_start_utc || null;
    game.snapshots_total += 1;
    game.statuses[status] = (game.statuses[status] || 0) + 1;

    if (classification.qualifying) {
      game.qualifying_snapshot_count += 1;
    } else {
      game.disqualified_snapshot_count += 1;
    }
  }

  const gameRows = Array.from(games.values()).sort((left, right) =>
    String(left.game_id).localeCompare(String(right.game_id)),
  );

  let gamesWithKnownEventStart = 0;
  let gamesWithQualifyingSnapshot = 0;
  let gamesExcluded = 0;
  let snapshotsQualifying = 0;
  let snapshotsDisqualified = 0;
  let snapshotsMissingEventStart = 0;

  for (const game of gameRows) {
    snapshotsQualifying += game.qualifying_snapshot_count;
    snapshotsDisqualified += game.disqualified_snapshot_count;
    snapshotsMissingEventStart += game.statuses.MISSING_EVENT_START || 0;

    const hasKnownEventStart = Number.isFinite(parseIsoToMs(game.event_start_utc));
    if (!hasKnownEventStart) continue;

    gamesWithKnownEventStart += 1;
    if (game.qualifying_snapshot_count > 0) {
      gamesWithQualifyingSnapshot += 1;
    } else {
      gamesExcluded += 1;
    }
  }

  const excludedRate =
    gamesWithKnownEventStart > 0
      ? Number((gamesExcluded / gamesWithKnownEventStart).toFixed(4))
      : 0;
  const shouldFail =
    gamesWithKnownEventStart > 0 && excludedRate >= safeMaxExcludedRate;

  return {
    policy: {
      max_excluded_rate: safeMaxExcludedRate,
      price_buffer_minutes: safeBufferMinutes,
      rule: 'snapshot_time <= event_start - PRICE_BUFFER_MINUTES',
    },
    summary: {
      excluded_game_rate: excludedRate,
      games_excluded_no_qualifying_snapshot: gamesExcluded,
      games_with_known_event_start: gamesWithKnownEventStart,
      games_with_qualifying_snapshot: gamesWithQualifyingSnapshot,
      snapshots_disqualified: snapshotsDisqualified,
      snapshots_missing_event_start: snapshotsMissingEventStart,
      snapshots_qualifying: snapshotsQualifying,
      total_games: gameRows.length,
      should_fail: shouldFail,
    },
    games: gameRows,
  };
}

function loadSnapshotRows(db, { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const safeLookbackDays = Math.max(
    1,
    toFiniteNumber(lookbackDays, DEFAULT_LOOKBACK_DAYS),
  );

  return db
    .prepare(
      `
      SELECT
        g.game_id,
        g.game_time_utc AS event_start_utc,
        o.captured_at AS snapshot_time_utc
      FROM games g
      LEFT JOIN odds_snapshots o ON o.game_id = g.game_id
      WHERE g.game_time_utc IS NOT NULL
        AND datetime(g.game_time_utc) >= datetime('now', ?)
      ORDER BY datetime(g.game_time_utc) DESC, datetime(o.captured_at) DESC
      `,
    )
    .all(`-${safeLookbackDays} days`);
}

function runClosingLineSubstitutionValidation({
  db = null,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  maxExcludedRate = DEFAULT_MAX_EXCLUDED_RATE,
  outPath = null,
  priceBufferMinutes = DEFAULT_PRICE_BUFFER_MINUTES,
  rows = null,
} = {}) {
  const ownDb = !db;
  const readOnlyDb = db || getDatabaseReadOnly();

  try {
    const snapshotRows = Array.isArray(rows)
      ? rows
      : loadSnapshotRows(readOnlyDb, { lookbackDays });
    const report = buildClosingLineSubstitutionReport(snapshotRows, {
      maxExcludedRate,
      priceBufferMinutes,
    });

    if (outPath) {
      const resolvedPath = path.resolve(outPath);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(`${resolvedPath}`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    return {
      ok: report.summary.should_fail !== true,
      report,
    };
  } finally {
    if (ownDb) closeReadOnlyInstance(readOnlyDb);
  }
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const parsed = {
    lookback_days: DEFAULT_LOOKBACK_DAYS,
    max_excluded_rate: DEFAULT_MAX_EXCLUDED_RATE,
    out: null,
    price_buffer_minutes: DEFAULT_PRICE_BUFFER_MINUTES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inlineValue] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, null];

    if (
      flag === '--out' ||
      flag === '--price-buffer-minutes' ||
      flag === '--max-excluded-rate' ||
      flag === '--lookback-days'
    ) {
      const nextValue = inlineValue !== null ? inlineValue : argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
      }
      const key = flag.slice(2).replace(/-/g, '_');
      parsed[key] = nextValue;
      if (inlineValue === null) index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  parsed.price_buffer_minutes = Math.max(
    0,
    toFiniteNumber(parsed.price_buffer_minutes, DEFAULT_PRICE_BUFFER_MINUTES),
  );
  parsed.max_excluded_rate = Math.min(
    1,
    Math.max(0, toFiniteNumber(parsed.max_excluded_rate, DEFAULT_MAX_EXCLUDED_RATE)),
  );
  parsed.lookback_days = Math.max(
    1,
    toFiniteNumber(parsed.lookback_days, DEFAULT_LOOKBACK_DAYS),
  );

  return parsed;
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  try {
    const parsed = parseCliArgs(argv);
    const { ok, report } = runClosingLineSubstitutionValidation({
      lookbackDays: parsed.lookback_days,
      maxExcludedRate: parsed.max_excluded_rate,
      outPath: parsed.out,
      priceBufferMinutes: parsed.price_buffer_minutes,
    });

    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (parsed.out) {
      stdout.write(`Wrote report to ${path.resolve(parsed.out)}\n`);
    }

    if (!ok) {
      stderr.write(
        `[validate_no_closing_line_sub] excluded rate ${report.summary.excluded_game_rate} >= threshold ${report.policy.max_excluded_rate}\n`,
      );
      return 1;
    }

    return 0;
  } catch (error) {
    stderr.write(`[validate_no_closing_line_sub] ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  buildClosingLineSubstitutionReport,
  classifyPreGameSnapshot,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MAX_EXCLUDED_RATE,
  DEFAULT_PRICE_BUFFER_MINUTES,
  loadSnapshotRows,
  parseCliArgs,
  runCli,
  runClosingLineSubstitutionValidation,
};
