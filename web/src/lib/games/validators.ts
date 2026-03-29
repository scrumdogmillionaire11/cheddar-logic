/**
 * Projection and payload validation helpers extracted from route.ts (WI-0621)
 * DB-dependent functions are grouped below pure ones.
 */

import { parseJsonObject, toFiniteNumber } from './normalizers';

// ---------------------------------------------------------------------------
// Pure validation helpers (no DB)
// ---------------------------------------------------------------------------

export function assessProjectionInputsFromRawData(
  sport: string,
  rawData: unknown,
): { projection_inputs_complete: boolean | null; projection_missing_inputs: string[] } {
  const raw = parseJsonObject(rawData);
  if (!raw) {
    return {
      projection_inputs_complete: null,
      projection_missing_inputs: [],
    };
  }

  const normalizedSport = String(sport || '').toUpperCase();
  const missingInputs: string[] = [];
  const espnMetrics = parseJsonObject(raw.espn_metrics);
  const homeEspnMetrics = parseJsonObject(espnMetrics?.home)?.metrics;
  const awayEspnMetrics = parseJsonObject(espnMetrics?.away)?.metrics;
  const homeMetrics = parseJsonObject(homeEspnMetrics);
  const awayMetrics = parseJsonObject(awayEspnMetrics);
  const homeRaw = parseJsonObject(raw.home);
  const awayRaw = parseJsonObject(raw.away);

  if (normalizedSport === 'NBA') {
    const homeAvgPoints =
      homeMetrics?.avgPoints ??
      raw.avg_points_home ??
      homeRaw?.avg_points;
    const awayAvgPoints =
      awayMetrics?.avgPoints ??
      raw.avg_points_away ??
      awayRaw?.avg_points;
    const homeAvgPointsAllowed =
      homeMetrics?.avgPointsAllowed ??
      raw.avg_points_allowed_home ??
      homeRaw?.avg_points_allowed;
    const awayAvgPointsAllowed =
      awayMetrics?.avgPointsAllowed ??
      raw.avg_points_allowed_away ??
      awayRaw?.avg_points_allowed;

    if (toFiniteNumber(homeAvgPoints) === null) missingInputs.push('home_avg_points');
    if (toFiniteNumber(awayAvgPoints) === null) missingInputs.push('away_avg_points');
    if (toFiniteNumber(homeAvgPointsAllowed) === null) {
      missingInputs.push('home_avg_points_allowed');
    }
    if (toFiniteNumber(awayAvgPointsAllowed) === null) {
      missingInputs.push('away_avg_points_allowed');
    }
  } else if (normalizedSport === 'NHL') {
    const homeGoalsFor =
      homeMetrics?.avgGoalsFor ??
      raw.avg_goals_for_home ??
      homeRaw?.avg_goals_for;
    const awayGoalsFor =
      awayMetrics?.avgGoalsFor ??
      raw.avg_goals_for_away ??
      awayRaw?.avg_goals_for;
    const homeGoalsAgainst =
      homeMetrics?.avgGoalsAgainst ??
      raw.avg_goals_against_home ??
      homeRaw?.avg_goals_against;
    const awayGoalsAgainst =
      awayMetrics?.avgGoalsAgainst ??
      raw.avg_goals_against_away ??
      awayRaw?.avg_goals_against;

    if (toFiniteNumber(homeGoalsFor) === null) missingInputs.push('home_avg_goals_for');
    if (toFiniteNumber(awayGoalsFor) === null) missingInputs.push('away_avg_goals_for');
    if (toFiniteNumber(homeGoalsAgainst) === null) {
      missingInputs.push('home_avg_goals_against');
    }
    if (toFiniteNumber(awayGoalsAgainst) === null) {
      missingInputs.push('away_avg_goals_against');
    }
  }

  return {
    projection_inputs_complete: missingInputs.length === 0,
    projection_missing_inputs: missingInputs,
  };
}

export function deriveSourceMappingHealth(rawData: unknown): {
  source_mapping_ok: boolean | null;
  source_mapping_failures: string[];
} {
  const raw = parseJsonObject(rawData);
  const sourceContract = raw?.espn_metrics &&
    typeof raw.espn_metrics === 'object' &&
    (raw.espn_metrics as Record<string, unknown>).source_contract &&
    typeof (raw.espn_metrics as Record<string, unknown>).source_contract === 'object'
      ? ((raw.espn_metrics as Record<string, unknown>).source_contract as Record<string, unknown>)
      : null;

  return {
    source_mapping_ok:
      typeof sourceContract?.mapping_ok === 'boolean'
        ? (sourceContract.mapping_ok as boolean)
        : null,
    source_mapping_failures: Array.isArray(sourceContract?.mapping_failures)
      ? sourceContract.mapping_failures.map((item) => String(item))
      : [],
  };
}

export function hasMinimumViability(
  play: {
    selection?: { side?: string };
    price?: number | null;
    line?: number | null;
  },
  marketType:
    | 'MONEYLINE'
    | 'SPREAD'
    | 'TOTAL'
    | 'PUCKLINE'
    | 'TEAM_TOTAL'
    | 'FIRST_PERIOD'
    | 'PROP'
    | 'INFO',
): boolean {
  const side = play.selection?.side;
  const hasPrice =
    typeof play.price === 'number' && Number.isFinite(play.price);
  const isMoneylineFamilySide =
    side === 'HOME' ||
    side === 'AWAY';
  if (marketType === 'TOTAL') {
    // Price is sourced from odds snapshot at display time — only require side + line.
    return (
      (side === 'OVER' || side === 'UNDER') && typeof play.line === 'number'
    );
  }
  if (marketType === 'SPREAD') {
    return (
      (side === 'HOME' || side === 'AWAY') &&
      typeof play.line === 'number' &&
      hasPrice
    );
  }
  if (marketType === 'MONEYLINE') {
    return isMoneylineFamilySide && hasPrice;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DB-dependent helpers — these require a live database connection.
// Tests that cannot provide a real DB should use it.skip() for these.
// ---------------------------------------------------------------------------

// NOTE: The DB type below uses `any` to avoid coupling this module to the
// @cheddar-logic/data package import (which causes Next.js bundle issues when
// imported outside of API route files).  Callers pass the result of
// getDatabaseReadOnly() which satisfies the duck-typed interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbInstance = any;

const CORE_RUN_STATE_SPORTS = [
  'nba',
  'nhl',
  'mlb',
  'nfl',
  'fpl',
  'nhl_props',
] as const;
const CORE_RUN_STATE_SPORT_SQL = CORE_RUN_STATE_SPORTS.map(
  (sport) => `'${sport}'`,
).join(', ');

export function getActiveRunIds(db: DbInstance): string[] {
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

export function getFallbackRunIdsFromCards(db: DbInstance): string[] {
  try {
    const row = db
      .prepare(
        `SELECT run_id
         FROM card_payloads
         WHERE run_id IS NOT NULL
           AND TRIM(run_id) != ''
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT 1`,
      )
      .get() as { run_id?: string | null } | undefined;
    return row?.run_id ? [String(row.run_id)] : [];
  } catch {
    return [];
  }
}

export function getRunStatus(db: DbInstance, runId: string | null): string {
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
