/**
 * GET /api/cards/[gameId]
 *
 * Canonical per-game card read surface in the current worker+DB runtime.
 * Fetch all card payloads for a specific game (betting dashboard only).
 * FPL projections are served from cheddar-fpl-sage backend.
 *
 * Historical endpoint families (`/api/models/*`, `/api/betting/projections`,
 * `/api/soccer/slate`) are deprecated references only.
 *
 * Query params:
 * - cardType: optional filter by card type
 * - dedupe: optional (default latest_per_game_type, use none for raw history)
 * - limit: max cards (default 10)
 *
 * Response:
 * {
 *   success: boolean,
 *   data: [
 *     {
 *       id: string,
 *       gameId: string,
 *       sport: string,
 *       cardType: string,
 *       cardTitle: string,
 *       createdAt: string (ISO 8601),
 *       expiresAt: string | null,
 *       payloadData: object | null (parsed JSON),
 *       payloadParseError: boolean,
 *       modelOutputIds: string | null
 *     }
 *   ],
 *   error?: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  requireEntitlementForRequest,
  RESOURCE,
} from '../../../../lib/api-security';

const ENABLE_WELCOME_HOME =
  process.env.ENABLE_WELCOME_HOME === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

const ENABLE_CARDS_LIFECYCLE_PARITY =
  process.env.ENABLE_CARDS_LIFECYCLE_PARITY === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_CARDS_LIFECYCLE_PARITY === 'true';

type LifecycleMode = 'pregame' | 'active';

const ACTIVE_EXCLUDED_STATUSES = [
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'FINAL',
  'CLOSED',
  'COMPLETE',
  'COMPLETED',
  'FT',
];

const CORE_RUN_STATE_SPORTS = [
  'nba',
  'nhl',
  'ncaam',
  'soccer',
  'mlb',
  'nfl',
  'fpl',
] as const;
const CORE_RUN_STATE_SPORT_SQL = CORE_RUN_STATE_SPORTS.map(
  (sport) => `'${sport}'`,
).join(', ');

function resolveLifecycleMode(searchParams: URLSearchParams): LifecycleMode {
  const lifecycleParam = (searchParams.get('lifecycle') || '').toLowerCase();
  if (lifecycleParam === 'active') return 'active';
  return 'pregame';
}

interface CardRow {
  id: string;
  game_id: string;
  sport: string;
  card_type: string;
  card_title: string;
  created_at: string;
  expires_at: string | null;
  payload_data: string;
  model_output_ids: string | null;
}

function clampNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: true };
  try {
    return { data: JSON.parse(payload), error: false };
  } catch {
    return { data: null, error: true };
  }
}

function normalizePayloadMeta(payload: Record<string, unknown> | null) {
  if (!payload || typeof payload !== 'object') return payload;
  const meta =
    payload.meta && typeof payload.meta === 'object'
      ? (payload.meta as Record<string, unknown>)
      : null;
  if (!meta) return payload;
  // Backward compatibility: older clients may still expect this field to exist.
  // Current worker pipeline writes cards via DB, not legacy model endpoint routes.
  if (!Object.prototype.hasOwnProperty.call(meta, 'model_endpoint')) {
    meta.model_endpoint = null;
  }
  return payload;
}

function getActiveRunIds(db: ReturnType<typeof getDatabaseReadOnly>): string[] {
  // Prefer per-sport rows (added by migration 021); fall back to singleton
  try {
    const successRows = db
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE id != 'singleton'
           AND LOWER(COALESCE(rs.sport, rs.id, '')) IN (${CORE_RUN_STATE_SPORT_SQL})
           AND rs.current_run_id IS NOT NULL
           AND TRIM(rs.current_run_id) != ''
           AND EXISTS (
             SELECT 1
             FROM job_runs jr
             WHERE jr.id = rs.current_run_id
               AND LOWER(jr.status) = 'success'
           )
         ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (successRows.length > 0) {
      return [...new Set(successRows.map((r) => r.current_run_id))];
    }

    const sportRows = db
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE rs.id != 'singleton'
           AND LOWER(COALESCE(rs.sport, rs.id, '')) IN (${CORE_RUN_STATE_SPORT_SQL})
           AND rs.current_run_id IS NOT NULL
           AND TRIM(rs.current_run_id) != ''
         ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (sportRows.length > 0) {
      return [...new Set(sportRows.map((r) => r.current_run_id))];
    }
  } catch {
    // fall through to singleton
  }
  try {
    const row = db
      .prepare(
        `SELECT current_run_id FROM run_state WHERE id = 'singleton' LIMIT 1`,
      )
      .get() as { current_run_id?: string | null } | undefined;
    return row?.current_run_id ? [row.current_run_id] : [];
  } catch {
    return [];
  }
}

function getRunStatus(
  db: ReturnType<typeof getDatabaseReadOnly>,
  runId: string | null,
): string {
  if (!runId) return 'NONE';
  try {
    const stmt = db.prepare(
      `SELECT status FROM job_runs WHERE id = ? ORDER BY started_at DESC LIMIT 1`,
    );
    const row = stmt.get(runId) as { status?: string | null } | undefined;
    return row?.status ? String(row.status).toUpperCase() : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> },
) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    await ensureDbReady();

    const securityCheck = performSecurityChecks(request, '/api/cards/[gameId]');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    if (process.env.ENABLE_AUTH_WALLS === 'true') {
      const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
      if (!access.ok) {
        return NextResponse.json(
          { success: false, error: access.error },
          { status: access.status }
        );
      }
    }

    const { gameId } = await params;
    const { searchParams } = request.nextUrl;
    const cardType =
      searchParams.get('cardType') || searchParams.get('card_type');
    const dedupe = searchParams.get('dedupe');
    const limit = clampNumber(searchParams.get('limit'), 10, 1, 100);
    const offset = clampNumber(searchParams.get('offset'), 0, 0, 1000);
    const lifecycleMode = ENABLE_CARDS_LIFECYCLE_PARITY
      ? resolveLifecycleMode(searchParams)
      : 'pregame';

    if (!gameId) {
      return NextResponse.json(
        { success: false, error: 'gameId is required' },
        { status: 400 },
      );
    }

    // Open database connection
    db = getDatabaseReadOnly();
    const activeRunIds = getActiveRunIds(db);
    const currentRunId = activeRunIds[0] ?? null;
    const runStatus = getRunStatus(db, currentRunId);

    const baseWhere: string[] = ['game_id = ?'];
    const baseParams: Array<string | number> = [gameId];

    if (cardType) {
      baseWhere.push('card_type = ?');
      baseParams.push(cardType);
    }

    // Exclude FPL cards - they are served from cheddar-fpl-sage backend
    baseWhere.push("sport != 'FPL'");
    baseWhere.push(`NOT EXISTS (
      SELECT 1
      FROM card_results cr
      WHERE cr.game_id = card_payloads.game_id
        AND cr.status = 'settled'
    )`);
    if (!ENABLE_WELCOME_HOME) {
      baseWhere.push("card_type NOT IN ('welcome-home', 'welcome-home-v2')");
    }

    // Apply lifecycle filtering if enabled and lifecycle=active is requested
    if (
      ENABLE_CARDS_LIFECYCLE_PARITY &&
      lifecycleMode === 'active'
    ) {
      const now = new Date();
      const nowSql = now
        .toISOString()
        .substring(0, 19)
        .replace('T', ' ');
      baseWhere.push(`UPPER(COALESCE((SELECT status FROM games WHERE game_id = card_payloads.game_id), '')) NOT IN (${ACTIVE_EXCLUDED_STATUSES.map(
        (status) => `'${status}'`,
      ).join(', ')})`);
      baseWhere.push(`datetime((SELECT game_time_utc FROM games WHERE game_id = card_payloads.game_id)) <= datetime(?)`);
      baseParams.push(nowSql);
    }

    const runScopedWhere = [...baseWhere];
    const runScopedParams = [...baseParams];
    if (activeRunIds.length > 0) {
      const runIdPlaceholders = activeRunIds.map(() => '?').join(', ');
      runScopedWhere.push(`run_id IN (${runIdPlaceholders})`);
      runScopedParams.push(...activeRunIds);
    }

    const dedupeMode = dedupe === 'none' ? 'none' : 'latest_per_game_type';
    const buildSql = (whereSql: string) =>
      dedupeMode === 'none'
        ? `
        SELECT * FROM card_payloads
        WHERE ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `
        : `
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY game_id, card_type
              ORDER BY created_at DESC, id DESC
            ) AS rn
          FROM card_payloads
          WHERE ${whereSql}
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `;

    const runScopedWhereSql = runScopedWhere.join(' AND ');
    const runScopedStmt = db.prepare(buildSql(runScopedWhereSql));
    let cards = runScopedStmt.all(
      ...runScopedParams,
      limit,
      offset,
    ) as CardRow[];

    if (activeRunIds.length > 0 && cards.length === 0) {
      const baseWhereSql = baseWhere.join(' AND ');
      const fallbackStmt = db.prepare(buildSql(baseWhereSql));
      cards = fallbackStmt.all(...baseParams, limit, offset) as CardRow[];
    }

    // Parse JSON fields for response
    const response = cards.map((card) => {
      const parsed = safeJsonParse(card.payload_data);
      const normalizedPayload = normalizePayloadMeta(parsed.data);
      return {
        id: card.id,
        gameId: card.game_id,
        sport: card.sport,
        cardType: card.card_type,
        cardTitle: card.card_title,
        createdAt: card.created_at,
        expiresAt: card.expires_at,
        payloadData: normalizedPayload,
        payloadParseError: parsed.error,
        modelOutputIds: card.model_output_ids,
      };
    });

    return NextResponse.json(
      {
        success: true,
        data: response,
        meta: {
          current_run_id: currentRunId,
          generated_at: new Date().toISOString(),
          run_status: runStatus,
          items_count: response.length,
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[API] Error fetching cards:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
