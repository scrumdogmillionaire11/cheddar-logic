import { getDatabaseReadOnly } from '@cheddar-logic/data';

import { PROJECTION_ONLY_LINE_SOURCES } from './payload-classifier';

export type LifecycleMode = 'pregame' | 'active';

export const ACTIVE_EXCLUDED_STATUSES = [
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'FINAL',
  'CLOSED',
  'COMPLETE',
  'COMPLETED',
  'FT',
] as const;

const CORE_RUN_STATE_SPORTS = [
  'nba',
  'nhl',
  'soccer',
  'mlb',
  'nfl',
  'fpl',
  'nhl_props',
] as const;
export const CORE_RUN_STATE_SPORT_SQL = CORE_RUN_STATE_SPORTS.map(
  (sport) => `'${sport}'`,
).join(', ');

export function resolveLifecycleMode(
  searchParams: URLSearchParams,
): LifecycleMode {
  const lifecycleParam = (searchParams.get('lifecycle') || '').toLowerCase();
  if (lifecycleParam === 'active') return 'active';
  return 'pregame';
}

export function buildBettingSurfacePayloadPredicate(
  payloadExpr: string,
): string {
  const lineSourceList = PROJECTION_ONLY_LINE_SOURCES.map(
    (source) => `'${source}'`,
  ).join(', ');

  // Cards-read payload gate. Purpose: keep generic projection-only rows off
  // the betting surface while preserving projection-surface card types at the
  // route layer. Failure semantics are mirrored by
  // getBettingSurfacePayloadDropReason for diagnostics reason codes:
  // PROJECTION_ONLY_BASIS, PROJECTION_ONLY_EXECUTION_STATUS,
  // PROJECTION_ONLY_LINE_SOURCE, SYNTHETIC_FALLBACK_PROJECTION_SOURCE.
  // Invalid JSON is not a drop reason; the API returns payloadParseError.
  return `
    CASE
      WHEN json_valid(${payloadExpr}) = 0 THEN 1
      ELSE NOT (
        UPPER(COALESCE(
          json_extract(${payloadExpr}, '$.decision_basis_meta.decision_basis'),
          json_extract(${payloadExpr}, '$.basis'),
          json_extract(${payloadExpr}, '$.execution_status'),
          json_extract(${payloadExpr}, '$.play.execution_status'),
          json_extract(${payloadExpr}, '$.prop_display_state'),
          json_extract(${payloadExpr}, '$.play.prop_display_state'),
          ''
        )) = 'PROJECTION_ONLY'
        OR LOWER(COALESCE(
          json_extract(${payloadExpr}, '$.decision_basis_meta.market_line_source'),
          json_extract(${payloadExpr}, '$.market_context.wager.line_source'),
          json_extract(${payloadExpr}, '$.play.market_context.wager.line_source'),
          json_extract(${payloadExpr}, '$.line_source'),
          json_extract(${payloadExpr}, '$.play.line_source'),
          ''
        )) IN (${lineSourceList})
        OR UPPER(COALESCE(
          json_extract(${payloadExpr}, '$.prop_decision.projection_source'),
          json_extract(${payloadExpr}, '$.play.prop_decision.projection_source'),
          json_extract(${payloadExpr}, '$.projection_source'),
          json_extract(${payloadExpr}, '$.play.projection_source'),
          ''
        )) = 'SYNTHETIC_FALLBACK'
      )
    END = 1
  `;
}

export function clampNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function getActiveRunIds(
  db: ReturnType<typeof getDatabaseReadOnly>,
): string[] {
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

export function getRunStatus(
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
