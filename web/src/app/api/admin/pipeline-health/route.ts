/**
 * GET /api/admin/pipeline-health
 *
 * Read surface for the pipeline_health table. Written exclusively by
 * apps/worker/src/jobs/check_pipeline_health.js on a scheduled interval.
 *
 * Returns the 50 most recent rows ordered by created_at DESC.
 * Auth deferred — see WI-0761 out-of-scope clause.
 *
 * Response: { success: boolean, data: PipelineHealthRow[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
  PipelineHealthRow,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../../lib/api-security';

interface PotdLane {
  phase: string;
  check_name: string;
  status: 'ok' | 'warning' | 'failed';
  reason: string;
  created_at: string;
  virtual: true;
}

interface PotdHealth {
  status: string;
  last_run_at: string | null;
  today_state: string;
  candidate_count: number;
  near_miss: {
    last_settled_at: string | null;
    counts: {
      total: number;
      pending: number;
      settled: number;
      win: number;
      loss: number;
      push: number;
    };
  };
  signals: string[];
}

const POTD_RUN_STALE_MS = 36 * 60 * 60 * 1000;
const POTD_NEAR_MISS_STALE_MS = 48 * 60 * 60 * 1000;
const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    const securityCheck = performSecurityChecks(request, '/api/admin/pipeline-health');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();

    db = getDatabaseReadOnly();

    const rows = db
      .prepare(
        `SELECT
           id,
           phase,
           check_name,
           status,
           reason,
           created_at,
           check_id,
           dedupe_key,
           first_seen_at,
           last_seen_at,
           resolved_at
         FROM pipeline_health
         ORDER BY
           CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END,
           COALESCE(last_seen_at, created_at) DESC,
           id DESC
         LIMIT 100`,
      )
      .all() as PipelineHealthRow[];

    const potdHealth = buildPotdHealth(db);
    const response = NextResponse.json({
      success: true,
      data: rows,
      potd_lanes: buildPotdLanes(potdHealth),
    });
    return addRateLimitHeaders(response, request);
  } catch (err) {
    console.error('[API] Error fetching pipeline-health:', err);
    const errorResponse = NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}

function buildPotdLanes(potdHealth: PotdHealth): PotdLane[] {
  const now = new Date().toISOString();
  const nearMissCounts = potdHealth.near_miss.counts;

  return [
    {
      phase: 'potd',
      check_name: 'run_recency',
      status: potdHealth.last_run_at
        ? potdHealth.status === 'stale' ? 'failed' : 'ok'
        : 'failed',
      reason: potdHealth.last_run_at
        ? `Last POTD run at ${potdHealth.last_run_at}`
        : 'No POTD run history found',
      created_at: now,
      virtual: true,
    },
    {
      phase: 'potd',
      check_name: 'today_state',
      status: potdHealth.today_state === 'fired'
        ? 'ok'
        : potdHealth.today_state === 'no-pick' ? 'warning' : 'failed',
      reason: `Today POTD state is ${potdHealth.today_state}`,
      created_at: now,
      virtual: true,
    },
    {
      phase: 'potd',
      check_name: 'candidate_volume',
      status: potdHealth.candidate_count > 0 ? 'ok' : 'warning',
      reason: `${potdHealth.candidate_count} POTD candidate(s) recorded for today`,
      created_at: now,
      virtual: true,
    },
    {
      phase: 'potd',
      check_name: 'near_miss_settlement',
      status: nearMissCounts.total === 0
        ? 'warning'
        : potdHealth.status === 'stale' && potdHealth.signals.some((signal) => signal.toLowerCase().includes('near-miss'))
          ? 'failed'
          : 'ok',
      reason: `${nearMissCounts.settled} settled, ${nearMissCounts.pending} pending near-miss shadow candidate(s)`,
      created_at: now,
      virtual: true,
    },
  ];
}

function buildPotdHealth(db: ReturnType<typeof getDatabaseReadOnly>): PotdHealth {
  const now = new Date();
  const today = ET_DATE_FORMATTER.format(now);
  const latestDaily = tableExists(db, 'potd_daily_stats')
    ? safeGet<{
        potd_fired: number;
        candidate_count: number;
        viable_count: number;
        created_at: string;
      }>(
        db,
        `SELECT potd_fired, candidate_count, viable_count, created_at
         FROM potd_daily_stats
         ORDER BY created_at DESC, play_date DESC
         LIMIT 1`,
      )
    : null;
  const todayDaily = tableExists(db, 'potd_daily_stats')
    ? safeGet<{
        potd_fired: number;
        candidate_count: number;
        viable_count: number;
        created_at: string;
      }>(
        db,
        `SELECT potd_fired, candidate_count, viable_count, created_at
         FROM potd_daily_stats
         WHERE play_date = ?
         LIMIT 1`,
        today,
      )
    : null;
  const todayPlay = tableExists(db, 'potd_plays')
    ? safeGet<{ posted_at: string | null; created_at: string }>(
        db,
        `SELECT posted_at, created_at
         FROM potd_plays
         WHERE play_date = ?
         ORDER BY posted_at DESC, created_at DESC
         LIMIT 1`,
        today,
      )
    : null;
  const latestPlay = tableExists(db, 'potd_plays')
    ? safeGet<{ posted_at: string | null; created_at: string }>(
        db,
        `SELECT posted_at, created_at
         FROM potd_plays
         ORDER BY posted_at DESC, created_at DESC
         LIMIT 1`,
      )
    : null;
  const todayNomineeCount = tableExists(db, 'potd_nominees')
    ? Number(safeGet<{ count: number }>(
        db,
        'SELECT COUNT(*) AS count FROM potd_nominees WHERE play_date = ?',
        today,
      )?.count || 0)
    : 0;
  const todayShadowCount = tableExists(db, 'potd_shadow_candidates')
    ? Number(safeGet<{ count: number }>(
        db,
        'SELECT COUNT(*) AS count FROM potd_shadow_candidates WHERE play_date = ?',
        today,
      )?.count || 0)
    : 0;
  const shadowRows = tableExists(db, 'potd_shadow_results')
    ? safeAll<{ status: string | null; result: string | null; count: number }>(
        db,
        `SELECT status, result, COUNT(*) AS count
         FROM potd_shadow_results
         GROUP BY status, result`,
      )
    : [];
  const latestShadowResult = tableExists(db, 'potd_shadow_results')
    ? safeGet<{ settled_at: string | null; updated_at: string | null; created_at: string }>(
        db,
        `SELECT settled_at, updated_at, created_at
         FROM potd_shadow_results
         ORDER BY COALESCE(settled_at, updated_at, created_at) DESC
         LIMIT 1`,
      )
    : null;

  const candidateCount = toFiniteNumber(todayDaily?.candidate_count)
    ?? todayNomineeCount + todayShadowCount;
  const todayState = todayPlay || Number(todayDaily?.potd_fired) === 1
    ? 'fired'
    : todayDaily
      ? 'no-pick'
      : 'no-data';
  const lastRunAt = maxIso(
    latestDaily?.created_at,
    latestPlay?.posted_at,
    latestPlay?.created_at,
  );
  const nearMissLastSettledAt = maxIso(
    latestShadowResult?.settled_at,
    latestShadowResult?.updated_at,
    latestShadowResult?.created_at,
  );
  const nearMissCounts = summarizeNearMissCounts(shadowRows);
  const signals: string[] = [];
  let status = 'healthy';

  if (!lastRunAt) {
    status = 'no-data';
    signals.push('No POTD run history found');
  } else if (now.getTime() - new Date(lastRunAt).getTime() > POTD_RUN_STALE_MS) {
    status = 'stale';
    signals.push('POTD run is stale');
  }
  if (todayState === 'no-data') {
    if (status === 'healthy') status = 'degraded';
    signals.push('No POTD fired/no-pick state recorded for today');
  } else if (todayState === 'no-pick' && status === 'healthy') {
    status = 'degraded';
    signals.push('POTD recorded a no-pick state today');
  }
  if (candidateCount === 0) {
    if (status === 'healthy') status = 'degraded';
    signals.push('POTD candidate volume is zero today');
  }
  if (nearMissCounts.total === 0) {
    if (status === 'healthy') status = 'degraded';
    signals.push('No near-miss shadow settlement history found');
  } else if (
    nearMissLastSettledAt &&
    now.getTime() - new Date(nearMissLastSettledAt).getTime() > POTD_NEAR_MISS_STALE_MS
  ) {
    if (status === 'healthy' || status === 'degraded') status = 'stale';
    signals.push('Near-miss shadow settlement is stale');
  }

  return {
    status,
    last_run_at: lastRunAt,
    today_state: todayState,
    candidate_count: candidateCount,
    near_miss: {
      last_settled_at: nearMissLastSettledAt,
      counts: nearMissCounts,
    },
    signals,
  };
}

function tableExists(db: ReturnType<typeof getDatabaseReadOnly>, tableName: string): boolean {
  try {
    return Boolean(
      db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      ).get(tableName),
    );
  } catch {
    return false;
  }
}

function safeGet<T>(db: ReturnType<typeof getDatabaseReadOnly>, sql: string, ...params: unknown[]): T | null {
  try {
    return (db.prepare(sql).get(...params) as T | undefined) || null;
  } catch {
    return null;
  }
}

function safeAll<T>(db: ReturnType<typeof getDatabaseReadOnly>, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values.filter(Boolean) as string[]) {
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > new Date(best).getTime()) best = value;
  }
  return best;
}

function summarizeNearMissCounts(
  rows: Array<{ status: string | null; result: string | null; count: number }>,
): PotdHealth['near_miss']['counts'] {
  const counts = { total: 0, pending: 0, settled: 0, win: 0, loss: 0, push: 0 };
  for (const row of rows) {
    const count = Number(row.count || 0);
    counts.total += count;
    const status = String(row.status || '').toLowerCase();
    const result = String(row.result || '').toLowerCase();
    if (status === 'pending') counts.pending += count;
    if (status === 'settled') counts.settled += count;
    if (result === 'win') counts.win += count;
    if (result === 'loss') counts.loss += count;
    if (result === 'push') counts.push += count;
  }
  return counts;
}
