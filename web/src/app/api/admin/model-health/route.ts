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

    const response = NextResponse.json({ success: true, data });
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
