import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseReadOnly, closeReadOnlyInstance } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '@/lib/api-security';

// Card types that support actual-result settlement (WI-0757 schema).
// mlb-f5 is intentionally excluded: no bookmaker odds exist for F5 markets, so
// showing them on /results implies false bet tracking.
const PROJECTION_CARD_TYPES = ['nhl-pace-1p'] as const;

// Fixed line for nhl-pace-1p binary outcome evaluation.
const NHL_1P_LINE = 1.5;

type DbPragmaRow = {
  name: string;
};

type DbSettledRow = {
  id: string;
  game_id: string;
  sport: string;
  card_type: string;
  card_title: string;
  created_at: string;
  payload_data: string | null;
  actual_result: string | null;
  home_team: string | null;
  away_team: string | null;
  game_time_utc: string | null;
};

export type ProjectionSettledRow = {
  id: string;
  gameId: string;
  sport: string;
  cardType: string;
  cardTitle: string;
  createdAt: string;
  homeTeam: string | null;
  awayTeam: string | null;
  gameTimeUtc: string | null;
  /** Model projected numeric total. */
  modelProjection: number | null;
  /** Fixed line applied for binary evaluation. Only set for nhl-pace-1p. */
  line: number | null;
  /** The direction the model projected (OVER/UNDER the line). */
  direction: 'OVER' | 'UNDER' | null;
  /** Actual outcome value from WI-0757 ingestion. */
  actualValue: number | null;
  /** Binary hit/miss (nhl-pace-1p). Null when actualsAvailable=false. */
  outcome: 'HIT' | 'MISS' | null;
  /** Absolute error between projection and actual (mlb-f5, nhl-pace-1p). */
  delta: number | null;
};

export type ProjectionSettledResponse = {
  success: boolean;
  data?: {
    settledRows: ProjectionSettledRow[];
    totalSettled: number;
    /** False when actual_result column not yet migrated (WI-0757 not run). */
    actualsReady: boolean;
  };
  error?: string;
};

function safeJsonParse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve the model's numeric projection from the payload.
 * nhl-pace-1p stores it in payload.projection.total.
 * mlb-f5 stores it in payload.projection.projected_total.
 */
function resolveModelProjection(
  payload: Record<string, unknown> | null,
  cardType: string,
): number | null {
  if (!payload) return null;
  const proj = payload.projection;
  if (proj && typeof proj === 'object') {
    const p = proj as Record<string, unknown>;
    if (cardType === 'nhl-pace-1p') {
      return toNumber(p.total);
    }
    if (cardType === 'mlb-f5') {
      return (
        toNumber(p.projected_total) ??
        toNumber(p.total) ??
        toNumber(payload.numeric_projection)
      );
    }
  }
  return toNumber(payload.numeric_projection);
}

/**
 * Determine the model's direction (OVER/UNDER) relative to the fixed line for
 * nhl-pace-1p, or null for card types without a line-based direction.
 */
function resolveDirection(
  modelProjection: number | null,
  cardType: string,
): 'OVER' | 'UNDER' | null {
  if (cardType === 'nhl-pace-1p' && modelProjection !== null) {
    return modelProjection > NHL_1P_LINE ? 'OVER' : 'UNDER';
  }
  return null;
}

/**
 * Derive the HIT/MISS outcome for nhl-pace-1p.
 * HIT = actual goals agree with the projected direction vs line 1.5.
 */
function resolveOutcome(
  cardType: string,
  direction: 'OVER' | 'UNDER' | null,
  actualValue: number | null,
): 'HIT' | 'MISS' | null {
  if (actualValue === null || direction === null) return null;
  if (cardType === 'nhl-pace-1p') {
    if (direction === 'OVER') return actualValue > NHL_1P_LINE ? 'HIT' : 'MISS';
    return actualValue < NHL_1P_LINE ? 'HIT' : 'MISS';
  }
  return null;
}

function transformRow(row: DbSettledRow): ProjectionSettledRow {
  const payload = safeJsonParse(row.payload_data);
  const actualResult = safeJsonParse(row.actual_result);

  const modelProjection = resolveModelProjection(payload, row.card_type);
  const line = row.card_type === 'nhl-pace-1p' ? NHL_1P_LINE : null;
  const direction = resolveDirection(modelProjection, row.card_type);

  let actualValue: number | null = null;
  if (actualResult) {
    if (row.card_type === 'nhl-pace-1p') {
      actualValue = toNumber(actualResult.goals_1p);
    } else if (row.card_type === 'mlb-f5') {
      actualValue = toNumber(actualResult.runs_f5);
    }
  }

  const outcome = resolveOutcome(row.card_type, direction, actualValue);
  const delta =
    modelProjection !== null && actualValue !== null
      ? Math.round(Math.abs(actualValue - modelProjection) * 100) / 100
      : null;

  return {
    id: row.id,
    gameId: row.game_id,
    sport: row.sport,
    cardType: row.card_type,
    cardTitle: row.card_title,
    createdAt: row.created_at,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    gameTimeUtc: row.game_time_utc,
    modelProjection,
    line,
    direction,
    actualValue,
    outcome,
    delta,
  };
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

    // Graceful degradation: check if actual_result column exists (WI-0757).
    const pragmaRows = db
      .prepare('PRAGMA table_info(card_payloads)')
      .all() as DbPragmaRow[];
    const hasActualResult = pragmaRows.some((r) => r.name === 'actual_result');

    if (!hasActualResult) {
      const response = NextResponse.json({
        success: true,
        data: {
          settledRows: [],
          totalSettled: 0,
          actualsReady: false,
        },
      });
      return addRateLimitHeaders(
        response as NextResponse<ProjectionSettledResponse>,
        request,
      ) as NextResponse<ProjectionSettledResponse>;
    }

    const placeholders = PROJECTION_CARD_TYPES.map(() => '?').join(',');

    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM card_payloads
         WHERE card_type IN (${placeholders})
           AND actual_result IS NOT NULL`,
      )
      .get(...PROJECTION_CARD_TYPES) as { cnt: number };

    const rawRows = db
      .prepare(
        `SELECT
           cp.id,
           cp.game_id,
           cp.sport,
           cp.card_type,
           cp.card_title,
           cp.created_at,
           cp.payload_data,
           cp.actual_result,
           g.home_team,
           g.away_team,
           g.game_time_utc
         FROM card_payloads cp
         LEFT JOIN games g ON g.game_id = cp.game_id
         WHERE cp.card_type IN (${placeholders})
           AND cp.actual_result IS NOT NULL
         ORDER BY COALESCE(g.game_time_utc, cp.created_at) DESC
         LIMIT 200`,
      )
      .all(...PROJECTION_CARD_TYPES) as DbSettledRow[];

    const settledRows = rawRows.map(transformRow);

    const response = NextResponse.json({
      success: true,
      data: {
        settledRows,
        totalSettled: countRow?.cnt ?? settledRows.length,
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
