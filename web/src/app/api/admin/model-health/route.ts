/**
 * GET /api/admin/model-health
 *
 * Read surface for persisted Dr. Claire snapshots. Written exclusively by
 * apps/worker/src/jobs/dr_claire_health_report.js when invoked with --persist.
 *
 * Returns the latest 30-day snapshot row per sport.
 * Auth deferred — see WI-0761 out-of-scope clause.
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
} from '../../../../lib/api-security';

interface ModelHealthSnapshotRow {
  sport: string;
  run_at: string;
  hit_rate: number | null;
  roi_units: number | null;
  roi_pct: number | null;
  total_unique: number;
  wins: number;
  losses: number;
  streak: string | null;
  last10_hit_rate: number | null;
  status: string;
  signals_json: string | null;
  lookback_days: number;
}

interface PotdHealth {
  status: string;
  last_run_at: string | null;
  last_run_age: string;
  today_state: string;
  play_date: string;
  candidate_count: number;
  viable_count: number | null;
  near_miss: {
    last_settled_at: string | null;
    last_settled_age: string;
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
    const securityCheck = performSecurityChecks(request, '/api/admin/model-health');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();
    db = getDatabaseReadOnly();

    const rows = db.prepare(
      `SELECT
         mhs.sport,
         mhs.run_at,
         mhs.hit_rate,
         mhs.roi_units,
         mhs.roi_pct,
         mhs.total_unique,
         mhs.wins,
         mhs.losses,
         mhs.streak,
         mhs.last10_hit_rate,
         mhs.status,
         mhs.signals_json,
         mhs.lookback_days
       FROM model_health_snapshots mhs
       WHERE mhs.lookback_days = 30
         AND mhs.run_at = (
           SELECT MAX(latest.run_at)
           FROM model_health_snapshots latest
           WHERE latest.sport = mhs.sport
             AND latest.lookback_days = mhs.lookback_days
         )
       ORDER BY mhs.sport ASC`,
    ).all() as ModelHealthSnapshotRow[];

    const data = rows.map((row) => ({
      sport: row.sport,
      run_at: row.run_at,
      hit_rate: row.hit_rate,
      roi_units: row.roi_units,
      roi_pct: row.roi_pct,
      total_unique: row.total_unique,
      wins: row.wins,
      losses: row.losses,
      streak: row.streak,
      last10_hit_rate: row.last10_hit_rate,
      status: row.status,
      signals: parseSignals(row.signals_json),
      lookback_days: row.lookback_days,
    }));

    const response = NextResponse.json({
      success: true,
      data,
      potd_health: buildPotdHealth(db),
    });
    return addRateLimitHeaders(response, request);
  } catch (err) {
    console.error('[API] Error fetching model-health:', err);
    const errorResponse = NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}

function buildPotdHealth(db: ReturnType<typeof getDatabaseReadOnly>): PotdHealth {
  const now = new Date();
  const today = ET_DATE_FORMATTER.format(now);
  const latestDaily = tableExists(db, 'potd_daily_stats')
    ? safeGet<{
        play_date: string;
        potd_fired: number;
        candidate_count: number;
        viable_count: number;
        created_at: string;
      }>(
        db,
        `SELECT play_date, potd_fired, candidate_count, viable_count, created_at
         FROM potd_daily_stats
         ORDER BY created_at DESC, play_date DESC
         LIMIT 1`,
      )
    : null;
  const todayDaily = tableExists(db, 'potd_daily_stats')
    ? safeGet<{
        play_date: string;
        potd_fired: number;
        candidate_count: number;
        viable_count: number;
        created_at: string;
      }>(
        db,
        `SELECT play_date, potd_fired, candidate_count, viable_count, created_at
         FROM potd_daily_stats
         WHERE play_date = ?
         LIMIT 1`,
        today,
      )
    : null;
  const todayPlay = tableExists(db, 'potd_plays')
    ? safeGet<{ play_date: string; posted_at: string | null; created_at: string }>(
        db,
        `SELECT play_date, posted_at, created_at
         FROM potd_plays
         WHERE play_date = ?
         ORDER BY posted_at DESC, created_at DESC
         LIMIT 1`,
        today,
      )
    : null;
  const latestPlay = tableExists(db, 'potd_plays')
    ? safeGet<{ play_date: string; posted_at: string | null; created_at: string }>(
        db,
        `SELECT play_date, posted_at, created_at
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
  const viableCount = toFiniteNumber(todayDaily?.viable_count);
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
    signals.push(`POTD run is stale: last run ${formatAge(lastRunAt)}`);
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
    signals.push(`Near-miss shadow settlement is stale: last update ${formatAge(nearMissLastSettledAt)}`);
  }

  return {
    status,
    last_run_at: lastRunAt,
    last_run_age: lastRunAt ? formatAge(lastRunAt) : 'never',
    today_state: todayState,
    play_date: today,
    candidate_count: candidateCount,
    viable_count: viableCount,
    near_miss: {
      last_settled_at: nearMissLastSettledAt,
      last_settled_age: nearMissLastSettledAt ? formatAge(nearMissLastSettledAt) : 'never',
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

function formatAge(ts: string): string {
  const ageMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function parseSignals(signalsJson: string | null): string[] {
  if (!signalsJson) return [];
  try {
    const parsed = JSON.parse(signalsJson);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
