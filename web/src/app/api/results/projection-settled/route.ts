import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseReadOnly, closeReadOnlyInstance } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '@/lib/api-security';

// WI-0967: Query projection_proxy_evals table for graded projection results.
// These rows come from settle_projections.js which calls buildProjectionProxyMarketRows().
type DbProxyEvalRow = {
  id: number;
  card_id: string;
  game_id: string;
  game_date: string;
  sport: string;
  card_family: string;
  proj_value: number;
  actual_value: number;
  proxy_line: number;
  edge_vs_line: number;
  recommended_side: 'OVER' | 'UNDER' | 'PASS';
  tier: 'PLAY' | 'LEAN' | 'STRONG' | 'PASS';
  confidence_bucket: string;
  agreement_group: string;
  graded_result: 'WIN' | 'LOSS' | 'NO_BET';
  hit_flag: number;
  tier_score: number;
  consensus_bonus: number;
  card_title: string | null;
  home_team: string | null;
  away_team: string | null;
};

type DbF5MoneylineRow = {
  id: number;
  card_id: string;
  game_id: string;
  settled_at: string | null;
  game_time_utc: string | null;
  sport: string;
  result: string | null;
  card_type: string;
  selection: string | null;
  payload_data: string | null;
  card_title: string | null;
  home_team: string | null;
  away_team: string | null;
};

export type ProjectionProxyRow = {
  id: number;
  cardId: string;
  gameId: string;
  gameDateUtc: string;
  sport: string;
  cardFamily: string;
  projValue: number;
  actualValue: number;
  proxyLine: number;
  edgeVsLine: number;
  recommendedSide: 'OVER' | 'UNDER' | 'PASS';
  tier: 'PLAY' | 'LEAN' | 'STRONG' | 'PASS';
  confidenceBucket: string;
  agreementGroup: string;
  gradedResult: 'WIN' | 'LOSS' | 'NO_BET';
  hitFlag: number;
  tierScore: number;
  consensusBonus: number;
  cardTitle: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
};

export type ProjectionSettledResponse = {
  success: boolean;
  data?: {
    settledRows: ProjectionProxyRow[];
    totalSettled: number;
    actualsReady: boolean;
  };
  error?: string;
};

function parsePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveF5MlSelection(row: DbF5MoneylineRow, payload: Record<string, unknown> | null): 'HOME' | 'AWAY' | null {
  const payloadSelection =
    (payload?.selection as Record<string, unknown> | undefined)?.side ??
    (payload?.market_context as Record<string, unknown> | undefined)?.selection_side ??
    (payload?.canonical_envelope_v2 as Record<string, unknown> | undefined)?.selection_side ??
    (payload?.decision_v2 as Record<string, unknown> | undefined)?.selection_side ??
    null;
  const raw = String(row.selection ?? payloadSelection ?? '').trim().toUpperCase();
  if (raw === 'HOME' || raw === 'H') return 'HOME';
  if (raw === 'AWAY' || raw === 'A') return 'AWAY';
  return null;
}

function resolveTier(payload: Record<string, unknown> | null): 'PLAY' | 'LEAN' | 'STRONG' | 'PASS' {
  const decisionV2 = payload?.decision_v2 as Record<string, unknown> | undefined;
  const official = String(decisionV2?.official_status ?? '').toUpperCase();
  if (official === 'PLAY' || official === 'LEAN') return official;
  if (official === 'PASS') return 'PASS';
  const status = String((payload?.status ?? payload?.action ?? '')).toUpperCase();
  if (status === 'PLAY' || status === 'LEAN' || status === 'PASS') return status;
  return 'PASS';
}

function gradedResultToken(value: string | null): 'WIN' | 'LOSS' | 'NO_BET' {
  const token = String(value || '').toLowerCase();
  if (token === 'win' || token === 'won') return 'WIN';
  if (token === 'loss' || token === 'lost') return 'LOSS';
  return 'NO_BET';
}

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ProjectionSettledResponse>> {
  const securityCheck = performSecurityChecks(request, '/api/results/projection-settled');
  if (!securityCheck.allowed) {
    return securityCheck.error as NextResponse<ProjectionSettledResponse>;
  }

  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;

  try {
    await ensureDbReady();
    db = getDatabaseReadOnly();

    // WI-0967: Query projection_proxy_evals directly.
    // Every settled projection card has a corresponding row in this table.
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM projection_proxy_evals`,
      )
      .get() as { cnt: number };

    const proxyRows = db
      .prepare(
        `SELECT
           ppe.id,
           ppe.card_id,
           ppe.game_id,
           ppe.game_date,
           ppe.sport,
           ppe.card_family,
           ppe.proj_value,
           ppe.actual_value,
           ppe.proxy_line,
           ppe.edge_vs_line,
           ppe.recommended_side,
           ppe.tier,
           ppe.confidence_bucket,
           ppe.agreement_group,
           ppe.graded_result,
           ppe.hit_flag,
           ppe.tier_score,
           ppe.consensus_bonus,
           cp.card_title,
           g.home_team,
           g.away_team
         FROM projection_proxy_evals ppe
         LEFT JOIN card_payloads cp ON cp.id = ppe.card_id
         LEFT JOIN games g ON g.game_id = ppe.game_id
         ORDER BY ppe.game_date DESC, ppe.id DESC
         LIMIT 200`,
      )
      .all() as DbProxyEvalRow[];

    const enrichedRows = proxyRows.map((row) => {
      return {
        id: row.id,
        cardId: row.card_id,
        gameId: row.game_id,
        gameDateUtc: row.game_date,
        sport: row.sport,
        cardFamily: row.card_family,
        projValue: row.proj_value,
        actualValue: row.actual_value,
        proxyLine: row.proxy_line,
        edgeVsLine: row.edge_vs_line,
        recommendedSide: row.recommended_side,
        tier: row.tier,
        confidenceBucket: row.confidence_bucket,
        agreementGroup: row.agreement_group,
        gradedResult: row.graded_result,
        hitFlag: row.hit_flag,
        tierScore: row.tier_score,
        consensusBonus: row.consensus_bonus,
        cardTitle: row.card_title,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
      };
    });

    const f5MoneylineRows = db
      .prepare(
        `SELECT
           cr.id,
           cr.card_id,
           cr.game_id,
           cr.settled_at,
           g.game_time_utc,
           cr.sport,
           cr.result,
           cr.card_type,
           cr.selection,
           cp.payload_data,
           cp.card_title,
           g.home_team,
           g.away_team
         FROM card_results cr
         JOIN card_payloads cp ON cp.id = cr.card_id
         LEFT JOIN games g ON g.game_id = cr.game_id
         WHERE LOWER(cr.card_type) = 'mlb-f5-ml'
           AND LOWER(cr.status) = 'settled'
         ORDER BY COALESCE(cr.settled_at, g.game_time_utc) DESC, cr.id DESC
         LIMIT 200`,
      )
      .all() as DbF5MoneylineRow[];

    const mappedF5MoneylineRows: ProjectionProxyRow[] = f5MoneylineRows.map((row) => {
      const payload = parsePayload(row.payload_data);
      const selection = resolveF5MlSelection(row, payload);
      const projProb = toNumberOrNull(
        (payload?.decision as Record<string, unknown> | undefined)?.win_prob,
      );
      const projValue =
        projProb ??
        (selection === 'HOME' ? 1 : selection === 'AWAY' ? 0 : 0.5);
      const resultToken = gradedResultToken(row.result);
      const actualValue =
        resultToken === 'WIN' ? 1 : resultToken === 'LOSS' ? 0 : 0.5;
      const recommendedSide =
        selection === 'HOME' ? 'OVER' : selection === 'AWAY' ? 'UNDER' : 'PASS';
      const edgeVsLine = projValue - 0.5;

      return {
        id: -1 * row.id,
        cardId: row.card_id,
        gameId: row.game_id,
        gameDateUtc: row.game_time_utc || row.settled_at || new Date(0).toISOString(),
        sport: row.sport || 'MLB',
        cardFamily: 'MLB_F5_ML',
        projValue,
        actualValue,
        proxyLine: 0.5,
        edgeVsLine,
        recommendedSide,
        tier: resolveTier(payload),
        confidenceBucket: 'F5_ML',
        agreementGroup: 'DIRECT_SELECTION',
        gradedResult: resultToken,
        hitFlag: resultToken === 'WIN' ? 1 : 0,
        tierScore: 0,
        consensusBonus: 0,
        cardTitle: row.card_title,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
      };
    });

    const settledRows = [...enrichedRows, ...mappedF5MoneylineRows].sort((a, b) => {
      const dateDiff = Date.parse(b.gameDateUtc) - Date.parse(a.gameDateUtc);
      if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
      return b.id - a.id;
    });

    const response = NextResponse.json({
      success: true,
      data: {
        settledRows,
        totalSettled: (countRow?.cnt ?? enrichedRows.length) + mappedF5MoneylineRows.length,
        actualsReady: true,
      },
    });
    return addRateLimitHeaders(
      response as NextResponse<ProjectionSettledResponse>,
      request,
    ) as NextResponse<ProjectionSettledResponse>;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('[API] projection-settled error:', message);
    const errorResponse = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    return addRateLimitHeaders(
      errorResponse as NextResponse<ProjectionSettledResponse>,
      request,
    ) as NextResponse<ProjectionSettledResponse>;
  } finally {
    if (db) {
      closeReadOnlyInstance(db);
    }
  }
}
