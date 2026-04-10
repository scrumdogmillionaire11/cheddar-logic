/**
 * GET /api/performance
 *
 * Returns aggregated performance report for a given market + period window.
 *
 * Query params:
 *   market  (required) — e.g. NHL_TOTAL, NBA_TOTAL, MLB_F5_TOTAL
 *   days    (optional, default 30) — rolling window in calendar days
 *
 * Response 200:
 * {
 *   market: string,
 *   period_days: number,
 *   bets_placed: number,
 *   hit_rate: number | null,
 *   roi: number | null,
 *   avg_clv: number | null,       -- null when no closing lines resolved yet
 *   brier: number | null,
 *   ece: number | null,
 *   model_ok_pct: number | null,
 *   no_bet_pct: number | null,
 *   kill_switch_active: boolean
 * }
 *
 * Response 404: no data for the requested market
 * Response 400: invalid market / days param
 *
 * WI-0826
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';

const ALLOWED_MARKETS = new Set([
  'NHL_TOTAL',
  'NBA_TOTAL',
  'MLB_F5_TOTAL',
  'NFL_TOTAL',
  'NHL_SPREAD',
  'NBA_SPREAD',
  'MLB_SPREAD',
  'NHL_MONEYLINE',
  'NBA_MONEYLINE',
  'MLB_MONEYLINE',
]);

const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

function toFiniteOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Aggregate daily_performance_reports rows for the requested market/window
 * into a single summary object.
 */
function aggregateReports(
  rows: Array<Record<string, unknown>>,
): {
  bets_placed: number;
  eligible_games: number;
  model_ok_count: number;
  no_bet_count: number;
  hit_rate: number | null;
  roi: number | null;
  avg_edge_at_placement: number | null;
  avg_clv: number | null;
  brier: number | null;
  ece: number | null;
  model_ok_pct: number | null;
  no_bet_pct: number | null;
} {
  if (rows.length === 0) {
    return {
      bets_placed: 0,
      eligible_games: 0,
      model_ok_count: 0,
      no_bet_count: 0,
      hit_rate: null,
      roi: null,
      avg_edge_at_placement: null,
      avg_clv: null,
      brier: null,
      ece: null,
      model_ok_pct: null,
      no_bet_pct: null,
    };
  }

  let totalBetsPlaced = 0;
  let totalEligible = 0;
  let totalModelOk = 0;
  let totalNoBet = 0;
  let weightedHitRate = 0;
  let hitRateWeight = 0;
  let weightedRoi = 0;
  let roiWeight = 0;
  let weightedEdge = 0;
  let edgeWeight = 0;
  let clvSum = 0;
  let clvCount = 0;
  let latestBrier: number | null = null;
  let latestEce: number | null = null;

  for (const row of rows) {
    const bp = Number(row.bets_placed ?? 0);
    const eg = Number(row.eligible_games ?? 0);
    const mok = Number(row.model_ok_count ?? 0);
    const nob = Number(row.no_bet_count ?? 0);

    totalBetsPlaced += bp;
    totalEligible += eg;
    totalModelOk += mok;
    totalNoBet += nob;

    const hr = toFiniteOrNull(row.hit_rate);
    if (hr !== null && bp > 0) {
      weightedHitRate += hr * bp;
      hitRateWeight += bp;
    }

    const roi = toFiniteOrNull(row.roi);
    if (roi !== null && bp > 0) {
      weightedRoi += roi * bp;
      roiWeight += bp;
    }

    const edge = toFiniteOrNull(row.avg_edge_at_placement);
    if (edge !== null && eg > 0) {
      weightedEdge += edge * eg;
      edgeWeight += eg;
    }

    const clv = toFiniteOrNull(row.avg_clv);
    if (clv !== null) {
      clvSum += clv;
      clvCount += 1;
    }

    if (row.brier !== null && row.brier !== undefined) {
      latestBrier = toFiniteOrNull(row.brier);
    }
    if (row.ece !== null && row.ece !== undefined) {
      latestEce = toFiniteOrNull(row.ece);
    }
  }

  const hitRate = hitRateWeight > 0
    ? Number((weightedHitRate / hitRateWeight).toFixed(4))
    : null;

  const roi = roiWeight > 0
    ? Number((weightedRoi / roiWeight).toFixed(4))
    : null;

  const avgEdge = edgeWeight > 0
    ? Number((weightedEdge / edgeWeight).toFixed(4))
    : null;

  // avg_clv: null if no entries resolved — never coerce to 0
  const avgClv = clvCount > 0
    ? Number((clvSum / clvCount).toFixed(4))
    : null;

  const modelOkPct = totalEligible > 0
    ? Number((totalModelOk / totalEligible).toFixed(4))
    : null;
  const noBetPct = totalEligible > 0
    ? Number((totalNoBet / totalEligible).toFixed(4))
    : null;

  return {
    bets_placed: totalBetsPlaced,
    eligible_games: totalEligible,
    model_ok_count: totalModelOk,
    no_bet_count: totalNoBet,
    hit_rate: hitRate,
    roi,
    avg_edge_at_placement: avgEdge,
    avg_clv: avgClv,
    brier: latestBrier,
    ece: latestEce,
    model_ok_pct: modelOkPct,
    no_bet_pct: noBetPct,
  };
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;

  try {
    const securityCheck = performSecurityChecks(request, '/api/performance');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    const { searchParams } = request.nextUrl;
    const rawMarket = (searchParams.get('market') ?? '').trim().toUpperCase();
    const rawDays = searchParams.get('days') ?? String(DEFAULT_DAYS);
    const days = Math.min(MAX_DAYS, Math.max(1, parseInt(rawDays, 10) || DEFAULT_DAYS));

    // market is required; validate against allowed list
    if (!rawMarket) {
      return NextResponse.json(
        { success: false, error: 'market query param is required' },
        { status: 400 },
      );
    }
    if (!ALLOWED_MARKETS.has(rawMarket)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unknown market: ${rawMarket}. Valid: ${[...ALLOWED_MARKETS].join(', ')}`,
        },
        { status: 400 },
      );
    }

    await ensureDbReady();
    db = getDatabaseReadOnly();

    // Check table exists; if not, return 404
    const tableExists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_performance_reports'",
      )
      .get();

    if (!tableExists) {
      return NextResponse.json(
        { success: false, error: `No performance data for market: ${rawMarket}` },
        { status: 404 },
      );
    }

    const rows = db
      .prepare(
        `SELECT *
         FROM daily_performance_reports
         WHERE market = ?
           AND date(report_date) >= date('now', ?)
         ORDER BY report_date DESC`,
      )
      .all(rawMarket, `-${days} days`) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: `No performance data for market: ${rawMarket}` },
        { status: 404 },
      );
    }

    // Check kill_switch_active from calibration_reports (latest)
    let killSwitchActive = false;
    const calTableExists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_reports'",
      )
      .get();
    if (calTableExists) {
      const calRow = db
        .prepare(
          `SELECT kill_switch_active
           FROM calibration_reports
           WHERE market = ?
           ORDER BY computed_at DESC
           LIMIT 1`,
        )
        .get(rawMarket) as Record<string, unknown> | undefined;
      if (calRow) {
        killSwitchActive = Boolean(calRow.kill_switch_active);
      }
    }

    const agg = aggregateReports(rows);

    const response = NextResponse.json(
      {
        success: true,
        market: rawMarket,
        period_days: days,
        bets_placed: agg.bets_placed,
        hit_rate: agg.hit_rate,
        roi: agg.roi,
        avg_clv: agg.avg_clv,
        brier: agg.brier,
        ece: agg.ece,
        model_ok_pct: agg.model_ok_pct,
        no_bet_pct: agg.no_bet_pct,
        kill_switch_active: killSwitchActive,
      },
      { status: 200 },
    );

    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[/api/performance] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  } finally {
    if (db) {
      closeReadOnlyInstance(db);
    }
  }
}
