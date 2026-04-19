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

    const response = NextResponse.json({
      success: true,
      data: {
        settledRows: enrichedRows,
        totalSettled: countRow?.cnt ?? enrichedRows.length,
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
