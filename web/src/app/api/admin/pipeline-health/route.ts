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
        `SELECT id, phase, check_name, status, reason, created_at
         FROM pipeline_health
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all() as PipelineHealthRow[];

    const response = NextResponse.json({ success: true, data: rows });
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
