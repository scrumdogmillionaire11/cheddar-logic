/**
 * One-shot repair for MLB full-game total/moneyline display-log gaps.
 *
 * Dry-run is the default:
 *   node apps/worker/src/jobs/repair_mlb_full_game_display_log.js
 *   node apps/worker/src/jobs/repair_mlb_full_game_display_log.js --apply
 */

'use strict';

require('dotenv').config();

const { getDatabase, withDb } = require('@cheddar-logic/data');

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function hasOwnValue(source, key) {
  return (
    source &&
    typeof source === 'object' &&
    Object.prototype.hasOwnProperty.call(source, key) &&
    source[key] !== null &&
    source[key] !== undefined &&
    String(source[key]).trim() !== ''
  );
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMarketType(value) {
  const token = toUpperToken(value).replace(/[\s-]+/g, '_');
  if (token === 'MONEYLINE' || token === 'ML' || token === 'H2H') {
    return 'MONEYLINE';
  }
  if (token === 'TOTAL' || token === 'TOTALS' || token === 'OVER_UNDER' || token === 'OU') {
    return 'TOTAL';
  }
  return token;
}

function resolveStrictStatus(payloadData) {
  const decisionV2 =
    payloadData?.decision_v2 && typeof payloadData.decision_v2 === 'object'
      ? payloadData.decision_v2
      : null;
  if (hasOwnValue(decisionV2, 'official_status')) {
    const explicit = toUpperToken(decisionV2.official_status);
    return explicit === 'PLAY' || explicit === 'LEAN' || explicit === 'PASS'
      ? explicit
      : '';
  }

  const fallback = hasOwnValue(payloadData, 'status')
    ? toUpperToken(payloadData.status)
    : toUpperToken(payloadData?.action);
  if (fallback === 'PLAY' || fallback === 'FIRE') return 'PLAY';
  if (fallback === 'LEAN') return 'LEAN';
  if (fallback === 'PASS') return 'PASS';
  return '';
}

function resolveExecutionStatus(payloadData) {
  return toUpperToken(
    payloadData?.execution_status ??
      payloadData?.play?.execution_status ??
      payloadData?._publish_state?.execution_status,
  );
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExecutableMlbFullGameLean(row, payloadData) {
  const cardType = String(row.card_type || '').trim().toLowerCase();
  if (cardType !== 'mlb-full-game' && cardType !== 'mlb-full-game-ml') {
    return false;
  }
  if (resolveStrictStatus(payloadData) !== 'LEAN') return false;
  if (resolveExecutionStatus(payloadData) !== 'EXECUTABLE') return false;

  const marketType = normalizeMarketType(
    row.market_type ?? payloadData?.market_type ?? payloadData?.recommended_bet_type,
  );
  const selection = toUpperToken(
    row.selection ?? payloadData?.selection?.side ?? payloadData?.selection,
  );
  const line = toFiniteNumberOrNull(row.line ?? payloadData?.line);
  const odds = toFiniteNumberOrNull(row.locked_price ?? payloadData?.price);

  if (marketType === 'MONEYLINE') {
    return (selection === 'HOME' || selection === 'AWAY') && odds !== null;
  }
  if (marketType === 'TOTAL') {
    return (
      (selection === 'OVER' || selection === 'UNDER') &&
      line !== null &&
      odds !== null
    );
  }
  return false;
}

function parseArgs(argv) {
  const args = { dryRun: true, limit: 500, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--limit') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limit = Math.trunc(parsed);
      }
      i += 1;
    }
  }
  return args;
}

async function repairMlbFullGameDisplayLog({ dryRun = true, limit = 500 } = {}) {
  return withDb(async () => {
    const db = getDatabase();
    const hasDisplayLog = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'card_display_log' LIMIT 1`,
      )
      .get();
    if (!hasDisplayLog) {
      return {
        success: false,
        dryRun,
        scanned: 0,
        eligible: 0,
        inserted: 0,
        error: 'card_display_log table not found',
      };
    }

    const rows = db
      .prepare(
        `
        SELECT
          cr.id AS result_id,
          cr.card_id,
          cr.game_id,
          cr.sport,
          cr.card_type,
          cr.market_type,
          cr.selection,
          cr.line,
          cr.locked_price,
          cp.run_id,
          cp.created_at,
          cp.payload_data
        FROM card_results cr
        INNER JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
        LEFT JOIN card_payloads cp ON cp.id = cr.card_id
        LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
        WHERE cr.status = 'pending'
          AND cdl.pick_id IS NULL
          AND UPPER(COALESCE(cr.sport, cp.sport, json_extract(cp.payload_data, '$.sport'), '')) IN ('MLB', 'BASEBALL_MLB')
          AND LOWER(COALESCE(cr.card_type, cp.card_type, '')) IN ('mlb-full-game', 'mlb-full-game-ml')
        ORDER BY datetime(COALESCE(cp.created_at, '1970-01-01T00:00:00Z')) ASC, cr.card_id ASC
        LIMIT ?
      `,
      )
      .all(limit);

    const candidates = [];
    for (const row of rows) {
      const payloadData = parseJsonObject(row.payload_data);
      if (!isExecutableMlbFullGameLean(row, payloadData)) continue;
      const marketType = normalizeMarketType(
        row.market_type ?? payloadData?.market_type ?? payloadData?.recommended_bet_type,
      );
      candidates.push({
        pickId: row.card_id,
        runId: row.run_id || null,
        gameId: row.game_id,
        sport: 'MLB',
        marketType,
        selection: toUpperToken(
          row.selection ?? payloadData?.selection?.side ?? payloadData?.selection,
        ),
        line: toFiniteNumberOrNull(row.line ?? payloadData?.line),
        odds: toFiniteNumberOrNull(row.locked_price ?? payloadData?.price),
        oddsBook: payloadData?.odds_context?.bookmaker || null,
        confidencePct:
          toFiniteNumberOrNull(payloadData?.confidence_pct) ??
          (
            toFiniteNumberOrNull(payloadData?.confidence) !== null
              ? toFiniteNumberOrNull(payloadData.confidence) * 100
              : null
          ),
        displayedAt: row.created_at || new Date().toISOString(),
      });
    }

    let inserted = 0;
    if (!dryRun && candidates.length > 0) {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO card_display_log (
          pick_id,
          run_id,
          game_id,
          sport,
          market_type,
          selection,
          line,
          odds,
          odds_book,
          confidence_pct,
          displayed_at,
          api_endpoint
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '/api/games')
      `);

      for (const candidate of candidates) {
        const info = insertStmt.run(
          candidate.pickId,
          candidate.runId,
          candidate.gameId,
          candidate.sport,
          candidate.marketType,
          candidate.selection,
          candidate.line,
          candidate.odds,
          candidate.oddsBook,
          candidate.confidencePct,
          candidate.displayedAt,
        );
        inserted += Number(info?.changes || 0);
      }
    }

    return {
      success: true,
      dryRun,
      scanned: rows.length,
      eligible: candidates.length,
      inserted,
      candidatePickIds: candidates.map((candidate) => candidate.pickId),
    };
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  repairMlbFullGameDisplayLog(args)
    .then((result) => {
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `[RepairMlbFullGameDisplayLog] dryRun=${result.dryRun} scanned=${result.scanned} eligible=${result.eligible} inserted=${result.inserted}`,
        );
        if (result.candidatePickIds?.length) {
          console.log(
            `[RepairMlbFullGameDisplayLog] candidates=${result.candidatePickIds.join(',')}`,
          );
        }
        if (result.error) {
          console.error(`[RepairMlbFullGameDisplayLog] ${result.error}`);
        }
      }
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = {
  isExecutableMlbFullGameLean,
  parseArgs,
  repairMlbFullGameDisplayLog,
  resolveExecutionStatus,
  resolveStrictStatus,
};
