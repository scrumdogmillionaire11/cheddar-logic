/**
 * GET /api/cards
 *
 * Canonical card read surface in the current worker+DB runtime.
 * Returns betting dashboard cards (NBA, NHL, SOCCER, MLB).
 * Includes projection-surface card types from shared contract.
 * FPL projections are served from cheddar-fpl-sage backend.
 *
 * Historical endpoint families (`/api/models/*`, `/api/betting/projections`,
 * `/api/soccer/slate`) are deprecated references only.
 *
 * Cards are automatically sorted by game start time (soonest first).
 *
 * Query params:
 * - sport: optional sport filter (case-insensitive)
 * - card_type: optional card type filter
 * - game_id: optional game ID filter
 * - date: optional UTC game date filter (default today, use all for full horizon)
 * - dedupe: optional (default latest_per_game_type, use none for raw history)
 * - limit: optional (default 20, max 100)
 * - offset: optional (default 0, max 1000)
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
 *       createdAt: string,
 *       expiresAt: string | null,
 *       payloadData: object | null,
 *       payloadParseError: boolean,
 *       modelOutputIds: string | null
 *     }
 *   ],
 *   error?: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import cheddarData from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  createCorrelationId,
  finalizeApiResponse,
  createOpaqueErrorResponse,
  requireEntitlementForRequest,
  RESOURCE,
} from '../../../lib/api-security';
import {
  PROJECTION_SURFACE_CARD_TYPES_SQL,
  isProjectionSurfaceCardType,
} from '@/lib/games/projection-surface';
import {
  ACTIVE_EXCLUDED_STATUSES,
  buildBettingSurfacePayloadPredicate,
  buildCardTypePreciseSettledPredicate,
  buildMarketIdentityKeyExpression,
  buildPerTypeRunScopePredicate,
  buildSimplifiedGateWhere,
  clampNumber,
  getActiveRunIds,
  getRunStatus,
  resolveLifecycleMode,
  resolveNhlCompatibleSports,
  type LifecycleMode,
} from '@/lib/cards/query';
import {
  buildShadowCompareTelemetry,
  getBettingSurfacePayloadDropReason,
  isBettingSurfacePayload,
  normalizePayloadMeta,
  safeJsonParse,
  type ShadowCompareRow,
  type ShadowCompareTelemetry,
} from '@/lib/cards/payload-classifier';

const {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
  buildDecisionOutcomeFromDecisionV2,
} = cheddarData as {
  getDatabaseReadOnly: typeof import('@cheddar-logic/data').getDatabaseReadOnly;
  closeReadOnlyInstance: typeof import('@cheddar-logic/data').closeReadOnlyInstance;
  buildDecisionOutcomeFromDecisionV2: (decisionV2: unknown) => {
    status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
    reasons?: { blockers?: string[] };
  };
};

const ENABLE_WELCOME_HOME =
  process.env.ENABLE_WELCOME_HOME === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

// Server-only API route: do not read NEXT_PUBLIC_ prefix here.
const ENABLE_CARDS_LIFECYCLE_PARITY =
  process.env.ENABLE_CARDS_LIFECYCLE_PARITY === 'true';

// Simplified gate: single-phase query using per-type run-scope predicate.
// Default false keeps legacy two-phase behavior until rollout validation completes.
const ENABLE_SIMPLIFIED_CARDS_GATE =
  process.env.ENABLE_SIMPLIFIED_CARDS_GATE === 'true';

// Shadow compare: run both legacy and simplified paths and emit count delta
// telemetry. Consumer receives the active gate result (controlled by
// ENABLE_SIMPLIFIED_CARDS_GATE). Does not affect response data contract.
const ENABLE_GATE_SHADOW_COMPARE =
  process.env.ENABLE_GATE_SHADOW_COMPARE === 'true';

/*
Source-contract mirror for api-cards-lifecycle-regression:
@/lib/cards/query owns getActiveRunIds and its SQL guard:
const CORE_RUN_STATE_SPORTS = [
  'nba',
  'nhl',
  'soccer',
  'mlb',
  'nfl',
  'fpl',
  'nhl_props',
] as const;
LOWER(COALESCE(rs.sport, rs.id, '')) IN
@/lib/cards/payload-classifier owns payload visibility markers:
execution_status
PROJECTION_ONLY
projection_source
synthetic_fallback
*/

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
  run_id?: string | null;
}

interface CardsDropDiagnosticsRow extends CardRow {
  game_status: string | null;
  game_time_utc: string | null;
  has_settled_result: 0 | 1;
}

type CardsDropReasonCode =
  | 'SPORT_EXCLUDED_FPL'
  | 'SPORT_EXCLUDED_NCAAM'
  | 'PROJECTION_ONLY_BASIS'
  | 'PROJECTION_ONLY_EXECUTION_STATUS'
  | 'PROJECTION_ONLY_LINE_SOURCE'
  | 'SYNTHETIC_FALLBACK_PROJECTION_SOURCE'
  | 'SETTLED_RESULT'
  | 'WELCOME_HOME_DISABLED'
  | 'LIFECYCLE_STATUS_EXCLUDED'
  | 'LIFECYCLE_NOT_STARTED_OR_MISSING_TIME'
  | 'RUN_SCOPE_EXCLUDED';

interface CardsDropDiagnostics {
  enabled: true;
  total_evaluated: number;
  returned_count: number;
  run_scope_fallback_applied: boolean;
  by_reason: Array<{
    reason: CardsDropReasonCode;
    count: number;
  }>;
  by_card_type: Array<{
    card_type: string;
    reason: CardsDropReasonCode;
    count: number;
  }>;
}

function shouldApplyGlobalRunFallback(lifecycleMode: LifecycleMode): boolean {
  // Active mode is fail-closed: never widen from scoped runs to global history.
  return lifecycleMode !== 'active';
}

function normalizeSqlDateTime(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const isoValue = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const timestamp = Date.parse(isoValue);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function readPayloadDecisionV2(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null;
  const play =
    payload.play && typeof payload.play === 'object'
      ? (payload.play as Record<string, unknown>)
      : null;
  const decisionV2 = payload.decision_v2 ?? play?.decision_v2;
  return decisionV2 && typeof decisionV2 === 'object'
    ? (decisionV2 as Record<string, unknown>)
    : null;
}

function buildPayloadDecisionOutcome(
  payload: Record<string, unknown> | null,
) {
  const decisionV2 = readPayloadDecisionV2(payload);
  if (!decisionV2) return null;
  return buildDecisionOutcomeFromDecisionV2(decisionV2);
}

type DecisionSurfaceBucket = 'OFFICIAL' | 'MONITORED' | 'DIAGNOSTIC';

function normalizeRawDecisionStatus(value: unknown):
  | 'PLAY'
  | 'LEAN'
  | 'SLIGHT_EDGE'
  | 'PASS'
  | 'UNKNOWN' {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'PLAY') return 'PLAY';
  if (normalized === 'LEAN') return 'LEAN';
  if (normalized === 'SLIGHT_EDGE' || normalized === 'SLIGHT EDGE') {
    return 'SLIGHT_EDGE';
  }
  if (normalized === 'PASS') return 'PASS';
  return 'UNKNOWN';
}

function buildDecisionSurfaceMetadata(
  payload: Record<string, unknown> | null,
  decisionOutcome: { status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS' } | null,
): {
  canonical_status: 'PLAY' | 'LEAN' | 'PASS';
  raw_status: 'PLAY' | 'LEAN' | 'SLIGHT_EDGE' | 'PASS' | 'UNKNOWN';
  surface_bucket: DecisionSurfaceBucket;
} {
  const decisionV2 = readPayloadDecisionV2(payload);
  const rawStatus =
    normalizeRawDecisionStatus(decisionOutcome?.status) !== 'UNKNOWN'
      ? normalizeRawDecisionStatus(decisionOutcome?.status)
      : normalizeRawDecisionStatus(
          decisionV2?.official_status ??
            (decisionV2?.canonical_envelope_v2 as
              | { official_status?: unknown }
              | undefined)?.official_status,
        );

  const canonicalStatus: 'PLAY' | 'LEAN' | 'PASS' =
    rawStatus === 'PLAY' ? 'PLAY' : rawStatus === 'PASS' ? 'PASS' : 'LEAN';
  const surfaceBucket: DecisionSurfaceBucket =
    canonicalStatus === 'PLAY'
      ? 'OFFICIAL'
      : canonicalStatus === 'LEAN'
        ? 'MONITORED'
        : 'DIAGNOSTIC';

  return {
    canonical_status: canonicalStatus,
    raw_status: rawStatus,
    surface_bucket: surfaceBucket,
  };
}

function attachDecisionOutcome(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return payload;
  const decisionOutcome = buildPayloadDecisionOutcome(payload);
  const decisionSurface = buildDecisionSurfaceMetadata(payload, decisionOutcome);
  if (!decisionOutcome) {
    return {
      ...payload,
      decision_surface: decisionSurface,
    };
  }

  const play =
    payload.play && typeof payload.play === 'object'
      ? (payload.play as Record<string, unknown>)
      : null;

  return {
    ...payload,
    decision_outcome: decisionOutcome,
    decision_surface: decisionSurface,
    ...(play
      ? {
          play: {
            ...play,
            decision_outcome: decisionOutcome,
            decision_surface: decisionSurface,
          },
        }
      : null),
  };
}

function hasActionableProjectionCall(
  payload: Record<string, unknown> | null,
): boolean {
  const decisionOutcome = buildPayloadDecisionOutcome(payload);
  if (!decisionOutcome) return false;
  return (
    decisionOutcome.status === 'PLAY' ||
    decisionOutcome.status === 'SLIGHT_EDGE'
  );
}

function addDropReason(
  reasonCounts: Map<CardsDropReasonCode, number>,
  cardTypeReasonCounts: Map<string, number>,
  cardType: string,
  reason: CardsDropReasonCode,
) {
  reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const cardTypeReasonKey = `${cardType}\u0000${reason}`;
  cardTypeReasonCounts.set(
    cardTypeReasonKey,
    (cardTypeReasonCounts.get(cardTypeReasonKey) ?? 0) + 1,
  );
}

function buildCardsDropDiagnostics(
  db: ReturnType<typeof getDatabaseReadOnly>,
  params: {
    requestWhere: string[];
    requestParams: Array<string | number>;
    activeRunIds: string[];
    runScopeFallbackApplied: boolean;
    welcomeHomeEnabled: boolean;
    lifecycleMode: LifecycleMode;
    lifecycleEnabled: boolean;
    lifecycleNowSql: string | null;
    returnedCount: number;
  },
): CardsDropDiagnostics {
  const whereSql =
    params.requestWhere.length > 0
      ? `WHERE ${params.requestWhere.join(' AND ')}`
      : '';
  const diagnosticsRows = db
    .prepare(
      `
      SELECT cp.*,
        g.status AS game_status,
        g.game_time_utc AS game_time_utc,
        EXISTS (
          SELECT 1
          FROM card_results cr
          WHERE cr.game_id = cp.game_id
            AND cr.status = 'settled'
        ) AS has_settled_result
      FROM card_payloads cp
      LEFT JOIN games g ON cp.game_id = g.game_id
      ${whereSql}
    `,
    )
    .all(...params.requestParams) as CardsDropDiagnosticsRow[];

  const reasonCounts = new Map<CardsDropReasonCode, number>();
  const cardTypeReasonCounts = new Map<string, number>();
  const activeRunIdSet = new Set(params.activeRunIds);
  const lifecycleNowMs = normalizeSqlDateTime(params.lifecycleNowSql);

  for (const row of diagnosticsRows) {
    const sport = String(row.sport || '').toLowerCase();
    const cardType = row.card_type || 'unknown';
    let reason: CardsDropReasonCode | null = null;

    if (sport === 'fpl') {
      reason = 'SPORT_EXCLUDED_FPL';
    } else if (sport === 'ncaam') {
      reason = 'SPORT_EXCLUDED_NCAAM';
    } else {
      const parsed = safeJsonParse(row.payload_data);
      const normalizedPayload = normalizePayloadMeta(parsed.data);
      const isProjectionSurfaceType = isProjectionSurfaceCardType(row.card_type);
      const payloadDropReason =
        !parsed.error && !isProjectionSurfaceType
          ? getBettingSurfacePayloadDropReason(normalizedPayload)
          : null;
      if (payloadDropReason) {
        reason = payloadDropReason;
      } else if (row.has_settled_result) {
        reason = 'SETTLED_RESULT';
      } else if (
        !params.welcomeHomeEnabled &&
        (row.card_type === 'welcome-home' || row.card_type === 'welcome-home-v2')
      ) {
        reason = 'WELCOME_HOME_DISABLED';
      } else if (
        params.lifecycleEnabled &&
        params.lifecycleMode === 'active' &&
        (ACTIVE_EXCLUDED_STATUSES as readonly string[]).includes(
          String(row.game_status || '').toUpperCase(),
        )
      ) {
        reason = 'LIFECYCLE_STATUS_EXCLUDED';
      } else if (
        params.lifecycleEnabled &&
        params.lifecycleMode === 'active' &&
        (lifecycleNowMs === null ||
          normalizeSqlDateTime(row.game_time_utc) === null ||
          normalizeSqlDateTime(row.game_time_utc)! > lifecycleNowMs)
      ) {
        reason = 'LIFECYCLE_NOT_STARTED_OR_MISSING_TIME';
      } else if (
        params.activeRunIds.length > 0 &&
        !params.runScopeFallbackApplied &&
        (!row.run_id || !activeRunIdSet.has(row.run_id))
      ) {
        reason = 'RUN_SCOPE_EXCLUDED';
      }
    }

    if (reason) {
      addDropReason(reasonCounts, cardTypeReasonCounts, cardType, reason);
    }
  }

  return {
    enabled: true,
    total_evaluated: diagnosticsRows.length,
    returned_count: params.returnedCount,
    run_scope_fallback_applied: params.runScopeFallbackApplied,
    by_reason: Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    by_card_type: Array.from(cardTypeReasonCounts.entries())
      .map(([key, count]) => {
        const [card_type, reason] = key.split('\u0000') as [
          string,
          CardsDropReasonCode,
        ];
        return { card_type, reason, count };
      })
      .sort(
        (a, b) =>
          b.count - a.count ||
          a.card_type.localeCompare(b.card_type) ||
          a.reason.localeCompare(b.reason),
      ),
  };
}

function buildShadowCompareRows(rows: CardRow[]): ShadowCompareRow[] {
  return rows.map((row) => {
    const parsed = safeJsonParse(row.payload_data);
    const normalizedPayload = normalizePayloadMeta(parsed.data);
    return {
      card_type: row.card_type || 'unknown',
      drop_reason:
        parsed.error || isProjectionSurfaceCardType(row.card_type)
          ? 'SURFACED'
          : (getBettingSurfacePayloadDropReason(normalizedPayload) ?? 'SURFACED'),
    };
  });
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/cards');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();

    const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    if (!access.ok) {
      const message = access.status === 403 ? 'Forbidden' : 'Unauthorized';
      return createOpaqueErrorResponse(request, access.status, message);
    }

    const { searchParams } = request.nextUrl;
    const sportParam = searchParams.get('sport');
    const sport = sportParam ? sportParam.toLowerCase() : null;
    const cardType = searchParams.get('card_type');
    const gameId = searchParams.get('game_id');
    const dateParam = searchParams.get('date') ?? null;
    const dedupe = searchParams.get('dedupe');
    const limit = clampNumber(searchParams.get('limit'), 20, 1, 100);
    const offset = clampNumber(searchParams.get('offset'), 0, 0, 1000);
    const diagnosticsEnabled = searchParams.has('_diag');
    const lifecycleMode = ENABLE_CARDS_LIFECYCLE_PARITY
      ? resolveLifecycleMode(searchParams)
      : 'pregame';

    db = getDatabaseReadOnly();
    const activeRunIds = getActiveRunIds(db);
    const currentRunId = activeRunIds[0] ?? null;
    const runStatus = getRunStatus(db, currentRunId);

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads'`,
    );
    const hasCardsTable = tableCheckStmt.get();

    if (!hasCardsTable) {
      // Database is not initialized - return empty data
      const response = NextResponse.json(
        {
          success: true,
          data: [],
          meta: {
            current_run_id: currentRunId,
            generated_at: new Date().toISOString(),
            run_status: runStatus,
            items_count: 0,
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
      return finalizeApiResponse(response, request);
    }

    const requestWhere: string[] = [];
    const requestParams: Array<string | number> = [];

    if (sport) {
      // Request filter gate. Purpose: honor explicit sport selection.
      // NHL lane: also include nhl_props cards when sport=nhl so game cards and
      // prop cards surface together without requiring a separate query.
      // Failure semantics: not counted as a hidden-card drop because rows
      // outside the requested sport are intentionally out of scope.
      const compatibleSports = resolveNhlCompatibleSports(sport);
      if (compatibleSports && compatibleSports.length > 1) {
        const sportPlaceholders = compatibleSports.map(() => '?').join(', ');
        requestWhere.push(`LOWER(cp.sport) IN (${sportPlaceholders})`);
        requestParams.push(...compatibleSports);
      } else {
        requestWhere.push('LOWER(cp.sport) = ?');
        requestParams.push(sport);
      }
    }

    if (cardType) {
      // Request filter gate. Purpose: honor explicit card_type selection.
      // Failure semantics: not a diagnostics drop; unmatched card types are
      // outside the caller-selected inventory.
      requestWhere.push('cp.card_type = ?');
      requestParams.push(cardType);
    }

    if (gameId) {
      // Request filter gate. Purpose: honor explicit game_id selection.
      // Failure semantics: not a diagnostics drop; other games are outside
      // the caller-selected inventory.
      requestWhere.push('cp.game_id = ?');
      requestParams.push(gameId);
    }

    const showAllDates = dateParam === 'all';
    const gameDateFilter =
      !showAllDates && dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
        ? dateParam
        : !showAllDates
          ? new Date().toISOString().slice(0, 10)
          : null;

    if (gameDateFilter) {
      // Request date gate. Purpose: default the read surface to the UTC game
      // date while keeping orphan cards visible for diagnosis.
      // Failure semantics: not a hidden-card drop because rows outside the
      // requested date are intentionally out of scope.
      requestWhere.push('(DATE(g.game_time_utc) = ? OR cp.game_id IS NULL)');
      requestParams.push(gameDateFilter);
    }

    const baseWhere = [...requestWhere];
    const baseParams = [...requestParams];

    // Sport support gate. Purpose: exclude domains not served by /api/cards.
    // Failure semantics: SPORT_EXCLUDED_FPL and SPORT_EXCLUDED_NCAAM.
    baseWhere.push("LOWER(cp.sport) != 'fpl'");
    baseWhere.push("LOWER(cp.sport) != 'ncaam'");
    // Projection visibility gate. Purpose: hide generic projection-only rows
    // while preserving explicit projection-surface card types. Failure
    // semantics are the PROJECTION_ONLY_* / SYNTHETIC_FALLBACK_* reason codes.
    baseWhere.push(
      `(LOWER(cp.card_type) IN (${PROJECTION_SURFACE_CARD_TYPES_SQL}) OR ${buildBettingSurfacePayloadPredicate('cp.payload_data')})`,
    );
    // Settlement gate. Purpose: hide cards whose specific card_type has settled
    // results for this game. Uses card-type-precise scope so a settled nhl-totals
    // row does not suppress unsettled nhl-pace-1p cards from the same game.
    // Failure semantics: SETTLED_RESULT.
    baseWhere.push(buildCardTypePreciseSettledPredicate());
    if (!ENABLE_WELCOME_HOME) {
      // Feature-flag gate. Purpose: keep welcome-home experiments hidden unless
      // explicitly enabled. Failure semantics: WELCOME_HOME_DISABLED.
      baseWhere.push("cp.card_type NOT IN ('welcome-home', 'welcome-home-v2')");
    }

    let lifecycleNowSql: string | null = null;
    // Lifecycle gate. Purpose: when parity mode is enabled and lifecycle=active
    // is requested, show only started non-terminal games. Failure semantics:
    // LIFECYCLE_STATUS_EXCLUDED or LIFECYCLE_NOT_STARTED_OR_MISSING_TIME.
    if (
      ENABLE_CARDS_LIFECYCLE_PARITY &&
      lifecycleMode === 'active'
    ) {
      const now = new Date();
      lifecycleNowSql = now
        .toISOString()
        .substring(0, 19)
        .replace('T', ' ');
      baseWhere.push(`UPPER(COALESCE(g.status, '')) NOT IN (${ACTIVE_EXCLUDED_STATUSES.map(
        (status) => `'${status}'`,
      ).join(', ')})`);
      baseWhere.push(`datetime(g.game_time_utc) <= datetime(?)`);
      baseParams.push(lifecycleNowSql);
    }

    const runScopedWhere = [...baseWhere];
    const runScopedParams = [...baseParams];
    if (activeRunIds.length > 0) {
      const runIdPlaceholders = activeRunIds.map(() => '?').join(', ');
      // Run-scope gate with per-type fallback. Purpose: prefer cards from
      // current successful worker runs while allowing a card type to surface
      // from older runs if the active run has no rows for that game+type.
      // Failure semantics: RUN_SCOPE_EXCLUDED (global fallback only).
      // Callers push activeRunIds twice: once for each IN clause in the predicate.
      runScopedWhere.push(buildPerTypeRunScopePredicate(runIdPlaceholders));
      runScopedParams.push(...activeRunIds, ...activeRunIds);
    }

    const dedupeMode = dedupe === 'none' ? 'none' : 'latest_per_game_type';
    const buildSql = (whereSql: string) =>
      dedupeMode === 'none'
        ? `
        SELECT cp.* FROM card_payloads cp
        LEFT JOIN games g ON cp.game_id = g.game_id
        ${whereSql}
        ORDER BY COALESCE(g.game_time_utc, cp.created_at) ASC, cp.created_at DESC, cp.id DESC
        LIMIT ? OFFSET ?
      `
        : `
        WITH filtered AS (
          SELECT cp.*,
            g.game_time_utc,
            ${buildMarketIdentityKeyExpression('cp')} AS market_identity_key
          FROM card_payloads cp
          LEFT JOIN games g ON cp.game_id = g.game_id
          ${whereSql}
        ),
        ranked AS (
          SELECT cp.*,
            ROW_NUMBER() OVER (
              PARTITION BY market_identity_key
              ORDER BY created_at DESC, id DESC
            ) AS rn
          FROM filtered cp
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY COALESCE(game_time_utc, created_at) ASC, created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `;

    // Legacy path: run-scoped query with global fallback when scoped returns empty.
    // Skipped when simplified gate is active without shadow compare.
    const runLegacyPath = !ENABLE_SIMPLIFIED_CARDS_GATE || ENABLE_GATE_SHADOW_COMPARE;
    let legacyRows: CardRow[] = [];
    let runScopeFallbackApplied = false;

    if (runLegacyPath) {
      const runScopedWhereSql =
        runScopedWhere.length > 0 ? `WHERE ${runScopedWhere.join(' AND ')}` : '';
      legacyRows = db.prepare(buildSql(runScopedWhereSql)).all(
        ...runScopedParams,
        limit,
        offset,
      ) as CardRow[];

      if (
        activeRunIds.length > 0 &&
        legacyRows.length === 0 &&
        shouldApplyGlobalRunFallback(lifecycleMode)
      ) {
        const baseWhereSql =
          baseWhere.length > 0 ? `WHERE ${baseWhere.join(' AND ')}` : '';
        legacyRows = db.prepare(buildSql(baseWhereSql)).all(
          ...baseParams,
          limit,
          offset,
        ) as CardRow[];
        runScopeFallbackApplied = true;
      }
    }

    // Simplified gate: single-phase query — per-type predicate subsumes the
    // global fallback, so no second query is needed.
    let simplifiedRows: CardRow[] | null = null;
    if (ENABLE_SIMPLIFIED_CARDS_GATE || ENABLE_GATE_SHADOW_COMPARE) {
      const sg = buildSimplifiedGateWhere(baseWhere, baseParams, activeRunIds);
      const simplifiedWhereSql =
        sg.where.length > 0 ? `WHERE ${sg.where.join(' AND ')}` : '';
      simplifiedRows = db.prepare(buildSql(simplifiedWhereSql)).all(
        ...sg.sqlParams,
        limit,
        offset,
      ) as CardRow[];
    }

    // Active result selection: simplified takes precedence when its flag is set.
    let rows: CardRow[];
    if (ENABLE_SIMPLIFIED_CARDS_GATE && simplifiedRows !== null) {
      rows = simplifiedRows;
      runScopeFallbackApplied = false;
    } else {
      rows = legacyRows;
    }

    // Shadow compare telemetry: counts by card_type and drop_reason, legacy
    // versus simplified.
    const shadowCompareTelemetry: ShadowCompareTelemetry | undefined =
      ENABLE_GATE_SHADOW_COMPARE && simplifiedRows !== null
        ? buildShadowCompareTelemetry(
            buildShadowCompareRows(legacyRows),
            buildShadowCompareRows(simplifiedRows),
          )
        : undefined;

    const response = rows.flatMap((card) => {
      const parsed = safeJsonParse(card.payload_data);
      const normalizedPayload = attachDecisionOutcome(
        normalizePayloadMeta(parsed.data),
      );
      const isProjectionSurfaceType =
        isProjectionSurfaceCardType(card.card_type);
      if (
        !parsed.error &&
        isProjectionSurfaceType &&
        !hasActionableProjectionCall(normalizedPayload)
      ) {
        return [];
      }
      // Serialization safety gate. Purpose: mirror the SQL projection
      // visibility gate after JSON parsing so malformed query predicates or
      // future SQL drift cannot leak projection-only betting rows. Failure
      // semantics match the PROJECTION_ONLY_* / SYNTHETIC_FALLBACK_* reasons.
      if (!parsed.error && !isProjectionSurfaceType && !isBettingSurfacePayload(normalizedPayload)) {
        return [];
      }
      return [{
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
      }];
    });

    const diagnostics = diagnosticsEnabled
      ? buildCardsDropDiagnostics(db, {
          requestWhere,
          requestParams,
          activeRunIds,
          runScopeFallbackApplied,
          welcomeHomeEnabled: ENABLE_WELCOME_HOME,
          lifecycleMode,
          lifecycleEnabled: ENABLE_CARDS_LIFECYCLE_PARITY,
          lifecycleNowSql,
          returnedCount: response.length,
        })
      : undefined;

    // NOTE: card_display_log writes intentionally removed.
    // Worker owns all DB writes (single-writer architecture).
    // Display analytics can be added back via worker-side logging if needed.

    const apiResponse = NextResponse.json(
      {
        success: true,
        data: response,
        meta: {
          current_run_id: currentRunId,
          generated_at: new Date().toISOString(),
          run_status: runStatus,
          items_count: response.length,
          has_more: rows.length === limit,
          offset,
          limit,
          ...(diagnostics ? { diagnostics } : {}),
          ...(shadowCompareTelemetry ? { gate_shadow_compare: shadowCompareTelemetry } : {}),
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return finalizeApiResponse(apiResponse, request);
  } catch (error) {
    const correlationId = createCorrelationId();
    console.error('[API] Error fetching cards:', { correlationId, error });
    return createOpaqueErrorResponse(request, 500, 'Internal server error');
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
